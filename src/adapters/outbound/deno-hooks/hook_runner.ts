import { parseDeliveryOutput } from "../../../domain/outbox/delivery.ts";

type JsonRecord = Record<string, unknown>;

export type HookOutputSchema =
  | "validation.v1"
  | "patch.v1"
  | "changeset.operations.v1"
  | "delivery.v1";
export type HookPermissions = {
  net?: false | string[] | boolean;
  read?: false | boolean;
  write?: false | boolean;
  env?: false | string[] | boolean;
  run?: false | boolean;
};
export type HookSecretRef = { name: string; env: string; slot?: string };
export type HookDefinition = {
  namespace: string;
  name: string;
  revision: string;
  scriptPath: string;
  scriptDigest: string;
  securityDigest?: string;
  scriptContent: string;
  outputSchema: HookOutputSchema;
  timeoutMs: number;
  permissions: HookPermissions;
  secrets?: HookSecretRef[];
};
export type HookEnvelope = {
  hook: string;
  phase: string;
  input: JsonRecord;
  metadata?: JsonRecord;
};
export type HookRunResult = {
  ok: boolean;
  hook: string;
  outputSchema: HookOutputSchema;
  output?: JsonRecord;
  logs: string;
  logsTruncated?: boolean;
  secretsRedacted?: boolean;
  durationMs: number;
  exitCode: number | null;
  scriptDigest: string;
  error?: { code: string; message: string; details: JsonRecord };
};

export type DenoHookRunnerOptions = {
  cacheDir?: string;
  globalPolicy?: Required<
    { net: boolean; read: boolean; write: boolean; env: boolean; run: boolean }
  >;
  secretValues?: Record<string, string>;
  secretResolver?: (name: string) => Promise<string | undefined>;
  netAllow?: string[];
  envAllow?: string[];
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  maximumTimeoutMs?: number;
  inputDeliveryTimeoutMs?: number;
  serverPort?: number;
  serverHosts?: string[];
  databaseEndpoints?: string[];
  denoBin?: string;
};

const RESERVED_ENV = ["OPERANT_", "DENO_", "LD_", "DYLD_"];
const DEFAULT_STDOUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 4 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[OPERANT_LOG_TRUNCATED]";

export class DenoHookRunner {
  readonly #options: DenoHookRunnerOptions;
  readonly #cacheDir: string;

  constructor(options: DenoHookRunnerOptions = {}) {
    this.#options = options;
    this.#cacheDir = options.cacheDir ??
      `${Deno.env.get("TMPDIR") ?? "/tmp"}/operant-hook-cache`;
  }

