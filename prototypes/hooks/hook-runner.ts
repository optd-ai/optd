type Json = Record<string, unknown>;

type OutputSchema = "validation.v1" | "patch.v1" | "changeset.operations.v1";
type Permissions = {
  net?: boolean;
  read?: boolean;
  write?: boolean;
  env?: boolean;
  run?: boolean;
};
type SecretRef = {
  name: string;
  env: string;
};
type HookDefinition = {
  name: string;
  scriptPath: string;
  outputSchema: OutputSchema;
  timeoutMs: number;
  permissions: Permissions;
  secrets?: SecretRef[];
};
type HookEnvelope = {
  hook: string;
  phase: string;
  input: Json;
  metadata?: Json;
};
type HookRunResult = {
  ok: boolean;
  hook: string;
  outputSchema: OutputSchema;
  output?: Json;
  logs: string;
  durationMs: number;
  exitCode: number | null;
  error?: { code: string; message: string; details: Json };
};

type App = {
  handler: (request: Request) => Promise<Response>;
};

const scriptRoot = new URL("./scripts/", import.meta.url).pathname;

const hooks: Record<string, HookDefinition> = {
  normalize_lead: {
    name: "normalize_lead",
    scriptPath: `${scriptRoot}normalize_lead.ts`,
    outputSchema: "patch.v1",
    timeoutMs: 1_000,
    permissions: {},
  },
  validate_lead: {
    name: "validate_lead",
    scriptPath: `${scriptRoot}validate_lead.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
  },
  convert_lead: {
    name: "convert_lead",
    scriptPath: `${scriptRoot}convert_lead.ts`,
    outputSchema: "changeset.operations.v1",
    timeoutMs: 1_000,
    permissions: {},
  },
  bad_json: {
    name: "bad_json",
    scriptPath: `${scriptRoot}bad_json.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
  },
  permission_env_denied: {
    name: "permission_env_denied",
    scriptPath: `${scriptRoot}permission_env.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
  },
  permission_env_blocked_by_policy: {
    name: "permission_env_blocked_by_policy",
    scriptPath: `${scriptRoot}permission_env.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: { env: true },
  },
  timeout: {
    name: "timeout",
    scriptPath: `${scriptRoot}timeout.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 20,
    permissions: {},
  },
  use_secret: {
    name: "use_secret",
    scriptPath: `${scriptRoot}use_secret.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
    secrets: [{ name: "crm_api_key", env: "CRM_API_KEY" }],
  },
  missing_secret: {
    name: "missing_secret",
    scriptPath: `${scriptRoot}use_secret.ts`,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
    secrets: [{ name: "missing_secret", env: "MISSING_SECRET" }],
  },
};

const secretStore: Record<string, string> = {
  crm_api_key: "sk_test_widget_crm_secret",
};

const globalPolicy: Required<Permissions> = {
  net: false,
  read: false,
  write: false,
  env: false,
  run: false,
};

export function createApp(): App {
  return { handler: route };
}

export async function startServer(port = 0) {
  const app = createApp();
  const server = Deno.serve({ port, hostname: "127.0.0.1" }, app.handler);
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    server,
    close: async () => await server.shutdown(),
  };
}

async function route(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/hooks") {
      return json({
        hooks: Object.fromEntries(
          Object.entries(hooks).map((
            [name, hook],
          ) => [name, {
            outputSchema: hook.outputSchema,
            timeoutMs: hook.timeoutMs,
            permissions: hook.permissions,
            secrets: hook.secrets?.map((secret) => ({
              name: secret.name,
              env: secret.env,
            })) ?? [],
          }]),
        ),
      });
    }
    const match = url.pathname.match(/^\/hooks\/([a-z_][a-z0-9_]*)\/run$/);
    if (request.method === "POST" && match) {
      const hook = hooks[match[1]];
      if (!hook) {
        return errorResponse("not_found", `unknown hook ${match[1]}`, 404);
      }
      const body = await readJson(request);
      const envelope = parseEnvelope(hook.name, body);
      return json(await runHook(hook, envelope));
    }
    return errorResponse("not_found", `${request.method} ${url.pathname}`, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      message.startsWith("bad_request:") ? "bad_request" : "internal_error",
      message,
      message.startsWith("bad_request:") ? 400 : 500,
    );
  }
}

