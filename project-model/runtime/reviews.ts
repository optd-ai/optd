import type {
  ModelOperationScope,
  ModelReview,
  ProjectModel,
} from "./types.ts";

export function pendingPoints(review: ModelReview) {
  const resolved = new Set(review.outcomes.map(({ pointId }) => pointId));
  return review.points.filter(({ id }) => !resolved.has(id));
}

export function validateOperationScope(
  model: ProjectModel,
  scope: ModelOperationScope,
): void {
  if (
    !scope || !Array.isArray(scope.workstreamIds) ||
    scope.workstreamIds.some((id) => typeof id !== "string")
  ) {
    throw new Error(
      "Explicit workstreamIds scope is required; [] means repository scope",
    );
  }
  for (const id of scope.workstreamIds) {
    if (!model.workstreams.some((object) => object.id === id)) {
      throw new Error(`Unknown workstream: ${id}`);
    }
  }
  if (
    scope.objectIds !== undefined &&
    (!Array.isArray(scope.objectIds) ||
      scope.objectIds.some((id) => typeof id !== "string"))
  ) throw new Error("scope.objectIds must be a string array");
  const ids = new Set(
    Object.values(model).filter(Array.isArray).flat().map((
      object: { id: string },
    ) => object.id),
  );
  for (const id of scope.objectIds ?? []) {
    if (!ids.has(id)) throw new Error(`Unknown scope object: ${id}`);
  }
}

// Historical inputs may be partial patches and refer to objects no longer present.
// Validate their structure without replaying them into today's canonical model.
function validDirection(
  direction: unknown,
  states: Record<string, ReadonlySet<string>>,
  materialized = false,
): boolean {
  const text = (v: unknown) => typeof v === "string" && Boolean(v.trim());
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s: unknown) => typeof s === "string");
  if (
    !record(direction) || typeof direction.collection !== "string" ||
    !["intents", "concepts", "scenarios", "decisions", "commitments"].includes(
      direction.collection,
    )
  ) return false;
  if (
    ["id", "newId", "key"].some((k) =>
      direction[k] !== undefined && !text(direction[k])
    ) || (direction.id !== undefined && direction.newId !== undefined)
  ) return false;
  const prefixes: Record<string, string> = {
    intents: "INT-",
    concepts: "CON-",
    scenarios: "SCN-",
    decisions: "DEC-",
    commitments: "COM-",
  };
  if (
    [direction.id, direction.newId].some((id) =>
      id !== undefined &&
      !(id as string).startsWith(prefixes[direction.collection as string])
    )
  ) return false;
  if (
    direction.state !== undefined &&
    !states[direction.collection]?.has(direction.state as string)
  ) return false;
  if (
    materialized &&
    (Boolean(direction.id) === Boolean(direction.newId) ||
      direction.state === undefined)
  ) return false;
  const value = direction.value;
  if (value === undefined) return !materialized && Boolean(direction.id);
  if (!record(value)) return false;
  if (
    materialized &&
    ["title", "body", "scope", "sourceRefs", "relationships"].some((k) =>
      value[k] === undefined
    )
  ) return false;
  if (!direction.id && (!text(value.title) || !text(value.body))) return false;
  if (
    ["title", "body"].some((k) => value[k] !== undefined && !text(value[k]))
  ) return false;
  if (
    ["id", "acceptance", "introducedBy", "createdAt", "updatedAt"].some((k) =>
      k in value
    )
  ) return false;
  if (
    value.state !== undefined &&
    !states[direction.collection]?.has(value.state as string)
  ) return false;
  if (
    value.scope !== undefined &&
    (!record(value.scope) ||
      !["repository", "workstreams"].includes(value.scope.kind as string) ||
      (value.scope.kind === "workstreams" &&
        (!strings(value.scope.workstreamIds) ||
          !value.scope.workstreamIds.length ||
          !value.scope.workstreamIds.every(text))))
  ) return false;
  if (
    [
      "sourceRefs",
      "legacyIds",
      "aliases",
      "examples",
      "counterexamples",
      "answerObjectIds",
      "poleObjectIds",
      "resolutionObjectIds",
      "selectedProposalIds",
      "resolvesQuestionIds",
    ].some((k) => value[k] !== undefined && !strings(value[k]))
  ) return false;
  if (
    ["rationale", "context", "action", "expectedOutcome"].some((k) =>
      value[k] !== undefined && typeof value[k] !== "string"
    )
  ) return false;
  if (
    value.confidence !== undefined &&
    !["low", "medium", "high"].includes(value.confidence as string)
  ) return false;
  const kinds: Record<string, string[]> = {
    intents: ["outcome", "priority", "value", "success_signal", "non_goal"],
    scenarios: ["ordinary", "boundary", "failure", "tradeoff", "surprising"],
  };
  if (
    kinds[direction.collection] &&
    ((materialized || !direction.id || value.kind !== undefined) &&
      !kinds[direction.collection].includes(value.kind as string))
  ) return false;
  if (
    value.relationships !== undefined &&
    (!Array.isArray(value.relationships) ||
      value.relationships.some((r: unknown) =>
        !record(r) ||
        ![
          "supports",
          "challenges",
          "depends_on",
          "addresses",
          "derived_from",
          "supersedes",
          "affects",
          "related_to",
        ].includes(r.kind as string) || !text(r.targetId) ||
        (r.note !== undefined && typeof r.note !== "string")
      ))
  ) return false;
  return true;
}