  async run(
    hook: HookDefinition,
    envelope: HookEnvelope,
  ): Promise<HookRunResult> {
    const started = performance.now();
    const denied = this.#capabilityError(hook);
    if (denied) return failure(hook, started, "hook_capability_denied", denied);
    if (containsForbiddenModuleSyntax(hook.scriptContent)) {
      return failure(
        hook,
        started,
        "hook_import_denied",
        "hook imports are disabled",
      );
    }
    if (
      !Number.isSafeInteger(hook.timeoutMs) || hook.timeoutMs < 1 ||
      hook.timeoutMs > (this.#options.maximumTimeoutMs ?? 600_000)
    ) {
      return failure(
        hook,
        started,
        "hook_capability_denied",
        "hook timeout exceeds the runtime limit",
      );
    }

    const resolved = await this.#resolveEnvironment(hook);
    if ("error" in resolved) {
      return failure(
        hook,
        started,
        resolved.error.code,
        resolved.error.message,
      );
    }
    const redactions = Object.values(resolved.secretEnv).filter((value) =>
      value.length > 0
    ).sort((a, b) => b.length - a.length);
    const scriptPath = await this.#materialize(hook);
    const net = netList(hook.permissions.net);
    const envNames = Object.keys(resolved.env).sort();
    const args = [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--cached-only",
      ...(net.length ? [`--allow-net=${net.join(",")}`] : []),
      ...(envNames.length ? [`--allow-env=${envNames.join(",")}`] : []),
      scriptPath,
    ];
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(
        this.#options.denoBin ?? Deno.execPath(),
        {
          args,
          clearEnv: true,
          env: resolved.env,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        },
      ).spawn();
    } catch {
      await removeEntry(scriptPath);
      return failure(
        hook,
        started,
        "hook_spawn_failed",
        "hook process could not be spawned",
      );
    }

    // Drain both child pipes immediately. A fast-failing runtime can otherwise
    // fill a startup diagnostic pipe while the parent is still delivering
    // stdin, obscuring the real status or turning delivery into a deadlock.
    const stdoutPromise = readBounded(
      child.stdout,
      this.#options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT,
      false,
    );
    const stderrLimit = this.#options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT;
    const redactionOverlap = redactions.reduce(
      (maximum, value) =>
        Math.max(maximum, new TextEncoder().encode(value).length - 1),
      0,
    );
    const stderrPromise = readBounded(
      child.stderr,
      stderrLimit + redactionOverlap,
      true,
    );
    const statusPromise = child.status;
    const delivery = startInputDelivery(child, curatedEnvelope(envelope));
    const stdoutOverflow = stdoutPromise.then((value) =>
      value.overflow ? "stdout_overflow" as const : new Promise<never>(() => {})
    );
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    const deliveryAccepted = await Promise.race([
      delivery.writeAccepted,
      new Promise<false>((resolve) => {
        deliveryTimer = setTimeout(
          () => resolve(false),
          this.#options.inputDeliveryTimeoutMs ?? 5_000,
        );
      }),
    ]);
    if (deliveryTimer !== undefined) clearTimeout(deliveryTimer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = deliveryAccepted
      ? await Promise.race([
        statusPromise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), hook.timeoutMs);
        }),
        stdoutOverflow,
      ])
      : "delivery_failure" as const;
    if (timer !== undefined) clearTimeout(timer);
    if (completed === "delivery_failure") {
      await killAndReap(child);
      const [status, stdout, stderr] = await Promise.all([
        statusPromise.catch(() => ({
          success: false,
          code: -1,
          signal: null,
        } as Deno.CommandStatus)),
        stdoutPromise.catch(() => ({
          bytes: new Uint8Array(),
          truncated: false,
        })),
        stderrPromise.catch(() => ({
          bytes: new Uint8Array(),
          truncated: false,
        })),
        delivery.settled,
      ]);
      await removeEntry(scriptPath);
      const retained = retainedLogs(stderr, redactions, stderrLimit);
      const stdoutRedacted = redact(decode(stdout.bytes), redactions);
      return failure(
        hook,
        started,
        "hook_spawn_failed",
        "hook input could not be delivered",
        retained.text,
        retained.truncated,
        retained.changed || stdoutRedacted.changed,
        status.code,
      );
    }
    if (completed === "stdout_overflow") {
      await killAndReap(child);
      await delivery.settled;
      await removeEntry(scriptPath);
      const stderr = await stderrPromise.catch(() => ({
        bytes: new Uint8Array(),
        truncated: false,
      }));
      const logs = retainedLogs(stderr, redactions, stderrLimit);
      return failure(
        hook,
        started,
        "hook_stdout_limit",
        "hook stdout exceeded the byte limit",
        logs.text,
        logs.truncated,
        logs.changed,
      );
    }
    if (completed === "timeout") {
      await killAndReap(child);
      await delivery.settled;
      await removeEntry(scriptPath);
      const stderr = await stderrPromise.catch(() => ({
        bytes: new Uint8Array(),
        truncated: false,
      }));
      await stdoutPromise.catch(() => undefined);
      const logs = retainedLogs(stderr, redactions, stderrLimit);
      return failure(
        hook,
        started,
        "hook_timeout",
        "hook execution timed out",
        logs.text,
        logs.truncated,
        logs.changed,
      );
    }

    const [stdoutRead, stderrRead] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      delivery.settled,
    ]);
    await removeEntry(scriptPath);
    const retained = retainedLogs(stderrRead, redactions, stderrLimit);
    if (stdoutRead.overflow) {
      return failure(
        hook,
        started,
        "hook_stdout_limit",
        "hook stdout exceeded the byte limit",
        retained.text,
        retained.truncated,
        retained.changed,
      );
    }
    const stdoutRedacted = redact(decode(stdoutRead.bytes), redactions);
    const logs = retained.text;
    if (!completed.success) {
      return failure(
        hook,
        started,
        "hook_failed",
        "hook process failed",
        logs,
        retained.truncated,
        stdoutRedacted.changed || retained.changed,
        completed.code,
      );
    }

    let parsed: unknown;
    try {
      const text = stdoutRedacted.text.trim();
      parsed = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error();
    } catch {
      return failure(
        hook,
        started,
        "hook_invalid_output",
        "hook stdout must be exactly one JSON object",
        logs,
        retained.truncated,
        stdoutRedacted.changed || retained.changed,
        completed.code,
      );
    }
    const outputError = validateOutputShape(
      hook.outputSchema,
      parsed as JsonRecord,
    );
    if (outputError) {
      return failure(
        hook,
        started,
        "hook_invalid_output",
        outputError,
        logs,
        retained.truncated,
        stdoutRedacted.changed || retained.changed,
        completed.code,
      );
    }
    return {
      ok: true,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      output: parsed as JsonRecord,
      logs,
      logsTruncated: retained.truncated,
      secretsRedacted: stdoutRedacted.changed || retained.changed,
      durationMs: Math.round(performance.now() - started),
      exitCode: completed.code,
      scriptDigest: hook.scriptDigest,
    };
  }

  async #materialize(hook: HookDefinition): Promise<string> {
    await Deno.mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
    const path = await Deno.makeTempFile({
      dir: this.#cacheDir,
      prefix: "entry_",
      suffix: ".ts",
    });
    await Deno.chmod(path, 0o600);
    await Deno.writeTextFile(
      path,
      `${trustedPrelude()}\n${hook.scriptContent}`,
    );
    return path;
  }

  #capabilityError(hook: HookDefinition): string | null {
    if (
      hook.permissions.read !== false && hook.permissions.read !== undefined
    ) return "filesystem read is permanently denied";
    if (
      hook.permissions.write !== false && hook.permissions.write !== undefined
    ) return "filesystem write is permanently denied";
    if (hook.permissions.run !== false && hook.permissions.run !== undefined) {
      return "subprocess execution is permanently denied";
    }
    if (hook.permissions.net === true || hook.permissions.env === true) {
      return "unrestricted permissions are denied";
    }
    const declaredNet = netList(hook.permissions.net);
    const ceiling = this.#options.netAllow ??
      parseCeiling(Deno.env.get("OPERANT_HOOK_NET_ALLOW"), true);
    if (
      ceiling !== undefined &&
      declaredNet.some((endpoint) => !ceiling.includes(endpoint))
    ) return "declared network endpoint exceeds deployment policy";
    if (
      declaredNet.some((endpoint) =>
        blockedEndpoint(
          endpoint,
          this.#options.serverPort,
          this.#options.serverHosts ?? [],
          this.#options.databaseEndpoints ?? [],
        )
      )
    ) return "self API and database endpoints are denied";
    return null;
  }

  async #resolveEnvironment(
    hook: HookDefinition,
  ): Promise<
    { env: Record<string, string>; secretEnv: Record<string, string> } | {
      error: { code: string; message: string };
    }
  > {
    const env: Record<string, string> = {};
    const secretEnv: Record<string, string> = {};
    const declared = envList(hook.permissions.env);
    const ceiling = this.#options.envAllow ??
      parseCeiling(Deno.env.get("OPERANT_HOOK_ENV_ALLOW"), false) ?? [];
    for (const name of declared) {
      if (
        RESERVED_ENV.some((prefix) => name.startsWith(prefix)) ||
        !ceiling.includes(name)
      ) {
        return {
          error: {
            code: "hook_env_unavailable",
            message: "declared environment is unavailable",
          },
        };
      }
      const value = Deno.env.get(name);
      if (value === undefined || value.includes("\0")) {
        return {
          error: {
            code: "hook_env_unavailable",
            message: "declared environment is unavailable",
          },
        };
      }
      env[name] = value;
    }
    for (const ref of hook.secrets ?? []) {
      if (
        RESERVED_ENV.some((prefix) => ref.env.startsWith(prefix)) ||
        Object.hasOwn(env, ref.env)
      ) {
        return {
          error: {
            code: "hook_capability_denied",
            message: "secret environment declaration is invalid",
          },
        };
      }
      let value = this.#options.secretValues?.[ref.name];
      if (value === undefined && this.#options.secretResolver) {
        try {
          value = await this.#options.secretResolver(ref.name);
        } catch { /* safe failure below */ }
      }
      if (value === undefined || value.length === 0 || value.includes("\0")) {
        return {
          error: {
            code: "hook_secret_unavailable",
            message: "required hook secret is unavailable",
          },
        };
      }
      env[ref.env] = value;
      secretEnv[ref.env] = value;
    }
    return { env, secretEnv };
  }
}

