import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import { compilePackDdl } from "../../src/adapters/outbound/postgres/resource_ddl.ts";
import { DenoHookRunner } from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";

async function proofFiles(directory: string): Promise<UploadedPackFile[]> {
  const files: UploadedPackFile[] = [];
  async function visit(path: string, prefix = "") {
    for await (const entry of Deno.readDir(path)) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory) {
        await visit(`${path}/${entry.name}`, `${relative}/`);
      } else {
        files.push({
          path: relative,
          text: await Deno.readTextFile(`${path}/${entry.name}`),
        });
      }
    }
  }
  await visit(directory);
  return files;
}

for (
  const [name, directory] of [
    ["crm", "prototypes/crm-default-pack"],
    ["projects", "prototypes/project-management-pack"],
  ]
) {
  Deno.test(`optd Pack oracle: ${name} canonical source, storage and behavior identities`, async () => {
    const pack = await loadPackFromFiles(await proofFiles(directory));
    assertEquals(pack.publisher, "optd");
    assertEquals(pack.name, name);
    assertMatch(pack.revision, new RegExp(`^optd/${name}@`));
    for (
      const definition of [
        ...Object.values(pack.resources),
        ...Object.values(pack.relationships),
        ...Object.values(pack.actions),
        ...Object.values(pack.hooks),
        ...Object.values(pack.roles),
        ...Object.values(pack.policies),
        ...Object.values(pack.lifecycles),
        ...Object.values(pack.seeds),
      ]
    ) {
      assertEquals(definition.publisher, "optd");
      assertEquals(definition.identity, `optd/${name}:${definition.name}`);
      assertEquals(definition.document.apiVersion, "optd.dev/v1");
    }
    const ddl = await compilePackDdl(pack);
    assert(ddl.length > 0);
    assert(ddl.every((entry) => !entry.ddl.includes("operant")));
    if (name === "crm") {
      assert(pack.resources.lead);
      assert(pack.resources.opportunity);
      assert(pack.actions.convert_lead);
      assert(
        pack.scripts["hooks/convert_lead.ts"].content.includes(
          "optd/crm:opportunity",
        ),
      );
      assert(pack.seeds.lead_statuses);
    } else {
      assert(pack.resources.project_member);
      assert(pack.resources.timesheet);
      assertEquals(pack.resources.timesheet_entry, undefined);
      assert(pack.actions.start_task);
      assert(pack.actions.complete_task);
      assert(
        pack.scripts["hooks/complete_task.ts"].content.includes(
          "optd/projects:timesheet",
        ),
      );
    }
  });

  Deno.test(`optd Pack oracle: ${name} rejects legacy namespace on every document and old official publisher`, async () => {
    const files = await proofFiles(directory);
    for (const file of files.filter((entry) => entry.path.endsWith(".yaml"))) {
      await assertRejects(
        () =>
          loadPackFromFiles(
            files.map((entry) =>
              entry === file
                ? {
                  ...entry,
                  text: entry.text.replaceAll("optd.dev/v1", "operant.dev/v1"),
                }
                : entry
            ),
          ),
        Error,
        "must be equal to constant",
      );
    }
    await assertRejects(
      () =>
        loadPackFromFiles(files.map((entry) => ({
          ...entry,
          text: entry.text.replaceAll("publisher: optd", "publisher: operant")
            .replaceAll(`optd/${name}`, `operant/${name}`),
        }))),
      Error,
      "must NOT be valid",
    );
  });
}

function thirdParty(reference = "contact"): UploadedPackFile[] {
  return [
    {
      path: "pack.yaml",
      text:
        `kind: Pack\napiVersion: optd.dev/v1\nmetadata: {publisher: acme-tools, name: crm, version: 1.0.0}\nspec: {purpose: Independent publisher test., axi: {}}`,
    },
    {
      path: "resources/contact.yaml",
      text:
        `kind: Resource\napiVersion: optd.dev/v1\nmetadata: {name: contact}\nspec: {fields: {name: {type: string}}, axi: {}}`,
    },
    {
      path: "resources/lead.yaml",
      text:
        `kind: Resource\napiVersion: optd.dev/v1\nmetadata: {name: lead}\nspec: {fields: {contact: {type: string, ref: '${reference}'}}, axi: {}}`,
    },
  ];
}

Deno.test("optd Pack oracle: third-party publishers retain exact qualification without official remapping", async () => {
  for (const ref of ["contact", "acme-tools/crm:contact"]) {
    const pack = await loadPackFromFiles(thirdParty(ref));
    assertEquals(pack.publisher, "acme-tools");
    assertEquals(pack.resources.lead.identity, "acme-tools/crm:lead");
    assertEquals(pack.resources.lead.spec.fields, {
      contact: { type: "string", ref: "acme-tools/crm:contact" },
    });
  }
});

Deno.test("optd Pack oracle: legacy and malformed resource identities are rejected, never translated", async () => {
  for (
    const ref of [
      "operant/crm:contact",
      "operant/projects:timesheet",
      "default.contact",
      "@optd/crm:contact",
      "crm:contact",
      "optd/crm.contact",
    ]
  ) {
    await assertRejects(() => loadPackFromFiles(thirdParty(ref)), Error);
  }
});

Deno.test("optd Pack oracle: CRM conversion and Projects completion emit canonical effects", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "optd-pack-oracle-" });
  const id = "019b7a2e-7c10-7000-8000-000000000001";
  try {
    for (
      const fixture of [
        {
          namespace: "optd/crm",
          directory: "crm-default-pack",
          name: "convert_lead",
          input: {
            lead: { name: "Acme", company_name: "Acme" },
            input: { lead_id: id },
          },
          expected: [
            ["create", "optd/crm:company"],
            ["create", "optd/crm:contact"],
            ["create", "optd/crm:opportunity"],
            ["link", "optd/crm:contact_company"],
            ["link", "optd/crm:opportunity_company"],
            ["link", "optd/crm:opportunity_contact"],
            ["update", "optd/crm:lead"],
          ],
        },
        {
          namespace: "optd/projects",
          directory: "project-management-pack",
          name: "complete_task",
          input: {
            action_input: {
              task_id: id,
              stage_id: id,
              spent_hours: "1.25",
              entry_date: "2026-09-30",
            },
            task: { version: 1 },
            actor: { id },
          },
          expected: [["transition", "optd/projects:task"], [
            "create",
            "optd/projects:timesheet",
          ]],
        },
      ]
    ) {
      const result = await new DenoHookRunner({ cacheDir }).run({
        namespace: fixture.namespace,
        name: fixture.name,
        revision: "identity-oracle",
        scriptPath: `hooks/${fixture.name}.ts`,
        scriptDigest: `sha256:${"1".repeat(64)}`,
        scriptContent: await Deno.readTextFile(
          `prototypes/${fixture.directory}/hooks/${fixture.name}.ts`,
        ),
        outputSchema: "changeset.operations.v1",
        timeoutMs: 30_000,
        permissions: {},
      }, {
        hook: `${fixture.namespace}:${fixture.name}`,
        phase: "action.stage",
        input: fixture.input,
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const operations =
        (result.output as { operations: Record<string, unknown>[] }).operations;
      assertEquals(
        operations.map((op) => [op.op, op.resource ?? op.relationship]),
        fixture.expected,
      );
      if (fixture.name === "convert_lead") {
        assertEquals(operations.at(-1)?.set, { status: "converted" });
      } else {
        assertEquals(operations[0].to, "done");
        assertEquals(
          (operations[1].fields as Record<string, unknown>).hours,
          "1.25",
        );
      }
    }
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
