import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import {
  activeReconsiderationIds,
  allObjects,
  findObject,
  sha256,
  specEligibleObjectIds,
} from "./model.ts";
import type {
  ModelCollectionName,
  ModelObject,
  ProjectModel,
  SpecProjectionView,
} from "./types.ts";

export const PROJECTION_CONTRACT_VERSION = 1;
const GENERATED_PREFIX = "<!-- generated-by: pi-dag-workflow/project-model";

export interface RenderedSpec {
  viewId: string;
  path: string;
  inputDigest: string;
  content: string;
}

export interface ProjectionResult {
  rendered: RenderedSpec[];
  changedPaths: string[];
  driftPaths: string[];
  stalePaths: string[];
}

export class SpecProjector {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  render(model: ProjectModel): RenderedSpec[] {
    const eligibleIds = specEligibleObjectIds(model);
    const renderedIds = new Set(eligibleIds);
    if (model.project.mode === "candidate") {
      for (const { collection, object } of allObjects(model)) {
        if (isCandidateProjectable(collection, object)) {
          renderedIds.add(object.id);
        }
      }
    }
    const placements = canonicalPlacements(model, renderedIds);
    return model.project.projections.specs.map((view) =>
      renderView(model, view, placements, eligibleIds)
    );
  }

  targetPaths(model: ProjectModel): string[] {
    return this.render(model).map(({ path }) => path);
  }

  async check(model: ProjectModel): Promise<ProjectionResult> {
    const rendered = this.render(model);
    const driftPaths: string[] = [];
    for (const file of rendered) {
      const target = resolve(this.root, file.path);
      await assertSafeTarget(this.root, target);
      try {
        const current = await readFile(target, "utf8");
        if (current !== file.content) driftPaths.push(file.path);
      } catch {
        driftPaths.push(file.path);
      }
    }
    const stalePaths = await this.findStaleGeneratedPaths(
      new Set(rendered.map(({ path }) => path)),
    );
    return { rendered, changedPaths: [], driftPaths, stalePaths };
  }

