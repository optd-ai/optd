// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import { assert, assertEquals } from "jsr:@std/assert";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
} from "../public_flow_contract.ts";
import type { CompletePublicFlowBackend } from "./backend.ts";
import { runJson } from "./helpers.ts";

const CRM = "operant/crm";

export async function runCompleteCrmMigration(
  harness: CompletePublicFlowBackend,
  human: PublicFlowLauncher,
  projectId: string,
  output: string[],
): Promise<void> {
  const [v1, transitional, final] = await Promise.all([
    harness.assetPath("crm_migration_v1"),
    harness.assetPath("crm_migration_transitional"),
    harness.assetPath("crm_migration_final"),
  ]);
  const installed = data(
    await ok(
      human.runCli([
        "--json",
        "pack",
        "apply",
        v1,
        "--safe",
      ]),
      output,
    ),
  );
  const v1Revision = String(installed.plan.to_pack_revision_id);
  const created = data(
    await ok(
      runJson(harness, ["--json", "changeset", "stage"], {
        project_id: projectId,
        operations: [{
          op: "create",
          key: "migration_lead",
          project_id: projectId,
          resource: `${CRM}:lead`,
          fields: {
            name: "Legacy migration lead",
            email: "migration@example.test",
            status: "new",
            phone: "555-0100",
          },
        }],
      }, human),
      output,
    ),
  );
  await ok(human.runCli(["--json", "changeset", "commit", created.id]), output);
  const leadId = String(created.operations[0].object_id);

  const earlyFinal = data(
    await ok(
      human.runCli([
        "--json",
        "pack",
        "preview",
        final,
      ]),
      output,
    ),
  ).plan;
  assertEquals(earlyFinal.class, "destructive");
  const earlyValidation = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "validate",
        earlyFinal.id,
      ]),
      output,
    ),
  );
  assertEquals(earlyValidation.status, "blocked");
  assert(earlyValidation.blockers.length > 0);
  assertEquals(earlyValidation.confirmation_token, null);

  const preview = data(
    await ok(
      human.runCli([
        "--json",
        "pack",
        "preview",
        transitional,
      ]),
      output,
    ),
  );
  assertEquals(preview.active, false);
  assertEquals(preview.plan.class, "safe");
  assertEquals(preview.plan.from_pack_revision_id, v1Revision);
  const inspect = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "inspect",
        preview.plan.id,
      ]),
      output,
    ),
  );
  assertEquals(inspect.id, preview.plan.id);
  const violations = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "inspect",
        preview.plan.id,
        "--violations",
      ]),
      output,
    ),
  );
  assertEquals(violations.blockers, []);
  const generatedSql = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "inspect",
        preview.plan.id,
        "--sql",
      ]),
      output,
    ),
  );
  assert(
    generatedSql.statements.length > 0 && generatedSql.statements.length < 20,
  );
  assert(
    generatedSql.statements.every((statement: string) =>
      statement.length < 4096
    ),
  );
  const unauthorized = await fetch(
    `${harness.serverOrigin}/api/v1/migrations/${preview.plan.id}`,
  );
  assertEquals(unauthorized.status, 401);
  await unauthorized.body?.cancel();
  assertEquals(
    data(
      await ok(
        human.runCli([
          "--json",
          "migration",
          "validate",
          preview.plan.id,
        ]),
        output,
      ),
    ).status,
    "ready",
  );
  await ok(
    human.runCli([
      "--json",
      "migration",
      "apply",
      preview.plan.id,
      "--safe",
    ]),
    output,
  );

  const beforeCleanup = data(
    await ok(
      human.runCli([
        "--json",
        "--project",
        projectId,
        "view",
        `${CRM}:lead`,
        leadId,
      ]),
      output,
    ),
  );
  assertEquals(beforeCleanup.data.phone, "555-0100");
  const cleanup = data(
    await ok(
      runJson(harness, ["--json", "changeset", "stage"], {
        project_id: projectId,
        operations: [{
          op: "update",
          project_id: projectId,
          resource: `${CRM}:lead`,
          object_id: leadId,
          expected_version: 1,
          set: { normalized_phone: "5550100" },
          unset: ["phone"],
        }],
      }, human),
      output,
    ),
  );
  assertEquals(
    data(
      await ok(
        human.runCli([
          "--json",
          "changeset",
          "inspect",
          cleanup.id,
        ]),
        output,
      ),
    ),
    cleanup,
  );
  await ok(human.runCli(["--json", "changeset", "commit", cleanup.id]), output);

  const finalPlan = data(
    await ok(
      human.runCli([
        "--json",
        "pack",
        "preview",
        final,
      ]),
      output,
    ),
  ).plan;
  assertEquals(finalPlan.class, "destructive");
  const finalValidation = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "validate",
        finalPlan.id,
      ]),
      output,
    ),
  );
  assertEquals(finalValidation.status, "ready");
  await expectedError(
    human,
    [
      "migration",
      "apply",
      finalPlan.id,
      "--confirm-token",
      "wrong",
    ],
    "migration_confirmation_invalid",
    output,
  );
  const token = String(finalValidation.confirmation_token);
  assertEquals(token.length, 43);
  const beforeFault = await harness.observeMigration();
  await harness.installMigrationFailureBarrier();
  try {
    await expectedError(
      human,
      [
        "migration",
        "apply",
        finalPlan.id,
        "--confirm-token",
        token,
      ],
      "migration_apply_failed",
      output,
    );
  } finally {
    await harness.removeMigrationFailureBarrier();
  }
  assertEquals(await harness.observeMigration(), beforeFault);

  await harness.holdMigrationTableLock();
  try {
    await expectedError(
      human,
      [
        "migration",
        "apply",
        finalPlan.id,
        "--confirm-token",
        token,
        "--timeout",
        "1ms",
      ],
      "pack_install_busy",
      output,
    );
  } finally {
    await harness.releaseMigrationTableLock();
  }
  assertEquals(await harness.observeMigration(), beforeFault);
  const freshToken = String(
    data(
      await ok(
        human.runCli([
          "--json",
          "migration",
          "validate",
          finalPlan.id,
        ]),
        output,
      ),
    ).confirmation_token,
  );
  await expectedError(
    human,
    [
      "migration",
      "apply",
      finalPlan.id,
      "--confirm-token",
      token,
    ],
    "migration_confirmation_invalid",
    output,
  );
  const applied = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "apply",
        finalPlan.id,
        "--confirm-token",
        freshToken,
      ]),
      output,
    ),
  );
  const repeated = data(
    await ok(
      human.runCli([
        "--json",
        "migration",
        "apply",
        finalPlan.id,
        "--confirm-token",
        freshToken,
      ]),
      output,
    ),
  );
  assertEquals(repeated, applied);

  const finalEvidence = await harness.observeMigration();
  assertEquals(finalEvidence.activeRevisionId, finalPlan.to_pack_revision_id);
  const finalMetadata = data(
    await ok(
      human.runCli([
        "--json",
        "metadata",
        "resource",
        `${CRM}:lead`,
      ]),
      output,
    ),
  );
  assertEquals(finalMetadata.schema.fields.phone, undefined);
  assert(finalMetadata.schema.fields.normalized_phone);
  const finalObject = data(
    await ok(
      human.runCli([
        "--json",
        "--project",
        projectId,
        "view",
        `${CRM}:lead`,
        leadId,
      ]),
      output,
    ),
  );
  assertEquals(finalObject.data.normalized_phone, "5550100");
  assertEquals(finalObject.data.phone, undefined);
  const history = data(
    await ok(
      human.runCli([
        "--json",
        "--project",
        projectId,
        "history",
        `${CRM}:lead`,
        leadId,
      ]),
      output,
    ),
  );
  assertEquals(
    history.items.filter((item: any) => item.kind === "object_version").length,
    2,
  );
  const removedField = await runJson(
    harness,
    ["--json", "changeset", "stage"],
    {
      project_id: projectId,
      operations: [{
        op: "update",
        project_id: projectId,
        resource: `${CRM}:lead`,
        object_id: leadId,
        expected_version: 2,
        set: { phone: "forbidden" },
      }],
    },
    human,
  );
  output.push(removedField.stdout, removedField.stderr);
  assertEquals(removedField.code, 1);
  assertEquals(JSON.parse(removedField.stderr).error.code, "validation_failed");
  const staleEffects = await harness.observeMigrationSideEffects(earlyFinal.id);
  await expectedError(
    human,
    [
      "migration",
      "validate",
      earlyFinal.id,
    ],
    "migration_stale",
    output,
  );
  assertEquals(
    await harness.observeMigrationSideEffects(earlyFinal.id),
    staleEffects,
  );
  assertEquals(/postgres(?:ql)?:\/\//i.test(output.join("\n")), false);
}

async function ok(promise: Promise<PublicFlowCommandResult>, output: string[]) {
  const result = await promise;
  output.push(result.stdout, result.stderr);
  assertEquals(result.code, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}
function data(result: PublicFlowCommandResult): any {
  return JSON.parse(result.stdout).data;
}
async function expectedError(
  launcher: PublicFlowLauncher,
  args: string[],
  code: string,
  output: string[],
) {
  const result = await launcher.runCli(["--json", ...args]);
  output.push(result.stdout, result.stderr);
  assertEquals(result.code, 1, result.stderr);
  assertEquals(JSON.parse(result.stderr).error.code, code);
}
