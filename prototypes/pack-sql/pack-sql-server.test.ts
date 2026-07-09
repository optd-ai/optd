import { startServer } from "./pack-sql-server.ts";

const crmV1 = new URL("../migration/packs/crm-v1", import.meta.url).pathname;
const crmDefault = new URL("../crm-default-pack", import.meta.url).pathname;

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

async function packForm(
  root: string,
  override?: { path: string; text: string },
) {
  const form = new FormData();
  for await (const path of walk(root)) {
    const rel = path.slice(root.length + 1);
    const text = override?.path === rel
      ? override.text
      : await Deno.readTextFile(path);
    form.append(rel, new File([text], rel));
  }
  if (override && ![...form.keys()].includes(override.path)) {
    form.append(override.path, new File([override.text], override.path));
  }
  return form;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    if (entry.isFile) yield path;
  }
}

async function postMultipart(url: string, path: string, form: FormData) {
  const response = await fetch(`${url}${path}`, { method: "POST", body: form });
  return { status: response.status, json: await response.json() };
}

Deno.test("pack preview compiles SQL steps without changing database", async () => {
  await withServer(async (url) => {
    const before = await (await fetch(`${url}/debug/schema`)).json();
    const preview = await postMultipart(
      url,
      "/packs/preview",
      await packForm(crmV1),
    );
    if (preview.status !== 200 || !preview.json.ok) {
      throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    }
    if (preview.json.databaseChanged !== false) {
      throw new Error("preview should not change database");
    }
    if (!preview.json.pack.resources.includes("lead")) {
      throw new Error("expected lead resource");
    }
    if (
      !preview.json.steps.some((s: any) =>
        s.kind === "create_resource_table" && s.target === "lead"
      )
    ) {
      throw new Error("expected lead create table step");
    }
    const after = await (await fetch(`${url}/debug/schema`)).json();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("preview changed schema");
    }
  });
});

Deno.test("pack apply stores revision metadata, uploaded files, hook scripts, and creates resource tables", async () => {
  await withServer(async (url) => {
    const apply = await postMultipart(
      url,
      "/packs/apply",
      await packForm(crmV1),
    );
    if (apply.status !== 200 || !apply.json.ok) {
      throw new Error(`apply failed: ${JSON.stringify(apply)}`);
    }
    if (apply.json.databaseChanged !== true) {
      throw new Error("apply should change database");
    }

    const schema = await (await fetch(`${url}/debug/schema`)).json();
    const tables = new Set(schema.tables.map((t: any) => t.tablename));
    for (
      const table of [
        "res_lead",
        "res_note",
        "pack_revisions",
        "hook_definitions",
        "rel_contact_company",
      ]
    ) {
      if (!tables.has(table)) throw new Error(`missing table ${table}`);
    }
    const columns = schema.columns.filter((c: any) =>
      c.table_name === "res_lead"
    );
    for (
      const column of [
        "id",
        "version",
        "archived_at",
        "name",
        "email",
        "company_name",
        "score",
        "status",
      ]
    ) {
      if (!columns.some((c: any) => c.column_name === column)) {
        throw new Error(`missing lead column ${column}`);
      }
    }
    const nameColumn = columns.find((c: any) => c.column_name === "name");
    if (nameColumn.is_nullable !== "NO") {
      throw new Error("required field should compile to not null");
    }
    const scoreColumn = columns.find((c: any) => c.column_name === "score");
    if (scoreColumn.data_type !== "integer") {
      throw new Error(`expected integer score, got ${scoreColumn.data_type}`);
    }

    const platform = await (await fetch(`${url}/debug/platform`)).json();
    if (platform.revisions.length !== 1 || !platform.revisions[0].active) {
      throw new Error("expected one active revision");
    }
    if (
      !platform.resources.some((r: any) =>
        r.name === "lead" && r.table_name === "res_lead"
      )
    ) throw new Error("missing lead resource metadata");
    if (
      !platform.fields.some((f: any) =>
        f.resource === "note" && f.name === "lead_id" && f.ref === "lead"
      )
    ) throw new Error("missing note.lead_id ref metadata");
    if (
      !platform.relationships.some((r: any) =>
        r.name === "contact_company" && r.table_name === "rel_contact_company"
      )
    ) {
      throw new Error("missing contact_company relationship metadata");
    }
    if (
      !platform.seeds.some((s: any) =>
        s.name === "lead_statuses" && s.resource === "lead_status"
      )
    ) {
      throw new Error("missing lead_statuses seed metadata");
    }
    if (
      !platform.seedRecords.some((r: any) =>
        r.seed_name === "lead_statuses" && r.key_value === "qualified"
      )
    ) {
      throw new Error("missing qualified seed record");
    }
    if (
      !platform.hooks.some((h: any) =>
        h.name === "convert_lead" &&
        h.script_path === "hooks/convert_lead.ts" && h.script_digest
      )
    ) throw new Error("missing hook script digest");
    if (
      !platform.files.some((f: any) =>
        f.path === "hooks/convert_lead.ts" && f.kind === "script"
      )
    ) throw new Error("missing uploaded script file record");
  });
});

