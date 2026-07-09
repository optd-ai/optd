import { PGlite } from "npm:@electric-sql/pglite";
import { deepRebacPolicy, policies, runScenarios } from "./policy-prototype.ts";

Deno.test("SQL-lowerable policies cover RBAC, ABAC, and one-level ReBAC combinations", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      new URL("./policy-prototype.ts", import.meta.url).pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`prototype failed\n${stderr}\n${stdout}`);
  }
  const summary = JSON.parse(stdout);
  if (summary.total !== 60) {
    throw new Error(`expected 60 scenarios, got ${summary.total}`);
  }
  if (summary.passed !== 60) {
    throw new Error(`expected all scenarios to pass: ${stdout}`);
  }
  for (const style of ["rbac", "abac", "rebac"]) {
    if (summary.byStyle[style].total !== 20) {
      throw new Error(`expected 20 ${style} scenarios`);
    }
    if (summary.byStyle[style].passed !== 20) {
      throw new Error(`expected 20 passing ${style} scenarios`);
    }
  }
});

Deno.test("deep ReBAC traversal is rejected as a hard constraint", async () => {
  const db = new PGlite();
  try {
    await runScenarios(db, [deepRebacPolicy()]);
    throw new Error("expected deep ReBAC to be rejected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("deep ReBAC is not supported")) throw error;
  } finally {
    await db.close();
  }
});
