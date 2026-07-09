import { startServer } from "./hook-runner.ts";

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

async function post(url: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

Deno.test("patch hook receives stdin envelope and returns patch.v1 output", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/normalize_lead/run", {
      phase: "before_preview",
      input: {
        operation: {
          op: "create",
          resource: "lead",
          fields: { name: "Ada", email: " ADA@EXAMPLE.COM " },
        },
      },
    });
    if (result.status !== 200 || !result.json.ok) {
      throw new Error(`hook failed: ${JSON.stringify(result)}`);
    }
    if (result.json.outputSchema !== "patch.v1") {
      throw new Error("expected patch.v1");
    }
    const patches = result.json.output.patches;
    if (
      !patches.some((p: any) =>
        p.path === "/fields/email" && p.value === "ada@example.com"
      )
    ) {
      throw new Error(`missing email patch: ${JSON.stringify(result.json)}`);
    }
    if (
      !patches.some((p: any) =>
        p.path === "/fields/status" && p.value === "new"
      )
    ) {
      throw new Error(
        `missing default status patch: ${JSON.stringify(result.json)}`,
      );
    }
    if (!result.json.logs.includes("normalize_lead processed")) {
      throw new Error("expected stderr logs to be captured");
    }
  });
});

Deno.test("validation hook returns structured validation.v1 errors and warnings", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/validate_lead/run", {
      phase: "validate",
      input: {
        operation: {
          op: "create",
          resource: "lead",
          fields: { name: "Ada", email: "bad" },
        },
      },
    });
    if (!result.json.ok) {
      throw new Error(
        `expected hook process ok: ${JSON.stringify(result.json)}`,
      );
    }
    if (result.json.output.allow !== false) {
      throw new Error("expected validation allow=false");
    }
    if (
      !result.json.output.errors.some((e: any) => e.code === "invalid_email")
    ) throw new Error("missing invalid_email");
    if (
      !result.json.output.warnings.some((w: any) =>
        w.code === "missing_company"
      )
    ) throw new Error("missing missing_company warning");
  });
});

Deno.test("action hook returns changeset.operations.v1 without mutating data itself", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/convert_lead/run", {
      phase: "action_preview",
      input: {
        lead: {
          id: "lead_1",
          version: 1,
          name: "Ada Lovelace",
          email: "ada@example.com",
          company_name: "Analytical Engines LLC",
        },
      },
    });
    if (!result.json.ok) {
      throw new Error(`hook failed: ${JSON.stringify(result.json)}`);
    }
    if (result.json.outputSchema !== "changeset.operations.v1") {
      throw new Error("expected changeset.operations.v1");
    }
    const operations = result.json.output.operations;
    for (const op of ["create", "link", "transition"]) {
      if (!operations.some((operation: any) => operation.op === op)) {
        throw new Error(`missing operation ${op}`);
      }
    }
    if (
      !operations.some((operation: any) => operation.resource === "opportunity")
    ) throw new Error("missing opportunity create");
  });
});

Deno.test("runner rejects invalid stdout JSON", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/bad_json/run", {
      phase: "validate",
      input: { operation: { op: "create" } },
    });
    if (result.json.ok !== false) {
      throw new Error("expected invalid stdout failure");
    }
    if (result.json.error.code !== "invalid_stdout_json") {
      throw new Error(
        `expected invalid_stdout_json: ${JSON.stringify(result.json)}`,
      );
    }
  });
});

Deno.test("runner captures Deno permission failures from scripts", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/permission_env_denied/run", {
      phase: "validate",
      input: {},
    });
    if (result.json.ok !== false) {
      throw new Error("expected permission failure");
    }
    if (result.json.error.code !== "hook_failed") {
      throw new Error(`expected hook_failed: ${JSON.stringify(result.json)}`);
    }
    if (!result.json.logs.includes("Requires env access")) {
      throw new Error(`expected Deno permission log: ${result.json.logs}`);
    }
  });
});

Deno.test("runner rejects permissions disabled by global policy before execution", async () => {
  await withServer(async (url) => {
    const result = await post(
      url,
      "/hooks/permission_env_blocked_by_policy/run",
      {
        phase: "validate",
        input: {},
      },
    );
    if (result.json.ok !== false) {
      throw new Error("expected global policy denial");
    }
    if (result.json.error.code !== "permission_policy_denied") {
      throw new Error(`expected policy denial: ${JSON.stringify(result.json)}`);
    }
    if (result.json.exitCode !== null) {
      throw new Error("expected hook not to execute");
    }
  });
});

Deno.test("runner injects declared secret refs as narrowly scoped env vars", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/use_secret/run", {
      phase: "validate",
      input: { envName: "CRM_API_KEY" },
    });
    if (!result.json.ok) {
      throw new Error(
        `expected secret hook success: ${JSON.stringify(result.json)}`,
      );
    }
    if (result.json.output.allow !== true) {
      throw new Error("expected allow true");
    }
    if (!result.json.logs.includes("CRM_API_KEY")) {
      throw new Error("expected secret access log");
    }
  });
});

Deno.test("runner fails closed when a hook references a missing secret", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/missing_secret/run", {
      phase: "validate",
      input: { envName: "MISSING_SECRET" },
    });
    if (result.json.ok !== false) {
      throw new Error("expected missing secret failure");
    }
    if (result.json.error.code !== "missing_secret") {
      throw new Error(
        `expected missing_secret: ${JSON.stringify(result.json)}`,
      );
    }
    if (result.json.exitCode !== null) {
      throw new Error("expected hook not to execute");
    }
  });
});

Deno.test("runner enforces hook timeout", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/timeout/run", {
      phase: "validate",
      input: {},
    });
    if (result.json.ok !== false) throw new Error("expected timeout failure");
    if (result.json.error.code !== "timeout") {
      throw new Error(`expected timeout: ${JSON.stringify(result.json)}`);
    }
  });
});

Deno.test("HTTP envelope validation returns stable error shape", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/hooks/validate_lead/run", {
      phase: "validate",
      input: [],
    });
    if (result.status !== 400) {
      throw new Error(`expected 400, got ${result.status}`);
    }
    if (result.json.error.code !== "bad_request") {
      throw new Error(`expected bad_request: ${JSON.stringify(result.json)}`);
    }
  });
});
