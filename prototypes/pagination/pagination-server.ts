import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
type Actor = {
  id: string;
  roles: string[];
  team_ids: string[];
  can_include_archived?: boolean;
};
type Sort = { field: "updated_at" | "score" | "id"; direction: "asc" | "desc" };
type QueryRequest = {
  actor: Actor;
  resource: "lead";
  fields?: string[];
  where?: string;
  sort?: Sort[];
  limit?: number;
  cursor?: string | null;
  include_archived?: boolean;
};
type Compiled = { sql: string; params: unknown[]; summary: string };

const defaultAxiFields = {
  lead: ["id", "name", "status", "score", "updated_at"],
};
const allowedFields = new Set([
  "id",
  "name",
  "status",
  "score",
  "owner_id",
  "team_id",
  "updated_at",
  "archived_at",
]);

export async function createApp() {
  const db = new PGlite();
  await initialize(db);
  return {
    db,
    handler: (request: Request) => route(db, request),
    close: async () => await db.close(),
  };
}

export async function startServer(port = 0) {
  const app = await createApp();
  const server = Deno.serve({ hostname: "127.0.0.1", port }, app.handler);
  return {
    app,
    url: `http://127.0.0.1:${server.addr.port}`,
    close: async () => {
      await server.shutdown();
      await app.close();
    },
  };
}

async function initialize(db: PGlite) {
  await db.exec(`
    create table res_lead(
      id text primary key,
      name text not null,
      status text not null,
      score integer not null,
      owner_id text not null,
      team_id text not null,
      updated_at timestamptz not null,
      archived_at timestamptz
    );
    create index res_lead_updated_id_idx on res_lead(updated_at desc, id desc);
    create index res_lead_score_id_idx on res_lead(score desc, id desc);
    create table actor_team_memberships(actor_id text not null, team_id text not null, primary key(actor_id, team_id));
    insert into actor_team_memberships values ('alice', 'team_west'), ('manager', 'team_west'), ('manager', 'team_east');
  `);
  const rows = [
    [
      "lead_10",
      "Ten",
      "qualified",
      95,
      "alice",
      "team_west",
      "2026-01-10T00:00:00Z",
      null,
    ],
    [
      "lead_09",
      "Nine",
      "qualified",
      90,
      "bob",
      "team_west",
      "2026-01-09T00:00:00Z",
      null,
    ],
    [
      "lead_08",
      "Eight",
      "new",
      85,
      "carol",
      "team_east",
      "2026-01-08T00:00:00Z",
      null,
    ],
    [
      "lead_07",
      "Seven",
      "qualified",
      80,
      "dave",
      "team_east",
      "2026-01-07T00:00:00Z",
      null,
    ],
    [
      "lead_06",
      "Six",
      "qualified",
      75,
      "alice",
      "team_west",
      "2026-01-06T00:00:00Z",
      null,
    ],
    [
      "lead_05",
      "Five",
      "lost",
      70,
      "bob",
      "team_west",
      "2026-01-05T00:00:00Z",
      null,
    ],
    [
      "lead_04",
      "Four",
      "qualified",
      65,
      "alice",
      "team_west",
      "2026-01-04T00:00:00Z",
      null,
    ],
    [
      "lead_03",
      "Three",
      "qualified",
      60,
      "carol",
      "team_east",
      "2026-01-03T00:00:00Z",
      null,
    ],
    [
      "lead_02",
      "Two",
      "new",
      55,
      "alice",
      "team_west",
      "2026-01-02T00:00:00Z",
      "2026-02-01T00:00:00Z",
    ],
    [
      "lead_01",
      "One",
      "qualified",
      50,
      "erin",
      "team_none",
      "2026-01-01T00:00:00Z",
      null,
    ],
  ];
  for (const row of rows) {
    await db.query(
      "insert into res_lead(id, name, status, score, owner_id, team_id, updated_at, archived_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      row,
    );
  }
}

async function route(db: PGlite, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/queries") {
      return json(await runQuery(db, parseQuery(await request.json())));
    }
    return error("not_found", `${request.method} ${url.pathname}`, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      message.startsWith("bad_request:") ? "bad_request" : "internal_error",
      message,
      message.startsWith("bad_request:") ? 400 : 500,
    );
  }
}