Deno.test("default CRM pack exercises resources relationships lifecycles policies seeds actions and hooks", async () => {
  await withServer(async (url) => {
    const apply = await postMultipart(
      url,
      "/packs/apply",
      await packForm(crmDefault),
    );
    if (apply.status !== 200 || !apply.json.ok) {
      throw new Error(`default CRM apply failed: ${JSON.stringify(apply)}`);
    }
    for (
      const expected of [
        "lead",
        "contact",
        "company",
        "opportunity",
        "activity",
        "task",
      ]
    ) {
      if (!apply.json.pack.resources.includes(expected)) {
        throw new Error(`missing resource ${expected}`);
      }
    }
    if (!apply.json.pack.relationships.includes("opportunity_contact")) {
      throw new Error("missing relationship summary");
    }
    if (!apply.json.pack.seeds.includes("opportunity_stages")) {
      throw new Error("missing seed summary");
    }
    const schema = await (await fetch(`${url}/debug/schema`)).json();
    const tables = new Set(schema.tables.map((t: any) => t.tablename));
    for (
      const table of [
        "res_lead",
        "res_opportunity",
        "rel_contact_company",
        "rel_opportunity_contact",
      ]
    ) {
      if (!tables.has(table)) throw new Error(`missing table ${table}`);
    }
    const platform = await (await fetch(`${url}/debug/platform`)).json();
    if (platform.resources.length < 12) {
      throw new Error("expected full CRM resources");
    }
    if (platform.relationships.length < 8) {
      throw new Error("expected CRM relationships");
    }
    if (
      !platform.lifecycles.some((l: any) => l.name === "opportunity_pipeline")
    ) throw new Error("missing lifecycle");
    if (!platform.policies.some((p: any) => p.name === "sales_access")) {
      throw new Error("missing policy");
    }
    if (
      !platform.seedRecords.some((r: any) =>
        r.seed_name === "lost_reasons" && r.key_value === "competitor"
      )
    ) throw new Error("missing seed record");
  });
});

Deno.test("pack apply validates strict layout and hook script references", async () => {
  await withServer(async (url) => {
    const badPath = await postMultipart(
      url,
      "/packs/preview",
      await packForm(crmV1, {
        path: "misc/bad.yaml",
        text: '{"kind":"Resource","metadata":{"name":"bad"},"spec":{}}',
      }),
    );
    if (badPath.status !== 400 || badPath.json.error.code !== "bad_request") {
      throw new Error(
        `expected bad path rejection: ${JSON.stringify(badPath)}`,
      );
    }

    const missingScript = await postMultipart(
      url,
      "/packs/preview",
      await packForm(crmV1, {
        path: "hooks/convert_lead.yaml",
        text:
          '{"kind":"Hook","metadata":{"name":"convert_lead"},"spec":{"script":"missing.ts"}}',
      }),
    );
    if (
      missingScript.status !== 400 ||
      !missingScript.json.error.message.includes("missing script")
    ) {
      throw new Error(
        `expected missing script rejection: ${JSON.stringify(missingScript)}`,
      );
    }
  });
});
