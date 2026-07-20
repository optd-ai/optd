import { canonicalJson, canonicalSha256 } from "../ids/canonical_json.ts";
import { uuidV7 } from "../ids/uuid_v7.ts";
import type {
  AuthoredOperation,
  StageRequest,
} from "../../schemas/changesets/operations.ts";

export type CanonicalOperation = Record<string, unknown> & {
  op: string;
  key: string;
  project_id: string;
};
export type OperationLimits = {
  maxOperations: number;
  maxDepth: number;
  maxGraphBytes: number;
  maxStringBytes: number;
};
export const DEFAULT_OPERATION_LIMITS: OperationLimits = {
  maxOperations: 10_000,
  maxDepth: 64,
  maxGraphBytes: 64 * 1024 * 1024,
  maxStringBytes: 8 * 1024 * 1024,
};
const PLATFORM_FIELDS = new Set([
  "id",
  "object_id",
  "relationship_id",
  "comment_id",
  "project_id",
  "version",
  "object_version_id",
  "created_at",
  "updated_at",
  "archived_at",
  "created_by",
  "updated_by",
  "actor_id",
  "auth_context_id",
]);

export class OperationError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message);
    this.name = "OperationError";
  }
}

export async function normalizeOperations(
  request: StageRequest,
  allocate?: () => string,
  limits: OperationLimits = DEFAULT_OPERATION_LIMITS,
): Promise<{ operations: CanonicalOperation[]; operationGraphDigest: string }> {
  inspectLimits(request, limits);
  const idAllocator = allocate ?? uuidV7;
  const entries = request.operations.map((source, ordinal) => ({
    source,
    ordinal,
    key: source.key ?? `op_${String(ordinal + 1).padStart(6, "0")}`,
    project_id: resolveProject(source, request.project_id, ordinal),
  }));
  const keys = new Map<string, typeof entries[number]>();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      throw new OperationError(
        "duplicate_key",
        `/operations/${entry.ordinal}/key`,
        "operation key must be unique",
      );
    }
    keys.set(entry.key, entry);
  }
  const produced = new Map<
    string,
    { property: string; id: string; project_id: string }
  >();
  for (const entry of entries) {
    const property = entry.source.op === "create"
      ? "object_id"
      : entry.source.op === "link"
      ? "relationship_id"
      : entry.source.op === "comment"
      ? "comment_id"
      : undefined;
    if (property) {
      produced.set(entry.key, {
        property,
        id: idAllocator(),
        project_id: entry.project_id,
      });
    }
  }
  const resolved = entries.map((entry) => resolveEntry(entry, produced));
  const merged = mergeMutations(resolved);
  inspectLimits({ operations: merged }, limits);
  const graph = { schema: "changeset.operations.v1", operations: merged };
  const bytes = new TextEncoder().encode(canonicalJson(graph)).byteLength;
  if (bytes > limits.maxGraphBytes) {
    tooLarge("/operations", "canonical operation graph exceeds byte limit");
  }
  return {
    operations: merged,
    operationGraphDigest: `sha256:${await canonicalSha256(graph)}`,
  };
}

export async function canonicalizeResolvedOperations(
  operations: CanonicalOperation[],
  limits: OperationLimits = DEFAULT_OPERATION_LIMITS,
): Promise<{ operations: CanonicalOperation[]; operationGraphDigest: string }> {
  inspectLimits({ operations }, limits);
  const keys = new Set<string>();
  for (let index = 0; index < operations.length; index++) {
    const key = String(operations[index].key);
    if (keys.has(key)) {
      throw new OperationError(
        "duplicate_key",
        `/operations/${index}/key`,
        "operation key must be unique",
      );
    }
    keys.add(key);
  }
  const merged = mergeMutations(structuredClone(operations));
  const graph = { schema: "changeset.operations.v1", operations: merged };
  const bytes = new TextEncoder().encode(canonicalJson(graph)).byteLength;
  if (bytes > limits.maxGraphBytes) {
    tooLarge("/operations", "canonical operation graph exceeds byte limit");
  }
  return {
    operations: merged,
    operationGraphDigest: `sha256:${await canonicalSha256(graph)}`,
  };
}

