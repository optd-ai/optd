import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  pendingPoints,
  validateModelReviews,
  validateOperationScope,
} from "./reviews.ts";
import {
  type ModelCollectionName,
  type ModelObject,
  type ObjectType,
  PROJECT_MODEL_SCHEMA_VERSION,
  type ProjectModel,
} from "./types.ts";

export const MODEL_COLLECTIONS = [
  "workstreams",
  "intents",
  "concepts",
  "evidence",
  "assumptions",
  "questions",
  "tensions",
  "scenarios",
  "proposals",
  "decisions",
  "commitments",
  "discoveries",
] as const satisfies readonly ModelCollectionName[];

export const COLLECTION_TYPE: Record<ModelCollectionName, ObjectType> = {
  workstreams: "workstream",
  intents: "intent",
  concepts: "concept",
  evidence: "evidence",
  assumptions: "assumption",
  questions: "question",
  tensions: "tension",
  scenarios: "scenario",
  proposals: "proposal",
  decisions: "decision",
  commitments: "commitment",
  discoveries: "discovery",
};

export const TYPE_COLLECTION = Object.fromEntries(
  Object.entries(COLLECTION_TYPE).map((
    [collection, type],
  ) => [type, collection]),
) as Record<ObjectType, ModelCollectionName>;

const ID_PREFIX: Record<ModelCollectionName, string> = {
  workstreams: "WS",
  intents: "INT",
  concepts: "CON",
  evidence: "EV",
  assumptions: "ASM",
  questions: "Q",
  tensions: "TEN",
  scenarios: "SCN",
  proposals: "PROP",
  decisions: "DEC",
  commitments: "COM",
  discoveries: "DISC",
};

const ALLOWED_STATES: Record<ModelCollectionName, ReadonlySet<string>> = {
  workstreams: new Set(["active", "deferred", "closed"]),
  intents: new Set(["proposed", "accepted", "superseded", "retired"]),
  concepts: new Set([
    "proposed",
    "accepted",
    "disputed",
    "superseded",
    "retired",
  ]),
  evidence: new Set(["current", "stale", "invalidated"]),
  assumptions: new Set([
    "open",
    "supported",
    "challenged",
    "invalidated",
    "retired",
  ]),
  questions: new Set(["open", "answered", "deferred", "obsolete"]),
  tensions: new Set(["active", "resolved", "deferred", "retired"]),
  scenarios: new Set([
    "proposed",
    "accepted",
    "invalidated",
    "superseded",
    "retired",
  ]),
  proposals: new Set([
    "candidate",
    "recommended",
    "selected",
    "rejected",
    "withdrawn",
    "superseded",
  ]),
  decisions: new Set([
    "candidate",
    "accepted",
    "suspended",
    "superseded",
    "retired",
  ]),
  commitments: new Set([
    "proposed",
    "not_reviewed",
    "accepted",
    "rejected",
    "suspended",
    "superseded",
    "retired",
  ]),
  discoveries: new Set([
    "untriaged",
    "investigating",
    "integrated",
    "dismissed",
    "deferred",
  ]),
};

const GOVERNING_STATES: Partial<
  Record<ModelCollectionName, ReadonlySet<string>>
> = {
  intents: new Set(["accepted", "superseded", "retired"]),
  concepts: new Set(["accepted", "superseded", "retired"]),
  scenarios: new Set(["accepted", "superseded", "retired"]),
  decisions: new Set(["accepted", "suspended", "superseded", "retired"]),
  commitments: new Set(["accepted", "suspended", "superseded", "retired"]),
};

export function allObjects(
  model: ProjectModel,
): Array<
  { collection: ModelCollectionName; type: ObjectType; object: ModelObject }
> {
  return MODEL_COLLECTIONS.flatMap((collection) =>
    (model[collection] as ModelObject[]).map((object) => ({
      collection,
      type: COLLECTION_TYPE[collection],
      object,
    }))
  );
}

export function findObject(
  model: ProjectModel,
  id: string,
):
  | { collection: ModelCollectionName; type: ObjectType; object: ModelObject }
  | undefined {
  for (const collection of MODEL_COLLECTIONS) {
    const object = (model[collection] as ModelObject[]).find((candidate) =>
      candidate.id === id
    );
    if (object) {
      return { collection, type: COLLECTION_TYPE[collection], object };
    }
  }
  return undefined;
}

