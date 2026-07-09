import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
type Operation =
  | { op: "create"; resource: string; as?: string; fields: Json }
  | {
    op: "update";
    resource: string;
    id: string;
    set?: Json;
    unset?: string[];
    expectedVersion?: number;
  }
  | { op: "archive"; resource: string; id: string; expectedVersion?: number }
  | {
    op: "transition";
    resource: string;
    id: string;
    to: string;
    expectedVersion?: number;
  }
  | {
    op: "link";
    relationship: string;
    from: string;
    to: string;
    fields?: Json;
  }
  | { op: "comment"; resource: string; id: string; body: string };

type ChangesetRequest = {
  actor: string;
  operations: Operation[];
  mode?: "preview" | "commit";
};

type ValidationMessage = {
  level: "error" | "warning";
  path: string;
  code: string;
  message: string;
};

type PreviewResult = {
  ok: boolean;
  changesetId: string;
  actor: string;
  mode: "preview" | "commit";
  operations: Operation[];
  normalizedOperations: Operation[];
  diffs: Json[];
  validation: { errors: ValidationMessage[]; warnings: ValidationMessage[] };
  wouldCommit: boolean;
};

type CommitResult = PreviewResult & {
  committed: boolean;
  ids: Record<string, string>;
  auditEvents: Json[];
};

type App = {
  db: PGlite;
  handler: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};

const resourceSpecs = {
  lead: {
    table: "res_lead",
    fields: {
      name: { type: "string", required: true },
      email: { type: "string", required: false },
      company_name: { type: "string", required: false },
      status: { type: "string", required: true },
      score: { type: "integer", required: false },
    },
    lifecycle: {
      field: "status",
      states: ["new", "qualified", "converted", "disqualified"],
      transitions: [
        ["new", "qualified"],
        ["qualified", "converted"],
        ["qualified", "disqualified"],
      ],
    },
  },
  company: {
    table: "res_company",
    fields: { name: { type: "string", required: true } },
  },
  contact: {
    table: "res_contact",
    fields: {
      name: { type: "string", required: true },
      email: { type: "string", required: true },
    },
  },
  opportunity: {
    table: "res_opportunity",
    fields: {
      name: { type: "string", required: true },
      company_id: { type: "string", required: true, ref: "company" },
      contact_id: { type: "string", required: false, ref: "contact" },
      stage: { type: "string", required: true },
    },
    lifecycle: {
      field: "stage",
      states: ["new", "proposal", "won", "lost"],
      transitions: [["new", "proposal"], ["proposal", "won"], [
        "proposal",
        "lost",
      ]],
    },
  },
} as const;

const relationships = {
  contact_company: {
    table: "rel_contact_company",
    fromResource: "contact",
    toResource: "company",
    fields: { role: { type: "string", required: false } },
  },
} as const;

export async function createApp(): Promise<App> {
  const db = new PGlite();
  await initialize(db);
  await seed(db);
  return {
    db,
    handler: (request) => route(db, request),
    close: async () => await db.close(),
  };
}