export function validateOutputShape(
  schema: HookOutputSchema,
  output: JsonRecord,
): string | null {
  if (schema === "validation.v1") {
    if (
      !exactKeys(output, [
        "allow",
        "errors",
        "required_approvals",
        "warnings",
      ]) || typeof output.allow !== "boolean" ||
      !Array.isArray(output.errors) || !Array.isArray(output.warnings) ||
      !Array.isArray(output.required_approvals)
    ) return "validation.v1 output has an invalid shape";
    if (output.errors.length > 0 && output.allow !== false) {
      return "validation errors require allow=false";
    }
    if (output.allow === false && output.errors.length === 0) {
      return "allow=false requires an error";
    }
    for (const message of [...output.errors, ...output.warnings]) {
      if (!validMessage(message)) {
        return "validation message has an invalid shape";
      }
    }
  } else if (schema === "patch.v1") {
    if (
      !hasOnlyKeys(output, ["patches", "warnings"], ["patches"]) ||
      !Array.isArray(output.patches) ||
      (output.warnings !== undefined &&
        (!Array.isArray(output.warnings) ||
          output.warnings.some((message) => !validMessage(message))))
    ) {
      return "patch.v1 output has an invalid shape";
    }
    for (const patch of output.patches) {
      if (
        !isRecord(patch) ||
        !["add", "remove", "replace", "test"].includes(String(patch.op)) ||
        typeof patch.path !== "string" || !patch.path.startsWith("/")
      ) return "patch.v1 contains an invalid RFC 6902 operation";
      const keys = patch.op === "remove"
        ? ["op", "path"]
        : ["op", "path", "value"];
      if (!exactKeys(patch, keys)) {
        return "patch.v1 operation has unknown or missing fields";
      }
    }
  } else if (schema === "changeset.operations.v1") {
    if (
      !exactKeys(output, ["operations"]) || !Array.isArray(output.operations)
    ) return "changeset.operations.v1 output has an invalid shape";
    if (
      output.operations.some((operation) =>
        !isRecord(operation) || typeof operation.op !== "string"
      )
    ) return "changeset operation is invalid";
  } else if (schema === "delivery.v1") {
    if (parseDeliveryOutput(output) === null) {
      return "delivery.v1 output has an invalid shape";
    }
  }
  return null;
}