  private async findStaleGeneratedPaths(
    declared: Set<string>,
  ): Promise<string[]> {
    const specRoot = resolve(this.root, "spec");
    try {
      await assertSafeTarget(this.root, specRoot);
      await lstat(specRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files = await markdownFiles(specRoot);
    const stale: string[] = [];
    for (const absolute of files) {
      const relative = posixify(absolute.slice(`${this.root}/`.length));
      if (declared.has(relative)) continue;
      let content: string;
      content = await readFile(absolute, "utf8");
      if (isGeneratedContent(content)) stale.push(relative);
    }
    return stale.sort();
  }
}

function renderView(
  model: ProjectModel,
  view: SpecProjectionView,
  placements: Map<string, { path: string; viewId: string }>,
  eligibleIds: ReadonlySet<string>,
): RenderedSpec {
  const selected = (view.sections ?? []).flatMap((section) =>
    section.objectIds.map((id) => {
      const found = findObject(model, id);
      if (!found) {
        throw new Error(
          `Projection ${view.id} references missing object ${id}`,
        );
      }
      return { ...found, sectionId: section.id };
    })
  );
  // Keep this traversal: it validates selected object references before rendering.
  void selected;
  const lines = [`# ${view.title}`];
  if (view.summary?.trim()) lines.push("", view.summary.trim());

  if (view.kind === "index" || view.kind === "prototype_index") {
    const children = (view.childViewIds ?? []).map((id) => {
      const child = model.project.projections.specs.find((candidate) =>
        candidate.id === id
      );
      if (!child) {
        throw new Error(`Projection ${view.id} references missing child ${id}`);
      }
      return child;
    });
    const manualLinks = view.manualLinks ?? [];
    if (children.length || manualLinks.length) {
      lines.push("", "## Contents", "");
      for (const child of children) {
        const href = relativeLink(view.path, child.path);
        lines.push(
          `- [${child.title}](${href})${
            child.summary ? ` — ${child.summary}` : ""
          }`,
        );
      }
      for (const link of manualLinks) {
        const href = relativeLink(view.path, link.path);
        lines.push(
          `- [${link.title}](${href})${
            link.summary ? ` — ${link.summary}` : ""
          }`,
        );
      }
    }
  }

  for (const section of view.sections ?? []) {
    lines.push("", `## ${section.title}`);
    let emitted = 0;
    for (const id of section.objectIds) {
      const found = findObject(model, id)!;
      const candidate = model.project.mode === "candidate" &&
        isCandidateProjectable(found.collection, found.object);
      if (!candidate && !eligibleIds.has(id)) continue;
      emitted += 1;
      lines.push(
        "",
        `<a id="obj-${anchorId(id)}"></a>`,
        "",
        `### ${found.object.title}`,
        "",
      );
      if (model.project.mode === "candidate") {
        lines.push(
          "> **Candidate:** pending migration audit and cutover acceptance.",
          "",
        );
      }
      const reconsiderationIds = activeReconsiderationIds(model, id);
      if (reconsiderationIds.length) {
        lines.push(`> **Under review:** ${reconsiderationIds.join(", ")}`, "");
      }
      lines.push(found.object.body.trim());
      appendTypeDetails(lines, found.collection, found.object);
      const crossLinks = found.object.relationships
        .map((relation) => ({
          relation,
          placement: placements.get(relation.targetId),
          target: findObject(model, relation.targetId),
        }))
        .filter(({ placement, target }) =>
          placement && target && placement.path !== view.path
        );
      if (crossLinks.length) {
        lines.push("", "**Related cross-domain objects**", "");
        for (const { relation, placement, target } of crossLinks) {
          const href = `${relativeLink(view.path, placement!.path)}#obj-${
            anchorId(target!.object.id)
          }`;
          lines.push(`- ${relation.kind}: [${target!.object.title}](${href})`);
        }
      }
    }
    if (!emitted) lines.push("", "_No accepted current content._");
  }
  const body = `${lines.join("\n").replace(/[ \t]+$/gm, "")}\n`;
  const inputDigest = sha256({
    contract: PROJECTION_CONTRACT_VERSION,
    path: view.path,
    body,
  });
  const content =
    `${GENERATED_PREFIX}; view: ${view.id}; contract: ${PROJECTION_CONTRACT_VERSION}; input: ${inputDigest} -->\n\n${body}`;
  return { viewId: view.id, path: view.path, inputDigest, content };
}

function appendTypeDetails(
  lines: string[],
  collection: ModelCollectionName,
  object: ModelObject,
) {
  if (
    (collection === "decisions" || collection === "commitments" ||
      collection === "proposals") &&
    "rationale" in object && object.rationale?.trim()
  ) {
    lines.push("", `**Rationale.** ${object.rationale.trim()}`);
  }
  if (collection === "scenarios") {
    const scenario = object as ProjectModel["scenarios"][number];
    if (scenario.context?.trim()) {
      lines.push("", `**Context.** ${scenario.context.trim()}`);
    }
    if (scenario.action?.trim()) {
      lines.push("", `**Action.** ${scenario.action.trim()}`);
    }
    if (scenario.expectedOutcome?.trim()) {
      lines.push(
        "",
        `**Expected outcome.** ${scenario.expectedOutcome.trim()}`,
      );
    }
  }
}

function canonicalPlacements(
  model: ProjectModel,
  renderedIds: ReadonlySet<string>,
): Map<string, { path: string; viewId: string }> {
  const placements = new Map<string, { path: string; viewId: string }>();
  for (const view of model.project.projections.specs) {
    for (const section of view.sections ?? []) {
      for (const id of section.objectIds) {
        if (!renderedIds.has(id)) continue;
        if (placements.has(id)) {
          throw new Error(`Multiple canonical placements for ${id}`);
        }
        placements.set(id, { path: view.path, viewId: view.id });
      }
    }
  }
  return placements;
}

function isCandidateProjectable(
  collection: ModelCollectionName,
  object: ModelObject,
): boolean {
  if (
    collection === "intents" || collection === "concepts" ||
    collection === "scenarios"
  ) return object.state === "proposed";
  if (collection === "decisions") return object.state === "candidate";
  if (collection === "commitments") {
    return ["proposed", "not_reviewed"].includes(object.state);
  }
  return false;
}

function relativeLink(from: string, to: string): string {
  const result = posix.relative(posix.dirname(from), to);
  return result || posix.basename(to);
}

function anchorId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
function posixify(path: string): string {
  return path.replaceAll("\\", "/");
}
function isGeneratedContent(content: string): boolean {
  return content.startsWith(GENERATED_PREFIX);
}

async function assertSafeTarget(root: string, target: string) {
  const relative = posixify(target.slice(`${root}/`.length));
  if (
    target === root || target.startsWith(`${root}/`) === false ||
    relative.startsWith("../")
  ) throw new Error(`Unsafe projection target: ${target}`);
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing projection path through symlink: ${current}`);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      break;
    }
  }
}

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string) => {
    let entries;
    entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing symlink in spec: ${path}`);
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
    }
  };
  await walk(root);
  return output.sort();
}
