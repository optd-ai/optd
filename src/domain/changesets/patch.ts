import { canonicalJson } from "../ids/canonical_json.ts";
import type { JsonPatch } from "../../schemas/changesets/patch.ts";

export class PatchError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export function parsePointer(pointer: string): string[] {
  if (!pointer.startsWith("/")) {
    throw new PatchError(
      "invalid_pointer",
      pointer,
      "JSON Pointer must start with '/'",
    );
  }
  return pointer.slice(1).split("/").map((token) => {
    for (let i = 0; i < token.length; i++) {
      if (token[i] === "~" && token[++i] !== "0" && token[i] !== "1") {
        throw new PatchError(
          "invalid_pointer",
          pointer,
          "malformed RFC 6901 escape",
        );
      }
    }
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

export function applyPatches<T>(
  document: T,
  patches: readonly JsonPatch[],
  mutableFields: ReadonlySet<string>,
): T {
  const result = structuredClone(document);
  const seen = new Set<string>();
  for (const patch of patches) {
    const tokens = parsePointer(patch.path);
    const identity = canonicalJson(tokens);
    if (seen.has(identity)) {
      throw new PatchError(
        "duplicate_path",
        patch.path,
        "duplicate patch path",
      );
    }
    seen.add(identity);
    if (!mutableFields.has(tokens[0])) {
      throw new PatchError(
        "platform_field",
        patch.path,
        "path does not name a mutable declared field",
      );
    }
    applyOne(result, patch, tokens);
  }
  return result;
}

function applyOne(root: unknown, patch: JsonPatch, tokens: string[]): void {
  let parent: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    parent = readChild(parent, token, patch.path);
  }
  const key = tokens.at(-1)!;
  if (Array.isArray(parent)) return applyArray(parent, key, patch);
  if (!isObject(parent)) {
    throw new PatchError(
      "path_not_found",
      patch.path,
      "path parent does not exist",
    );
  }
  const exists = Object.hasOwn(parent, key);
  if (patch.op === "test") {
    if (!exists || !equal(parent[key], patch.value)) {
      throw new PatchError("test_failed", patch.path, "patch test failed");
    }
  } else if (patch.op === "remove") {
    if (!exists) {
      throw new PatchError(
        "path_not_found",
        patch.path,
        "remove target does not exist",
      );
    }
    delete parent[key];
  } else if (patch.op === "replace") {
    if (!exists) {
      throw new PatchError(
        "path_not_found",
        patch.path,
        "replace target does not exist",
      );
    }
    parent[key] = structuredClone(patch.value);
  } else parent[key] = structuredClone(patch.value);
}

function applyArray(parent: unknown[], key: string, patch: JsonPatch): void {
  if (key === "-") {
    if (patch.op !== "add") {
      throw new PatchError(
        "invalid_array_index",
        patch.path,
        "'-' is valid only for add",
      );
    }
    parent.push(structuredClone(patch.value));
    return;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
    throw new PatchError(
      "invalid_array_index",
      patch.path,
      "invalid array index",
    );
  }
  const index = Number(key);
  if (!Number.isSafeInteger(index)) {
    throw new PatchError(
      "invalid_array_index",
      patch.path,
      "invalid array index",
    );
  }
  if (patch.op === "add") {
    if (index > parent.length) {
      throw new PatchError(
        "path_not_found",
        patch.path,
        "array add index is out of bounds",
      );
    }
    parent.splice(index, 0, structuredClone(patch.value));
  } else {
    if (index >= parent.length) {
      throw new PatchError(
        "path_not_found",
        patch.path,
        "array target does not exist",
      );
    }
    if (patch.op === "remove") parent.splice(index, 1);
    else if (patch.op === "replace") {
      parent[index] = structuredClone(patch.value);
    } else if (!equal(parent[index], patch.value)) {
      throw new PatchError("test_failed", patch.path, "patch test failed");
    }
  }
}

function readChild(parent: unknown, key: string, path: string): unknown {
  if (Array.isArray(parent)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= parent.length) {
      throw new PatchError("path_not_found", path, "path does not exist");
    }
    return parent[Number(key)];
  }
  if (!isObject(parent) || !Object.hasOwn(parent, key)) {
    throw new PatchError("path_not_found", path, "path does not exist");
  }
  return parent[key];
}
function equal(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