export async function resolveHookDenoBinary(
  configured = Deno.env.get("OPERANT_DENO_BIN"),
): Promise<string> {
  const candidate = configured ?? Deno.execPath();
  if (!candidate.startsWith("/")) {
    throw new Error("OPERANT_DENO_BIN must be an absolute path");
  }
  if (!configured && !/(?:^|\/)deno(?:\.exe)?$/.test(candidate)) {
    throw new Error(
      "OPERANT_DENO_BIN is required when the server executable is not Deno",
    );
  }
  const stat = await Deno.stat(candidate).catch(() => null);
  if (!stat?.isFile) throw new Error("configured Deno runtime is not a file");
  const probe = await new Deno.Command(candidate, {
    args: ["--version"],
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output().catch(() => null);
  if (
    !probe?.success ||
    !new TextDecoder().decode(probe.stdout).startsWith("deno ")
  ) {
    throw new Error("configured hook runtime is not a Deno interpreter");
  }
  return candidate;
}

function trustedPrelude(): string {
  return `(() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const safeFetch = async function (input, init = undefined) {
    const response = await nativeFetch(input, { ...(init ?? {}), redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      try { await response.body?.cancel(); } catch { /* response may already be closed */ }
      throw new Error("HTTP redirects are disabled");
    }
    return response;
  };
  Object.freeze(safeFetch);
  Object.defineProperty(globalThis, "fetch", {
    value: safeFetch,
    writable: false,
    enumerable: true,
    configurable: false,
  });
})();
const __operantDenyDynamicCode = function () {
  throw new Error("dynamic code evaluation is disabled");
};
for (const __operantTarget of [
  globalThis,
  Function.prototype,
  Object.getPrototypeOf(async function () {}),
  Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function* () {}),
]) {
  const __operantKey = __operantTarget === globalThis ? "eval" : "constructor";
  Object.defineProperty(__operantTarget, __operantKey, {
    value: __operantDenyDynamicCode,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}
for (const __operantGlobalName of [
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]) {
  Object.defineProperty(globalThis, __operantGlobalName, {
    value: __operantDenyDynamicCode,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}`;
}

async function removeEntry(path: string): Promise<void> {
  await Deno.remove(path).catch(() => undefined);
}

function curatedEnvelope(value: HookEnvelope): HookEnvelope {
  return {
    hook: value.hook,
    phase: value.phase,
    input: value.input,
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  };
}
function failure(
  hook: HookDefinition,
  started: number,
  code: string,
  message: string,
  logs = "",
  logsTruncated = false,
  secretsRedacted = false,
  exitCode: number | null = null,
): HookRunResult {
  return {
    ok: false,
    hook: hook.name,
    outputSchema: hook.outputSchema,
    logs,
    logsTruncated,
    secretsRedacted,
    durationMs: Math.round(performance.now() - started),
    exitCode,
    scriptDigest: hook.scriptDigest,
    error: { code, message, details: {} },
  };
}
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  truncate: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean; overflow?: boolean }> {
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (retained + value.length <= limit) {
      chunks.push(value);
      retained += value.length;
      continue;
    }
    if (!truncate) {
      await reader.cancel();
      return {
        bytes: concat(chunks, retained),
        truncated: false,
        overflow: true,
      };
    }
    const remaining = Math.max(0, limit - retained);
    if (remaining) {
      chunks.push(value.subarray(0, remaining));
      retained += remaining;
    }
    truncated = true;
  }
  return { bytes: concat(chunks, retained), truncated };
}
function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function startInputDelivery(
  child: Deno.ChildProcess,
  envelope: HookEnvelope,
): { writeAccepted: Promise<boolean>; settled: Promise<void> } {
  let resolveWriteAccepted!: (accepted: boolean) => void;
  let acceptanceResolved = false;
  const writeAccepted = new Promise<boolean>((resolve) => {
    resolveWriteAccepted = (accepted) => {
      if (acceptanceResolved) return;
      acceptanceResolved = true;
      resolve(accepted);
    };
  });
  const settled = (async () => {
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      writer = child.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(JSON.stringify(envelope)),
      );
      resolveWriteAccepted(true);
      // EOF is best-effort after the bytes have been accepted. A fast child may
      // exit after producing an authoritative result before close settles.
      await writer.close().catch(() => undefined);
    } catch {
      resolveWriteAccepted(false);
      await writer?.abort().catch(() => undefined);
    } finally {
      resolveWriteAccepted(false);
      try {
        writer?.releaseLock();
      } catch { /* stream already finalized */ }
    }
  })();
  return { writeAccepted, settled };
}

