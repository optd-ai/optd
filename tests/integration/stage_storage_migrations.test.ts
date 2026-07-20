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
import type { LoadedPack } from "../../src/adapters/outbound/yaml/pack_loader.ts";

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
        resources: { thing: { kind: "Resource", spec: { fields: {} } } },
        relationships: { sibling: { kind: "Relationship", spec: {} } },
        lifecycles: { flow: { kind: "Lifecycle", spec: {} } },
        actions: { run: { kind: "Action", spec: {} } },
        hooks: {
          guard: {
            kind: "Hook",
            spec: {
              attachments: [
                {
                  phase: "changeset.before_stage",
                  resource: "test/upgrade:thing",
                  input: {},
                },
                {
                  phase: "action.stage",
                  action: "test/upgrade:run",
                  input: {},
                },
                {
                  phase: "changeset.validate",
                  resource: "test/upgrade:thing",
                  input: {},
                },
                {
                  phase: "event.after_commit",
                  event: "thing.changed",
                  input: {},
                },
              ],
            },
          },
        },
        roles: { worker: { kind: "Role", spec: {} } },
        policies: { allow: { kind: "Policy", spec: {} } },
        seeds: { initial: { kind: "Seed", spec: {} } },
      };
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
          values($1,'test','upgrade','1.0.0',$2,$3,'{}',$4::jsonb,'{}')`,
          [
            candidate,
            `sha256:${"1".repeat(64)}`,
            `sha256:${"2".repeat(64)}`,
            definitions,
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
      assertEquals(components.rows.length, 8);
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
          hook: "test/upgrade:guard",
          phase: "changeset.before_stage",
          resource: "test/upgrade:thing",
          action: null,
          event: null,
          order: 0,
          condition: null,
          input: {},
        },
        {
          hook: "test/upgrade:guard",
          phase: "action.stage",
          resource: null,
          action: "test/upgrade:run",
          event: null,
          order: 0,
          condition: null,
          input: {},
        },
        {
          hook: "test/upgrade:guard",
          phase: "changeset.validate",
          resource: "test/upgrade:thing",
          action: null,
          event: null,
          order: 0,
          condition: null,
          input: {},
        },
        {
          hook: "test/upgrade:guard",
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
      const legacyPack = {
        publisher: "test",
        name: "upgrade",
        version: "1.0.0",
        revision: `test/upgrade@1.0.0:sha256:${"2".repeat(64)}`,
        sourceDigest: `sha256:${"1".repeat(64)}`,
        manifest: {},
        normalized: definitions,
        sourceFiles: [],
        resources: definitions.resources,
        relationships: definitions.relationships,
        lifecycles: definitions.lifecycles,
        actions: definitions.actions,
        hooks: definitions.hooks,
        roles: definitions.roles,
        policies: definitions.policies,
        seeds: definitions.seeds,
        scripts: {},
      } as unknown as LoadedPack;
      const reused = await sql.begin((tx) =>
        storeOrReuseCandidate(tx, legacyPack)
      );
      assertEquals(reused, { id: candidate, reused: true });
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_component_revisions where candidate_revision_id=$1",
          [candidate],
        )).rows[0].count,
        "8",
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
        "8",
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