export async function startServer(port = 0) {
  const app = await createApp();
  const server = Deno.serve({ port, hostname: "127.0.0.1" }, app.handler);
  return {
    app,
    server,
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
      version integer not null default 1,
      archived_at timestamptz,
      name text not null,
      email text,
      company_name text,
      status text not null,
      score integer
    );
    create table res_company(
      id text primary key,
      version integer not null default 1,
      archived_at timestamptz,
      name text not null
    );
    create table res_contact(
      id text primary key,
      version integer not null default 1,
      archived_at timestamptz,
      name text not null,
      email text not null
    );
    create table res_opportunity(
      id text primary key,
      version integer not null default 1,
      archived_at timestamptz,
      name text not null,
      company_id text not null references res_company(id),
      contact_id text references res_contact(id),
      stage text not null
    );
    create table rel_contact_company(
      id text primary key,
      from_id text not null references res_contact(id),
      to_id text not null references res_company(id),
      role text,
      unique(from_id, to_id)
    );
    create table object_comments(
      id text primary key,
      resource text not null,
      object_id text not null,
      actor text not null,
      body text not null,
      created_at timestamptz default now()
    );
    create table changesets(
      id text primary key,
      actor text not null,
      status text not null,
      request jsonb not null,
      preview jsonb not null,
      committed_at timestamptz
    );
    create table audit_events(
      id text primary key,
      changeset_id text,
      actor text not null,
      event text not null,
      resource text,
      object_id text,
      details jsonb not null,
      created_at timestamptz default now()
    );
    create table idempotency_keys(
      actor text not null,
      key text not null,
      request_hash text not null,
      response jsonb not null,
      primary key(actor, key)
    );
  `);
}

async function seed(db: PGlite) {
  await db.exec(`
    insert into res_lead(id, name, email, company_name, status, score) values
      ('lead_1', 'Ada Lovelace', 'ADA@EXAMPLE.COM', 'Analytical Engines LLC', 'new', 10),
      ('lead_2', 'Grace Hopper', 'grace@example.com', 'Compiler Co', 'qualified', 90);
    insert into res_company(id, name) values ('company_existing', 'Existing Co');
    insert into res_contact(id, name, email) values ('contact_existing', 'Existing Buyer', 'buyer@example.com');
  `);
}

async function route(db: PGlite, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/meta") {
      return json(metadata());
    }
    if (request.method === "GET" && url.pathname.startsWith("/debug/count/")) {
      const resource = url.pathname.split("/")[3];
      return json({ resource, count: await activeCount(db, resource) });
    }
    if (request.method === "GET" && url.pathname.startsWith("/objects/")) {
      const [, , resource, id] = url.pathname.split("/");
      return json(
        await getObject(
          db,
          resource,
          id,
          url.searchParams.get("include_archived") === "true",
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/changesets/preview") {
      const body = await readJson(request);
      const parsed = parseChangesetRequest(body, "preview");
      const preview = await previewChangeset(db, parsed);
      await persistPreview(db, parsed, preview);
      return json(preview);
    }
    if (request.method === "POST" && url.pathname === "/changesets/commit") {
      const body = await readJson(request);
      const parsed = parseChangesetRequest(body, "commit");
      const key = request.headers.get("idempotency-key") ?? undefined;
      return json(await commitChangeset(db, parsed, key));
    }
    const commitMatch = url.pathname.match(/^\/changesets\/([^/]+)\/commit$/);
    if (request.method === "POST" && commitMatch) {
      const key = request.headers.get("idempotency-key") ?? undefined;
      return json(await commitPersistedChangeset(db, commitMatch[1], key));
    }
    if (
      request.method === "POST" &&
      url.pathname === "/actions/convert_lead/preview"
    ) {
      const body = await readJson(request);
      const parsed = await convertLeadToChangeset(db, body);
      const preview = await previewChangeset(db, parsed);
      await persistPreview(db, parsed, preview);
      return json(preview);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/actions/convert_lead/commit"
    ) {
      const body = await readJson(request);
      const parsed = await convertLeadToChangeset(db, body);
      const key = request.headers.get("idempotency-key") ?? undefined;
      return json(await commitChangeset(db, parsed, key));
    }
    return errorResponse("not_found", `${request.method} ${url.pathname}`, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("bad_request:")
      ? 400
      : message.startsWith("conflict:")
      ? 409
      : 500;
    return errorResponse(
      status === 400
        ? "bad_request"
        : status === 409
        ? "conflict"
        : "internal_error",
      message,
      status,
    );
  }
}

function metadata() {
  return {
    resources: resourceSpecs,
    relationships,
    operations: [
      "create",
      "update",
      "archive",
      "transition",
      "link",
      "comment",
    ],
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("bad_request: request body must be JSON");
  }
}

function parseChangesetRequest(
  value: unknown,
  mode: "preview" | "commit",
): ChangesetRequest {
  if (!isRecord(value)) throw new Error("bad_request: body must be an object");
  if (typeof value.actor !== "string" || !value.actor) {
    throw new Error("bad_request: actor is required");
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new Error("bad_request: operations must be a non-empty array");
  }
  return {
    actor: value.actor,
    operations: value.operations.map(parseOperation),
    mode,
  };
}

function parseOperation(value: unknown): Operation {
  if (!isRecord(value) || typeof value.op !== "string") {
    throw new Error("bad_request: each operation needs op");
  }
  switch (value.op) {
    case "create":
      assertResource(value.resource);
      if (!isRecord(value.fields)) {
        throw new Error("bad_request: create.fields must be an object");
      }
      return {
        op: "create",
        resource: value.resource,
        as: typeof value.as === "string" ? value.as : undefined,
        fields: value.fields,
      };
    case "update":
      assertResource(value.resource);
      if (typeof value.id !== "string") {
        throw new Error("bad_request: update.id is required");
      }
      if (value.set !== undefined && !isRecord(value.set)) {
        throw new Error("bad_request: update.set must be an object");
      }
      if (value.unset !== undefined && !isStringArray(value.unset)) {
        throw new Error("bad_request: update.unset must be string[]");
      }
      return {
        op: "update",
        resource: value.resource,
        id: value.id,
        set: value.set as Json | undefined,
        unset: value.unset as string[] | undefined,
        expectedVersion: numberOrUndefined(value.expectedVersion),
      };
    case "archive":
      assertResource(value.resource);
      if (typeof value.id !== "string") {
        throw new Error("bad_request: archive.id is required");
      }
      return {
        op: "archive",
        resource: value.resource,
        id: value.id,
        expectedVersion: numberOrUndefined(value.expectedVersion),
      };
    case "transition":
      assertResource(value.resource);
      if (typeof value.id !== "string" || typeof value.to !== "string") {
        throw new Error(
          "bad_request: transition.id and transition.to are required",
        );
      }
      return {
        op: "transition",
        resource: value.resource,
        id: value.id,
        to: value.to,
        expectedVersion: numberOrUndefined(value.expectedVersion),
      };
    case "link":
      if (
        typeof value.relationship !== "string" ||
        !(value.relationship in relationships)
      ) throw new Error("bad_request: unknown relationship");
      if (typeof value.from !== "string" || typeof value.to !== "string") {
        throw new Error("bad_request: link.from and link.to are required");
      }
      if (value.fields !== undefined && !isRecord(value.fields)) {
        throw new Error("bad_request: link.fields must be object");
      }
      return {
        op: "link",
        relationship: value.relationship,
        from: value.from,
        to: value.to,
        fields: value.fields as Json | undefined,
      };
    case "comment":
      assertResource(value.resource);
      if (typeof value.id !== "string" || typeof value.body !== "string") {
        throw new Error(
          "bad_request: comment.id and comment.body are required",
        );
      }
      return {
        op: "comment",
        resource: value.resource,
        id: value.id,
        body: value.body,
      };
    default:
      throw new Error(`bad_request: unsupported operation ${value.op}`);
  }
}

async function previewChangeset(
  db: PGlite,
  request: ChangesetRequest,
): Promise<PreviewResult> {
  const normalizedOperations = normalizeOperations(request.operations);
  const validation = await validateOperations(
    db,
    normalizedOperations,
    request.actor,
  );
  const diffs = await buildDiffs(db, normalizedOperations);
  return {
    ok: validation.errors.length === 0,
    changesetId: `cs_${
      digestText(JSON.stringify({ actor: request.actor, normalizedOperations }))
        .slice(-10)
    }`,
    actor: request.actor,
    mode: request.mode ?? "preview",
    operations: request.operations,
    normalizedOperations,
    diffs,
    validation,
    wouldCommit: validation.errors.length === 0,
  };
}

async function persistPreview(
  db: PGlite,
  request: ChangesetRequest,
  preview: PreviewResult,
) {
  await db.query(
    `insert into changesets(id, actor, status, request, preview)
     values ($1, $2, 'previewed', $3, $4)
     on conflict (id) do update set request=excluded.request, preview=excluded.preview, status='previewed'`,
    [
      preview.changesetId,
      request.actor,
      request as unknown as Json,
      preview as unknown as Json,
    ],
  );
}

async function commitPersistedChangeset(
  db: PGlite,
  changesetId: string,
  idempotencyKey?: string,
) {
  const stored = await db.query<
    { actor: string; request: ChangesetRequest; status: string }
  >(
    "select actor, request, status from changesets where id=$1",
    [changesetId],
  );
  const row = stored.rows[0];
  if (!row) throw new Error("bad_request: changeset preview not found");
  if (row.status === "committed") {
    throw new Error("conflict: changeset already committed");
  }
  return await commitChangeset(
    db,
    { ...row.request, mode: "commit" },
    idempotencyKey,
  );
}

function normalizeOperations(operations: Operation[]): Operation[] {
  return operations.map((operation) => {
    if (
      (operation.op === "create" || operation.op === "update") &&
      operation.resource === "lead"
    ) {
      const fields = operation.op === "create"
        ? operation.fields
        : operation.set;
      const normalized = fields ? normalizeLeadFields(fields) : fields;
      return operation.op === "create"
        ? { ...operation, fields: normalized! }
        : { ...operation, set: normalized };
    }
    return operation;
  });
}

function normalizeLeadFields(fields: Json): Json {
  const next = { ...fields };
  if (typeof next.email === "string") {
    next.email = next.email.trim().toLowerCase();
  }
  if (typeof next.name === "string") next.name = next.name.trim();
  if (!next.status) next.status = "new";
  return next;
}

async function validateOperations(
  db: PGlite,
  operations: Operation[],
  actor: string,
) {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const aliases = new Set<string>();
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    const path = `/operations/${i}`;
    if (operation.op === "create") {
      validateFields(
        `${path}/fields`,
        operation.resource,
        operation.fields,
        true,
        errors,
        warnings,
      );
      if (
        operation.resource === "lead" &&
        typeof operation.fields.email === "string" &&
        !operation.fields.email.includes("@")
      ) {
        errors.push({
          level: "error",
          path: `${path}/fields/email`,
          code: "invalid_email",
          message: "lead email must contain @",
        });
      }
      if (operation.as) aliases.add(operation.as);
    }
    if (operation.op === "update") {
      await validateExistsAndVersion(
        db,
        operation.resource,
        operation.id,
        operation.expectedVersion,
        path,
        errors,
      );
      validateFields(
        `${path}/set`,
        operation.resource,
        operation.set ?? {},
        false,
        errors,
        warnings,
      );
      for (const field of operation.unset ?? []) {
        if (isRequired(operation.resource, field)) {
          errors.push({
            level: "error",
            path: `${path}/unset`,
            code: "required_unset",
            message: `cannot unset required field ${field}`,
          });
        }
      }
    }
    if (operation.op === "archive") {
      validatePolicy(actor, operation, path, errors);
      await validateExistsAndVersion(
        db,
        operation.resource,
        operation.id,
        operation.expectedVersion,
        path,
        errors,
      );
    }
    if (operation.op === "comment") {
      await validateExistsAndVersion(
        db,
        operation.resource,
        operation.id,
        undefined,
        path,
        errors,
      );
      if (!operation.body.trim()) {
        errors.push({
          level: "error",
          path,
          code: "empty_comment",
          message: "comment body cannot be empty",
        });
      }
    }
    if (operation.op === "transition") {
      await validateExistsAndVersion(
        db,
        operation.resource,
        operation.id,
        operation.expectedVersion,
        path,
        errors,
      );
      await validateTransition(db, operation, path, errors);
    }
    if (operation.op === "link") {
      await validateLink(db, operation, path, errors, aliases);
    }
  }
  return { errors, warnings };
}

function validateFields(
  path: string,
  resource: string,
  fields: Json,
  creating: boolean,
  errors: ValidationMessage[],
  warnings: ValidationMessage[],
) {
  const spec = resourceSpecs[resource as keyof typeof resourceSpecs];
  for (const field of Object.keys(fields)) {
    if (!(field in spec.fields)) {
      errors.push({
        level: "error",
        path: `${path}/${field}`,
        code: "unknown_field",
        message: `${resource}.${field} is not defined`,
      });
    }
  }
  if (creating) {
    for (const [field, def] of Object.entries(spec.fields)) {
      if (
        def.required &&
        (fields[field] === undefined || fields[field] === null ||
          fields[field] === "")
      ) {
        errors.push({
          level: "error",
          path: `${path}/${field}`,
          code: "required",
          message: `${resource}.${field} is required`,
        });
      }
    }
  }
  for (const [field, value] of Object.entries(fields)) {
    const def = spec.fields[field as keyof typeof spec.fields] as {
      type: string;
    } | undefined;
    if (!def || value === null || value === undefined) continue;
    if (def.type === "integer" && typeof value !== "number") {
      errors.push({
        level: "error",
        path: `${path}/${field}`,
        code: "type",
        message: `${resource}.${field} must be integer`,
      });
    }
    if (def.type === "string" && typeof value !== "string") {
      errors.push({
        level: "error",
        path: `${path}/${field}`,
        code: "type",
        message: `${resource}.${field} must be string`,
      });
    }
  }
  if (resource === "lead" && creating && !fields.email) {
    warnings.push({
      level: "warning",
      path: `${path}/email`,
      code: "missing_email",
      message: "lead email improves dedupe and conversion",
    });
  }
}

function validatePolicy(
  actor: string,
  operation: Operation,
  path: string,
  errors: ValidationMessage[],
) {
  if (operation.op === "archive" && actor !== "admin") {
    errors.push({
      level: "error",
      path,
      code: "policy_denied",
      message: "only admin can archive objects in this prototype policy",
    });
  }
}

async function validateExistsAndVersion(
  db: PGlite,
  resource: string,
  id: string,
  expectedVersion: number | undefined,
  path: string,
  errors: ValidationMessage[],
) {
  const object = await getObjectOrNull(db, resource, id, true);
  if (!object) {
    errors.push({
      level: "error",
      path,
      code: "not_found",
      message: `${resource}.${id} not found`,
    });
    return;
  }
  if (object.archived_at) {
    errors.push({
      level: "error",
      path,
      code: "archived_object",
      message: `${resource}.${id} is archived and cannot be modified or linked`,
    });
    return;
  }
  if (expectedVersion !== undefined && object.version !== expectedVersion) {
    errors.push({
      level: "error",
      path,
      code: "version_conflict",
      message: `expected version ${expectedVersion}, found ${object.version}`,
    });
  }
}

async function validateTransition(
  db: PGlite,
  operation: Extract<Operation, { op: "transition" }>,
  path: string,
  errors: ValidationMessage[],
) {
  const spec = resourceSpecs[operation.resource as keyof typeof resourceSpecs];
  if (!("lifecycle" in spec)) {
    errors.push({
      level: "error",
      path,
      code: "no_lifecycle",
      message: `${operation.resource} has no lifecycle`,
    });
    return;
  }
  const object = await getObjectOrNull(db, operation.resource, operation.id);
  if (!object) return;
  const lifecycle = spec.lifecycle!;
  const from = object[lifecycle.field] as string;
  const allowed = lifecycle.transitions.some(([a, b]) =>
    a === from && b === operation.to
  );
  if (!allowed) {
    errors.push({
      level: "error",
      path,
      code: "invalid_transition",
      message:
        `${operation.resource} cannot transition ${from} -> ${operation.to}`,
    });
  }
}

async function validateLink(
  db: PGlite,
  operation: Extract<Operation, { op: "link" }>,
  path: string,
  errors: ValidationMessage[],
  aliases: Set<string>,
) {
  const rel =
    relationships[operation.relationship as keyof typeof relationships];
  if (!isKnownRef(operation.from, aliases)) {
    const from = await getObjectOrNull(
      db,
      rel.fromResource,
      operation.from,
      true,
    );
    if (!from) {
      errors.push({
        level: "error",
        path: `${path}/from`,
        code: "not_found",
        message: `${rel.fromResource}.${operation.from} not found`,
      });
    } else if (from.archived_at) {
      errors.push({
        level: "error",
        path: `${path}/from`,
        code: "archived_object",
        message:
          `${rel.fromResource}.${operation.from} is archived and cannot be linked`,
      });
    }
  }
  if (!isKnownRef(operation.to, aliases)) {
    const to = await getObjectOrNull(db, rel.toResource, operation.to, true);
    if (!to) {
      errors.push({
        level: "error",
        path: `${path}/to`,
        code: "not_found",
        message: `${rel.toResource}.${operation.to} not found`,
      });
    } else if (to.archived_at) {
      errors.push({
        level: "error",
        path: `${path}/to`,
        code: "archived_object",
        message:
          `${rel.toResource}.${operation.to} is archived and cannot be linked`,
      });
    }
  }
}

async function buildDiffs(db: PGlite, operations: Operation[]) {
  const diffs: Json[] = [];
  for (const operation of operations) {
    if (operation.op === "create") {
      diffs.push({
        op: "create",
        resource: operation.resource,
        after: operation.fields,
        as: operation.as,
      });
    }
    if (operation.op === "update") {
      const before = await getObjectOrNull(
        db,
        operation.resource,
        operation.id,
      );
      const after = before
        ? { ...before, ...operation.set }
        : operation.set ?? {};
      for (const field of operation.unset ?? []) delete after[field];
      diffs.push({
        op: "update",
        resource: operation.resource,
        id: operation.id,
        before,
        after,
      });
    }
    if (operation.op === "archive") {
      const before = await getObjectOrNull(
        db,
        operation.resource,
        operation.id,
      );
      diffs.push({
        op: "archive",
        resource: operation.resource,
        id: operation.id,
        before,
        after: before ? { ...before, archived_at: "<commit timestamp>" } : null,
      });
    }
    if (operation.op === "transition") {
      const before = await getObjectOrNull(
        db,
        operation.resource,
        operation.id,
      );
      const lifecycle =
        (resourceSpecs[operation.resource as keyof typeof resourceSpecs] as {
          lifecycle: { field: string };
        })
          .lifecycle;
      diffs.push({
        op: "transition",
        resource: operation.resource,
        id: operation.id,
        from: before?.[lifecycle.field],
        to: operation.to,
      });
    }
    if (operation.op === "link") {
      diffs.push({
        op: "link",
        relationship: operation.relationship,
        from: operation.from,
        to: operation.to,
        fields: operation.fields ?? {},
      });
    }
    if (operation.op === "comment") {
      diffs.push({
        op: "comment",
        resource: operation.resource,
        id: operation.id,
        body: operation.body,
      });
    }
  }
  return diffs;
}

async function commitChangeset(
  db: PGlite,
  request: ChangesetRequest,
  idempotencyKey?: string,
): Promise<CommitResult> {
  if (idempotencyKey) {
    const prior = await db.query<
      { request_hash: string; response: CommitResult }
    >(
      "select request_hash, response from idempotency_keys where actor=$1 and key=$2",
      [request.actor, idempotencyKey],
    );
    const requestHash = digestText(JSON.stringify(request));
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) {
        throw new Error(
          "conflict: idempotency key reused with different payload",
        );
      }
      return prior.rows[0].response;
    }
  }

  const preview = await previewChangeset(db, { ...request, mode: "commit" });
  if (!preview.ok) {
    return { ...preview, committed: false, ids: {}, auditEvents: [] };
  }

  const ids: Record<string, string> = {};
  const auditEvents: Json[] = [];
  await db.exec("begin");
  try {
    for (let i = 0; i < preview.normalizedOperations.length; i++) {
      const operation = preview.normalizedOperations[i];
      const result = await applyOperation(
        db,
        operation,
        request.actor,
        preview.changesetId,
        ids,
        i,
      );
      Object.assign(ids, result.ids);
      auditEvents.push(...result.auditEvents);
    }
    const response: CommitResult = {
      ...preview,
      committed: true,
      ids,
      auditEvents,
    };
    await db.query(
      `insert into changesets(id, actor, status, request, preview, committed_at)
       values ($1, $2, 'committed', $3, $4, now())
       on conflict (id) do update set status='committed', request=excluded.request, preview=excluded.preview, committed_at=now()`,
      [
        preview.changesetId,
        request.actor,
        request as unknown as Json,
        preview as unknown as Json,
      ],
    );
    if (idempotencyKey) {
      await db.query(
        "insert into idempotency_keys(actor, key, request_hash, response) values ($1, $2, $3, $4)",
        [
          request.actor,
          idempotencyKey,
          digestText(JSON.stringify(request)),
          response as unknown as Json,
        ],
      );
    }
    await db.exec("commit");
    return response;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function applyOperation(
  db: PGlite,
  operation: Operation,
  actor: string,
  changesetId: string,
  ids: Record<string, string>,
  index: number,
) {
  const auditEvents: Json[] = [];
  const newIds: Record<string, string> = {};
  if (operation.op === "create") {
    const id = `obj_${
      digestText(`${changesetId}:${index}:${operation.resource}`).slice(-8)
    }`;
    const fields = resolveRefs(operation.fields, ids);
    await insertResource(db, operation.resource, id, fields);
    if (operation.as) newIds[operation.as] = id;
    auditEvents.push(
      await audit(db, changesetId, actor, "create", operation.resource, id, {
        fields,
      }),
    );
  }
  if (operation.op === "update") {
    await updateResource(
      db,
      operation.resource,
      operation.id,
      resolveRefs(operation.set ?? {}, ids),
      operation.unset ?? [],
    );
    auditEvents.push(
      await audit(
        db,
        changesetId,
        actor,
        "update",
        operation.resource,
        operation.id,
        { set: operation.set ?? {}, unset: operation.unset ?? [] },
      ),
    );
  }
  if (operation.op === "archive") {
    await db.query(
      `update ${
        qi(tableFor(operation.resource))
      } set archived_at=now(), version=version+1 where id=$1`,
      [operation.id],
    );
    auditEvents.push(
      await audit(
        db,
        changesetId,
        actor,
        "archive",
        operation.resource,
        operation.id,
        {},
      ),
    );
  }
  if (operation.op === "transition") {
    const lifecycle =
      (resourceSpecs[operation.resource as keyof typeof resourceSpecs] as {
        lifecycle: { field: string };
      })
        .lifecycle;
    await db.query(
      `update ${qi(tableFor(operation.resource))} set ${
        qi(lifecycle.field)
      }=$2, version=version+1 where id=$1`,
      [operation.id, operation.to],
    );
    auditEvents.push(
      await audit(
        db,
        changesetId,
        actor,
        "transition",
        operation.resource,
        operation.id,
        { to: operation.to },
      ),
    );
  }
  if (operation.op === "link") {
    const rel =
      relationships[operation.relationship as keyof typeof relationships];
    const id = `rel_${
      digestText(`${changesetId}:${index}:${operation.relationship}`).slice(-8)
    }`;
    await db.query(
      `insert into ${
        qi(rel.table)
      }(id, from_id, to_id, role) values ($1, $2, $3, $4)`,
      [
        id,
        resolveRef(operation.from, ids),
        resolveRef(operation.to, ids),
        operation.fields?.role ?? null,
      ],
    );
    auditEvents.push(
      await audit(db, changesetId, actor, "link", operation.relationship, id, {
        from: operation.from,
        to: operation.to,
        fields: operation.fields ?? {},
      }),
    );
  }
  if (operation.op === "comment") {
    const id = `comment_${
      digestText(`${changesetId}:${index}:comment`).slice(-8)
    }`;
    await db.query(
      "insert into object_comments(id, resource, object_id, actor, body) values ($1, $2, $3, $4, $5)",
      [id, operation.resource, operation.id, actor, operation.body],
    );
    auditEvents.push(
      await audit(
        db,
        changesetId,
        actor,
        "comment",
        operation.resource,
        operation.id,
        { body: operation.body },
      ),
    );
  }
  return { ids: newIds, auditEvents };
}

async function convertLeadToChangeset(
  db: PGlite,
  value: unknown,
): Promise<ChangesetRequest> {
  if (
    !isRecord(value) || typeof value.actor !== "string" ||
    typeof value.lead_id !== "string"
  ) throw new Error("bad_request: actor and lead_id are required");
  const lead = await getObjectOrNull(db, "lead", value.lead_id);
  if (!lead) throw new Error("bad_request: lead not found");
  const companyName = String(lead.company_name ?? `${lead.name} Company`);
  const email = String(lead.email ?? `${lead.id}@example.invalid`)
    .toLowerCase();
  return {
    actor: value.actor,
    mode: "commit",
    operations: [
      {
        op: "create",
        resource: "company",
        as: "company",
        fields: { name: companyName },
      },
      {
        op: "create",
        resource: "contact",
        as: "contact",
        fields: { name: lead.name, email },
      },
      {
        op: "create",
        resource: "opportunity",
        as: "opportunity",
        fields: {
          name: `${companyName} opportunity`,
          company_id: "@company",
          contact_id: "@contact",
          stage: "new",
        },
      },
      {
        op: "link",
        relationship: "contact_company",
        from: "@contact",
        to: "@company",
        fields: { role: "buyer" },
      },
      {
        op: "transition",
        resource: "lead",
        id: value.lead_id,
        to: "qualified",
        expectedVersion: typeof value.expectedVersion === "number"
          ? value.expectedVersion
          : undefined,
      },
      {
        op: "comment",
        resource: "lead",
        id: value.lead_id,
        body: "Converted lead into company, contact, and opportunity.",
      },
    ],
  };
}

async function insertResource(
  db: PGlite,
  resource: string,
  id: string,
  fields: Json,
) {
  const spec = resourceSpecs[resource as keyof typeof resourceSpecs];
  const names = Object.keys(spec.fields).filter((field) =>
    fields[field] !== undefined
  );
  const columns = ["id", ...names];
  const values = [id, ...names.map((name) => fields[name])];
  const placeholders = values.map((_, i) => `$${i + 1}`);
  await db.query(
    `insert into ${qi(spec.table)}(${columns.map(qi).join(", ")}) values (${
      placeholders.join(", ")
    })`,
    values,
  );
}

async function updateResource(
  db: PGlite,
  resource: string,
  id: string,
  set: Json,
  unset: string[],
) {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(set)) {
    assignments.push(`${qi(field)}=$${values.length + 1}`);
    values.push(value);
  }
  for (const field of unset) assignments.push(`${qi(field)}=null`);
  assignments.push("version=version+1");
  values.push(id);
  await db.query(
    `update ${qi(tableFor(resource))} set ${
      assignments.join(", ")
    } where id=$${values.length}`,
    values,
  );
}

async function audit(
  db: PGlite,
  changesetId: string,
  actor: string,
  event: string,
  resource: string,
  objectId: string,
  details: Json,
) {
  const id = `audit_${
    digestText(
      `${changesetId}:${event}:${resource}:${objectId}:${
        JSON.stringify(details)
      }`,
    ).slice(-10)
  }`;
  const row = {
    id,
    changeset_id: changesetId,
    actor,
    event,
    resource,
    object_id: objectId,
    details,
  };
  await db.query(
    "insert into audit_events(id, changeset_id, actor, event, resource, object_id, details) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, changesetId, actor, event, resource, objectId, details],
  );
  return row;
}

async function activeCount(db: PGlite, resource: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${
      qi(tableFor(resource))
    } where archived_at is null`,
  );
  return result.rows[0].count;
}