function parseQuery(value: unknown): QueryRequest {
  if (!isRecord(value)) throw new Error("bad_request: body must be object");
  const actor = value.actor;
  if (
    !isRecord(actor) || typeof actor.id !== "string" ||
    !Array.isArray(actor.roles) || !Array.isArray(actor.team_ids)
  ) throw new Error("bad_request: actor id, roles, team_ids required");
  if (value.resource !== "lead") {
    throw new Error("bad_request: only lead resource is supported");
  }
  if (
    value.fields !== undefined &&
    (!Array.isArray(value.fields) ||
      !value.fields.every((f) => typeof f === "string" && allowedFields.has(f)))
  ) throw new Error("bad_request: unknown requested field");
  const limit = value.limit === undefined ? 20 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("bad_request: limit must be positive integer");
  }
  if (limit > 100) {
    throw new Error("bad_request: limit_too_large maximum is 100");
  }
  const sort = parseSort(value.sort);
  return {
    actor: {
      id: actor.id,
      roles: actor.roles as string[],
      team_ids: actor.team_ids as string[],
      can_include_archived: actor.can_include_archived === true,
    },
    resource: "lead",
    fields: value.fields as string[] | undefined,
    where: typeof value.where === "string" ? value.where : undefined,
    sort,
    limit,
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    include_archived: value.include_archived === true,
  };
}

function parseSort(value: unknown): Sort[] {
  if (value === undefined) {
    return [{ field: "updated_at", direction: "desc" }, {
      field: "id",
      direction: "desc",
    }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("bad_request: sort must be non-empty array");
  }
  const sort = value.map((s) => {
    if (
      !isRecord(s) || typeof s.field !== "string" ||
      typeof s.direction !== "string"
    ) throw new Error("bad_request: invalid sort");
    if (!(["updated_at", "score", "id"].includes(s.field))) {
      throw new Error("bad_request: unsupported sort field");
    }
    if (s.direction !== "asc" && s.direction !== "desc") {
      throw new Error("bad_request: unsupported sort direction");
    }
    return {
      field: s.field as Sort["field"],
      direction: s.direction as Sort["direction"],
    };
  });
  if (!sort.some((s) => s.field === "id")) {
    sort.push({ field: "id", direction: sort[0].direction });
  }
  return sort;
}

async function runQuery(db: PGlite, req: QueryRequest) {
  if (req.include_archived && !req.actor.can_include_archived) {
    throw new Error("bad_request: include_archived requires permission");
  }
  const fields = req.fields?.length ? req.fields : defaultAxiFields.lead;
  const filter = compileCel(req.where ?? "true", 1);
  const policy = compilePolicy(
    req.actor,
    filter.params.length + 1,
    req.include_archived === true,
  );
  const cursor = req.cursor ? decodeCursor(req.cursor) : null;
  const digest = queryDigest(req, filter.summary, policy.summary);
  if (cursor && cursor.digest !== digest) {
    throw new Error(
      "bad_request: cursor does not match query/filter/sort/actor policy",
    );
  }
  const cursorPred = cursor
    ? compileCursor(
      req.sort!,
      asCursorLast(cursor.last),
      filter.params.length + policy.params.length + 1,
    )
    : { sql: "true", params: [] };
  const params = [...filter.params, ...policy.params, ...cursorPred.params];
  const sql = `
    select ${fields.map((f) => `o.${qi(f)}`).join(", ")}
    from res_lead o
    ${policy.joins.join("\n")}
    where (${filter.sql}) and (${policy.sql}) and (${cursorPred.sql})
    order by ${
    req.sort!.map((s) => `o.${qi(s.field)} ${s.direction}`).join(", ")
  }
    limit ${req.limit! + 1}
  `;
  const result = await db.query<Json>(sql, params);
  const rows = result.rows;
  const hasMore = rows.length > req.limit!;
  const items = rows.slice(0, req.limit!);
  return {
    ok: true,
    resource: req.resource,
    items,
    page: {
      limit: req.limit,
      returned: items.length,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
          digest,
          last: lastValues(items.at(-1)!, req.sort!),
          sort: req.sort,
        })
        : null,
      sort: req.sort,
    },
    fields: {
      source: req.fields?.length ? "request" : "axi.list.fields",
      returned: fields,
    },
    filter: { applied: Boolean(req.where), summary: filter.summary },
    policy: { applied: true, summary: policy.summary },
    help: [
      "Use page.next_cursor to continue.",
      "Request fewer fields to reduce context.",
      "Use object detail for full records.",
    ],
  };
}