export function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item)) as T;
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) sorted[key] = canonicalize(item);
    }
    return sorted as T;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
  return `sha256:${
    createHash("sha256").update(
      typeof value === "string" ? value : canonicalStringify(value),
    ).digest("hex")
  }`;
}

function normalizeObject(input: ModelObject): ModelObject {
  const object = structuredClone(input);
  if (Array.isArray(object.sourceRefs)) {
    object.sourceRefs = [...new Set(object.sourceRefs)].sort();
  }
  if (
    Array.isArray(object.relationships) &&
    object.relationships.every((relation) =>
      relation && typeof relation.kind === "string" &&
      typeof relation.targetId === "string"
    )
  ) {
    object.relationships = [...object.relationships].sort((a, b) =>
      a.kind.localeCompare(b.kind) || a.targetId.localeCompare(b.targetId) ||
      (a.note ?? "").localeCompare(b.note ?? "")
    );
  }
  if (
    object.scope?.kind === "workstreams" &&
    Array.isArray(object.scope.workstreamIds)
  ) {
    object.scope.workstreamIds = [...new Set(object.scope.workstreamIds)]
      .sort();
  }
  if (Array.isArray(object.legacyIds)) {
    object.legacyIds = [...new Set(object.legacyIds)].sort();
  }
  return object;
}

export function normalizeModel(input: ProjectModel): ProjectModel {
  const model = structuredClone(input);
  for (const collection of MODEL_COLLECTIONS) {
    const values = model[collection] as ModelObject[];
    for (let index = 0; index < values.length; index++) {
      values[index] = normalizeObject(values[index]);
    }
    values.sort((a, b) => a.id.localeCompare(b.id));
  }
  model.project.projections.specs.sort((a, b) =>
    a.path.localeCompare(b.path) || a.id.localeCompare(b.id)
  );
  if (model.project.migration) {
    if (Array.isArray(model.project.migration.sources)) {
      model.project.migration.sources.sort((a, b) =>
        String(a?.path).localeCompare(String(b?.path))
      );
    }
    if (Array.isArray(model.project.migration.artifacts)) {
      model.project.migration.artifacts.sort((a, b) =>
        String(a?.path).localeCompare(String(b?.path))
      );
    }
    if (Array.isArray(model.project.migration.blockers)) {
      model.project.migration.blockers = [
        ...new Set(model.project.migration.blockers),
      ].sort();
    }
  }
  return canonicalize(model);
}

function hasAcceptedSpecAuthority(
  collection: ModelCollectionName,
  object: ModelObject,
): boolean {
  if (
    collection === "intents" || collection === "concepts" ||
    collection === "scenarios"
  ) return object.state === "accepted";
  if (collection === "decisions") return object.state === "accepted";
  if (collection === "commitments") return object.state === "accepted";
  return false;
}

export function specEligibleObjectIds(model: ProjectModel): Set<string> {
  const accepted = allObjects(model).filter(({ collection, object }) =>
    hasAcceptedSpecAuthority(collection, object)
  );
  const superseded = new Set(
    accepted.flatMap(({ object }) =>
      (Array.isArray(object.relationships) ? object.relationships : [])
        .filter((relationship) => relationship?.kind === "supersedes")
        .map(({ targetId }) => targetId)
    ),
  );
  return new Set(
    accepted.filter(({ object }) => !superseded.has(object.id)).map((
      { object },
    ) => object.id),
  );
}

export function activeReconsiderationIds(
  model: ProjectModel,
  targetId: string,
): string[] {
  return model.questions
    .filter((question) =>
      question.kind === "reconsideration" && question.state === "open"
    )
    .filter((question) =>
      question.relationships.some((relationship) =>
        relationship.kind === "challenges" && relationship.targetId === targetId
      )
    )
    .map(({ id }) => id)
    .sort();
}