export async function runHook(
  hook: HookDefinition,
  envelope: HookEnvelope,
): Promise<HookRunResult> {
  const started = performance.now();
  const policyError = validatePermissions(hook.permissions);
  if (policyError) {
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: "",
      durationMs: Math.round(performance.now() - started),
      exitCode: null,
      error: {
        code: "permission_policy_denied",
        message: policyError,
        details: { permissions: hook.permissions, globalPolicy },
      },
    };
  }

  const secretEnv = resolveSecretEnv(hook);
  if (secretEnv.error) {
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: "",
      durationMs: Math.round(performance.now() - started),
      exitCode: null,
      error: secretEnv.error,
    };
  }

  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      ...permissionFlags(hook.permissions, hook.secrets ?? []),
      hook.scriptPath,
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

  let timeoutId: number | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), hook.timeoutMs);
  });
  const outputOrTimeout = await Promise.race([child.output(), timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (outputOrTimeout === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process may already have exited.
    }
    await child.status.catch(() => undefined);
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: "",
      durationMs: Math.round(performance.now() - started),
      exitCode: null,
      error: {
        code: "timeout",
        message: `hook exceeded ${hook.timeoutMs}ms`,
        details: {},
      },
    };
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
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: stderr,
      durationMs,
      exitCode: outputOrTimeout.code,
      error: {
        code: "invalid_stdout_json",
        message: "hook stdout must be exactly one JSON object",
        details: { stdout },
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: stderr,
      durationMs,
      exitCode: outputOrTimeout.code,
      error: {
        code: "invalid_stdout_shape",
        message: "hook stdout JSON must be an object",
        details: { stdout: parsed },
      },
    };
  }

  const shapeError = validateOutputShape(hook.outputSchema, parsed);
  if (shapeError) {
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: stderr,
      durationMs,
      exitCode: outputOrTimeout.code,
      error: {
        code: "invalid_output_schema",
        message: shapeError,
        details: { output: parsed },
      },
    };
  }

  return {
    ok: true,
    hook: hook.name,
    outputSchema: hook.outputSchema,
    output: parsed,
    logs: stderr,
    durationMs,
    exitCode: outputOrTimeout.code,
  };
}

function validateOutputShape(
  schema: OutputSchema,
  output: Json,
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
  }
  if (schema === "patch.v1") {
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
  }
  if (schema === "changeset.operations.v1") {
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

function validatePermissions(permissions: Permissions): string | null {
  for (const key of ["net", "read", "write", "env", "run"] as const) {
    if (permissions[key] && !globalPolicy[key]) {
      return `global policy denies ${key} permission`;
    }
  }
  return null;
}

function permissionFlags(
  permissions: Permissions,
  secrets: SecretRef[] = [],
): string[] {
  const flags: string[] = [];
  if (permissions.net) flags.push("--allow-net");
  if (permissions.read) flags.push("--allow-read");
  if (permissions.write) flags.push("--allow-write");
  const secretEnvNames = secrets.map((secret) => secret.env);
  if (permissions.env === true) flags.push("--allow-env");
  else if (secretEnvNames.length > 0) {
    flags.push(`--allow-env=${secretEnvNames.join(",")}`);
  }
  if (permissions.run) flags.push("--allow-run");
  return flags;
}

function resolveSecretEnv(hook: HookDefinition):
  | { env: Record<string, string>; error?: undefined }
  | { env?: undefined; error: HookRunResult["error"] } {
  const env: Record<string, string> = {};
  for (const ref of hook.secrets ?? []) {
    const value = secretStore[ref.name];
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

function parseEnvelope(hook: string, value: unknown): HookEnvelope {
  if (!isRecord(value)) {
    throw new Error("bad_request: envelope must be an object");
  }
  if (value.hook !== undefined && value.hook !== hook) {
    throw new Error("bad_request: envelope hook does not match route");
  }
  if (typeof value.phase !== "string") {
    throw new Error("bad_request: phase is required");
  }
  if (!isRecord(value.input)) {
    throw new Error("bad_request: input object is required");
  }
  return {
    hook,
    phase: value.phase,
    input: value.input,
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("bad_request: request body must be JSON");
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function errorResponse(code: string, message: string, status: number) {
  return json({ ok: false, error: { code, message, details: [] } }, status);
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8788);
  await startServer(port);
}
