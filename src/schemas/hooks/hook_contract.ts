import { lowerAfterCommitCondition } from "../../domain/outbox/condition.ts";

type JsonRecord = Record<string, unknown>;

const OUTPUT_BY_PHASE: Record<string, string> = {
  "action.stage": "changeset.operations.v1",
  "changeset.before_stage": "patch.v1",
  "changeset.validate": "validation.v1",
  "event.after_commit": "delivery.v1",
};
const RESERVED_ENV = ["OPTD_", "DENO_", "LD_", "DYLD_"];
const SLOT = /^[a-z][a-z0-9_]{0,62}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const DNS_LABEL = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)$/;
const INPUT_REFS: Record<string, Set<string>> = {
  "action.stage": new Set(["$action.input", "$actor", "$reads"]),
  "changeset.before_stage": new Set([
    "$operation",
    "$current",
    "$proposed",
    "$reads",
    "$object_version",
    "$project_id",
  ]),
  "changeset.validate": new Set([
    "$operation",
    "$current",
    "$proposed",
    "$reads",
    "$object_version",
    "$project_id",
  ]),
  "event.after_commit": new Set([
    "$actor",
    "$event",
    "$object_version",
  ]),
};

export type ValidatedHookSecurity = {
  normalized: JsonRecord;
  securityDigest: string;
};

export async function validateHookContract(
  hookIdentity: string,
  spec: JsonRecord,
  scriptDigest: string,
  scriptContent: string,
): Promise<ValidatedHookSecurity> {
  rejectHookImports(scriptContent);
  const permissions = record(spec.permissions, "spec.permissions");
  const net = permissions.net === false
    ? []
    : stringArray(permissions.net, "spec.permissions.net");
  assertSortedUnique(net, "spec.permissions.net");
  for (const endpoint of net) validateEndpoint(endpoint);
  const env = permissions.env === false
    ? []
    : stringArray(permissions.env, "spec.permissions.env");
  assertSortedUnique(env, "spec.permissions.env");
  for (const name of env) validateEnv(name, "non-secret environment");

  const secrets = array(spec.secrets, "spec.secrets").map((value, index) => {
    const secret = record(value, `spec.secrets[${index}]`);
    if (typeof secret.slot !== "string" || !SLOT.test(secret.slot)) {
      fail(`spec.secrets[${index}].slot is invalid`);
    }
    if (typeof secret.env !== "string") {
      fail(`spec.secrets[${index}].env is invalid`);
    }
    validateEnv(secret.env as string, "secret environment");
    return { slot: secret.slot as string, env: secret.env as string };
  });
  assertSortedUnique(secrets.map((value) => value.slot), "spec.secrets slots");
  const secretEnvs = secrets.map((value) => value.env);
  if (new Set(secretEnvs).size !== secretEnvs.length) {
    fail("spec.secrets env names must be unique");
  }
  for (const name of secretEnvs) {
    if (env.includes(name)) {
      fail(`secret env ${name} collides with permissions.env`);
    }
  }

  const timeoutMs = parseTimeout(spec.timeout);
  const output = record(spec.output, "spec.output");
  const outputSchema = output.schema;
  const attachments = array(spec.attachments, "spec.attachments").map(
    (value, index) => {
      const attachment = record(value, `spec.attachments[${index}]`);
      const phase = String(attachment.phase);
      if (OUTPUT_BY_PHASE[phase] !== outputSchema) {
        fail(`${phase} requires output schema ${OUTPUT_BY_PHASE[phase]}`);
      }
      const targets = [attachment.resource, attachment.action, attachment.event]
        .filter((v) => v !== undefined);
      if (targets.length !== 1) {
        fail(`spec.attachments[${index}] must declare exactly one target`);
      }
      if (phase === "action.stage" && attachment.action === undefined) {
        fail("action.stage attachment requires action");
      }
      if (phase === "event.after_commit" && attachment.event === undefined) {
        fail("event.after_commit attachment requires event");
      }
      if (
        (phase === "changeset.before_stage" ||
          phase === "changeset.validate") && attachment.resource === undefined
      ) {
        fail(`${phase} attachment requires resource`);
      }
      const orderValue = attachment.order === undefined
        ? 1000
        : attachment.order;
      if (
        typeof orderValue !== "number" || !Number.isSafeInteger(orderValue)
      ) fail(`spec.attachments[${index}].order must be an integer`);
      const order = orderValue as number;
      const input = record(
        attachment.input,
        `spec.attachments[${index}].input`,
      );
      for (const mapped of Object.values(input)) {
        validateInputValue(
          mapped,
          phase,
          `spec.attachments[${index}].input`,
        );
      }
      validateCondition(attachment.condition, phase, index);
      return { ...attachment, order } as JsonRecord & { order: number };
    },
  );

  const effects = array(
    record(spec.effects, "spec.effects").operations,
    "spec.effects.operations",
  )
    .map((value, index) => {
      const effect = record(value, `spec.effects.operations[${index}]`);
      const resource = String(effect.resource);
      const ops = stringArray(
        effect.ops,
        `spec.effects.operations[${index}].ops`,
      );
      assertSortedUnique(ops, `spec.effects.operations[${index}].ops`);
      return { resource, ops };
    });
  assertSortedUnique(
    effects.map((effect) => effect.resource),
    "spec.effects.operations resources",
  );
  if (outputSchema !== "changeset.operations.v1" && effects.length !== 0) {
    fail("only changeset.operations.v1 hooks may declare operation effects");
  }

  const normalized: JsonRecord = {
    script: spec.script,
    timeout_ms: timeoutMs,
    permissions: { net, env, read: false, write: false, run: false },
    secrets,
    effects: { operations: effects },
    output: { schema: outputSchema },
    attachments,
    ...(spec.axi === undefined ? {} : { axi: spec.axi }),
  };
  const securityFacts = {
    schema: "hook.security.v1",
    hook: hookIdentity,
    script_digest: scriptDigest,
    permissions: { net, env },
    secrets,
    effects: { operations: effects },
    output: { schema: outputSchema },
    attachments: attachments.map((
      { phase, resource, action, event, order, condition, input },
    ) => ({
      phase,
      ...(resource === undefined ? {} : { resource }),
      ...(action === undefined ? {} : { action }),
      ...(event === undefined ? {} : { event }),
      order,
      ...(condition === undefined ? {} : { condition }),
      input,
    })),
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(securityFacts)),
  );
  return {
    normalized,
    securityDigest: `sha256:${hex(new Uint8Array(digest))}`,
  };
}

