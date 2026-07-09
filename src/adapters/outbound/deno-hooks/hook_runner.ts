type JsonRecord = Record<string, unknown>;

export type HookOutputSchema =
  | "validation.v1"
  | "patch.v1"
  | "changeset.operations.v1";
export type HookPermissions = {
  net?: boolean;
  read?: boolean;
  write?: boolean;
  env?: boolean;
  run?: boolean;
};
export type HookSecretRef = { name: string; env: string };
export type HookDefinition = {
  namespace: string;
  name: string;
  revision: string;
  scriptPath: string;
  scriptDigest: string;
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
  durationMs: number;
  exitCode: number | null;
  scriptDigest: string;
  error?: { code: string; message: string; details: JsonRecord };
};

export type DenoHookRunnerOptions = {
  cacheDir?: string;
  globalPolicy?: Required<HookPermissions>;
  secretValues?: Record<string, string>;
};

const defaultGlobalPolicy: Required<HookPermissions> = {
  net: false,
  read: false,
  write: false,
  env: false,
  run: false,
};

export class DenoHookRunner {
  #cacheDir: string;
  #globalPolicy: Required<HookPermissions>;
  #secretValues: Record<string, string>;

  constructor(options: DenoHookRunnerOptions = {}) {
    this.#cacheDir = options.cacheDir ??
      `${Deno.env.get("TMPDIR") ?? "/tmp"}/operant-hook-cache`;
    this.#globalPolicy = options.globalPolicy ?? defaultGlobalPolicy;
    this.#secretValues = options.secretValues ?? {};
  }

  async run(
    hook: HookDefinition,
    envelope: HookEnvelope,
  ): Promise<HookRunResult> {
    const started = performance.now();
    const policyError = this.#validatePermissions(hook.permissions);
    if (policyError) {
      return failure(
        hook,
        started,
        null,
        "",
        "permission_policy_denied",
        policyError,
        {
          permissions: hook.permissions,
          globalPolicy: this.#globalPolicy,
        },
      );
    }
    if (hasImportStatement(hook.scriptContent)) {
      return failure(
        hook,
        started,
        null,
        "",
        "imports_disabled",
        "hook imports are disabled for MVP",
        {},
      );
    }
    const secretEnv = this.#resolveSecretEnv(hook);
    if ("error" in secretEnv) {
      return failure(
        hook,
        started,
        null,
        "",
        secretEnv.error.code,
        secretEnv.error.message,
        secretEnv.error.details,
      );
    }

    const scriptPath = await this.#materialize(hook);
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--no-prompt",
        ...permissionFlags(hook.permissions, hook.secrets ?? []),
        scriptPath,
      ],
      env: secretEnv.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    const stdin = child.stdin.getWriter();
    await stdin.write(new TextEncoder().encode(JSON.stringify(envelope)));
    await stdin.close();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), hook.timeoutMs);
    });
    const outputOrTimeout = await Promise.race([child.output(), timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (outputOrTimeout === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // process may already have exited
      }
      await child.status.catch(() => undefined);
      return failure(
        hook,
        started,
        null,
        "",
        "timeout",
        `hook exceeded ${hook.timeoutMs}ms`,
        {},
      );
    }

    const stdout = new TextDecoder().decode(outputOrTimeout.stdout).trim();
    const stderr = new TextDecoder().decode(outputOrTimeout.stderr).trim();
    const durationMs = Math.round(performance.now() - started);
    if (!outputOrTimeout.success) {
      return {
        ok: false,
        hook: hook.name,
        outputSchema: hook.outputSchema,
        logs: stderr,
        durationMs,
        exitCode: outputOrTimeout.code,
        scriptDigest: hook.scriptDigest,
        error: {
          code: "hook_failed",
          message: `hook exited with code ${outputOrTimeout.code}`,
          details: { stdout },
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return failure(
        hook,
        started,
        outputOrTimeout.code,
        stderr,
        "invalid_stdout_json",
        "hook stdout must be exactly one JSON object",
        { stdout },
      );
    }
    if (!isRecord(parsed)) {
      return failure(
        hook,
        started,
        outputOrTimeout.code,
        stderr,
        "invalid_stdout_shape",
        "hook stdout JSON must be an object",
        { stdout: parsed },
      );
    }
    const shapeError = validateOutputShape(hook.outputSchema, parsed);
    if (shapeError) {
      return failure(
        hook,
        started,
        outputOrTimeout.code,
        stderr,
        "invalid_output_schema",
        shapeError,
        { output: parsed },
      );
    }
    return {
      ok: true,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      output: parsed,
      logs: stderr,
      durationMs,
      exitCode: outputOrTimeout.code,
      scriptDigest: hook.scriptDigest,
    };
  }

  async #materialize(hook: HookDefinition): Promise<string> {
    await Deno.mkdir(this.#cacheDir, { recursive: true });
    const safeName = `${
      hook.scriptDigest.replace(/[^a-zA-Z0-9_-]/g, "_")
    }_${hook.name}.ts`;
    const path = `${this.#cacheDir}/${safeName}`;
    await Deno.writeTextFile(path, hook.scriptContent);
    return path;
  }

  #validatePermissions(permissions: HookPermissions): string | null {
    for (const key of ["net", "read", "write", "env", "run"] as const) {
      if (permissions[key] && !this.#globalPolicy[key]) {
        return `global policy denies ${key} permission`;
      }
    }
    return null;
  }

  #resolveSecretEnv(
    hook: HookDefinition,
  ): { env: Record<string, string> } | {
    error: NonNullable<HookRunResult["error"]>;
  } {
    const env: Record<string, string> = {};
    for (const ref of hook.secrets ?? []) {
      const value = this.#secretValues[ref.name];
      if (value === undefined) {
        return {
          error: {
            code: "missing_secret",
            message: `hook references missing secret ${ref.name}`,
            details: { secret: ref.name, env: ref.env },
          },
        };
      }
      env[ref.env] = value;
    }
    return { env };
  }
}