function compilePolicy(
  actor: Actor,
  start: number,
  includeArchived: boolean,
): Compiled & { joins: string[] } {
  const activeSql = includeArchived ? "true" : "o.archived_at is null";
  if (actor.roles.includes("manager")) {
    return {
      sql: `(true) and (${activeSql})`,
      params: [],
      joins: [],
      summary: includeArchived
        ? "manager policy; archived included by permission"
        : "manager policy plus active()",
    };
  }
  if (actor.roles.includes("sales_rep")) {
    return {
      sql:
        `(o.owner_id = $${start} or atm.actor_id is not null) and (${activeSql})`,
      params: [actor.id, actor.id],
      joins: [
        `left join actor_team_memberships atm on atm.actor_id = $${
          start + 1
        } and atm.team_id = o.team_id`,
      ],
      summary: includeArchived
        ? "sales_rep owner/team policy; archived included by permission"
        : "role policy plus active()",
    };
  }
  return {
    sql: "false",
    params: [],
    joins: [],
    summary: "no matching role policy",
  };
}

function compileCel(expr: string, start: number): Compiled {
  const params: unknown[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return `$${start + params.length - 1}`;
  };
  let sql = expr.trim();
  if (sql === "" || sql === "true") {
    return { sql: "true", params, summary: "true" };
  }
  sql = sql.replace(/\bactive\(\)/g, "o.archived_at is null");
  sql = sql.replace(/\s&&\s/g, " and ").replace(/\s\|\|\s/g, " or ");
  sql = sql.replace(/!\s*\(/g, "not (");
  sql = sql.replace(
    /\b([a-z_][a-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*("[^"]*"|'[^']*'|\d+)/g,
    (_m, field, op, raw) => {
      if (!allowedFields.has(field)) {
        throw new Error(`bad_request: unknown filter field ${field}`);
      }
      const value = raw.startsWith('"') || raw.startsWith("'")
        ? raw.slice(1, -1)
        : Number(raw);
      const sqlOp = op === "==" ? "=" : op === "!=" ? "<>" : op;
      return `o.${qi(field)} ${sqlOp} ${next(value)}`;
    },
  );
  if (/[^\w\s$.<>=()'"-]/.test(sql.replace(/<>/g, ""))) {
    throw new Error("bad_request: unsupported CEL filter syntax");
  }
  return { sql, params, summary: expr };
}

function asCursorLast(value: unknown): Json {
  if (!isRecord(value)) {
    throw new Error("bad_request: invalid cursor last values");
  }
  return value;
}

function compileCursor(sort: Sort[], last: Json, start: number) {
  if (
    sort.length !== 2 || sort[1].field !== "id" ||
    sort[0].direction !== sort[1].direction
  ) {
    throw new Error(
      "bad_request: prototype cursor supports primary sort plus id with same direction",
    );
  }
  const op = sort[0].direction === "desc" ? "<" : ">";
  return {
    sql: `(o.${qi(sort[0].field)}, o.id) ${op} ($${start}, $${start + 1})`,
    params: [last[sort[0].field], last.id],
  };
}

function lastValues(row: Json, sort: Sort[]) {
  return Object.fromEntries(sort.map((s) => [s.field, row[s.field]]));
}
function encodeCursor(value: Json) {
  return btoa(JSON.stringify(value));
}
function decodeCursor(value: string): Json {
  try {
    return JSON.parse(atob(value));
  } catch {
    throw new Error("bad_request: invalid cursor");
  }
}
function queryDigest(
  req: QueryRequest,
  filterSummary: string,
  policySummary: string,
) {
  return digestText(JSON.stringify({
    resource: req.resource,
    where: filterSummary,
    sort: req.sort,
    actor: req.actor.id,
    roles: req.actor.roles,
    teams: req.actor.team_ids,
    include_archived: req.include_archived === true,
    policySummary,
  }));
}
function digestText(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16)}`;
}
function qi(identifier: string) {
  if (!allowedFields.has(identifier)) {
    throw new Error(`bad_request: unsafe field ${identifier}`);
  }
  return `"${identifier}"`;
}
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function error(code: string, message: string, status: number) {
  return json({ ok: false, error: { code, message, details: [] } }, status);
}

if (import.meta.main) await startServer(Number(Deno.env.get("PORT") ?? 8790));