async function getObject(
  db: PGlite,
  resource: string,
  id: string,
  includeArchived = false,
) {
  assertResource(resource);
  const object = await getObjectOrNull(db, resource, id, includeArchived);
  if (!object) throw new Error("bad_request: object not found");
  return object;
}

async function getObjectOrNull(
  db: PGlite,
  resource: string,
  id: string,
  includeArchived = false,
): Promise<Json | null> {
  const table = tableFor(resource);
  const result = await db.query<Json>(
    `select * from ${qi(table)} where id=$1 ${
      includeArchived ? "" : "and archived_at is null"
    }`,
    [id],
  );
  return result.rows[0] ?? null;
}

function resolveRefs(fields: Json, ids: Record<string, string>): Json {
  return Object.fromEntries(
    Object.entries(fields).map((
      [key, value],
    ) => [key, typeof value === "string" ? resolveRef(value, ids) : value]),
  );
}
function resolveRef(value: string, ids: Record<string, string>) {
  if (value.startsWith("@")) return ids[value.slice(1)] ?? value;
  return value;
}
function isKnownRef(value: string, aliases: Set<string>) {
  return value.startsWith("@") && aliases.has(value.slice(1));
}
function isRequired(resource: string, field: string) {
  const spec = resourceSpecs[resource as keyof typeof resourceSpecs];
  return Boolean(
    (spec.fields as Record<string, { required?: boolean }>)[field]?.required,
  );
}
function tableFor(resource: string) {
  const spec = resourceSpecs[resource as keyof typeof resourceSpecs];
  if (!spec) throw new Error(`bad_request: unknown resource ${resource}`);
  return spec.table;
}
function assertResource(resource: unknown): asserts resource is string {
  if (typeof resource !== "string" || !(resource in resourceSpecs)) {
    throw new Error(`bad_request: unknown resource ${String(resource)}`);
  }
}
function numberOrUndefined(value: unknown) {
  return typeof value === "number" ? value : undefined;
}
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}
function qi(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier ${identifier}`);
  }
  return `"${identifier}"`;
}
function digestText(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function errorResponse(
  code: string,
  message: string,
  status: number,
  details: unknown[] = [],
) {
  return json({ ok: false, error: { code, message, details } }, status);
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8787);
  await startServer(port);
}