function failure(
  hook: HookDefinition,
  started: number,
  exitCode: number | null,
  logs: string,
  code: string,
  message: string,
  details: JsonRecord,
): HookRunResult {
  return {
    ok: false,
    hook: hook.name,
    outputSchema: hook.outputSchema,
    logs,
    durationMs: Math.round(performance.now() - started),
    exitCode,
    scriptDigest: hook.scriptDigest,
    error: { code, message, details },
  };
}

function permissionFlags(
  permissions: HookPermissions,
  secrets: HookSecretRef[],
): string[] {
  const flags: string[] = [];
  if (permissions.net) flags.push("--allow-net");
  if (permissions.read) flags.push("--allow-read");
  if (permissions.write) flags.push("--allow-write");
  const secretEnvNames = secrets.map((secret) => secret.env);
  if (permissions.env === true) flags.push("--allow-env");
  else if (secretEnvNames.length) {
    flags.push(`--allow-env=${secretEnvNames.join(",")}`);
  }
  if (permissions.run) flags.push("--allow-run");
  return flags;
}

export function validateOutputShape(
  schema: HookOutputSchema,
  output: JsonRecord,
): string | null {
  if (schema === "validation.v1") {
    if (output.allow !== undefined && typeof output.allow !== "boolean") {
      return "validation.v1 allow must be boolean";
    }
    if (output.errors !== undefined && !Array.isArray(output.errors)) {
      return "validation.v1 errors must be an array";
    }
    if (output.warnings !== undefined && !Array.isArray(output.warnings)) {
      return "validation.v1 warnings must be an array";
    }
  } else if (schema === "patch.v1") {
    if (!Array.isArray(output.patches)) {
      return "patch.v1 patches must be an array";
    }
    for (const patch of output.patches) {
      if (
        !isRecord(patch) || (patch.op !== "set" && patch.op !== "unset") ||
        typeof patch.path !== "string"
      ) {
        return "patch.v1 patches must contain {op,set|unset,path}";
      }
    }
  } else if (schema === "changeset.operations.v1") {
    if (!Array.isArray(output.operations)) {
      return "changeset.operations.v1 operations must be an array";
    }
    for (const operation of output.operations) {
      if (!isRecord(operation) || typeof operation.op !== "string") {
        return "each operation must contain op";
      }
    }
  }
  return null;
}

function hasImportStatement(source: string): boolean {
  return /^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source);
}
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
