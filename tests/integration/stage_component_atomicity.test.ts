import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  closePostgresClient,
  createPostgresClient,
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  applyMigrationPlan,
  createPackMigrationPlan,
  validateMigrationPlan,
} from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import {
  type LoadedPack,
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { canonicalSha256 } from "../../src/domain/ids/canonical_json.ts";
import { isUuidV7, uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test({
  name:
    "candidate components and hook attachments project atomically across reuse races and apply failure",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
      throw new Error("PostgreSQL 18.4 app-managed binaries are required");
    }
    const root = await Deno.makeTempDir({ prefix: "operant-components-" });
    const previous = Deno.env.get("OPERANT_DATA_DIR");
    Deno.env.set("OPERANT_DATA_DIR", root);
    let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
    let sql: Sql | undefined;
    try {
      runtime = await startPostgresRuntime();
      sql = createPostgresClient(runtime.databaseUrl);
      await sql.begin((tx) => applyPlatformMigrations(tx));
      const auth = await seedRoot(sql);
      const original = withAllAttachments(
        await loadPackFromFiles(
          await packFiles("prototypes/crm-default-pack"),
        ),
      );

      await installFailureTrigger(sql, "pack_component_revisions");
      await assertRejects(() =>
        sql!.begin((tx) => createPackMigrationPlan(tx, original, auth.id))
      );
      await assertProjectionAbsent(sql, original.sourceDigest);
      await dropFailureTrigger(sql, "pack_component_revisions");

      await installFailureTrigger(sql, "pack_hook_attachment_revisions");
      await assertRejects(() =>
        sql!.begin((tx) => createPackMigrationPlan(tx, original, auth.id))
      );
      await assertProjectionAbsent(sql, original.sourceDigest);
      await dropFailureTrigger(sql, "pack_hook_attachment_revisions");

      const first = await sql.begin((tx) =>
        createPackMigrationPlan(tx, original, auth.id)
      );
      assertEquals(first.candidate_reused, false);
      const firstProjection = await projection(
        sql,
        first.plan.to_pack_revision_id,
      );
      await assertProjection(original, firstProjection);

      const reused = await sql.begin((tx) =>
        createPackMigrationPlan(tx, original, auth.id)
      );
      assertEquals(reused.candidate_reused, true);
      assertEquals(
        reused.plan.to_pack_revision_id,
        first.plan.to_pack_revision_id,
      );
      assertEquals(
        await projection(sql, first.plan.to_pack_revision_id),
        firstProjection,
      );

      const raced = await Promise.all(
        Array.from(
          { length: 4 },
          () =>
            sql!.begin((tx) => createPackMigrationPlan(tx, original, auth.id)),
        ),
      );
      assertEquals(
        new Set(raced.map((item) => item.plan.to_pack_revision_id)).size,
        1,
      );
      assert(raced.every((item) => item.candidate_reused));
      assertEquals(
        await projection(sql, first.plan.to_pack_revision_id),
        firstProjection,
      );

      await sql.begin((tx) =>
        validateMigrationPlan(tx, first.plan.id, auth.id)
      );
      const applied = await sql.begin((tx) =>
        applyMigrationPlan(
          tx,
          first.plan.id,
          acknowledgement(first.plan.class),
          auth.id,
        )
      );
      assert(applied);
      const activeBefore = await activeProjection(
        sql,
        original.publisher,
        original.name,
      );

      const secondPack = nextRevision(original, "0.2.0", "9");
      const second = await sql.begin((tx) =>
        createPackMigrationPlan(tx, secondPack, auth.id)
      );
      const secondProjection = await projection(
        sql,
        second.plan.to_pack_revision_id,
      );
      await assertProjection(secondPack, secondProjection);
      assertEquals(
        secondProjection.components.length,
        firstProjection.components.length,
      );
      assertEquals(
        secondProjection.attachments.length,
        firstProjection.attachments.length,
      );
      assertEquals(
        new Set([
          ...firstProjection.components.map((row) => row.id),
          ...secondProjection.components.map((row) => row.id),
        ]).size,
        firstProjection.components.length + secondProjection.components.length,
      );
      assertEquals(
        new Set([
          ...firstProjection.attachments.map((row) => row.id),
          ...secondProjection.attachments.map((row) => row.id),
        ]).size,
        firstProjection.attachments.length +
          secondProjection.attachments.length,
      );
      assert(
        secondProjection.components.some((row, index) =>
          row.digest !== firstProjection.components[index].digest
        ),
      );

      await assertConstraintMatrix(sql, firstProjection);
      await sql.begin((tx) =>
        validateMigrationPlan(tx, second.plan.id, auth.id)
      );
      await assertRejects(() =>
        sql!.begin((tx) =>
          applyMigrationPlan(
            tx,
            second.plan.id,
            acknowledgement(second.plan.class),
            auth.id,
            "after_sql",
          )
        )
      );
      assertEquals(
        await activeProjection(sql, original.publisher, original.name),
        activeBefore,
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_migration_applications where plan_id=$1",
          [second.plan.id],
        )).rows[0].count,
        "0",
      );
      assertEquals(
        await projection(sql, second.plan.to_pack_revision_id),
        secondProjection,
      );
    } finally {
      if (sql) await closePostgresClient(sql).catch(() => undefined);
      if (runtime) await runtime.stop().catch(() => undefined);
      if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
      else Deno.env.set("OPERANT_DATA_DIR", previous);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

type ComponentRow = { id: string; kind: string; name: string; digest: string };
type AttachmentRow = {
  id: string;
  hook_revision_id: string;
  component_revision_id: string | null;
  phase: string;
  ordinal: number;
  digest: string;
  spec: Record<string, unknown>;
};
type Projection = {
  components: ComponentRow[];
  attachments: AttachmentRow[];
};

async function projection(sql: Sql, candidate: string): Promise<Projection> {
  const components = (await query<ComponentRow>(
    sql,
    `select id,definition_kind kind,definition_name name,definition_digest digest
     from pack_component_revisions where candidate_revision_id=$1 order by kind,name`,
    [candidate],
  )).rows;
  const attachments = (await query<AttachmentRow>(
    sql,
    `select id,hook_revision_id,component_revision_id,phase,ordinal,
      declaration_digest digest,declaration_spec spec
     from pack_hook_attachment_revisions where candidate_revision_id=$1
     order by hook_revision_id,phase,ordinal,id`,
    [candidate],
  )).rows;
  return { components, attachments };
}

async function assertProjection(pack: LoadedPack, value: Projection) {
  const sections = [
    ["resource", pack.resources],
    ["relationship", pack.relationships],
    ["lifecycle", pack.lifecycles],
    ["action", pack.actions],
    ["hook", pack.hooks],
    ["role", pack.roles],
    ["policy", pack.policies],
    ["seed", pack.seeds],
  ] as const;
  const expected: Array<[string, string, string]> = [];
  for (const [kind, definitions] of sections) {
    assert(Object.keys(definitions).length > 0, kind);
    for (const [name, definition] of Object.entries(definitions)) {
      expected.push([
        kind,
        name,
        `sha256:${await canonicalSha256(definition.document)}`,
      ]);
    }
  }
  expected.sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`));
  assertEquals(
    value.components.map((row) => [row.kind, row.name, row.digest]),
    expected,
  );
  assert(value.components.every((row) => isUuidV7(row.id)));
  assert(value.attachments.every((row) => isUuidV7(row.id)));
  assertEquals(
    new Set(value.components.map((row) => row.id)).size,
    value.components.length,
  );
  assertEquals(
    new Set(value.attachments.map((row) => row.id)).size,
    value.attachments.length,
  );
  assertEquals(
    [...new Set(value.attachments.map((row) => row.phase))].sort(),
    [
      "action.stage",
      "changeset.before_stage",
      "changeset.validate",
      "event.after_commit",
    ],
  );
  for (const row of value.attachments) {
    assertEquals(row.digest, `sha256:${await canonicalSha256(row.spec)}`);
    assertEquals(row.spec.phase, row.phase);
    assertEquals(row.spec.order, row.ordinal);
    assertEquals(Object.keys(row.spec).sort(), [
      "action",
      "condition",
      "event",
      "hook",
      "input",
      "order",
      "phase",
      "resource",
    ]);
    assertEquals(
      row.component_revision_id === null,
      row.spec.resource === null && row.spec.action === null,
    );
  }
}

async function assertConstraintMatrix(sql: Sql, value: Projection) {
  const component = value.components[0], attachment = value.attachments[0];
  assertEquals(
    (await query<{ count: string }>(
      sql,
      `select count(*)::text count from pg_constraint where contype='f' and (
       (conrelid='pack_component_revisions'::regclass and confrelid='pack_candidate_revisions'::regclass) or
       (conrelid='pack_hook_attachment_revisions'::regclass and confrelid in
         ('pack_candidate_revisions'::regclass,'pack_component_revisions'::regclass)) or
       (conrelid='staged_changeset_operations'::regclass and confrelid='pack_component_revisions'::regclass))`,
    )).rows[0].count,
    "5",
  );
  assertEquals(
    (await query<{ count: string }>(
      sql,
      `select count(*)::text count from pg_indexes where indexname in
       ('pack_component_revisions_candidate_revision_id_definition_k_key',
        'pack_hook_attachment_component_ordinal_unique')`,
    )).rows[0].count,
    "2",
  );
  await assertRejects(() =>
    query(
      sql,
      `insert into pack_component_revisions(id,candidate_revision_id,definition_kind,definition_name,definition_digest)
       select $1,candidate_revision_id,definition_kind,definition_name,definition_digest
       from pack_component_revisions where id=$2`,
      [uuidV7(), component.id],
    )
  );
  await assertRejects(() =>
    query(
      sql,
      `insert into pack_hook_attachment_revisions(
       id,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
       phase,ordinal,declaration_digest,declaration_spec)
       select $1,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
       phase,ordinal,$2,declaration_spec from pack_hook_attachment_revisions where id=$3`,
      [uuidV7(), `sha256:${"f".repeat(64)}`, attachment.id],
    )
  );
  for (
    const statement of [
      "update pack_component_revisions set definition_digest=definition_digest where id=$1",
      "delete from pack_component_revisions where id=$1",
    ]
  ) await assertRejects(() => query(sql, statement, [component.id]));
  for (
    const statement of [
      "update pack_hook_attachment_revisions set ordinal=ordinal where id=$1",
      "delete from pack_hook_attachment_revisions where id=$1",
    ]
  ) await assertRejects(() => query(sql, statement, [attachment.id]));
  await assertRejects(() =>
    query(
      sql,
      `insert into pack_component_revisions(id,candidate_revision_id,definition_kind,definition_name,definition_digest)
       values($1,$2,'resource','missing',$3)`,
      [uuidV7(), uuidV7(), `sha256:${"1".repeat(64)}`],
    )
  );
  await assertRejects(() =>
    query(
      sql,
      `insert into pack_hook_attachment_revisions(
       id,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
       phase,ordinal,declaration_digest,declaration_spec)
       select $1,candidate_revision_id,$2,hook_identity,component_revision_id,
       phase,ordinal,$3,declaration_spec from pack_hook_attachment_revisions where id=$4`,
      [uuidV7(), uuidV7(), `sha256:${"2".repeat(64)}`, attachment.id],
    )
  );
}

async function installFailureTrigger(sql: Sql, table: string) {
  await query(
    sql,
    `create function test_fail_${table}() returns trigger language plpgsql as $$
     begin raise exception 'injected ${table} projection failure'; end $$`,
  );
  await query(
    sql,
    `create trigger test_fail_${table}_trigger before insert on ${table}
     for each row execute function test_fail_${table}()`,
  );
}
async function dropFailureTrigger(sql: Sql, table: string) {
  await query(sql, `drop trigger test_fail_${table}_trigger on ${table}`);
  await query(sql, `drop function test_fail_${table}()`);
}
async function assertProjectionAbsent(sql: Sql, digest: string) {
  const row = (await query<
    {
      candidates: string;
      components: string;
      attachments: string;
      plans: string;
    }
  >(
    sql,
    `select
      (select count(*)::text from pack_candidate_revisions where source_digest=$1) candidates,
      (select count(*)::text from pack_component_revisions c join pack_candidate_revisions r on r.id=c.candidate_revision_id where r.source_digest=$1) components,
      (select count(*)::text from pack_hook_attachment_revisions a join pack_candidate_revisions r on r.id=a.candidate_revision_id where r.source_digest=$1) attachments,
      (select count(*)::text from pack_migration_plans_v1 where candidate_source_digest=$1) plans`,
    [digest],
  )).rows[0];
  assertEquals(row, {
    candidates: "0",
    components: "0",
    attachments: "0",
    plans: "0",
  });
}

function withAllAttachments(pack: LoadedPack): LoadedPack {
  const value = structuredClone(pack);
  const hookName = Object.keys(value.hooks).sort()[0];
  const hook = value.hooks[hookName];
  const resource = Object.keys(value.resources).sort()[0];
  const action = Object.keys(value.actions).sort()[0];
  const attachments = [
    {
      phase: "changeset.before_stage",
      resource: `${value.publisher}/${value.name}:${resource}`,
      order: 10,
      input: {},
    },
    {
      phase: "action.stage",
      action: `${value.publisher}/${value.name}:${action}`,
      order: 20,
      input: {},
    },
    {
      phase: "changeset.validate",
      resource: `${value.publisher}/${value.name}:${resource}`,
      order: 30,
      input: {},
    },
    {
      phase: "event.after_commit",
      event: "component.test",
      order: 40,
      input: {},
    },
  ];
  hook.spec.attachments = attachments as never;
  (hook.document.spec as Record<string, unknown>).attachments = attachments;
  const normalizedHook =
    (value.normalized.hooks as Record<string, Record<string, unknown>>)[
      hookName
    ];
  (normalizedHook.spec as Record<string, unknown>).attachments = attachments;
  return value;
}
function nextRevision(
  pack: LoadedPack,
  version: string,
  digestCharacter: string,
): LoadedPack {
  const value = structuredClone(pack);
  value.version = version;
  value.sourceDigest = `sha256:${digestCharacter.repeat(64)}`;
  value.revision = `${value.publisher}/${value.name}@${version}:sha256:${
    digestCharacter.repeat(64)
  }`;
  const resourceName = Object.keys(value.resources).sort()[0];
  const definition = value.resources[resourceName];
  (definition.spec.fields as Record<string, unknown>).matrix_extra = {
    type: "string",
  };
  const documentSpec = definition.document.spec as Record<string, unknown>;
  (documentSpec.fields as Record<string, unknown>).matrix_extra = {
    type: "string",
  };
  const normalized = (value.normalized.resources as Record<
    string,
    Record<string, unknown>
  >)[resourceName];
  const normalizedSpec = normalized.spec as Record<string, unknown>;
  (normalizedSpec.fields as Record<string, unknown>).matrix_extra = {
    type: "string",
  };
  return value;
}
async function activeProjection(sql: Sql, publisher: string, pack: string) {
  const candidate = (await query<{ id: string }>(
    sql,
    "select candidate_revision_id id from pack_active_revisions where publisher=$1 and pack_name=$2",
    [publisher, pack],
  )).rows[0].id;
  return { candidate, ...await projection(sql, candidate) };
}
function acknowledgement(value: "safe" | "risky" | "destructive") {
  return {
    acknowledgement: value === "safe"
      ? "safe" as const
      : value === "risky"
      ? "reviewed" as const
      : "destructive" as const,
  };
}
async function seedRoot(sql: Sql) {
  const principal = uuidV7(),
    human = uuidV7(),
    session = uuidV7(),
    id = uuidV7();
  await query(
    sql,
    "insert into principals(id,type,active) values($1,'human_user',true)",
    [principal],
  );
  await query(
    sql,
    "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'component-root','Component Root','active')",
    [human, principal],
  );
  await query(
    sql,
    "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','component-root-token')",
    [session, principal, human],
  );
  await query(
    sql,
    "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{system:super_admin}',now())",
    [id, principal, human, session],
  );
  return { id, principal, human, session };
}
async function packFiles(dir: string): Promise<UploadedPackFile[]> {
  const files: UploadedPackFile[] = [];
  async function collect(path: string, prefix = "") {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await collect(child, relative);
      else if (/\.(?:yaml|ts)$/.test(relative)) {
        files.push({ path: relative, text: await Deno.readTextFile(child) });
      }
    }
  }
  await collect(dir);
  return files;
}
