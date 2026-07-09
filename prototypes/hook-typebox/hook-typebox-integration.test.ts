import { runValidatedHook } from "./hook-typebox-integration.ts";

Deno.test("validates hook YAML shape maps input injects secrets and validates output", async () => {
  const result = await runValidatedHook({
    kind: "Hook",
    metadata: { name: "use_secret" },
    spec: {
      script: "use_secret.ts",
      secrets: [{ name: "crm_api_key", env: "CRM_API_KEY" }],
      output: { schema: "validation.v1" },
      attachments: [{
        phase: "changeset.validate",
        input: { envName: "CRM_API_KEY", actor: "$actor" },
      }],
    },
  }, { actor: { id: "agent" } });
  if (!result.ok) throw new Error(JSON.stringify(result));
  const ok = result as any;
  if (!ok.secretEnvNames.includes("CRM_API_KEY")) {
    throw new Error("missing secret env");
  }
  if (ok.output.allow !== true) {
    throw new Error("secret hook did not validate");
  }
});

Deno.test("missing secret fails before hook execution", async () => {
  const result = await runValidatedHook({
    kind: "Hook",
    metadata: { name: "use_secret" },
    spec: {
      script: "use_secret.ts",
      secrets: [{ name: "missing", env: "CRM_API_KEY" }],
      output: { schema: "validation.v1" },
    },
  }, {});
  if (result.ok) throw new Error("expected failure");
  if ((result as any).error.code !== "missing_secret") {
    throw new Error(JSON.stringify(result));
  }
});