export function rejectHookImports(source: string): void {
  // Single-file hooks have no legitimate use for these tokens. Conservatively
  // rejecting them even in generated strings closes comment/string/template,
  // dynamic Function, URL, and alternate registry bypasses.
  const forbidden: Array<[RegExp, string]> = [
    [/\bimport\b/i, "import"],
    [/\brequire\s*\(/i, "require"],
    [/\bfrom\s*["'`]/i, "static module source"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) fail(`hook scripts may not contain ${label}`);
  }
}

function validateEndpoint(value: string): void {
  if (
    value !== value.toLowerCase() || value.includes("/") ||
    value.includes("@") || value.includes("*") || value.includes(" ")
  ) {
    fail(`invalid net endpoint '${value}'`);
  }
  let host = value;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([0-9a-f:]+)\](?::([0-9]{1,5}))?$/.exec(value);
    if (!match) fail(`invalid net endpoint '${value}'`);
    host = match![1];
    port = match![2];
  } else {
    const parts = value.split(":");
    if (parts.length > 2) fail(`IPv6 endpoints must use brackets: '${value}'`);
    [host, port] = parts;
    if (
      host !== "localhost" &&
      host.split(".").some((label) => !DNS_LABEL.test(label))
    ) {
      fail(`invalid net endpoint '${value}'`);
    }
  }
  if (
    port !== undefined &&
    (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
  ) {
    fail(`invalid net endpoint port '${value}'`);
  }
}

function validateEnv(name: string, label: string): void {
  if (!ENV.test(name)) fail(`${label} name '${name}' is invalid`);
  if (RESERVED_ENV.some((prefix) => name.startsWith(prefix))) {
    fail(`${label} name '${name}' uses a reserved prefix`);
  }
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "string") fail("spec.timeout must be a duration");
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value as string);
  if (!match) fail("spec.timeout must be a positive duration");
  const factor = match![2] === "m" ? 60_000 : match![2] === "s" ? 1_000 : 1;
  const timeout = Number(match![1]) * factor;
  if (!Number.isSafeInteger(timeout) || timeout > 600_000) {
    fail("spec.timeout exceeds 10m");
  }
  return timeout;
}

function validateCondition(value: unknown, phase: string, index: number): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    fail(`spec.attachments[${index}].condition is invalid`);
  }
  for (
    const ref of value.match(/\$(?:[a-z_]+)(?:\.[a-z_][a-z0-9_]*)*/g) ?? []
  ) {
    validateReference(ref, phase, `spec.attachments[${index}].condition`);
  }
  if (phase === "event.after_commit") {
    try {
      lowerAfterCommitCondition(value);
    } catch (error) {
      fail(
        `spec.attachments[${index}].condition ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
function validateInputValue(value: unknown, phase: string, path: string): void {
  if (typeof value === "string" && value.startsWith("$")) {
    validateReference(value, phase, path);
  } else if (Array.isArray(value)) {
    value.forEach((v) => validateInputValue(v, phase, path));
  } else if (value && typeof value === "object") {
    Object.values(value as JsonRecord).forEach((v) =>
      validateInputValue(v, phase, path)
    );
  }
}
function validateReference(ref: string, phase: string, path: string): void {
  const root = ref.startsWith("$reads.") ? "$reads" : ref;
  if (!INPUT_REFS[phase]?.has(root)) {
    fail(`${path} reference '${ref}' is unavailable in ${phase}`);
  }
  if (root === "$reads" && !/^\$reads\.[a-z][a-z0-9_]{0,62}$/.test(ref)) {
    fail(`${path} read reference '${ref}' is invalid`);
  }
}
function assertSortedUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(`${path} must be unique`);
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    fail(`${path} must be sorted`);
  }
}
function stringArray(value: unknown, path: string): string[] {
  const values = array(value, path);
  if (values.some((item) => typeof item !== "string")) {
    fail(`${path} must contain strings`);
  }
  return values as string[];
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value as unknown[];
}
function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as JsonRecord;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value as JsonRecord).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
function fail(message: string): never {
  throw new Error(message);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
