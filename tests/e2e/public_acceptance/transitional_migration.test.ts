// deno-lint-ignore-file no-import-prefix no-unversioned-import no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { parseYamlJsonObject } from "../../../src/adapters/outbound/yaml/pack_loader.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

const CRM = "operant/crm";

for (const logLevel of ["info", "trace"] as const) {
  Deno.test(`public transitional migration is atomic using immutable plans (${logLevel})`, async () => {
    const harness = await startLiveHarness({
      environment: logLevel === "trace" ? { OPERANT_LOG_LEVEL: "trace" } : {},
    });
    const output: string[] = [];
    try {
      const bootstrap = await harness.bootstrap({
        username: "root",
        password: "migration acceptance password",
      });
      output.push(bootstrap.stdout, bootstrap.stderr);
      assertEquals(bootstrap.code, 0, bootstrap.stderr);
      const v1 = await makeRevision(harness, "v1", "1.0.0", "unchanged");
      const transitional = await makeRevision(harness, "v1-1", "1.1.0", "add");
      const final = await makeRevision(harness, "v2", "2.0.0", "remove");

      const installed = data(
        await ok(harness, ["--json", "pack", "apply", v1, "--safe"], output),
      );
      const v1Revision = installed.plan.to_pack_revision_id;
      const project = data(
        await ok(harness, [
          "--json",
          "project",
          "create",
          "migration",
          "--display-name",
          "Migration",
        ], output),
      );
      const created = await stage(harness, project.id, [{
        op: "create",
        key: "lead",
        project_id: project.id,
        resource: `${CRM}:lead`,
        fields: {
          name: "Legacy lead",
          email: "legacy@example.test",
          status: "new",
          phone: "555-0100",
        },
      }], output);
      const leadId = created.operations[0].object_id;
      await ok(harness, ["--json", "changeset", "commit", created.id], output);

      // Freeze the final candidate before cleanup: its blocker evidence must not
      // be rewritten by later facts or by applying the transitional revision.
      const earlyFinal =
        data(await ok(harness, ["--json", "pack", "preview", final], output))
          .plan;
      assertEquals(earlyFinal.class, "destructive");
      const earlyValidation = data(
        await ok(
          harness,
          ["--json", "migration", "validate", earlyFinal.id],
          output,
        ),
      );
      assertEquals(earlyValidation.status, "blocked");
      assertEquals(earlyValidation.blockers.length > 0, true);

      const preview = data(
        await ok(harness, ["--json", "pack", "preview", transitional], output),
      );
      assertEquals(preview.active, false);
      assertEquals(preview.plan.class, "safe");
      assertEquals(preview.plan.from_pack_revision_id, v1Revision);
      const inspect = data(
        await ok(
          harness,
          ["--json", "migration", "inspect", preview.plan.id],
          output,
        ),
      );
      assertEquals(inspect.id, preview.plan.id);
      const violations = data(
        await ok(harness, [
          "--json",
          "migration",
          "inspect",
          preview.plan.id,
          "--violations",
        ], output),
      );
      assertEquals(violations.blockers, []);
      const sql = data(
        await ok(harness, [
          "--json",
          "migration",
          "inspect",
          preview.plan.id,
          "--sql",
        ], output),
      );
      assert(sql.statements.length > 0 && sql.statements.length < 20);
      assert(
        sql.statements.every((statement: string) => statement.length < 4096),
      );
      const unauthorized = await fetch(
        `${harness.baseUrl}/api/v1/migrations/${preview.plan.id}`,
      );
      try {
        assertEquals(unauthorized.status, 401);
        assertEquals(
          (await unauthorized.json()).error.code,
          "authentication_required",
        );
      } finally {
        if (!unauthorized.bodyUsed) await unauthorized.body?.cancel();
      }
      const transitionalValidation = data(
        await ok(
          harness,
          ["--json", "migration", "validate", preview.plan.id],
          output,
        ),
      );
      assertEquals(transitionalValidation.status, "ready");
      await ok(harness, [
        "--json",
        "migration",
        "apply",
        preview.plan.id,
        "--safe",
      ], output);

      const beforeCleanup = await view(harness, project.id, leadId, output);
      assertEquals(beforeCleanup.data.phone, "555-0100");
      const beforeHistory = await history(harness, project.id, leadId, output);
      assertEquals(
        beforeHistory.items.filter((x: any) => x.kind === "object_version")
          .length,
        1,
      );

      // All business-data migration work goes through the ordinary immutable
      // changeset stage/inspect/commit surface.
      const cleanup = await stage(harness, project.id, [{
        op: "update",
        project_id: project.id,
        resource: `${CRM}:lead`,
        object_id: leadId,
        expected_version: 1,
        set: { normalized_phone: "5550100" },
        unset: ["phone"],
      }], output);
      const cleanupInspect = data(
        await ok(
          harness,
          ["--json", "changeset", "inspect", cleanup.id],
          output,
        ),
      );
      assertEquals(cleanupInspect, cleanup);
      await ok(harness, ["--json", "changeset", "commit", cleanup.id], output);
      const cleaned = await view(harness, project.id, leadId, output);
      assertEquals(cleaned.data.normalized_phone, "5550100");
      assertEquals(cleaned.data.phone, null);
      assertEquals(
        (await history(harness, project.id, leadId, output)).items.filter((
          x: any,
        ) => x.kind === "object_version").length,
        2,
      );

      const staleEarlyToken = earlyValidation.confirmation_token;
      assertEquals(staleEarlyToken, null);
      const finalPlan =
        data(await ok(harness, ["--json", "pack", "preview", final], output))
          .plan;
      assertEquals(finalPlan.class, "destructive");
      assertEquals(
        data(
          await ok(
            harness,
            ["--json", "migration", "validate", finalPlan.id],
            output,
          ),
        ).status,
        "ready",
      );
      await error(
        harness,
        ["migration", "apply", finalPlan.id, "--confirm-token", "wrong"],
        "migration_confirmation_invalid",
        output,
      );
      const token = data(
        await ok(
          harness,
          ["--json", "migration", "validate", finalPlan.id],
          output,
        ),
      ).confirmation_token;
      assert(typeof token === "string" && token.length === 43);

      // Fault barrier only: force a failure after migration DDL, then prove the
      // enclosing transaction retained activation, metadata and the old field.
      await query(
        harness.server.sql,
        `create function test_fail_migration_application() returns trigger language plpgsql as $$ begin raise exception 'acceptance injected failure'; end $$; create trigger test_fail_migration_application before insert on pack_migration_applications for each row execute function test_fail_migration_application()`,
      );
      await error(
        harness,
        ["migration", "apply", finalPlan.id, "--confirm-token", token],
        "migration_apply_failed",
        output,
      );
      await query(
        harness.server.sql,
        "drop trigger test_fail_migration_application on pack_migration_applications; drop function test_fail_migration_application() ",
      );
      assertEquals(
        await activeRevision(harness),
        preview.plan.to_pack_revision_id,
      );
      assert((await metadata(harness, output)).schema.fields.phone);
      assertEquals(
        (await view(harness, project.id, leadId, output)).data.normalized_phone,
        "5550100",
      );

      // A lock barrier exercises the bounded lock timeout without changing data.
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
      )).rows[0].table_name;
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = harness.server.sql.begin(async (tx) => {
        await query(tx, `lock table "${table}" in row exclusive mode`);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      await error(
        harness,
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
      release.resolve();
      await blocker;

      const freshToken = data(
        await ok(
          harness,
          ["--json", "migration", "validate", finalPlan.id],
          output,
        ),
      ).confirmation_token;
      await error(
        harness,
        ["migration", "apply", finalPlan.id, "--confirm-token", token],
        "migration_confirmation_invalid",
        output,
      );
      const applied = data(
        await ok(harness, [
          "--json",
          "migration",
          "apply",
          finalPlan.id,
          "--confirm-token",
          freshToken,
        ], output),
      );
      const repeated = data(
        await ok(harness, [
          "--json",
          "migration",
          "apply",
          finalPlan.id,
          "--confirm-token",
          freshToken,
        ], output),
      );
      assertEquals(repeated, applied);
      assertEquals(
        await activeRevision(harness),
        finalPlan.to_pack_revision_id,
      );
      const finalObject = await view(harness, project.id, leadId, output);
      assertEquals(finalObject.data.normalized_phone, "5550100");
      assertEquals(finalObject.data.phone, undefined);
      assertEquals(
        (await history(harness, project.id, leadId, output)).items.filter((
          x: any,
        ) => x.kind === "object_version").length,
        2,
      );
      assertEquals(
        (await metadata(harness, output)).schema.fields.phone,
        undefined,
      );

      const rejected = await harness.runJson(["--json", "changeset", "stage"], {
        project_id: project.id,
        operations: [{
          op: "update",
          project_id: project.id,
          resource: `${CRM}:lead`,
          object_id: leadId,
          expected_version: 2,
          set: { phone: "forbidden" },
        }],
      });
      output.push(rejected.stdout, rejected.stderr);
      assertEquals(rejected.code, 1);
      assertEquals(JSON.parse(rejected.stderr).error.code, "validation_failed");
      const toon = await ok(harness, [
        "--project",
        project.id,
        "view",
        `${CRM}:lead`,
        leadId,
      ], output);
      assertStringIncludes(toon.stdout, "normalized_phone");
      assertEquals(toon.stdout.includes("555-0100"), false);

      const staleSideEffectsBefore = await migrationSideEffects(
        harness,
        earlyFinal.id,
      );
      await error(
        harness,
        ["migration", "validate", earlyFinal.id],
        "migration_stale",
        output,
      );
      assertEquals(
        await migrationSideEffects(harness, earlyFinal.id),
        staleSideEffectsBefore,
      );
      // Confirmation tokens are expected response data from validate, so the
      // aggregate public-response transcript can only be checked for ambient
      // infrastructure secrets and internal diagnostics.
      assertNoLeaks(output.join("\n"), [harness.databaseUrl]);
    } finally {
      await harness.close();
    }
  });
}

async function makeRevision(
  harness: LiveHarness,
  name: string,
  version: string,
  phone: "unchanged" | "add" | "remove",
) {
  const dir = join(harness.rootDir, name);
  const copied = await new Deno.Command("cp", {
    args: ["-R", "prototypes/crm-default-pack", dir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(copied.code, 0, new TextDecoder().decode(copied.stderr));
  const packPath = join(dir, "pack.yaml");
  await Deno.writeTextFile(
    packPath,
    (await Deno.readTextFile(packPath)).replace(
      "version: 0.1.0",
      `version: ${version}`,
    ),
  );
  if (phone !== "unchanged") {
    const leadPath = join(dir, "resources", "lead.yaml");
    const lead = parseYamlJsonObject(
      await Deno.readTextFile(leadPath),
      leadPath,
    ) as any;
    if (phone === "add") lead.spec.fields.normalized_phone = { type: "string" };
    else {
      delete lead.spec.fields.phone;
      lead.spec.fields.normalized_phone = { type: "string" };
      lead.spec.axi.list.defaultFields = lead.spec.axi.list.defaultFields
        .filter((x: string) => x !== "phone");
    }
    await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));
    if (phone === "remove") {
      const actionPath = join(dir, "actions", "convert_lead.yaml");
      const action = parseYamlJsonObject(
        await Deno.readTextFile(actionPath),
        actionPath,
      ) as any;
      action.spec.reads.lead.fields = action.spec.reads.lead.fields.filter((
        x: string,
      ) => x !== "phone");
      await Deno.writeTextFile(actionPath, JSON.stringify(action, null, 2));
    }
  }
  return dir;
}

async function ok(
  h: LiveHarness,
  args: string[],
  out: string[],
  stdin?: string,
) {
  const r = await h.runOptctl(args, stdin);
  out.push(r.stdout, r.stderr);
  assertEquals(r.code, 0, `${r.stderr}\n${r.stdout}`);
  return r;
}
function data(r: { stdout: string }) {
  return JSON.parse(r.stdout).data;
}
async function error(
  h: LiveHarness,
  args: string[],
  code: string,
  out: string[],
) {
  const r = await h.runOptctl(["--json", ...args]);
  out.push(r.stdout, r.stderr);
  assertEquals(r.code, 1, r.stderr);
  assertEquals(JSON.parse(r.stderr).error.code, code);
}
async function stage(
  h: LiveHarness,
  projectId: string,
  operations: any[],
  out: string[],
) {
  const r = await h.runJson(["--json", "changeset", "stage"], {
    project_id: projectId,
    operations,
  });
  out.push(r.stdout, r.stderr);
  assertEquals(r.code, 0, r.stderr);
  return data(r);
}
async function view(
  h: LiveHarness,
  projectId: string,
  id: string,
  out: string[],
) {
  return data(
    await ok(
      h,
      ["--json", "--project", projectId, "view", `${CRM}:lead`, id],
      out,
    ),
  );
}
async function history(
  h: LiveHarness,
  projectId: string,
  id: string,
  out: string[],
) {
  return data(
    await ok(h, [
      "--json",
      "--project",
      projectId,
      "history",
      `${CRM}:lead`,
      id,
    ], out),
  );
}
async function metadata(h: LiveHarness, out: string[]) {
  return data(
    await ok(h, ["--json", "metadata", "resource", `${CRM}:lead`], out),
  );
}
async function migrationSideEffects(h: LiveHarness, planId: string) {
  return (await query<{
    validations: string;
    tokens: string;
    attempts: string;
  }>(
    h.server.sql,
    `select
       (select count(*)::text from pack_migration_validations where plan_id=$1) validations,
       (select count(*)::text from pack_migration_confirmation_tokens where plan_id=$1) tokens,
       (select count(*)::text from pack_migration_attempts where plan_id=$1) attempts`,
    [planId],
  )).rows[0];
}
async function activeRevision(h: LiveHarness) {
  return (await query<{ id: string }>(
    h.server.sql,
    "select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm'",
  )).rows[0].id;
}
function assertNoLeaks(text: string, secrets: string[]) {
  for (const secret of secrets) assertEquals(text.includes(secret), false);
  assertEquals(/postgres(?:ql)?:\/\//i.test(text), false);
  assertEquals(/\n\s+at\s+/i.test(text), false);
}
