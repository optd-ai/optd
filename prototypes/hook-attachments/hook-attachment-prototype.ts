import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
const scripts = new URL("../hooks/scripts/", import.meta.url).pathname;

export async function createDb() {
  const db = new PGlite();
  await db.exec(`
    create table hook_definitions(name text primary key, script_path text not null, output_schema text not null, phase text not null);
    create table hook_attachments(id text primary key, resource text, action text, phase text not null, hook_name text not null references hook_definitions(name));
    create table res_lead(id text primary key, version integer not null default 1, name text not null, email text, company_name text, status text not null default 'new');
    create table outbox(id text primary key, hook_name text not null, envelope_json jsonb not null, status text not null default 'pending');
    create table hook_executions(id text primary key, hook_name text not null, phase text not null, output_json jsonb, logs text, status text not null);
    insert into hook_definitions values
      ('normalize_lead', '${scripts}normalize_lead.ts', 'patch.v1', 'before_preview'),
      ('validate_lead', '${scripts}validate_lead.ts', 'validation.v1', 'validate'),
      ('convert_lead', '${scripts}convert_lead.ts', 'changeset.operations.v1', 'action'),
      ('notify_lead_change', '${scripts}validate_lead.ts', 'validation.v1', 'after_commit');
    insert into hook_attachments values
      ('att_norm_lead', 'lead', null, 'before_preview', 'normalize_lead'),
      ('att_validate_lead', 'lead', null, 'validate', 'validate_lead'),
      ('att_convert_lead', null, 'convert_lead', 'action', 'convert_lead'),
      ('att_notify_lead', 'lead', null, 'after_commit', 'notify_lead_change');
    insert into res_lead(id, name, email, company_name, status) values ('lead_1', 'Ada', 'ada@example.com', 'Analytical Engines', 'new');
  `);
  return db;
}

export async function previewCreateLead(db: PGlite, fields: Json) {
  let operation: Json = { op: "create", resource: "lead", fields };
  const normalizeHooks = await attachedHooks(db, {
    resource: "lead",
    phase: "before_preview",
  });
  const executions: Json[] = [];
  for (const hook of normalizeHooks) {
    const result = await runHook(hook, {
      phase: "before_preview",
      input: { operation },
    });
    executions.push(result);
    operation = applyPatches(
      operation,
      (result.output as Json).patches as Json[],
    );
  }
  const validateHooks = await attachedHooks(db, {
    resource: "lead",
    phase: "validate",
  });
  const errors: Json[] = [];
  const warnings: Json[] = [];
  for (const hook of validateHooks) {
    const result = await runHook(hook, {
      phase: "validate",
      input: { operation },
    });
    executions.push(result);
    const output = result.output as Json;
    errors.push(...((output.errors as Json[] | undefined) ?? []));
    warnings.push(...((output.warnings as Json[] | undefined) ?? []));
  }
  return {
    ok: errors.length === 0,
    operation,
    validation: { errors, warnings },
    executions,
  };
}

export async function commitCreateLead(db: PGlite, fields: Json) {
  const preview = await previewCreateLead(db, fields);
  if (!preview.ok) return { committed: false, ...preview };
  const op = preview.operation as any;
  await db.exec("begin");
  await db.query(
    "insert into res_lead(id, name, email, company_name, status) values ($1,$2,$3,$4,$5)",
    [
      "lead_new",
      op.fields.name,
      op.fields.email ?? null,
      op.fields.company_name ?? null,
      op.fields.status ?? "new",
    ],
  );
  const afterCommit = await attachedHooks(db, {
    resource: "lead",
    phase: "after_commit",
  });
  for (const hook of afterCommit) {
    await db.query(
      "insert into outbox(id, hook_name, envelope_json) values ($1,$2,$3)",
      [`outbox_${hook.name}`, hook.name, {
        phase: "after_commit",
        input: { resource: "lead", id: "lead_new" },
      }],
    );
  }
  await db.exec("commit");
  return { committed: true, ...preview };
}

export async function previewActionConvertLead(db: PGlite, leadId: string) {
  const lead =
    (await db.query<Json>("select * from res_lead where id=$1", [leadId]))
      .rows[0];
  const hooks = await attachedHooks(db, {
    action: "convert_lead",
    phase: "action",
  });
  const executions: Json[] = [];
  const operations: Json[] = [];
  for (const hook of hooks) {
    const result = await runHook(hook, {
      phase: "action_preview",
      input: { lead },
    });
    executions.push(result);
    operations.push(
      ...(((result.output as Json).operations as Json[] | undefined) ?? []),
    );
  }
  return { ok: true, operations, executions };
}

export async function processOutbox(db: PGlite) {
  const row = (await db.query<Json>(
    "select * from outbox where status='pending' order by id limit 1",
  )).rows[0];
  if (!row) return null;
  const hook =
    (await db.query<Json>("select * from hook_definitions where name=$1", [
      row.hook_name,
    ])).rows[0];
  const result = await runHook(hook, row.envelope_json as Json);
  await db.query(
    "insert into hook_executions(id, hook_name, phase, output_json, logs, status) values ($1,$2,$3,$4,$5,$6)",
    [
      `hexec_${row.id}`,
      row.hook_name,
      "after_commit",
      result.output ?? {},
      result.logs,
      result.ok ? "succeeded" : "failed",
    ],
  );
  await db.query("update outbox set status='succeeded' where id=$1", [row.id]);
  return result;
}

async function attachedHooks(
  db: PGlite,
  q: { resource?: string; action?: string; phase: string },
) {
  return (await db.query<Json>(
    "select h.* from hook_attachments a join hook_definitions h on h.name=a.hook_name where a.phase=$1 and coalesce(a.resource,'')=coalesce($2,'') and coalesce(a.action,'')=coalesce($3,'') order by a.id",
    [q.phase, q.resource ?? null, q.action ?? null],
  )).rows;
}

async function runHook(hook: Json, envelope: Json) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--no-prompt", hook.script_path as string],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(envelope)));
  await writer.close();
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const logs = new TextDecoder().decode(output.stderr).trim();
  return {
    ok: output.success,
    hook: hook.name,
    output: output.success ? JSON.parse(stdout) : null,
    logs,
  };
}

function applyPatches(operation: Json, patches: Json[]) {
  const next = structuredClone(operation) as any;
  for (const patch of patches) {
    const path = patch.path as string;
    if (patch.op === "set" && path.startsWith("/fields/")) {
      next.fields[path.slice("/fields/".length)] = patch.value;
    }
    if (patch.op === "unset" && path.startsWith("/fields/")) {
      delete next.fields[path.slice("/fields/".length)];
    }
  }
  return next;
}

export async function inspect(db: PGlite) {
  return {
    leads: (await db.query("select * from res_lead order by id")).rows,
    outbox: (await db.query("select * from outbox order by id")).rows,
    executions:
      (await db.query("select * from hook_executions order by id")).rows,
  };
}

if (import.meta.main) {
  const db = await createDb();
  console.log(
    JSON.stringify(
      await previewCreateLead(db, {
        name: " Jane ",
        email: "JANE@EXAMPLE.COM",
      }),
      null,
      2,
    ),
  );
}
