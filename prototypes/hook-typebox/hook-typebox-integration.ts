import {
  HookSchema,
  validateWithSchema,
  ValidationOutputSchema,
} from "../typebox/typebox-spike.ts";

type Json = Record<string, unknown>;
const secretStore: Record<string, string> = { crm_api_key: "sk_test_secret" };

export async function runValidatedHook(config: unknown, context: Json) {
  const validation = validateWithSchema(HookSchema, config, "hook");
  if (!validation.ok) {
    return {
      ok: false,
      error: { code: "schema_validation_failed", details: validation.errors },
    };
  }
  const hook = config as any;
  const attachment = hook.spec.attachments?.[0];
  const input = mapInput(attachment?.input ?? { context: "$context" }, context);
  const env: Record<string, string> = {};
  for (const secret of hook.spec.secrets ?? []) {
    if (!secretStore[secret.name]) {
      return {
        ok: false,
        error: { code: "missing_secret", details: { secret: secret.name } },
      };
    }
    env[secret.env] = secretStore[secret.name];
  }
  const script =
    new URL(`../hooks/scripts/${hook.spec.script}`, import.meta.url).pathname;
  const args = [
    "run",
    "--quiet",
    "--no-prompt",
    hook.spec.secrets?.length
      ? `--allow-env=${hook.spec.secrets.map((s: any) => s.env).join(",")}`
      : "",
    script,
  ].filter(Boolean);
  const child = new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        hook: hook.metadata.name,
        phase: attachment?.phase ?? "changeset.validate",
        input,
      }),
    ),
  );
  await writer.close();
  const out = await child.output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (!out.success) {
    return { ok: false, error: { code: "hook_failed", stderr } };
  }
  const parsed = JSON.parse(stdout);
  const outputSchema = hook.spec.output.schema === "validation.v1"
    ? ValidationOutputSchema
    : undefined;
  if (outputSchema) {
    const outputValidation = validateWithSchema(outputSchema, parsed, "stdout");
    if (!outputValidation.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_output_schema",
          details: outputValidation.errors,
        },
      };
    }
  }
  return {
    ok: true,
    input,
    output: parsed,
    logs: stderr,
    secretEnvNames: Object.keys(env),
  };
}

function mapInput(mapping: Json, context: Json) {
  return Object.fromEntries(
    Object.entries(mapping).map((
      [key, value],
    ) => [key, resolve(value, context)]),
  );
}
function resolve(value: unknown, context: Json): unknown {
  if (value === "$context") return context;
  if (value === "$operation") return context.operation;
  if (value === "$actor") return context.actor;
  return value;
}