async function killAndReap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch { /* exited */ }
  await child.status.catch(() => undefined);
}
function retainedLogs(
  captured: { bytes: Uint8Array; truncated: boolean },
  values: string[],
  limit: number,
): { text: string; truncated: boolean; changed: boolean } {
  const redacted = redact(decode(captured.bytes), values);
  const encoded = new TextEncoder().encode(redacted.text);
  const truncated = captured.truncated || encoded.length > limit;
  const retained = truncated ? encoded.subarray(0, limit) : encoded;
  return {
    text: decode(retained) + (truncated ? TRUNCATION_MARKER : ""),
    truncated,
    changed: redacted.changed,
  };
}

function redact(
  text: string,
  values: string[],
): { text: string; changed: boolean } {
  let changed = false;
  for (const value of values) {
    if (text.includes(value)) {
      text = text.split(value).join("[REDACTED_SECRET]");
      changed = true;
    }
  }
  return { text, changed };
}
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
function containsForbiddenModuleSyntax(source: string): boolean {
  return /\bimport\b|\brequire\s*\(|\bfrom\s*["'`]/i.test(source);
}
function netList(value: HookPermissions["net"]): string[] {
  return Array.isArray(value) ? value : [];
}
function envList(value: HookPermissions["env"]): string[] {
  return Array.isArray(value) ? value : [];
}
function parseCeiling(
  value: string | undefined,
  absentIsUndefined: boolean,
): string[] | undefined {
  if (value === undefined) return absentIsUndefined ? undefined : [];
  return value === "" ? [] : value.split(",");
}
function blockedEndpoint(
  endpoint: string,
  serverPort: number | undefined,
  serverHosts: string[],
  database: string[],
): boolean {
  if (database.includes(endpoint)) return true;
  if (serverPort === undefined) return false;
  const parsed = parseEndpoint(endpoint);
  const aliases = new Set([
    ...serverHosts,
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "host.docker.internal",
  ].map((host) => host.replace(/^\[|\]$/g, "")));
  return parsed.port === serverPort && aliases.has(parsed.host);
}

function parseEndpoint(
  endpoint: string,
): { host: string; port: number | null } {
  const ipv6 = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(endpoint);
  if (ipv6) return { host: ipv6[1], port: ipv6[2] ? Number(ipv6[2]) : null };
  const separator = endpoint.lastIndexOf(":");
  if (separator > 0 && /^[0-9]+$/.test(endpoint.slice(separator + 1))) {
    return {
      host: endpoint.slice(0, separator),
      port: Number(endpoint.slice(separator + 1)),
    };
  }
  return { host: endpoint, port: null };
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: JsonRecord, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
function hasOnlyKeys(
  value: JsonRecord,
  allowed: string[],
  required: string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}
function validMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.every((key) =>
      ["path", "code", "message", "details"].includes(key)
    ) || !["path", "code", "message"].every((key) => Object.hasOwn(value, key))
  ) return false;
  return typeof value.path === "string" && typeof value.code === "string" &&
    typeof value.message === "string";
}
