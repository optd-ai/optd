import type { Sql } from "../client.ts";
import { query, quoteIdentifier } from "../client.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { Result } from "../../../../domain/errors/result.ts";
import type {
  StageDto,
  StageSource,
} from "../../../../application/ports/stage_repository.ts";
import type {
  ActionDefinition,
  ActionIdentity,
  ActionReadRequest,
  ActionReadResult,
  ActionStageCapabilities,
} from "../../../../application/services/actions/stage_actions.ts";
import type { PinnedHookProgram } from "../../../../application/ports/repair/repositories.ts";
import {
  evaluateTargetedActionPolicy,
  lockTargetedActionAuthority,
  targetedActionAuthorityFactsDigest,
} from "../query_policy_sql.ts";
import {
  type FieldSpec,
  lowerCelToSql,
} from "../../../../domain/queries/expression_lowerer.ts";
import { lockReadAuthority } from "../object_read_boundary.ts";

export function makePostgresActionStageRepository(
  sql: Sql,
  common: {
    stageSource(
      input: unknown,
      source: StageSource,
      auth: AuthContext,
    ): Promise<Result<StageDto | null>>;
  },
): Omit<ActionStageCapabilities, "executeHooks"> {
  return {
    async definition(
      identity: ActionIdentity,
    ): Promise<ActionDefinition | null> {
      const revision = (await query<{ id: string; normalized: unknown }>(
        sql,
        `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2`,
        [identity.publisher, identity.pack],
      )).rows[0];
      const action = record(
        record(record(revision?.normalized).actions)[identity.name],
      );
      return revision && Object.keys(action).length
        ? {
          revisionId: revision.id,
          normalized: revision.normalized,
          spec: record(action.spec),
        }
        : null;
    },

    async availability(
      identity: ActionIdentity,
    ): Promise<ActionDefinition | null> {
      return await this.definition(identity);
    },

    async current(
      request: ActionReadRequest,
    ): Promise<ActionReadResult | null> {
      const table = await runtimeTable(sql, request.target);
      if (!table) return null;
      const columns = [
        ...new Set([
          "id",
          "version",
          "current_object_version_id",
          ...request.fields,
        ]),
      ]
        .map(quoteIdentifier).join(",");
      const row = (await query<Record<string, unknown>>(
        sql,
        `select ${columns} from ${
          quoteIdentifier(table)
        } where project_id=$1 and id=$2 and archived_at is null`,
        [request.projectId, request.objectId],
      )).rows[0];
      if (!row) return null;
      return {
        values: Object.fromEntries(
          request.fields.map((
            field,
          ) => [field, curatedReadValue(field, row[field])]),
        ),
        objectVersionId: String(row.current_object_version_id),
      };
    },

    async availabilityState(request): Promise<unknown | undefined> {
      const table = await runtimeTable(sql, request.target);
      if (!table) return undefined;
      return (await query<Record<string, unknown>>(
        sql,
        `select ${quoteIdentifier(request.field)} state from ${
          quoteIdentifier(table)
        } where project_id=$1 and id=$2 and archived_at is null`,
        [request.projectId, request.objectId],
      )).rows[0]?.state;
    },

    async availabilityCondition(request): Promise<boolean> {
      const table = await runtimeTable(sql, request.target);
      if (!table) return false;
      const fields = Object.fromEntries(
        Object.entries(request.fields).map(([name, raw]) => {
          const descriptor = record(raw);
          return [name, {
            type: String(descriptor.type) as FieldSpec["type"],
            ...(descriptor.required !== true ? { nullable: true } : {}),
            ...(descriptor.format === "uuid" || descriptor.ref
              ? { format: "uuid" as const }
              : {}),
          }];
        }),
      );
      const lowered = lowerCelToSql(request.expression, {
        fields,
        actor: {
          id: { type: "string", value: request.auth.principalId },
          human_user_id: {
            type: "string",
            value: request.auth.principalType === "agent_user"
              ? null
              : request.auth.humanUserId,
          },
        },
        alias: "candidate",
        parameterOffset: 2,
        maxNodes: 80,
        maxLength: 1000,
      });
      return (await query<{ allowed: boolean }>(
        sql,
        `select coalesce((${lowered.sql}),false) allowed from ${
          quoteIdentifier(table)
        } candidate where project_id=$1 and id=$2 and archived_at is null`,
        [request.projectId, request.objectId, ...lowered.params],
      )).rows[0]?.allowed === true;
    },

    async pinned(
      request,
    ): Promise<readonly PinnedHookProgram<"action.stage">[]> {
      const rows = (await query<Record<string, unknown>>(
        sql,
        `select a.id,a.hook_revision_id,a.ordinal,a.declaration_digest,a.declaration_spec,h.definition_name hook_name,
          h.hook_security_digest,h.hook_script_digest,h.hook_normalized_config,h.hook_script_content
         from pack_hook_attachment_revisions a join pack_component_revisions h on h.id=a.hook_revision_id
         where a.candidate_revision_id=$1 and a.phase='action.stage' and a.declaration_spec->>'action'=$2 order by a.ordinal,a.id`,
        [
          request.revisionId,
          `${request.publisher}/${request.pack}:${request.name}`,
        ],
      )).rows;
      return rows.map((row) => pinnedProgram(row, request));
    },

    async lockAndEvaluate(request) {
      return await sql.begin(async (tx) => {
        const anchor = await lockReadAuthority(
          tx,
          request.auth,
          request.projectId,
        );
        await lockTargetedActionAuthority(tx, request.targets);
        const evaluation = await evaluateTargetedActionPolicy(tx, {
          projectId: request.projectId,
          action: request.action,
          targets: request.targets,
        }, request.auth);
        return {
          ...evaluation,
          authorizationRootId: anchor.authorizationRootId,
          factsDigest: await targetedActionAuthorityFactsDigest(
            tx,
            request.projectId,
            request.targets,
            request.auth,
          ),
        };
      });
    },

    assertAllowed(decision) {
      return Promise.resolve(decision);
    },

    async record(request) {
      const persisted = request.source.authority?.targeted?.cutoff;
      if (
        !persisted ||
        persisted.authorization_root_id !==
          request.cutoff.authorizationRootId ||
        persisted.facts_digest !== request.cutoff.factsDigest ||
        persisted.principal_id !== request.auth.principalId ||
        persisted.auth_context_id !== request.auth.id
      ) {
        throw Object.assign(
          new Error("action authority cutoff changed before persistence"),
          { code: "40001" },
        );
      }
      return await common.stageSource(
        request.input,
        request.source,
        request.auth,
      );
    },
  };
}