function resolveProject(
  source: AuthoredOperation,
  inherited: string | undefined,
  ordinal: number,
): string {
  if (source.project_id && inherited && source.project_id !== inherited) {
    throw new OperationError(
      "project_conflict",
      `/operations/${ordinal}/project_id`,
      "operation project conflicts with request project",
    );
  }
  const project = source.project_id ?? inherited;
  if (!project) {
    throw new OperationError(
      "project_required",
      `/operations/${ordinal}/project_id`,
      "project_id is required without request inheritance",
    );
  }
  return project;
}

function resolveEntry(
  entry: {
    source: AuthoredOperation;
    ordinal: number;
    key: string;
    project_id: string;
  },
  produced: Map<string, { property: string; id: string; project_id: string }>,
): CanonicalOperation {
  const source = entry.source as Record<string, unknown>;
  const output: Record<string, unknown> = {
    ...source,
    key: entry.key,
    project_id: entry.project_id,
  };
  const own = produced.get(entry.key);
  if (own) output[own.property] = own.id;
  for (const field of ["fields", "set"] as const) {
    if (isObject(output[field])) {
      rejectPlatformFields(
        output[field] as Record<string, unknown>,
        `/operations/${entry.ordinal}/${field}`,
      );
    }
  }
  if (Array.isArray(output.unset)) {
    for (const name of output.unset) {
      if (PLATFORM_FIELDS.has(String(name))) {
        throw new OperationError(
          "platform_field",
          `/operations/${entry.ordinal}/unset`,
          "platform fields cannot be mutated",
        );
      }
    }
  }
  if (source.op === "update" || source.op === "transition") {
    validateMutation(output, entry.ordinal);
  }
  if (source.op === "comment" && String(source.body).trim().length === 0) {
    throw new OperationError(
      "validation_failed",
      `/operations/${entry.ordinal}/body`,
      "comment body must not be blank",
    );
  }
  return resolveValue(
    output,
    produced,
    entry.project_id,
    `/operations/${entry.ordinal}`,
  ) as CanonicalOperation;
}

function resolveValue(
  value: unknown,
  produced: Map<string, { property: string; id: string; project_id: string }>,
  project: string,
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      resolveValue(item, produced, project, `${path}/${i}`)
    );
  }
  if (!isObject(value)) return value;
  if (Object.hasOwn(value, "$ref")) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== "string") {
      throw new OperationError(
        "invalid_reference",
        path,
        "reference must be an exact singleton object",
      );
    }
    const dot = value.$ref.lastIndexOf(".");
    const key = value.$ref.slice(0, dot), property = value.$ref.slice(dot + 1);
    const producer = produced.get(key);
    if (!producer) {
      throw new OperationError(
        "invalid_reference",
        path,
        "reference producer does not exist",
      );
    }
    if (producer.property !== property) {
      throw new OperationError(
        "invalid_reference",
        path,
        "producer does not expose the referenced property",
      );
    }
    if (producer.project_id !== project) {
      throw new OperationError(
        "project_conflict",
        path,
        "cross-project references are forbidden",
      );
    }
    return producer.id;
  }
  return Object.fromEntries(
    Object.entries(value).map((
      [key, item],
    ) => [
      key,
      resolveValue(item, produced, project, `${path}/${escapePointer(key)}`),
    ]),
  );
}

function validateMutation(
  operation: Record<string, unknown>,
  ordinal: number,
): void {
  const set = isObject(operation.set) ? operation.set : {};
  const unset = Array.isArray(operation.unset)
    ? operation.unset as string[]
    : [];
  if (!Object.keys(set).length && !unset.length && operation.op === "update") {
    throw new OperationError(
      "no_changes",
      `/operations/${ordinal}`,
      "update has no effective mutation",
    );
  }
  for (const field of unset) {
    if (Object.hasOwn(set, field)) {
      throw new OperationError(
        "operation_conflict",
        `/operations/${ordinal}`,
        "field cannot be set and unset",
      );
    }
  }
}

