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
  serverPort?: number;
  databaseEndpoints?: string[];
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
    const child = new Deno.Command(Deno.execPath(), {
      args,
      clearEnv: true,
      env: resolved.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    try {
      const writer = child.stdin.getWriter();
      await writer.write(
        new TextEncoder().encode(JSON.stringify(curatedEnvelope(envelope))),
      );
      await writer.close();
    } catch {
      await killAndReap(child);
      return failure(
        hook,
        started,
        "hook_spawn_failed",
        "hook input could not be delivered",
      );
    }

    const stdoutPromise = readBounded(
      child.stdout,
      this.#options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT,
      false,
    );
    const stderrPromise = readBounded(
      child.stderr,
      this.#options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT,
      true,
    );
    let timer: number | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), hook.timeoutMs);
    });
    const completed = await Promise.race([child.status, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (completed === "timeout") {
      await killAndReap(child);
      const stderr = await stderrPromise.catch(() => ({
        bytes: new Uint8Array(),
        truncated: false,
      }));
      await stdoutPromise.catch(() => undefined);
      const logs = redact(decode(stderr.bytes), redactions);
      return failure(
        hook,
        started,
        "hook_timeout",
        "hook execution timed out",
        logs.text,
        stderr.truncated,
        logs.changed,
      );
    }

    const [stdoutRead, stderrRead] = await Promise.all([
      stdoutPromise,
      stderrPromise,
    ]);
    if (stdoutRead.overflow) {
      return failure(
        hook,
        started,
        "hook_stdout_limit",
        "hook stdout exceeded the byte limit",
        redact(decode(stderrRead.bytes), redactions).text,
        stderrRead.truncated,
      );
    }
    const stdoutRedacted = redact(decode(stdoutRead.bytes), redactions);
    const stderrRedacted = redact(decode(stderrRead.bytes), redactions);
    const logs = stderrRedacted.text +
      (stderrRead.truncated ? TRUNCATION_MARKER : "");
    if (!completed.success) {
      return failure(
        hook,
        started,
        "hook_failed",
        "hook process failed",
        logs,
        stderrRead.truncated,
        stdoutRedacted.changed || stderrRedacted.changed,
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
        stderrRead.truncated,
        stdoutRedacted.changed || stderrRedacted.changed,
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
        stderrRead.truncated,
        stdoutRedacted.changed || stderrRedacted.changed,
        completed.code,
      );
    }
    return {
      ok: true,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      output: parsed as JsonRecord,
      logs,
      logsTruncated: stderrRead.truncated,
      secretsRedacted: stdoutRedacted.changed || stderrRedacted.changed,
      durationMs: Math.round(performance.now() - started),
      exitCode: completed.code,
      scriptDigest: hook.scriptDigest,
    };
  }

  async #materialize(hook: HookDefinition): Promise<string> {
    await Deno.mkdir(this.#cacheDir, { recursive: true, mode: 0o700 });
    const safeDigest = hook.scriptDigest.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = `${this.#cacheDir}/${safeDigest}.ts`;
    try {
      const existing = await Deno.readTextFile(path);
      if (existing !== hook.scriptContent) {
        throw new Error("stored hook digest collision");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await Deno.writeTextFile(path, hook.scriptContent, {
        createNew: true,
        mode: 0o600,
      });
    }
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
    if (!exactKeys(output, ["patches"]) || !Array.isArray(output.patches)) {
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
    if (
      !exactKeys(output, ["outcome"]) ||
      !["success", "retry", "dead_letter"].includes(String(output.outcome))
    ) return "delivery.v1 output has an invalid shape";
  }
  return null;
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
async function killAndReap(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch { /* exited */ }
  await child.status.catch(() => undefined);
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
  return /\bimport\b|\brequire\s*\(|\b(?:https?|file|data|blob|npm|jsr|node):|\bfrom\s*["'`]/i
    .test(source);
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
  database: string[],
): boolean {
  if (database.includes(endpoint)) return true;
  if (serverPort === undefined) return false;
  const host = endpoint.replace(/^\[|\](?=:|$)/g, "").split(":")[0];
  const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
  return port === serverPort &&
    ["localhost", "127.0.0.1", "0.0.0.0", "::1", "::", "host.docker.internal"]
      .includes(host);
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
