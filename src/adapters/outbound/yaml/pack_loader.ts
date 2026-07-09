import { parseAllDocuments, visit } from "npm:yaml@2";
import {
  type PackKind,
  validatePackDocument,
} from "../../../schemas/packs/pack_schemas.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
export type UploadedPackFile = {
  path: string;
  text: string;
  kind?: "config" | "script";
};

export type NormalizedDefinition = {
  kind: PackKind;
  path: string;
  name: string;
  namespace: string;
  document: Record<string, JsonValue>;
  spec: Record<string, JsonValue>;
};

export type LoadedPack = {
  namespace: string;
  name: string;
  version: string;
  revision: string;
  manifest: Record<string, JsonValue>;
  normalized: Record<string, JsonValue>;
  sourceFiles: Array<
    { path: string; kind: "config" | "script"; digest: string; content: string }
  >;
  resources: Record<string, NormalizedDefinition>;
  relationships: Record<string, NormalizedDefinition>;
  lifecycles: Record<string, NormalizedDefinition>;
  actions: Record<string, NormalizedDefinition>;
  hooks: Record<
    string,
    NormalizedDefinition & { script: string; scriptDigest: string }
  >;
  policies: Record<string, NormalizedDefinition>;
  seeds: Record<string, NormalizedDefinition>;
  scripts: Record<string, { path: string; digest: string; content: string }>;
};

const allowedPath =
  /^(pack\.yaml|resources\/[a-z_][a-z0-9_]*\.yaml|relationships\/[a-z_][a-z0-9_]*\.yaml|lifecycles\/[a-z_][a-z0-9_]*\.yaml|actions\/[a-z_][a-z0-9_]*\.yaml|hooks\/[a-z_][a-z0-9_]*\.(yaml|ts)|policies\/[a-z_][a-z0-9_]*\.yaml|seeds\/[a-z_][a-z0-9_]*\.yaml)$/;
const dirKind: Record<string, PackKind> = {
  resources: "Resource",
  relationships: "Relationship",
  lifecycles: "Lifecycle",
  actions: "Action",
  hooks: "Hook",
  policies: "Policy",
  seeds: "Seed",
};

