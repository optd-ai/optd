import { assertEquals } from "jsr:@std/assert";
import { loadPackFromFiles } from "../../src/adapters/outbound/yaml/pack_loader.ts";
import { buildMigrationPlan } from "../../src/domain/migrations/pack_migration.ts";

async function packFiles(dir: string) {
  const files = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) {
      files.push({
        path: entry.name,
        text: await Deno.readTextFile(`${dir}/${entry.name}`),
      });
    }
    if (entry.isDirectory) {
      for await (const child of Deno.readDir(`${dir}/${entry.name}`)) {
        files.push({
          path: `${entry.name}/${child.name}`,
          text: await Deno.readTextFile(`${dir}/${entry.name}/${child.name}`),
        });
      }
    }
  }
  return files;
}

Deno.test("pack migration classification covers safe risky and destructive blocked issues", async () => {
  const v1 = await loadPackFromFiles(
    await packFiles("tests/fixtures/migration-crm-v1"),
  );
  const v2 = await loadPackFromFiles(
    await packFiles("tests/fixtures/migration-crm-v2"),
  );
  const plan = await buildMigrationPlan({
    id: "mig_test",
    active: {
      revision: v1.revision,
      namespace: v1.namespace,
      name: v1.name,
      normalized: v1.normalized,
    },
    candidate: v2,
    liveFacts: {
      resourceRows: { lead: 1 },
      fieldPresentValues: { "lead.company_name": 1, "lead.priority": 1 },
    },
  });
  assertEquals(plan.summary.safe, 2);
  assertEquals(plan.summary.risky, 1);
  assertEquals(plan.summary.destructive, 1);
  assertEquals(plan.summary.blocked, 1);
  assertEquals(plan.status, "blocked");
  assertEquals(
    plan.changes.find((c) => c.kind === "add_field")?.status,
    "ready",
  );
  assertEquals(
    plan.changes.find((c) => c.kind === "change_field_type")?.class,
    "risky",
  );
  assertEquals(
    plan.changes.find((c) => c.kind === "remove_field")?.status,
    "blocked",
  );
});