async function runtimeTable(
  sql: Sql,
  target: { publisher: string; pack: string; name: string },
): Promise<string | null> {
  return (await query<{ table_name: string }>(
    sql,
    `select rt.table_name from pack_runtime_tables rt
     join pack_active_revisions ar on ar.publisher=rt.publisher and ar.pack_name=rt.pack_name
     where rt.publisher=$1 and rt.pack_name=$2 and rt.definition_kind='resource' and rt.definition_name=$3`,
    [target.publisher, target.pack, target.name],
  )).rows[0]?.table_name ?? null;
}

function pinnedProgram(
  row: Record<string, unknown>,
  request: ActionIdentity & { revisionId: string },
): PinnedHookProgram<"action.stage"> {
  const config = record(row.hook_normalized_config);
  const permissions = record(config.permissions);
  const declaration = record(row.declaration_spec);
  const digest = String(row.declaration_digest);
  return {
    hookIdentity: `${request.publisher}/${request.pack}:${
      String(row.hook_name)
    }`,
    revisionId: String(row.hook_revision_id),
    source: String(row.hook_script_content),
    sourceDigest: String(row.hook_script_digest),
    scriptDigest: String(row.hook_script_digest),
    securityDigest: String(row.hook_security_digest),
    attachmentId: String(row.id),
    attachmentDigest: digest,
    configurationDigest: String(row.hook_security_digest),
    declarationDigest: digest,
    declaration: {
      pack_revision_id: request.revisionId,
      input_mapping: record(declaration.input),
      condition: declaration.condition == null
        ? null
        : String(declaration.condition),
      effects: array(record(config.effects).operations),
    } as PinnedHookProgram<"action.stage">["declaration"],
    ordinal: Number(row.ordinal),
    timeoutMs: Number(config.timeout_ms),
    permissions: {
      net: array(permissions.net).map(String),
      env: array(permissions.env).map(String),
    },
    secretDeclarations: array(config.secrets).map((slot) => ({
      slot: String(record(slot).slot),
      env: String(record(slot).env),
    })),
    enabled: true,
    phase: "action.stage",
    outputSchema: "changeset.operations.v1",
  };
}

function curatedReadValue(field: string, value: unknown): unknown {
  if (field === "id") return String(value);
  if (field === "version") {
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("declared action read has an invalid object version");
    }
    return version;
  }
  return value instanceof Date ? value.toISOString() : value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