export async function loadPackFromFiles(
  inputFiles: UploadedPackFile[],
): Promise<LoadedPack> {
  const files = inputFiles.map((file) => ({
    ...file,
    path: normalizeUploadPath(file.path),
    kind: file.kind ??
      (file.path.endsWith(".ts") ? "script" as const : "config" as const),
  }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) {
      throw new Error(`duplicate pack path ${file.path}`);
    }
    paths.add(file.path);
    if (!allowedPath.test(file.path)) {
      throw new Error(`unexpected pack path ${file.path}`);
    }
    if (file.path.startsWith("docs/") || file.path === "docs") {
      throw new Error("packs must not include docs/");
    }
  }
  const manifestFile = files.find((file) => file.path === "pack.yaml");
  if (!manifestFile) throw new Error("missing pack.yaml");
  const manifest = parseYamlJsonObject(manifestFile.text, "pack.yaml");
  assertKind(manifest, "Pack", "pack.yaml");
  validateOrThrow("Pack", manifest, "pack.yaml");
  const metadata = asRecord(manifest.metadata, "pack.yaml.metadata");
  const namespace = requiredString(
    metadata.namespace,
    "pack.yaml.metadata.namespace",
  );
  const name = requiredString(metadata.name, "pack.yaml.metadata.name");
  const version = requiredString(
    metadata.version,
    "pack.yaml.metadata.version",
  );

  const pack: Omit<LoadedPack, "revision"> & { revision?: string } = {
    namespace,
    name,
    version,
    manifest,
    normalized: {},
    sourceFiles: [],
    resources: {},
    relationships: {},
    lifecycles: {},
    actions: {},
    hooks: {},
    policies: {},
    seeds: {},
    scripts: {},
  };

  for (const file of files) {
    const digest = await sha256Hex(file.text);
    pack.sourceFiles.push({
      path: file.path,
      kind: file.kind,
      digest,
      content: file.text,
    });
    if (file.kind === "script") {
      pack.scripts[file.path] = { path: file.path, digest, content: file.text };
    }
  }

  for (const file of files) {
    if (file.path === "pack.yaml" || file.kind === "script") continue;
    const [dir, basenameWithExt] = file.path.split("/");
    const expectedKind = dirKind[dir];
    if (!expectedKind) continue;
    const basename = basenameWithExt.replace(/\.yaml$/, "");
    const document = parseYamlJsonObject(file.text, file.path);
    assertKind(document, expectedKind, file.path);
    validateOrThrow(expectedKind, document, file.path);
    const metadata = asRecord(document.metadata, `${file.path}.metadata`);
    const objectName = requiredString(
      metadata.name,
      `${file.path}.metadata.name`,
    );
    if (objectName !== basename) {
      throw new Error(
        `${file.path}: metadata.name '${objectName}' must match basename '${basename}'`,
      );
    }
    const objectNamespace = typeof metadata.namespace === "string"
      ? metadata.namespace
      : namespace;
    const spec = asRecord(document.spec ?? {}, `${file.path}.spec`);
    const def: NormalizedDefinition = {
      kind: expectedKind,
      path: file.path,
      name: objectName,
      namespace: objectNamespace,
      document,
      spec,
    };
    switch (expectedKind) {
      case "Resource":
        pack.resources[objectName] = def;
        break;
      case "Relationship":
        pack.relationships[objectName] = def;
        break;
      case "Lifecycle":
        pack.lifecycles[objectName] = def;
        break;
      case "Action":
        pack.actions[objectName] = def;
        break;
      case "Policy":
        pack.policies[objectName] = def;
        break;
      case "Seed":
        pack.seeds[objectName] = def;
        break;
      case "Hook": {
        const script = requiredString(spec.script, `${file.path}.spec.script`);
        if (
          script.includes("/") || script.includes("\\\\") ||
          script !== basenameFromPath(script)
        ) {
          throw new Error(`${file.path}: hook script must be a basename`);
        }
        const scriptPath = `hooks/${script}`;
        const scriptFile = pack.scripts[scriptPath];
        if (!scriptFile) {
          throw new Error(
            `${file.path}: referenced hook script ${script} is missing`,
          );
        }
        pack.hooks[objectName] = {
          ...def,
          script,
          scriptDigest: scriptFile.digest,
        };
        break;
      }
      case "Pack":
        break;
    }
  }

  for (const scriptPath of Object.keys(pack.scripts)) {
    const yamlPath = scriptPath.replace(/\.ts$/, ".yaml");
    if (!pack.hooks[basenameFromPath(scriptPath).replace(/\.ts$/, "")]) {
      throw new Error(`${scriptPath}: hook script requires paired ${yamlPath}`);
    }
  }

  pack.normalized = canonicalize({
    manifest: pack.manifest,
    resources: docs(pack.resources),
    relationships: docs(pack.relationships),
    lifecycles: docs(pack.lifecycles),
    actions: docs(pack.actions),
    hooks: docs(pack.hooks),
    policies: docs(pack.policies),
    seeds: docs(pack.seeds),
    scripts: Object.fromEntries(
      Object.entries(pack.scripts).map((
        [path, script],
      ) => [path, script.digest]),
    ),
  }) as Record<string, JsonValue>;
  const revisionDigest = await sha256Hex(canonicalJson(pack.normalized));
  pack.revision = `${namespace}.${name}@${version}:${revisionDigest}`;
  return pack as LoadedPack;
}

export function parseYamlJsonObject(
  text: string,
  path: string,
): Record<string, JsonValue> {
  const docs = parseAllDocuments(text, {
    merge: true,
    uniqueKeys: true,
    schema: "core",
  });
  if (docs.length !== 1) {
    throw new Error(`${path}: expected exactly one YAML document`);
  }
  const doc = docs[0];
  if (doc.errors.length) {
    throw new Error(`${path}: ${doc.errors.map((e) => e.message).join("; ")}`);
  }
  let hasCustomTag = false;
  visit(doc, (_key, node) => {
    if (node && typeof node === "object" && "tag" in node) {
      const tag = String((node as { tag?: string }).tag ?? "");
      if (tag && !tag.startsWith("tag:yaml.org,2002:")) hasCustomTag = true;
    }
  });
  if (hasCustomTag) {
    throw new Error(`${path}: custom YAML tags are not allowed`);
  }
  return asRecord(canonicalize(doc.toJSON()), path);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-JSON number is not allowed");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value) {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("non-JSON object is not allowed");
    }
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (typeof key !== "string") {
        throw new Error("non-string object key is not allowed");
      }
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error("undefined is not JSON-compatible");
      }
      out[key] = canonicalize(child);
    }
    return out;
  }
  throw new Error(`non-JSON value is not allowed: ${String(value)}`);
}

function validateOrThrow(kind: PackKind, value: unknown, path: string) {
  const issues = validatePackDocument(kind, value);
  if (issues.length) {
    throw new Error(
      `${path}: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
  }
}
function assertKind(
  value: Record<string, JsonValue>,
  kind: PackKind,
  path: string,
) {
  if (value.kind !== kind) throw new Error(`${path}: expected kind ${kind}`);
}
function docs(defs: Record<string, NormalizedDefinition>) {
  return Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [name, def.document]),
  );
}
function asRecord(value: unknown, path: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, JsonValue>;
}
function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return value;
}
function basenameFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}
function normalizeUploadPath(path: string): string {
  return path.replaceAll("\\\\", "/").replace(/^\.\//, "");
}
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