function mergeMutations(
  operations: CanonicalOperation[],
): CanonicalOperation[] {
  const result: Array<CanonicalOperation | undefined> = [];
  const groups = new Map<string, number>();
  for (const operation of operations) {
    if (!["create", "update", "transition", "archive"].includes(operation.op)) {
      result.push(operation);
      continue;
    }
    const target = String(operation.object_id);
    const groupKey = `${operation.project_id}\u0000${
      String(operation.resource)
    }\u0000${target}`;
    const existingIndex = groups.get(groupKey);
    if (existingIndex === undefined) {
      groups.set(groupKey, result.length);
      result.push(structuredClone(operation));
      continue;
    }
    result[existingIndex] = mergePair(result[existingIndex]!, operation);
  }
  return result.filter((item): item is CanonicalOperation =>
    item !== undefined
  );
}

function mergePair(
  left: CanonicalOperation,
  right: CanonicalOperation,
): CanonicalOperation {
  if (left.op === "archive" || right.op === "archive") {
    conflict("archive cannot be combined with another mutation");
  }
  if (left.op === "transition" && right.op === "transition") {
    conflict("only one transition is allowed per object");
  }
  if (
    left.expected_version !== undefined &&
    right.expected_version !== undefined &&
    left.expected_version !== right.expected_version
  ) conflict("expected versions differ");
  if (
    (left.op === "create" && right.op === "transition") ||
    (left.op === "transition" && right.op === "create")
  ) conflict("transition cannot target an object created in the same graph");
  const output = structuredClone(left);
  if (
    output.expected_version === undefined &&
    right.expected_version !== undefined
  ) output.expected_version = right.expected_version;
  if (right.op === "create") {
    output.op = "create";
    output.object_id = right.object_id;
    delete output.expected_version;
    output.fields = {
      ...((left.set as Record<string, unknown> | undefined) ?? {}),
    };
    delete output.set;
  } else if (right.op === "transition") {
    output.op = "transition";
    output.to = right.to;
  }
  const leftSetName = output.op === "create" ? "fields" : "set";
  const rightSetName = right.op === "create" ? "fields" : "set";
  const set = {
    ...((output[leftSetName] as Record<string, unknown> | undefined) ?? {}),
  };
  const unset = new Set<string>((output.unset as string[] | undefined) ?? []);
  for (const field of (right.unset as string[] | undefined) ?? []) {
    if (Object.hasOwn(set, field)) {
      conflict(`field '${field}' is both set and unset`);
    }
    unset.add(field);
  }
  for (
    const [field, value] of Object.entries(
      (right[rightSetName] as Record<string, unknown> | undefined) ?? {},
    )
  ) {
    if (unset.has(field)) conflict(`field '${field}' is both set and unset`);
    if (
      Object.hasOwn(set, field) &&
      canonicalJson(set[field]) !== canonicalJson(value)
    ) conflict(`field '${field}' has different values`);
    set[field] = value;
  }
  if (Object.keys(set).length) output[leftSetName] = set;
  if (unset.size) output.unset = [...unset].sort();
  else delete output.unset;
  return output;
}
function conflict(message: string): never {
  throw new OperationError("operation_conflict", "/operations", message);
}
function rejectPlatformFields(
  fields: Record<string, unknown>,
  path: string,
): void {
  for (const field of Object.keys(fields)) {
    if (PLATFORM_FIELDS.has(field)) {
      throw new OperationError(
        "platform_field",
        `${path}/${field}`,
        "platform fields are server managed",
      );
    }
  }
}
function inspectLimits(value: unknown, limits: OperationLimits): void {
  let operations = 0;
  if (isObject(value) && Array.isArray(value.operations)) {
    operations = value.operations.length;
  }
  if (operations > limits.maxOperations) {
    tooLarge("/operations", "operation count exceeds limit");
  }
  const encoder = new TextEncoder();
  const visit = (item: unknown, depth: number, path: string): void => {
    if (depth > limits.maxDepth) tooLarge(path, "JSON nesting exceeds limit");
    if (
      typeof item === "string" &&
      encoder.encode(item).byteLength > limits.maxStringBytes
    ) tooLarge(path, "string exceeds byte limit");
    if (Array.isArray(item)) {
      item.forEach((child, i) => visit(child, depth + 1, `${path}/${i}`));
    } else if (isObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        visit(key, depth + 1, path);
        visit(child, depth + 1, `${path}/${escapePointer(key)}`);
      }
    }
  };
  visit(value, 0, "");
}
function tooLarge(path: string, message: string): never {
  throw new OperationError("changeset_too_large", path || "/", message);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