export function validateModelReviews(
  reviews: ProjectModel["project"]["reviews"],
  errors: string[],
  states: Record<string, ReadonlySet<string>>,
): void {
  if (reviews === undefined) return;
  if (!Array.isArray(reviews)) {
    errors.push("project.reviews must be an array");
    return;
  }
  const ids = new Set<string>();
  const text = (value: unknown): value is string =>
    typeof value === "string" && Boolean(value.trim());
  for (const review of reviews) {
    if (
      !review || !text(review.id) || !/^review-[a-z0-9-]+$/.test(review.id) ||
      ids.has(review.id)
    ) {
      errors.push("Invalid or duplicate review id");
      continue;
    }
    ids.add(review.id);
    const error = (message: string) => errors.push(`${review.id}: ${message}`);
    if (
      !text(review.title) || !text(review.createdAt) ||
      Number.isNaN(Date.parse(review.createdAt))
    ) error("title/createdAt is invalid");
    if (
      !Number.isSafeInteger(review.revision) || review.revision < 0 ||
      !Number.isSafeInteger(review.modelRevision) || review.modelRevision < 0
    ) error("revision is invalid");
    if (!["pending", "resolved"].includes(review.status)) {
      error("status is invalid");
    }
    if (
      !Array.isArray(review.scope?.workstreamIds) ||
      review.scope.workstreamIds.some((id) => !text(id))
    ) error("workstream scope is invalid");
    if (
      review.scope?.objectIds !== undefined &&
      (!Array.isArray(review.scope.objectIds) ||
        review.scope.objectIds.some((id) => !text(id)))
    ) error("object scope is invalid");
    if (
      !Array.isArray(review.points) || !review.points.length ||
      !Array.isArray(review.outcomes)
    ) {
      error("points/outcomes are invalid");
      continue;
    }
    const points = new Set<string>();
    for (const point of review.points) {
      if (!point || !text(point.id) || points.has(point.id)) {
        error("invalid or duplicate point");
        continue;
      }
      points.add(point.id);
      if (
        !text(point.title) || !text(point.context) ||
        !["decision", "awareness"].includes(point.purpose)
      ) error(`invalid point ${point.id}`);
      if (
        !Array.isArray(point.objectRefs) ||
        point.objectRefs.some((ref) => !text(ref?.id))
      ) error(`invalid object refs ${point.id}`);
      if (!Array.isArray(point.options)) {
        error(`invalid options ${point.id}`);
        continue;
      }
      if (
        point.purpose === "decision" &&
        (!text(point.question) || !point.options.length)
      ) error(`decision requires question/options ${point.id}`);
      const options = new Set<string>();
      for (const option of point.options) {
        if (
          !option || !text(option.id) || options.has(option.id) ||
          !text(option.label) || !text(option.description)
        ) {
          error(`invalid option ${point.id}`);
          continue;
        }
        options.add(option.id);
      }
      for (
        const direction of [
          ...point.options.map((option) => option?.direction),
          point.rejectDirection,
          point.deferDirection,
        ].filter((value) => value !== undefined)
      ) {
        if (!validDirection(direction, states, true)) {
          error(`invalid direction ${point.id}`);
        }
      }
    }
    const outcomes = new Set<string>();
    for (const outcome of review.outcomes) {
      if (
        !outcome || !points.has(outcome.pointId) ||
        outcomes.has(outcome.pointId) ||
        !["accept", "reject", "modify", "defer"].includes(outcome.action) ||
        !text(outcome.recordedAt) ||
        Number.isNaN(Date.parse(outcome.recordedAt))
      ) {
        error("invalid or duplicate outcome");
        continue;
      }
      outcomes.add(outcome.pointId);
      const point = review.points.find(({ id }) => id === outcome.pointId)!;
      if (
        outcome.optionId !== undefined &&
        !point.options?.some(({ id }) => id === outcome.optionId)
      ) error("outcome references unknown option");
      if (
        outcome.action === "accept" && point.purpose === "decision" &&
        !text(outcome.optionId)
      ) error("decision acceptance requires optionId");
      if (outcome.action === "modify" && outcome.direction === undefined) {
        error("modification requires direction");
      }
      const selectedDirection = outcome.action === "accept"
        ? point.options?.find((option) => option?.id === outcome.optionId)
          ?.direction
        : outcome.action === "reject"
        ? point.rejectDirection
        : outcome.action === "defer"
        ? point.deferDirection
        : undefined;
      if (selectedDirection !== undefined && outcome.direction === undefined) {
        error("outcome requires applied direction");
      }
      if (
        outcome.direction !== undefined &&
        !validDirection(outcome.direction, states)
      ) error("invalid outcome direction");
    }
    if (
      (review.status === "resolved") !==
        (review.points.every(({ id }) => outcomes.has(id)))
    ) error("status does not match pending points");
  }
}