export function validateProjectModel(model: ProjectModel): string[] {
  const errors: string[] = [];
  if (!model || typeof model !== "object") {
    return ["project model must be an object"];
  }
  if (model.schemaVersion !== PROJECT_MODEL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PROJECT_MODEL_SCHEMA_VERSION}`);
  }
  if (typeof model.project?.id !== "string" || !model.project.id.trim()) {
    errors.push("project.id is required");
  }
  if (typeof model.project?.title !== "string" || !model.project.title.trim()) {
    errors.push("project.title is required");
  }
  if (
    !Number.isInteger(model.project?.revision) || model.project.revision < 0
  ) errors.push("project.revision must be a non-negative integer");
  if (!new Set(["candidate", "authoritative"]).has(model.project?.mode)) {
    errors.push("project.mode is invalid");
  }
  if (!Array.isArray(model.project?.projections?.specs)) {
    errors.push("project.projections.specs must be an array");
  }
  validateMigrationMetadata(model.project?.migration, errors);

  const seenIds = new Set<string>();
  const objectById = new Map<
    string,
    { collection: ModelCollectionName; object: ModelObject }
  >();
  for (const collection of MODEL_COLLECTIONS) {
    const values = model[collection];
    if (!Array.isArray(values)) {
      errors.push(`${collection} must be an array`);
      continue;
    }
    for (const object of values as ModelObject[]) {
      const label = `${collection}.${object?.id ?? "?"}`;
      if (typeof object?.id !== "string" || !object.id.trim()) {
        errors.push(`${label}.id is required`);
      } else if (seenIds.has(object.id)) {
        errors.push(`duplicate object id ${object.id}`);
      } else {
        seenIds.add(object.id);
        objectById.set(object.id, { collection, object });
      }
      if (
        typeof object?.id !== "string" ||
        !object.id.startsWith(`${ID_PREFIX[collection]}-`)
      ) errors.push(`${label}.id must start with ${ID_PREFIX[collection]}-`);
      if (typeof object?.title !== "string" || !object.title.trim()) {
        errors.push(`${label}.title is required`);
      }
      if (typeof object?.body !== "string" || !object.body.trim()) {
        errors.push(`${label}.body is required`);
      }
      if (!ALLOWED_STATES[collection].has(object?.state)) {
        errors.push(`${label}.state is invalid: ${object?.state}`);
      }
      if (
        !object?.scope ||
        !new Set(["repository", "workstreams"]).has(object.scope.kind)
      ) errors.push(`${label}.scope is invalid`);
      if (
        object?.scope?.kind === "workstreams" &&
        (!Array.isArray(object.scope.workstreamIds) ||
          !object.scope.workstreamIds.length ||
          object.scope.workstreamIds.some((id) => typeof id !== "string"))
      ) {
        errors.push(
          `${label}.scope.workstreamIds must be a non-empty string array`,
        );
      }
      if (
        !Array.isArray(object?.sourceRefs) ||
        object.sourceRefs.some((ref) => typeof ref !== "string")
      ) errors.push(`${label}.sourceRefs must be a string array`);
      if (!Array.isArray(object?.relationships)) {
        errors.push(`${label}.relationships must be an array`);
      }
      if (
        !new Set([
          "user",
          "agent",
          "repository",
          "external",
          "prototype",
          "migration",
          "execution",
        ]).has(object?.introducedBy)
      ) errors.push(`${label}.introducedBy is invalid`);
      if (
        object?.confidence !== undefined &&
        !new Set(["low", "medium", "high"]).has(object.confidence)
      ) errors.push(`${label}.confidence is invalid`);
      if (!validIso(object?.createdAt) || !validIso(object?.updatedAt)) {
        errors.push(`${label} timestamps must be ISO dates`);
      }
      if (object?.acceptance) {
        validateAcceptance(collection, object, label, errors);
      }
    }
  }

  for (const { collection, object } of objectById.values()) {
    const label = `${collection}.${object.id}`;
    for (
      const relationship of Array.isArray(object.relationships)
        ? object.relationships
        : []
    ) {
      if (!relationship || typeof relationship !== "object") {
        errors.push(`${label} relationship must be an object`);
        continue;
      }
      if (
        !new Set([
          "supports",
          "challenges",
          "depends_on",
          "addresses",
          "derived_from",
          "supersedes",
          "affects",
          "related_to",
        ]).has(relationship.kind)
      ) {
        errors.push(
          `${label} has invalid relationship kind ${relationship.kind}`,
        );
      }
      if (!objectById.has(relationship.targetId)) {
        errors.push(
          `${label} references missing relationship target ${relationship.targetId}`,
        );
      }
      if (
        relationship.targetId === object.id &&
        relationship.kind === "supersedes"
      ) errors.push(`${label} cannot supersede itself`);
    }
    if (
      object.scope?.kind === "workstreams" &&
      Array.isArray(object.scope.workstreamIds)
    ) {
      for (const id of object.scope.workstreamIds) {
        if (
          !Array.isArray(model.workstreams) ||
          !model.workstreams.some((workstream) => workstream?.id === id)
        ) errors.push(`${label} references missing workstream ${id}`);
      }
    }
    validateCollectionShape(collection, object, label, objectById, errors);
    if (collection === "tensions") {
      const tension = object as ProjectModel["tensions"][number];
      if (
        !Array.isArray(tension.poleObjectIds) ||
        tension.poleObjectIds.length < 2
      ) errors.push(`${label}.poleObjectIds requires at least two objects`);
      for (
        const id of Array.isArray(tension.poleObjectIds)
          ? tension.poleObjectIds
          : []
      ) {
        if (!objectById.has(id)) {
          errors.push(`${label} references missing pole ${id}`);
        }
      }
    }
    if (collection === "questions") {
      const question = object as ProjectModel["questions"][number];
      if (["contradiction", "tradeoff"].includes(question.kind)) {
        const challenged =
          (Array.isArray(question.relationships) ? question.relationships : [])
            .filter((relationship) => relationship?.kind === "challenges");
        if (challenged.length < 2) {
          errors.push(
            `${label} ${question.kind} requires at least two challenges relationships`,
          );
        }
      }
      if (
        question.kind === "reconsideration" &&
        !(Array.isArray(question.relationships) ? question.relationships : [])
          .some((relationship) => relationship?.kind === "challenges")
      ) {
        errors.push(
          `${label} reconsideration requires a challenges relationship`,
        );
      }
    }
  }

  if (
    !validIso(model.project?.createdAt) || !validIso(model.project?.updatedAt)
  ) errors.push("project timestamps must be ISO dates");
  validateSupersessionCycles(objectById, errors);
  validateProjections(model, objectById, errors);
  validateCurrentUnderstanding(model, objectById, errors);
  validateModelReviews(model.project?.reviews, errors, ALLOWED_STATES);
  if (!errors.length) {
    for (const review of model.project.reviews ?? []) {
      if (review.status !== "pending") continue;
      try {
        validateOperationScope(model, review.scope);
      } catch (error) {
        errors.push(`${review.id}: ${String(error)}`);
      }
      for (const point of pendingPoints(review)) {
        for (
          const id of [
            ...point.objectRefs.map((ref) => ref.id),
            ...point.options.flatMap((option) =>
              option.objectId ? [option.objectId] : []
            ),
          ]
        ) {
          if (!objectById.has(id)) {
            errors.push(`${review.id}/${point.id}: missing subject ${id}`);
          }
        }
        for (
          const direction of [
            ...point.options.map((option) => option.direction),
            point.rejectDirection,
            point.deferDirection,
          ].filter(Boolean)
        ) {
          // Pending alternatives retain references, not a veto over later canonical direction.
          const target = direction!.id
            ? objectById.get(direction!.id)
            : undefined;
          if (
            direction!.id &&
            (!target || target.collection !== direction!.collection)
          ) {
            errors.push(
              `${review.id}: missing direction target ${direction!.id}`,
            );
          }
          for (const ref of direction!.value?.relationships ?? []) {
            if (
              !objectById.has(ref.targetId) && ref.targetId !== direction!.newId
            ) {
              errors.push(
                `${review.id}: missing direction relationship target ${ref.targetId}`,
              );
            }
          }
          for (
            const field of [
              "answerObjectIds",
              "poleObjectIds",
              "resolutionObjectIds",
              "selectedProposalIds",
              "resolvesQuestionIds",
            ]
          ) {
            for (const id of (direction!.value?.[field] ?? []) as string[]) {
              if (!objectById.has(id) && id !== direction!.newId) {
                errors.push(
                  `${review.id}: missing direction ${field} reference ${id}`,
                );
              }
            }
          }
          if (direction!.value?.scope?.kind === "workstreams") {
            for (const id of direction!.value.scope.workstreamIds) {
              if (
                !model.workstreams.some((object) => object.id === id)
              ) {
                errors.push(`${review.id}: missing direction workstream ${id}`);
              }
            }
          }
        }
      }
    }
  }
  return errors;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validateAcceptance(
  collection: ModelCollectionName,
  object: ModelObject,
  label: string,
  errors: string[],
) {
  const receipt = object.acceptance!;
  if (!GOVERNING_STATES[collection]) {
    errors.push(`${label} cannot carry an acceptance receipt`);
  }
  if (
    !new Set(["direct_direction", "accepted_existing", "migration_cutover"])
      .has(receipt.mode)
  ) errors.push(`${label}.acceptance.mode is invalid`);
  if (receipt.actor !== "user") {
    errors.push(`${label}.acceptance.actor must be user`);
  }
  if (!validIso(receipt.acceptedAt)) {
    errors.push(`${label}.acceptance.acceptedAt must be an ISO date`);
  }
  if (receipt.interactionRef !== undefined && !receipt.interactionRef.trim()) {
    errors.push(`${label}.acceptance.interactionRef must be non-empty`);
  }
  if (receipt.batchRef !== undefined && !receipt.batchRef.trim()) {
    errors.push(`${label}.acceptance.batchRef must be non-empty`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(receipt.contentHash)) {
    errors.push(`${label}.acceptance.contentHash is invalid`);
  }
}

function validateCollectionShape(
  collection: ModelCollectionName,
  object: ModelObject,
  label: string,
  objectById: Map<
    string,
    { collection: ModelCollectionName; object: ModelObject }
  >,
  errors: string[],
) {
  const requireEnum = (field: string, values: string[]) => {
    const value = (object as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string" || !values.includes(value)) {
      errors.push(`${label}.${field} is invalid`);
    }
  };
  if (collection === "intents") {
    requireEnum("kind", [
      "outcome",
      "priority",
      "value",
      "success_signal",
      "non_goal",
    ]);
  }
  if (collection === "questions") {
    requireEnum("kind", [
      "uncertainty",
      "tradeoff",
      "contradiction",
      "reconsideration",
    ]);
  }
  if (collection === "scenarios") {
    requireEnum("kind", [
      "ordinary",
      "boundary",
      "failure",
      "tradeoff",
      "surprising",
    ]);
  }
  if (
    collection === "tensions" &&
    !Array.isArray((object as ProjectModel["tensions"][number]).poleObjectIds)
  ) errors.push(`${label}.poleObjectIds must be an array`);
  for (
    const relationship of Array.isArray(object.relationships)
      ? object.relationships
      : []
  ) {
    if (!relationship || typeof relationship !== "object") continue;
    if (
      typeof relationship.targetId !== "string" || !relationship.targetId.trim()
    ) errors.push(`${label} relationship targetId is required`);
    if (
      relationship?.note !== undefined && typeof relationship.note !== "string"
    ) errors.push(`${label} relationship note must be a string`);
  }
  const referenceFields = [
    "answerObjectIds",
    "poleObjectIds",
    "resolutionObjectIds",
    "selectedProposalIds",
    "resolvesQuestionIds",
  ];
  for (const field of referenceFields) {
    const value = (object as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      errors.push(`${label}.${field} must be a string array`);
    } else {for (const id of value) {
        if (!objectById.has(id)) {
          errors.push(`${label}.${field} references missing object ${id}`);
        }
      }}
  }
}

function validateSupersessionCycles(
  objectById: Map<
    string,
    { collection: ModelCollectionName; object: ModelObject }
  >,
  errors: string[],
) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const found = objectById.get(id);
    for (
      const relation of Array.isArray(found?.object.relationships)
        ? found.object.relationships
        : []
    ) {
      if (
        relation?.kind === "supersedes" && visit(relation.targetId)
      ) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of objectById.keys()) {
    if (visit(id)) {
      errors.push(`supersession cycle includes ${id}`);
      break;
    }
  }
}

function validateProjections(
  model: ProjectModel,
  objectById: Map<
    string,
    { collection: ModelCollectionName; object: ModelObject }
  >,
  errors: string[],
) {
  const rawViews = model.project?.projections?.specs;
  const views = Array.isArray(rawViews) ? rawViews : [];
  const viewIds = new Set<string>();
  const paths = new Set<string>();
  const placed = new Map<string, string>();
  for (const view of views) {
    if (!view || typeof view !== "object") {
      errors.push("projection must be an object");
      continue;
    }
    const label = `projection.${String(view.id ?? "?")}`;
    if (typeof view.id !== "string" || !view.id.trim()) {
      errors.push("projection id is required");
    } else if (viewIds.has(view.id)) {
      errors.push(`duplicate projection id ${view.id}`);
    } else viewIds.add(view.id);
    if (!new Set(["spec", "index", "prototype_index"]).has(view.kind)) {
      errors.push(`${label}.kind is invalid`);
    }
    if (!validSpecPath(view.path)) {
      errors.push(`${label}.path must be a safe Markdown path under spec/`);
    } else if (paths.has(view.path)) {
      errors.push(`duplicate projection path ${view.path}`);
    } else paths.add(view.path);
    if (typeof view.title !== "string" || !view.title.trim()) {
      errors.push(`${label}.title is required`);
    }

    const sections = view.sections === undefined
      ? []
      : Array.isArray(view.sections)
      ? view.sections
      : (errors.push(`${label}.sections must be an array`), []);
    const sectionIds = new Set<string>();
    for (const section of sections) {
      if (!section || typeof section !== "object") {
        errors.push(`${label} section must be an object`);
        continue;
      }
      if (
        typeof section.id !== "string" || !section.id.trim() ||
        typeof section.title !== "string" || !section.title.trim()
      ) errors.push(`${label} section id/title is required`);
      else if (sectionIds.has(section.id)) {
        errors.push(`${label} has duplicate section ${section.id}`);
      } else sectionIds.add(section.id);
      if (
        !Array.isArray(section.objectIds) ||
        section.objectIds.some((id: unknown) => typeof id !== "string")
      ) {
        errors.push(
          `${label}.${section.id ?? "?"}.objectIds must be a string array`,
        );
        continue;
      }
      for (const id of section.objectIds) {
        if (!objectById.has(id)) {
          errors.push(`${label} references missing object ${id}`);
        }
        if (placed.has(id)) {
          errors.push(
            `${id} has multiple canonical placements: ${
              placed.get(id)
            }, ${view.path}`,
          );
        } else placed.set(id, view.path);
      }
    }
    const childIds = view.childViewIds === undefined
      ? []
      : Array.isArray(view.childViewIds)
      ? view.childViewIds
      : (errors.push(`${label}.childViewIds must be an array`), []);
    for (const id of childIds) {
      if (typeof id !== "string") {
        errors.push(`${label}.childViewIds must contain strings`);
      } else if (!views.some((candidate) => candidate?.id === id)) {
        errors.push(`${label} references missing child view ${id}`);
      }
    }
    const links = view.manualLinks === undefined
      ? []
      : Array.isArray(view.manualLinks)
      ? view.manualLinks
      : (errors.push(`${label}.manualLinks must be an array`), []);
    for (const link of links) {
      if (
        !link || typeof link !== "object" || !validSpecPath(link.path, true)
      ) {
        errors.push(
          `${label} manual link must be a safe Markdown path under spec/: ${
            String(link?.path)
          }`,
        );
      }
      if (typeof link?.title !== "string" || !link.title.trim()) {
        errors.push(`${label} manual link title is required`);
      }
    }
  }
  if (model.project?.mode === "authoritative") {
    let eligibleIds: Set<string>;
    try {
      eligibleIds = specEligibleObjectIds(model);
    } catch {
      for (const id of objectById.keys()) {
        errors.push(`${id} cannot be evaluated for projection eligibility`);
      }
      return;
    }
    for (const id of eligibleIds) {
      if (!placed.has(id)) {
        errors.push(`${id} has no canonical generated-spec placement`);
      }
    }
  }
}

function validateCurrentUnderstanding(
  model: ProjectModel,
  objectById: Map<
    string,
    { collection: ModelCollectionName; object: ModelObject }
  >,
  errors: string[],
) {
  const understanding = model.project?.currentUnderstanding;
  if (!understanding) return;
  if (typeof understanding.body !== "string" || !understanding.body.trim()) {
    errors.push("project.currentUnderstanding.body is required");
  }
  if (!validIso(understanding.generatedAt)) {
    errors.push("project.currentUnderstanding.generatedAt must be an ISO date");
  }
  const sources = Array.isArray(understanding.sourceObjects)
    ? understanding.sourceObjects
    : (errors.push(
      "project.currentUnderstanding.sourceObjects must be an array",
    ),
      []);
  for (const source of sources) {
    if (
      !source || typeof source.id !== "string" ||
      (source.semanticHash !== undefined &&
        typeof source.semanticHash !== "string")
    ) {
      errors.push("currentUnderstanding source is invalid");
      continue;
    }
    const found = objectById.get(source.id);
    if (!found) {
      errors.push(
        `currentUnderstanding references missing object ${source.id}`,
      );
    }
  }
}

function validateMigrationMetadata(
  migration: ProjectModel["project"]["migration"],
  errors: string[],
) {
  if (migration === undefined) return;
  if (migration?.schemaVersion !== 1) {
    errors.push("project.migration.schemaVersion must be 1");
  }
  if (
    migration?.focusId !== undefined &&
    (typeof migration.focusId !== "string" ||
      !migration.focusId.startsWith("focus-"))
  ) errors.push("project.migration.focusId must start with focus-");
  if (!new Set(["inventory", "draft", "ready"]).has(migration?.phase)) {
    errors.push("project.migration.phase is invalid");
  }
  if (!validIso(migration?.updatedAt)) {
    errors.push("project.migration.updatedAt must be an ISO date");
  }
  if (!Array.isArray(migration?.sources)) {
    errors.push("project.migration.sources must be an array");
  }
  if (!Array.isArray(migration?.artifacts)) {
    errors.push("project.migration.artifacts must be an array");
  }
  if (
    !Array.isArray(migration?.blockers) ||
    !migration.blockers.every((value) =>
      typeof value === "string" && value.trim()
    )
  ) errors.push("project.migration.blockers must contain non-empty strings");
  const sourcePaths = new Set<string>();
  for (const [index, source] of (migration?.sources ?? []).entries()) {
    const label = `project.migration.sources[${index}]`;
    validateMigrationPath(source?.path, `${label}.path`, sourcePaths, errors);
    if (typeof source?.kind !== "string" || !source.kind.trim()) {
      errors.push(`${label}.kind is required`);
    }
    if (
      !new Set(["unreviewed", "mapped", "retained", "omitted"]).has(
        source?.disposition,
      )
    ) errors.push(`${label}.disposition is invalid`);
    if (!validSha256(source?.observedHash)) {
      errors.push(`${label}.observedHash is invalid`);
    }
  }
  const artifactPaths = new Set<string>();
  for (const [index, artifact] of (migration?.artifacts ?? []).entries()) {
    const label = `project.migration.artifacts[${index}]`;
    validateMigrationPath(
      artifact?.path,
      `${label}.path`,
      artifactPaths,
      errors,
    );
    if (
      !new Set([
        "unresolved",
        "create_generated",
        "replace_generated",
        "retain_reference",
        "retain_evidence",
        "block",
      ]).has(artifact?.disposition)
    ) errors.push(`${label}.disposition is invalid`);
    if (
      artifact?.observedHash !== null && !validSha256(artifact?.observedHash)
    ) errors.push(`${label}.observedHash is invalid`);
    if (
      artifact?.generatedHash !== undefined &&
      !validSha256(artifact.generatedHash)
    ) errors.push(`${label}.generatedHash is invalid`);
  }
}

function validateMigrationPath(
  value: unknown,
  label: string,
  seen: Set<string>,
  errors: string[],
) {
  if (typeof value !== "string") {
    errors.push(`${label} is unsafe`);
    return;
  }
  const normalized = posix.normalize(
    value.replaceAll("\\", "/").replace(/^\.\//, ""),
  );
  if (
    !normalized || normalized === "." || normalized !== value ||
    normalized.startsWith("../") || normalized.startsWith("/")
  ) errors.push(`${label} is unsafe`);
  if (seen.has(normalized)) errors.push(`${label} is duplicated`);
  seen.add(normalized);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validSpecPath(path: string, allowPrototypeContent = false): boolean {
  if (
    typeof path !== "string" || !path.startsWith("spec/") ||
    !path.endsWith(".md")
  ) return false;
  const normalized = posix.normalize(path);
  if (
    normalized !== path || normalized.includes("../") ||
    normalized.startsWith("/")
  ) return false;
  return allowPrototypeContent || !normalized.startsWith("spec/prototypes/") ||
    normalized === "spec/prototypes/spec.md";
}
