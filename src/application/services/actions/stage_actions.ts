import type { Sql } from "../../../adapters/outbound/postgres/client.ts";
import {
  query,
  quoteIdentifier,
} from "../../../adapters/outbound/postgres/client.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { StageDto, StageSource } from "../../ports/stage_repository.ts";
import {
  type ActionStageHookDeclaration,
  TrustedStageHookCoordinator,
} from "../hooks/stage_hook_coordinator.ts";
import { validateFieldMap } from "../../../schemas/changesets/field_values.ts";
import {
  evaluateTargetedActionPolicy,
  type TargetedActionPolicyTarget,
} from "../query_objects.ts";
import {
  type FieldSpec,
  lowerCelToSql,
} from "../../../domain/queries/expression_lowerer.ts";

export function makeStageActionService(
  sql: Sql,
  coordinator: TrustedStageHookCoordinator,
  common: {
    stageSource(
      input: unknown,
      source: StageSource,
      auth: AuthContext,
    ): Promise<Result<StageDto | null>>;
  },
) {
  return {
    async stage(
      publisher: string,
      pack: string,
      name: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<StageDto | { status: "no_changes"; stage: null }>> {
      try {
        if (
          !isRecord(raw) || Object.keys(raw).some((key) =>
            key !== "project_id" && key !== "input"
          ) || typeof raw.project_id !== "string" ||
          !isUuidV7(raw.project_id) || !isRecord(raw.input)
        ) {
          return invalid("action stage request is invalid");
        }
        const revision = (await query<{ id: string; normalized: unknown }>(
          sql,
          `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2`,
          [publisher, pack],
        )).rows[0];
        const action = record(
          record(record(revision?.normalized).actions)[name],
        );
        if (!revision || !Object.keys(action).length) {
          return err({
            code: "not_found",
            message: "action was not found",
            severity: "not_found",
            details: {},
          });
        }
        const spec = record(action.spec);
        const inputSpec = record(spec.input);
        const inputIssue = validateActionInput(raw.input, inputSpec);
        if (inputIssue) {
          return invalid(inputIssue);
        }
        const semantic = `action:${publisher}/${pack}:${name}`;
        const reads: Record<string, unknown> = {};
        const readFacts: Record<
          string,
          { row: Record<string, unknown>; resource: string; table: string }
        > = {};
        const readDependencies: Array<
          {
            name: string;
            project_id: string;
            resource_identity: string;
            object_id: string;
            object_version_id: string;
          }
        > = [];
        const policyTargets: TargetedActionPolicyTarget[] = [];
        for (const readName of Object.keys(record(spec.reads)).sort()) {
          const declaration = record(record(spec.reads)[readName]);
          const source = String(declaration.id_from);
          const fieldName = source.replace(/^\$action\.input\./, "");
          const objectId = raw.input[fieldName];
          if (objectId === undefined && declaration.required === false) {
            continue;
          }
          if (
            typeof objectId !== "string" || !isUuidV7(objectId)
          ) {
            return invalid(
              `declared action read ${readName} requires a UUIDv7 input`,
            );
          }
          const resourceIdentity = String(declaration.resource);
          const qualified = resourceIdentity.includes(":")
            ? resourceIdentity
            : `${publisher}/${pack}:${resourceIdentity}`;
          const target = parseResourceIdentity(qualified);
          if (!target) {
            return invalid("declared action read resource is unavailable");
          }
          const table = (await query<{ table_name: string }>(
            sql,
            `select rt.table_name from pack_runtime_tables rt
             join pack_active_revisions ar on ar.publisher=rt.publisher and ar.pack_name=rt.pack_name
             where rt.publisher=$1 and rt.pack_name=$2 and rt.definition_kind='resource' and rt.definition_name=$3`,
            [target.publisher, target.pack, target.name],
          )).rows[0]?.table_name;
          if (!table) {
            return invalid(
              "declared action read resource is unavailable",
            );
          }
          const fields = Array.isArray(declaration.fields)
            ? declaration.fields.map(String)
            : [];
          const columns = [
            ...new Set([
              "id",
              "version",
              "current_object_version_id",
              ...fields,
            ]),
          ].map(quoteIdentifier).join(",");
          const row = (await query<Record<string, unknown>>(
            sql,
            `select ${columns} from ${
              quoteIdentifier(table)
            } where project_id=$1 and id=$2 and archived_at is null`,
            [raw.project_id, objectId],
          )).rows[0];
          if (!row) {
            if (declaration.required === false) {
              continue;
            }
            return invalid(`required action read ${readName} was not found`);
          }
          reads[readName] = Object.fromEntries(
            fields.map((field) => [field, row[field]]),
          );
          readFacts[readName] = { row, resource: qualified, table };
          policyTargets.push({ definition: target, objectId });
          readDependencies.push({
            name: readName,
            project_id: raw.project_id,
            resource_identity: qualified,
            object_id: objectId,
            object_version_id: String(row.current_object_version_id),
          });
        }
        const availabilityIssue = await checkAvailability(
          sql,
          revision.normalized,
          spec,
          readFacts,
          raw.project_id,
          auth,
        );
        if (availabilityIssue) {
          return err({
            code: "action_unavailable",
            message: "action is not currently available",
            severity: "conflict",
            details: { reason: availabilityIssue },
          });
        }
        const rows = (await query<Record<string, unknown>>(
          sql,
          `select a.id,a.hook_revision_id,a.ordinal,a.declaration_digest,a.declaration_spec,h.definition_name hook_name,
          h.hook_security_digest,h.hook_script_digest,h.hook_normalized_config,h.hook_script_content
         from pack_hook_attachment_revisions a join pack_component_revisions h on h.id=a.hook_revision_id
         where a.candidate_revision_id=$1 and a.phase='action.stage' and a.declaration_spec->>'action'=$2 order by a.ordinal,a.id`,
          [revision.id, `${publisher}/${pack}:${name}`],
        )).rows;
        if (!rows.length) {
          return invalid(
            "action has no active reviewed stage attachment",
          );
        }
        const declarations: ActionStageHookDeclaration[] = rows.map((row) => {
          const config = record(row.hook_normalized_config);
          const permissions = record(config.permissions);
          const declaration = record(row.declaration_spec);
          return {
            attachment_id: String(row.id),
            hook_revision_id: String(row.hook_revision_id),
            pack_revision_id: revision.id,
            hook: `${publisher}/${pack}:${String(row.hook_name)}`,
            phase: "action.stage",
            resource: null,
            operation_key: null,
            order: Number(row.ordinal),
            script_digest: String(row.hook_script_digest),
            security_digest: String(row.hook_security_digest),
            script_content: String(row.hook_script_content),
            timeout_ms: Number(config.timeout_ms),
            output_schema: "changeset.operations.v1",
            permissions: {
              net: array(permissions.net).map(String),
              env: array(permissions.env).map(String),
            },
            secret_slots: array(config.secrets).map((slot) => ({
              slot: String(record(slot).slot),
              env: String(record(slot).env),
            })),
            input_mapping: record(declaration.input),
            condition: declaration.condition == null
              ? null
              : String(declaration.condition),
            effects: array(record(config.effects).operations),
            declaration_digest: String(row.declaration_digest),
          };
        });
        const effects = declarations.flatMap((declaration) =>
          declaration.effects
        ).filter((value): value is Record<string, unknown> =>
          isRecord(value)
        ).map((effect) => ({
          resource: String(effect.resource),
          ops: array(effect.ops).map(String),
        }));
        const resolvedPolicyTargets = resolveActionPolicyTargets(
          policyTargets,
          effects,
        );
        if (!resolvedPolicyTargets) {
          return invalid("action effects have no exact authorization target");
        }
        const authority = await sql.begin((tx) =>
          evaluateTargetedActionPolicy(
            tx,
            {
              projectId: String(raw.project_id),
              action: semantic,
              targets: resolvedPolicyTargets,
            },
            auth,
          )
        ) as Awaited<ReturnType<typeof evaluateTargetedActionPolicy>>;
        if (!authority.allowed) {
          return policyDenied(semantic, raw.project_id, auth);
        }

        const result = await coordinator.runActionStage({
          action: `${publisher}/${pack}:${name}`,
          project_id: raw.project_id,
          actor: {
            id: auth.principalId,
            principal_type: auth.principalType,
          },
          input: raw.input,
          reads,
          read_dependencies: readDependencies,
          declarations,
          authority_snapshot: {
            principal_id: auth.principalId,
            auth_context_id: auth.id,
            assignment_digest: authority.policyDigest,
            policy_digest: authority.policyDigest,
          },
        });
        if (!result.added_operations.length) {
          return ok({
            status: "no_changes",
            stage: null,
          });
        }
        const source: StageSource = {
          kind: "action",
          identity: {
            action: `${publisher}/${pack}:${name}`,
            revision_id: revision.id,
          },
          authority: {
            project_id: raw.project_id,
            actions: [semantic],
            revision_id: revision.id,
            effects: effects.map((effect) => ({
              ...effect,
              authority_action: semantic,
            })),
            operation_authority: Object.fromEntries(
              result.added_operations.map((
                operation,
              ) => [operation.key, semantic]),
            ),
          },
          dependencies: readDependencies.map((dependency) => ({
            kind: "object_version",
            ...dependency,
            expected_version_id: dependency.object_version_id,
          })),
          hook_executions: result.hook_executions.map((execution) => ({
            id: execution.id,
            attachment_id: execution.attachment_id,
            phase: execution.phase,
            pack_revision_id: execution.pack_revision_id,
            hook_revision_id: execution.hook_revision_id,
            input_digest: execution.input_digest,
            output_digest: execution.output_digest,
            output: execution.output,
            script_digest: execution.script_digest,
            security_digest: execution.security_digest,
            stderr: execution.stderr,
            logs_truncated: execution.logs_truncated,
            secrets_redacted: execution.secrets_redacted,
            duration_ms: execution.duration_ms,
            authority_snapshot: execution.authority_snapshot,
            grant_snapshot: execution.grant_snapshot,
          })),
        };
        const staged = await common.stageSource(
          { operations: result.added_operations },
          source,
          auth,
        );
        return staged.ok ? ok(staged.value!) : staged;
      } catch (error) {
        console.error(error);
        return err({
          code: "internal_error",
          message: "unexpected server error",
          severity: "internal",
          details: {},
        });
      }
    },
  };
}
async function checkAvailability(
  sql: Sql,
  normalized: unknown,
  actionSpec: Record<string, unknown>,
  reads: Record<
    string,
    { row: Record<string, unknown>; resource: string; table: string }
  >,
  projectId: string,
  auth: AuthContext,
): Promise<string | null> {
  const availability = record(actionSpec.availability);
  if (!Object.keys(availability).length) return null;
  const resource = String(availability.resource);
  const matches = Object.values(reads).filter((read) =>
    read.resource === resource
  );
  if (matches.length !== 1) {
    return "availability does not bind one reviewed current read";
  }
  const current = matches[0];
  const lifecycles = Object.values(record(record(normalized).lifecycles)).map(
    record,
  ).filter((value) => String(record(value.spec).resource) === resource);
  if (lifecycles.length !== 1) {
    return "availability lifecycle is unavailable or ambiguous";
  }
  const lifecycle = record(lifecycles[0].spec);
  const field = String(lifecycle.field);
  const state = (await query<Record<string, unknown>>(
    sql,
    `select ${quoteIdentifier(field)} state from ${
      quoteIdentifier(current.table)
    } where project_id=$1 and id=$2 and archived_at is null`,
    [projectId, current.row.id],
  )).rows[0]?.state;
  if (state === undefined) return "availability object is absent or archived";
  if (
    Array.isArray(availability.states) && !availability.states.includes(state)
  ) return "availability state is not allowed";
  if (typeof availability.condition === "string") {
    const resourceName = resource.split(":").pop()!;
    const definition = record(
      record(record(normalized).resources)[resourceName],
    );
    const descriptors = record(record(definition.spec).fields);
    const fields = Object.fromEntries(
      Object.entries(descriptors).map(([name, raw]) => {
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
    const lowered = lowerCelToSql(availability.condition, {
      fields,
      actor: {
        id: { type: "string", value: auth.principalId },
        human_user_id: {
          type: "string",
          value: auth.principalType === "agent_user" ? null : auth.humanUserId,
        },
      },
      alias: "candidate",
      parameterOffset: 2,
      maxNodes: 80,
      maxLength: 1000,
    });
    const result = await query<{ allowed: boolean }>(
      sql,
      `select coalesce((${lowered.sql}),false) allowed from ${
        quoteIdentifier(current.table)
      } candidate where project_id=$1 and id=$2 and archived_at is null`,
      [projectId, current.row.id, ...lowered.params],
    );
    if (!result.rows[0]?.allowed) {
      return "availability condition is not satisfied";
    }
  }
  return null;
}

export function validateActionInput(
  input: Record<string, unknown>,
  fields: Record<string, unknown>,
): string | null {
  return validateFieldMap(input, fields, true);
}
export function resolveActionPolicyTargets(
  reads: TargetedActionPolicyTarget[],
  effects: Array<{ resource: string }>,
): TargetedActionPolicyTarget[] | null {
  if (reads.length) return reads;
  const targets: TargetedActionPolicyTarget[] = [];
  for (
    const resource of [...new Set(effects.map((effect) => effect.resource))]
  ) {
    const definition = parseResourceIdentity(resource);
    if (!definition) return null;
    targets.push({ definition });
  }
  return targets.length ? targets : null;
}

function parseResourceIdentity(value: string): {
  kind: "resource";
  publisher: string;
  pack: string;
  name: string;
} | null {
  const match =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(value);
  return match
    ? { kind: "resource", publisher: match[1], pack: match[2], name: match[3] }
    : null;
}
function policyDenied(
  action: string,
  projectId: string,
  auth: AuthContext,
): Result<never> {
  return err({
    code: "policy_denied",
    message:
      `current authority does not allow ${action} on its declared targets`,
    severity: "authorization",
    details: {
      auth_context_id: auth.id,
      principal_id: auth.principalId,
      boundary: { type: "project", project_id: projectId },
      action,
    },
  });
}
function invalid(message: string): Result<never> {
  return err({
    code: "validation_failed",
    message,
    severity: "validation",
    details: {},
  });
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
