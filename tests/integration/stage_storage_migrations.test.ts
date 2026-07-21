// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  closePostgresClient,
  createPostgresClient,
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
  platformMigrations,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { canonicalSha256 } from "../../src/domain/ids/canonical_json.ts";
import { isUuidV7, uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { storeOrReuseCandidate } from "../../src/adapters/outbound/postgres/pack_repository.ts";
import { loadPackFromFiles } from "../../src/adapters/outbound/yaml/pack_loader.ts";

Deno.test({
  name:
    "populated 1019 database upgrades component and attachment evidence through 1021",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
      throw new Error("PostgreSQL 18.4 app-managed binaries are required");
    }
    const root = await Deno.makeTempDir({ prefix: "operant-stage-upgrade-" });
    const previous = Deno.env.get("OPERANT_DATA_DIR");
    Deno.env.set("OPERANT_DATA_DIR", root);
    let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
    let sql: Sql | undefined;
    try {
      runtime = await startPostgresRuntime();
      sql = createPostgresClient(runtime.databaseUrl);
      const migration1020 = platformMigrations.find((migration) =>
        migration.id === "1020_immutable_pack_component_revisions"
      )!;
      const migration1021 = platformMigrations.find((migration) =>
        migration.id === "1021_immutable_hook_attachment_revisions"
      )!;
      const migrations1022To1024 = platformMigrations.filter((migration) =>
        [
          "1022_hook_attachment_ordinal_identity",
          "1023_hook_attachment_component_ordinal_identity",
          "1024_trusted_hook_secrets",
        ].includes(migration.id)
      );
      const before1020 = platformMigrations.slice(
        0,
        platformMigrations.indexOf(migration1020),
      );
      await sql.begin((tx) => applyPlatformMigrations(tx, before1020));

      const principal = uuidV7(),
        user = uuidV7(),
        session = uuidV7(),
        auth = uuidV7(),
        project = uuidV7(),
        candidate = uuidV7(),
        stage = uuidV7(),
        operation = uuidV7();
      const definitions: Record<string, Record<string, unknown>> = {
        resources: {
          thing: {
            kind: "Resource",
            spec: { fields: {} },
            "\u{10000}": 1e-7,
            "\uE000": 1e30,
          },
        },
        relationships: { sibling: { kind: "Relationship", spec: {} } },
        lifecycles: { flow: { kind: "Lifecycle", spec: {} } },
        actions: { run: { kind: "Action", spec: {} } },
        hooks: {
          guard_before: strictLegacyHook("guard_before.ts", "patch.v1", {
            phase: "changeset.before_stage",
            resource: "test/upgrade:thing",
            input: { "\u{10000}": 1e-7, "\uE000": 1e30 },
          }),
          guard_action: strictLegacyHook(
            "guard_action.ts",
            "changeset.operations.v1",
            {
              phase: "action.stage",
              action: "test/upgrade:run",
              input: {},
            },
          ),
          guard_validate: strictLegacyHook(
            "guard_validate.ts",
            "validation.v1",
            {
              phase: "changeset.validate",
              resource: "test/upgrade:thing",
              input: {},
            },
          ),
          guard_event: strictLegacyHook("guard_event.ts", "delivery.v1", {
            phase: "event.after_commit",
            event: "thing.changed",
            input: {},
          }),
        },
        roles: { worker: { kind: "Role", spec: {} } },
        policies: { allow: { kind: "Policy", spec: {} } },
        seeds: { initial: { kind: "Seed", spec: {} } },
      };
      const legacySources = await legacyHookSources();
      await sql.begin(async (tx) => {
        await query(
          tx,
          "insert into principals(id,type,active) values($1,'human_user',true)",
          [principal],
        );
        await query(
          tx,
          "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'stage-upgrade','Stage Upgrade','active')",
          [user, principal],
        );
        await query(
          tx,
          "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','stage-upgrade-token')",
          [session, principal, user],
        );
        await query(
          tx,
          "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{}',now())",
          [auth, principal, user, session],
        );
        await query(
          tx,
          "insert into projects(id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id) values($1,'stage-upgrade','Stage Upgrade',$2,$2)",
          [project, auth],
        );
        await query(
          tx,
          `insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files)
          values($1,'test','upgrade','1.0.0',$2,$3,'{}',$4::jsonb,$5::jsonb)`,
          [
            candidate,
            `sha256:${"1".repeat(64)}`,
            `sha256:${"2".repeat(64)}`,
            definitions,
            legacySources,
          ],
        );
        await query(
          tx,
          `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json)
          values($1,1,'direct','{}',$2,$3,'{}',$4,$4,'{}','[]','[]','[]','[]','[]')`,
          [stage, auth, principal, `sha256:${"3".repeat(64)}`],
        );
        await query(
          tx,
          `insert into staged_changeset_operations(stage_id,ordinal,operation_id,project_id,pack_revision_id,resource_revision_id,operation_kind,object_id,canonical_operation_json,component_digest)
          values($1,0,$2,$3,$4,null,'create',$5,$6::jsonb,$7)`,
          [stage, operation, project, candidate, uuidV7(), {
            op: "create",
            resource: "test/upgrade:thing",
          }, `sha256:${"0".repeat(64)}`],
        );
        await query(
          tx,
          "insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'ready',1)",
          [stage],
        );
      });

      for (const failAt of ["callback", "finalization"] as const) {
        const failedMigration = {
          id: `test_application_migration_${failAt}_rollback`,
          sql:
            `create table test_application_migration_${failAt}_rollback(value text)`,
          applicationChecksum: `test-${failAt}-v1`,
          async migrate(tx: Parameters<typeof applyPlatformMigrations>[0]) {
            await query(
              tx,
              `insert into test_application_migration_${failAt}_rollback values('partial')`,
            );
            if (failAt === "callback") {
              throw new Error("injected callback failure");
            }
          },
          finalSql: failAt === "finalization"
            ? "select missing_finalization_function()"
            : "select 1",
        };
        await assertRejects(() =>
          sql!.begin((tx) => applyPlatformMigrations(tx, [failedMigration]))
        );
        assertEquals(
          (await query<{ table_name: string | null }>(
            sql,
            `select to_regclass('test_application_migration_${failAt}_rollback')::text table_name`,
          )).rows[0].table_name,
          null,
        );
        assertEquals(
          (await query<{ count: string }>(
            sql,
            "select count(*)::text count from platform_schema_migrations where id=$1",
            [failedMigration.id],
          )).rows[0].count,
          "0",
        );
      }

      assertEquals(
        (await sql.begin((tx) => applyPlatformMigrations(tx, [migration1020])))
          .applied,
        [migration1020.id],
      );
      const components = await query<
        {
          id: string;
          definition_kind: string;
          definition_name: string;
          definition_digest: string;
        }
      >(
        sql,
        "select id,definition_kind,definition_name,definition_digest from pack_component_revisions where candidate_revision_id=$1 order by definition_kind",
        [candidate],
      );
      assertEquals(components.rows.length, 11);
      for (const component of components.rows) {
        assertEquals(isUuidV7(component.id), true);
        const section = component.definition_kind === "policy"
          ? "policies"
          : component.definition_kind === "lifecycle"
          ? "lifecycles"
          : `${component.definition_kind}s`;
        assertEquals(
          component.definition_digest,
          `sha256:${await canonicalSha256(
            definitions[section][component.definition_name],
          )}`,
        );
      }
      const pinnedOperation = (await query<
        { component_revision_id: string; component_digest: string }
      >(
        sql,
        "select component_revision_id,component_digest from staged_changeset_operations where stage_id=$1",
        [stage],
      )).rows[0];
      assertEquals(isUuidV7(pinnedOperation.component_revision_id), true);
      assertEquals(
        pinnedOperation.component_digest,
        components.rows.find((row) => row.definition_kind === "resource")!
          .definition_digest,
      );
      const nullable = (await query<{ is_nullable: string }>(
        sql,
        "select is_nullable from information_schema.columns where table_name='staged_changeset_operations' and column_name='component_revision_id'",
      )).rows[0];
      assertEquals(nullable.is_nullable, "NO");
      assertEquals(
        (await query<{ exists: boolean }>(
          sql,
          "select to_regprocedure('operant_canonical_jsonb(jsonb)') is not null exists",
        )).rows[0].exists,
        false,
      );

      assertEquals(
        (await sql.begin((tx) => applyPlatformMigrations(tx, [migration1021])))
          .applied,
        [migration1021.id],
      );
      const attachments = await query<
        {
          id: string;
          phase: string;
          ordinal: number;
          declaration_digest: string;
          component_revision_id: string | null;
          declaration_spec: Record<string, unknown>;
        }
      >(
        sql,
        "select id,phase,ordinal,declaration_digest,component_revision_id,declaration_spec from pack_hook_attachment_revisions where candidate_revision_id=$1 order by ordinal,phase",
        [candidate],
      );
      assertEquals(attachments.rows.map((row) => row.phase).sort(), [
        "action.stage",
        "changeset.before_stage",
        "changeset.validate",
        "event.after_commit",
      ]);
      const expectedAttachmentSpecs = [
        {
          hook: "test/upgrade:guard_before",
          phase: "changeset.before_stage",
          resource: "test/upgrade:thing",
          action: null,
          event: null,
          order: 0,
          condition: null,
          input: { "\u{10000}": 1e-7, "\uE000": 1e30 },
        },
        {
          hook: "test/upgrade:guard_action",
          phase: "action.stage",
          resource: null,
          action: "test/upgrade:run",
          event: null,
          order: 0,
          condition: null,
          input: {},
        },
        {
          hook: "test/upgrade:guard_validate",
          phase: "changeset.validate",
          resource: "test/upgrade:thing",
          action: null,
          event: null,
          order: 0,
          condition: null,
          input: {},
        },
        {
          hook: "test/upgrade:guard_event",
          phase: "event.after_commit",
          resource: null,
          action: null,
          event: "thing.changed",
          order: 0,
          condition: null,
          input: {},
        },
      ];
      for (const attachment of attachments.rows) {
        assertEquals(isUuidV7(attachment.id), true);
        const expected = expectedAttachmentSpecs.find((item) =>
          item.phase === attachment.phase
        )!;
        assertEquals(attachment.declaration_spec, expected);
        assertEquals(
          attachment.declaration_digest,
          `sha256:${await canonicalSha256(expected)}`,
        );
        assertEquals(
          attachment.component_revision_id === null,
          attachment.phase === "event.after_commit",
        );
      }
      assertEquals(
        (await query<{ count: string }>(
          sql,
          `select count(*)::text count from staged_changeset_operations o
           join pack_component_revisions c on c.id=o.component_revision_id
           where o.stage_id=$1 and o.component_revision_id is not null`,
          [stage],
        )).rows[0].count,
        "1",
      );
      await query(
        sql,
        `insert into platform_secrets(name,description,ciphertext,nonce,algorithm,key_id,created_by)
         values('legacy-secret',null,$1,$2,'AES-256-GCM','legacy-key','legacy-actor')`,
        [new Uint8Array([1, 2, 3]), new Uint8Array(12)],
      );
      await query(
        sql,
        `create table legacy_hook_secret_grants(id text primary key)`,
      );
      await query(
        sql,
        `insert into legacy_hook_secret_grants values('legacy-grant')`,
      );
      const auditId = uuidV7();
      await query(
        sql,
        `insert into audit_events(id,actor_id,event_type,resource,object_id,action,request_metadata_json)
         values($1,'legacy-actor','legacy.secret','system:secret','legacy-secret','legacy.secret','{}')`,
        [auditId],
      );
      await assertRejects(
        () =>
          sql!.begin((tx) => applyPlatformMigrations(tx, migrations1022To1024)),
        Error,
        "incompatible legacy secret ciphertext",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          `select count(*)::text count from platform_schema_migrations
            where id=any($1::text[])`,
          [migrations1022To1024.map((migration) => migration.id)],
        )).rows[0].count,
        "0",
      );
      assertEquals(
        (await query<{ present: boolean }>(
          sql,
          `select exists(select 1 from information_schema.columns
            where table_name='pack_component_revisions' and column_name='hook_security_digest') present`,
        )).rows[0].present,
        false,
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from audit_events where id=$1",
          [auditId],
        )).rows[0].count,
        "1",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from platform_secrets where name='legacy-secret'",
        )).rows[0].count,
        "1",
      );
      await query(
        sql,
        "delete from platform_secrets where name='legacy-secret'",
      );
      await assertRejects(
        () =>
          sql!.begin((tx) => applyPlatformMigrations(tx, migrations1022To1024)),
        Error,
        "incompatible legacy hook secret grants",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          `select count(*)::text count from platform_schema_migrations
            where id=any($1::text[])`,
          [migrations1022To1024.map((migration) => migration.id)],
        )).rows[0].count,
        "0",
      );
      await query(sql, "delete from legacy_hook_secret_grants");
      assertEquals(
        (await sql.begin((tx) =>
          applyPlatformMigrations(tx, migrations1022To1024)
        )).applied,
        migrations1022To1024.map((migration) => migration.id),
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from audit_events where id=$1",
          [auditId],
        )).rows[0].count,
        "1",
      );
      const currentPack = await loadPackFromFiles([
        {
          path: "pack.yaml",
          text: `kind: Pack
apiVersion: operant.dev/v1
metadata: { publisher: test, name: current, version: 1.0.0 }
spec: { purpose: Current repository proof., axi: {} }
`,
        },
        {
          path: "resources/item.yaml",
          text: `kind: Resource
apiVersion: operant.dev/v1
metadata: { name: item }
spec:
  fields:
    name: { type: string, required: true }
  axi: {}
`,
        },
        {
          path: "hooks/guard.yaml",
          text: `kind: Hook
apiVersion: operant.dev/v1
metadata: { name: guard }
spec:
  script: guard.ts
  permissions: { net: false, env: false, read: false, write: false, run: false }
  secrets: []
  effects: { operations: [] }
  output: { schema: validation.v1 }
  attachments:
    - { phase: changeset.validate, resource: item, input: {} }
  axi: {}
`,
        },
        {
          path: "hooks/guard.ts",
          text:
            `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`,
        },
      ]);
      const stored = await sql.begin((tx) =>
        storeOrReuseCandidate(tx, currentPack)
      );
      assertEquals(stored.reused, false);
      assertEquals(
        await sql.begin((tx) => storeOrReuseCandidate(tx, currentPack)),
        { id: stored.id, reused: true },
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_component_revisions where candidate_revision_id=$1",
          [candidate],
        )).rows[0].count,
        "11",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_hook_attachment_revisions where candidate_revision_id=$1",
          [candidate],
        )).rows[0].count,
        "4",
      );
      await assertRejects(() =>
        query(
          sql!,
          "update pack_component_revisions set definition_name=definition_name where candidate_revision_id=$1",
          [candidate],
        )
      );
      await assertRejects(() =>
        query(
          sql!,
          "delete from pack_hook_attachment_revisions where candidate_revision_id=$1",
          [candidate],
        )
      );
      assertEquals(
        (await sql.begin((tx) =>
          applyPlatformMigrations(tx, [migration1020, migration1021])
        )).applied,
        [],
      );

      await closePostgresClient(sql);
      sql = undefined;
      await runtime.stop();
      runtime = undefined;
      runtime = await startPostgresRuntime();
      sql = createPostgresClient(runtime.databaseUrl);
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_component_revisions where candidate_revision_id=$1",
          [candidate],
        )).rows[0].count,
        "11",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_hook_attachment_revisions where candidate_revision_id=$1",
          [candidate],
        )).rows[0].count,
        "4",
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

function strictLegacyHook(
  script: string,
  output: string,
  attachment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "Hook",
    spec: {
      script,
      timeout: "30s",
      permissions: {
        net: false,
        env: false,
        read: false,
        write: false,
        run: false,
      },
      secrets: [],
      effects: { operations: [] },
      output: { schema: output },
      attachments: [{ order: 0, ...attachment }],
      axi: {},
    },
  };
}

async function legacyHookSources(): Promise<Array<Record<string, unknown>>> {
  const sources = {
    "guard_before.ts": `console.log(JSON.stringify({patches:[]}));`,
    "guard_action.ts": `console.log(JSON.stringify({operations:[]}));`,
    "guard_validate.ts":
      `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`,
    "guard_event.ts": `console.log(JSON.stringify({outcome:"success"}));`,
  };
  const rows: Array<Record<string, unknown>> = [];
  for (const [name, content] of Object.entries(sources)) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(content),
      ),
    );
    rows.push({
      path: `hooks/${name}`,
      kind: "script",
      digest: `sha256:${
        Array.from(
          digest,
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("")
      }`,
      content,
    });
  }
  return rows;
}
