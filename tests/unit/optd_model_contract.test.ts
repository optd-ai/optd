import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { checkProjectModel } from "../../scripts/project-model.ts";
import {
  findObject,
  normalizeModel,
  validateProjectModel,
} from "../../project-model/runtime/model.ts";
import { SpecProjector } from "../../project-model/runtime/projector.ts";
import type { ProjectModel } from "../../project-model/runtime/types.ts";

const root = resolve(import.meta.dirname!, "../..");
const load = async (): Promise<ProjectModel> =>
  JSON.parse(await Deno.readTextFile(join(root, "project-model/model.json")));

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) Object.assign(result, await snapshot(path));
    else result[path] = await Deno.readTextFile(path);
  }
  return result;
}

Deno.test("model check preserves every authority and projection byte", async () => {
  const before = {
    ...await snapshot(join(root, "project-model")),
    ...await snapshot(join(root, "spec")),
  };
  assert.equal(await checkProjectModel(root), 62);
  assert.deepEqual({
    ...await snapshot(join(root, "project-model")),
    ...await snapshot(join(root, "spec")),
  }, before);
});

Deno.test("canonical dependent identity retains newer authority and historical evidence", async () => {
  const model = await load();
  assert.equal(model.project.mode, "authoritative");
  const object = (id: string) => {
    const found = findObject(model, id);
    assert.ok(found, id);
    return found.object;
  };
  for (
    const id of [
      "Q-projects-timesheet-name",
      "DISC-timesheet-identity",
      "DEC-projects-timesheet-identity",
    ]
  ) {
    assert.ok(object(id).body.includes("optd/projects:timesheet"), id);
    assert.ok(
      !object(id).sourceRefs.some((ref) =>
        ref.includes("#operantprojectstimesheet")
      ),
      id,
    );
  }
  assert.match(
    object("DISC-crm-scope-stale").body,
    /historical migration evidence/,
  );
  assert.match(object("DISC-crm-scope-stale").body, /optd\/crm/);
  assert.match(object("WS-product").body, /optd/);
  assert.equal(object("DEC-optd-github-transfer").state, "superseded");
  assert.match(
    object("DEC-optd-identity-matrix").body,
    /created new and public/,
  );
  assert.match(
    object("DEC-optd-identity-matrix").body,
    /rather than transferred/,
  );
  const namespace = object("DEC-optd-api-namespace").body;
  assert.match(namespace, /optd\.dev\/v1/);
  assert.match(namespace, /pi-dag-workflow=b1c0895ca2a37f9b592044e84c7e75ad/);
  assert.match(namespace, /both authoritative nameservers/);
  assert.match(namespace, /at least two independent validating resolvers/);
  assert.match(
    object("PROP-optd-successor-public-release").body,
    /behind explicit later authority/,
  );
  assert.equal(object("Q-external-validation").state, "deferred");
  assert.match(
    object("INT-local-binding-boundary").body,
    /hardened local provider is deferred/,
  );
  const preserved = JSON.stringify(model);
  const normalized = normalizeModel(model);
  assert.equal(JSON.stringify(model), preserved);
  assert.deepEqual(normalizeModel(normalized), normalized);
  assert.deepEqual(validateProjectModel(normalized), []);
});

Deno.test("projection rendering is deterministic, nonmutating and matches frozen output", async () => {
  const model = await load();
  const before = JSON.stringify(model);
  const projector = new SpecProjector(root);
  const rendered = projector.render(normalizeModel(model));
  assert.deepEqual(projector.render(normalizeModel(model)), rendered);
  assert.equal(JSON.stringify(model), before);
  for (const file of rendered) {
    assert.equal(
      file.content,
      await Deno.readTextFile(join(root, file.path)),
      file.path,
    );
  }
});

Deno.test("schema rejects broken references, duplicate placement and unsafe paths", async () => {
  const original = await load();
  for (
    const corrupt of [
      (m: ProjectModel) => {
        m.decisions[0].relationships.push({
          kind: "depends_on",
          targetId: "DEC-missing",
        });
      },
      (m: ProjectModel) => {
        m.project.projections.specs[0].path = "../escape.md";
      },
      (m: ProjectModel) => {
        m.project.projections.specs.push(
          structuredClone(m.project.projections.specs[0]),
        );
      },
      (m: ProjectModel) => {
        m.schemaVersion = 99 as 1;
      },
    ]
  ) {
    const model = structuredClone(original);
    corrupt(model);
    assert.ok(validateProjectModel(model).length > 0);
  }
});

Deno.test("real checker rejects changed, missing, stale and symlinked projections without repairing", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-model-test-" });
  try {
    await Deno.mkdir(join(fixture, "project-model"));
    await Deno.copyFile(
      join(root, "project-model/model.json"),
      join(fixture, "project-model/model.json"),
    );
    const model = await load();
    const files = new SpecProjector(root).render(normalizeModel(model));
    for (const file of files) {
      const target = join(fixture, file.path);
      await Deno.mkdir(resolve(target, ".."), { recursive: true });
      await Deno.writeTextFile(target, file.content);
    }
    assert.equal(await checkProjectModel(fixture), files.length);
    const target = join(fixture, files[0].path);
    await Deno.writeTextFile(target, "deliberately stale\n");
    await assert.rejects(
      () => checkProjectModel(fixture),
      /Specification drift/,
    );
    assert.equal(await Deno.readTextFile(target), "deliberately stale\n");
    await Deno.remove(target);
    await assert.rejects(
      () => checkProjectModel(fixture),
      /Specification drift/,
    );
    await Deno.writeTextFile(target, files[0].content);
    const stale = join(fixture, "spec/stale.md");
    await Deno.writeTextFile(stale, files[0].content);
    await assert.rejects(
      () => checkProjectModel(fixture),
      /Stale generated specifications: spec\/stale.md/,
    );
    await Deno.remove(stale);
    await Deno.symlink(target, stale);
    await assert.rejects(() => checkProjectModel(fixture), /symlink/);
    await Deno.remove(stale);
    const changed = structuredClone(model);
    changed.decisions.find((o) => o.id === "DEC-optd-identity-matrix")!.body +=
      "\nChanged authority fixture.";
    await Deno.writeTextFile(
      join(fixture, "project-model/model.json"),
      JSON.stringify(changed),
    );
    await assert.rejects(
      () => checkProjectModel(fixture),
      /Specification drift/,
    );
    await Deno.writeTextFile(join(fixture, "project-model/model.json"), "null");
    await assert.rejects(() => checkProjectModel(fixture));
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
