import { startServer } from "./vertical-slice-server.ts";

const crmDefault = new URL("../crm-default-pack", import.meta.url).pathname;

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

async function packForm(root: string) {
  const form = new FormData();
  for await (const path of walk(root)) {
    const rel = path.slice(root.length + 1);
    form.append(rel, new File([await Deno.readTextFile(path)], rel));
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

async function post(url: string, path: string, body: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function applyPack(url: string) {
  const response = await fetch(`${url}/packs/apply`, {
    method: "POST",
    body: await packForm(crmDefault),
  });
  const json = await response.json();
  if (response.status !== 200 || !json.ok) {
    throw new Error(`pack apply failed: ${JSON.stringify(json)}`);
  }
  return json;
}

Deno.test("vertical slice applies CRM pack and seeds through committed changesets", async () => {
  await withServer(async (url) => {
    const applied = await applyPack(url);
    if (!applied.pack.resources.includes("lead")) {
      throw new Error("missing lead resource");
    }
    if (!applied.pack.relationships.includes("contact_company")) {
      throw new Error("missing relationship");
    }
    if (applied.seedChangesets.length < 5) {
      throw new Error("expected seed changesets");
    }

    const platform = await (await fetch(`${url}/debug/platform`)).json();
    if (platform.resources.length < 12) {
      throw new Error("expected full CRM resource registry");
    }
    if (!platform.changesets.some((c: any) => c.actor_id === "system:seed")) {
      throw new Error("seeds did not use changesets");
    }
    if (
      !platform.objectVersions.some((v: any) =>
        v.resource === "opportunity_stage" && v.object_id === "won"
      )
    ) throw new Error("missing seeded opportunity stage version");

    const home = await (await fetch(`${url}/metadata/home`)).json();
    if (home.system.active_pack !== "default.crm@0.1.0") {
      throw new Error("missing active pack home metadata");
    }
    if (!home.actions.includes("default.convert_lead")) {
      throw new Error("missing action home metadata");
    }
    const lead = await (await fetch(`${url}/metadata/resources/default/lead`))
      .json();
    if (!lead.schema.fields.name?.required) {
      throw new Error("missing lead field schema metadata");
    }
  });
});

Deno.test("vertical slice previews commits queries and records lead history", async () => {
  await withServer(async (url) => {
    await applyPack(url);
    const operations = [{
      op: "create",
      resource: "lead",
      id: "lead_ada",
      fields: {
        name: " Ada Lovelace ",
        email: "ADA@EXAMPLE.COM",
        company_name: "Analytical Engines",
        source: "web",
      },
    }];
    const preview = await post(url, "/changesets/preview", {
      actor_id: "agent_1",
      operations,
    });
    if (!preview.json.ok) {
      throw new Error(`preview failed: ${JSON.stringify(preview.json)}`);
    }
    if (preview.json.operations[0].fields.email !== "ada@example.com") {
      throw new Error("normalize hook did not lower email");
    }

    const commit = await post(url, "/changesets/commit", {
      actor_id: "agent_1",
      operations,
    });
    if (!commit.json.ok || commit.json.status !== "committed") {
      throw new Error(`commit failed: ${JSON.stringify(commit.json)}`);
    }

    const query = await post(url, "/queries", {
      resource: "lead",
      filter: 'status == "new" && active()',
      fields: ["id", "name", "email", "status"],
      limit: 10,
    });
    if (
      !query.json.items.some((row: any) =>
        row.id === "lead_ada" && row.email === "ada@example.com"
      )
    ) throw new Error(`query missed lead: ${JSON.stringify(query.json)}`);

    const history = await (await fetch(`${url}/history/lead/lead_ada`)).json();
    if (
      history.versions.length !== 1 ||
      history.versions[0].operation !== "create"
    ) throw new Error("missing lead history");
    if (!history.audit.length || !history.events.length) {
      throw new Error("missing audit/events");
    }
  });
});

Deno.test("vertical slice action hook converts lead and outbox worker executes after-commit hook", async () => {
  await withServer(async (url) => {
    await applyPack(url);
    await post(url, "/changesets/commit", {
      actor_id: "agent_1",
      operations: [{
        op: "create",
        resource: "lead",
        id: "lead_convert",
        fields: {
          name: "Grace Hopper",
          email: "grace@example.com",
          company_name: "Compiler Co",
          status: "qualified",
        },
      }],
    });

    const preview = await post(url, "/actions/convert_lead/preview", {
      actor_id: "agent_1",
      input: { lead_id: "lead_convert" },
    });
    if (
      !preview.json.operations.some((op: any) => op.resource === "opportunity")
    ) throw new Error("convert preview missing opportunity op");

    const commit = await post(url, "/actions/convert_lead/commit", {
      actor_id: "agent_1",
      input: { lead_id: "lead_convert" },
    });
    if (!commit.json.ok) {
      throw new Error(`convert commit failed: ${JSON.stringify(commit.json)}`);
    }

    const opportunities = await post(url, "/queries", {
      resource: "opportunity",
      filter: 'stage == "qualified" && active()',
      fields: ["id", "name", "stage", "lead_id"],
      limit: 10,
    });
    if (
      !opportunities.json.items.some((row: any) =>
        row.lead_id === "lead_convert"
      )
    ) throw new Error("missing converted opportunity");

    await post(url, "/outbox/process", {});
    const platform = await (await fetch(`${url}/debug/platform`)).json();
    if (
      !platform.hookExecutions.some((e: any) =>
        e.hook_name === "notify_crm_change" && e.status === "succeeded"
      )
    ) throw new Error("missing after-commit hook execution");
  });
});
