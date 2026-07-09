import { startServer } from "./pagination-server.ts";

const alice = { id: "alice", roles: ["sales_rep"], team_ids: ["team_west"] };
const manager = {
  id: "manager",
  roles: ["manager"],
  team_ids: ["team_west", "team_east"],
  can_include_archived: true,
};

async function withServer<T>(fn: (url: string) => Promise<T>) {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}
async function query(url: string, body: unknown) {
  const response = await fetch(`${url}/queries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

Deno.test("keyset pagination applies CEL filter and policy before limit", async () => {
  await withServer(async (url) => {
    const first = await query(url, {
      actor: alice,
      resource: "lead",
      where: 'status == "qualified"',
      limit: 2,
    });
    if (!first.json.ok) throw new Error(JSON.stringify(first.json));
    if (first.json.items.length !== 2) {
      throw new Error("expected full first page");
    }
    if (
      first.json.items.map((i: any) => i.id).join(",") !== "lead_10,lead_09"
    ) {
      throw new Error(
        `unexpected first page ${JSON.stringify(first.json.items)}`,
      );
    }
    if (!first.json.page.has_more || !first.json.page.next_cursor) {
      throw new Error("expected next cursor");
    }

    const second = await query(url, {
      actor: alice,
      resource: "lead",
      where: 'status == "qualified"',
      limit: 2,
      cursor: first.json.page.next_cursor,
    });
    if (
      second.json.items.map((i: any) => i.id).join(",") !== "lead_06,lead_04"
    ) {
      throw new Error(
        `unexpected second page ${JSON.stringify(second.json.items)}`,
      );
    }
    const seen = new Set(
      [...first.json.items, ...second.json.items].map((i: any) => i.id),
    );
    if (seen.size !== 4) throw new Error("duplicate rows across pages");
  });
});

Deno.test("default fields come from AXI list config and explicit fields reduce context", async () => {
  await withServer(async (url) => {
    const def = await query(url, { actor: alice, resource: "lead", limit: 1 });
    if (def.json.fields.source !== "axi.list.fields") {
      throw new Error("expected AXI field source");
    }
    if (
      Object.keys(def.json.items[0]).sort().join(",") !==
        "id,name,score,status,updated_at"
    ) {
      throw new Error(
        `unexpected default fields ${JSON.stringify(def.json.items[0])}`,
      );
    }

    const compact = await query(url, {
      actor: alice,
      resource: "lead",
      fields: ["id", "name"],
      limit: 1,
    });
    if (compact.json.fields.source !== "request") {
      throw new Error("expected request field source");
    }
    if (Object.keys(compact.json.items[0]).sort().join(",") !== "id,name") {
      throw new Error(
        `unexpected compact fields ${JSON.stringify(compact.json.items[0])}`,
      );
    }
  });
});

Deno.test("cursor is bound to filter sort and actor policy", async () => {
  await withServer(async (url) => {
    const first = await query(url, {
      actor: alice,
      resource: "lead",
      where: 'status == "qualified"',
      limit: 2,
    });
    const changedFilter = await query(url, {
      actor: alice,
      resource: "lead",
      where: 'status == "new"',
      limit: 2,
      cursor: first.json.page.next_cursor,
    });
    if (changedFilter.status !== 400) {
      throw new Error("expected cursor/filter mismatch rejection");
    }
    if (!changedFilter.json.error.message.includes("cursor does not match")) {
      throw new Error(JSON.stringify(changedFilter.json));
    }

    const changedActor = await query(url, {
      actor: manager,
      resource: "lead",
      where: 'status == "qualified"',
      limit: 2,
      cursor: first.json.page.next_cursor,
    });
    if (changedActor.status !== 400) {
      throw new Error("expected cursor/actor mismatch rejection");
    }
  });
});

Deno.test("include_archived requires permission", async () => {
  await withServer(async (url) => {
    const denied = await query(url, {
      actor: alice,
      resource: "lead",
      include_archived: true,
    });
    if (
      denied.status !== 400 ||
      !denied.json.error.message.includes("include_archived")
    ) throw new Error(`expected denial ${JSON.stringify(denied)}`);

    const allowed = await query(url, {
      actor: manager,
      resource: "lead",
      include_archived: true,
      where: 'owner_id == "alice"',
      fields: ["id", "archived_at"],
      sort: [{ field: "id", direction: "asc" }],
      limit: 10,
    });
    if (!allowed.json.ok) {
      throw new Error(
        `include_archived query failed: ${JSON.stringify(allowed.json)}`,
      );
    }
    if (
      !allowed.json.items.some((i: any) => i.id === "lead_02" && i.archived_at)
    ) throw new Error("expected archived lead visible to manager");
  });
});

Deno.test("limits and unsupported filters are rejected", async () => {
  await withServer(async (url) => {
    const tooLarge = await query(url, {
      actor: alice,
      resource: "lead",
      limit: 101,
    });
    if (
      tooLarge.status !== 400 ||
      !tooLarge.json.error.message.includes("limit_too_large")
    ) throw new Error("expected limit rejection");
    const badField = await query(url, {
      actor: alice,
      resource: "lead",
      where: 'secret == "x"',
    });
    if (
      badField.status !== 400 ||
      !badField.json.error.message.includes("unknown filter field")
    ) throw new Error(`expected bad field ${JSON.stringify(badField)}`);
    const badSort = await query(url, {
      actor: alice,
      resource: "lead",
      sort: [{ field: "name", direction: "asc" }],
    });
    if (
      badSort.status !== 400 ||
      !badSort.json.error.message.includes("unsupported sort field")
    ) throw new Error(`expected bad sort ${JSON.stringify(badSort)}`);
  });
});

Deno.test("one-level ReBAC policy fills page after SQL pushdown", async () => {
  await withServer(async (url) => {
    const res = await query(url, {
      actor: alice,
      resource: "lead",
      where: "score >= 50",
      fields: ["id", "team_id", "owner_id"],
      limit: 5,
    });
    const ids = res.json.items.map((i: any) => i.id);
    if (ids.length !== 5) {
      throw new Error(
        `expected full page from authorized rows, got ${ids.length}`,
      );
    }
    if (
      ids.includes("lead_08") || ids.includes("lead_07") ||
      ids.includes("lead_01")
    ) throw new Error(`policy leaked unauthorized rows: ${ids}`);
    if (res.json.policy.summary !== "role policy plus active()") {
      throw new Error("expected policy summary");
    }
  });
});
