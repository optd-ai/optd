import { type Clock, SystemClock } from "../../../application/ports/clock.ts";
import { ObjectReadAuthorityInvalidError } from "../../../application/ports/object_reader.ts";
import { validateFieldValue as validateCanonicalFieldValue } from "../../../schemas/changesets/field_values.ts";
import type {
  StageDto,
  StageRepository,
  StageSource,
} from "../../../application/ports/stage_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { policyActorFromAuthContext } from "../../../domain/auth/policy_actor.ts";
import type { CanonicalOperation } from "../../../domain/changesets/operations.ts";
import {
  ApprovalContractError,
  canonicalizeApprovalRequirements,
} from "../../../domain/approvals/requirements.ts";
import {
  stageDigest,
  type StageHookDeclaration,
  type StageHookInput,
  type StageHookResult,
} from "../../../domain/changesets/stage.ts";
import {
  canonicalJson,
  canonicalSha256,
} from "../../../domain/ids/canonical_json.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { AuthorizationRepository } from "../../../application/ports/authorization.ts";
import { query, type Queryable, quoteIdentifier, type Sql } from "./client.ts";
import { lockReadAuthority } from "./object_read_boundary.ts";
import {
  type FieldSpec,
  lowerCelToSql,
} from "../../../domain/queries/expression_lowerer.ts";
import {
  evaluateExactTargetedActionAuthority,
  lockExactTargetAuthorityDependencies,
  lockTargetedActionAuthority,
  type TargetedActionPolicyTarget,
} from "./query_policy_sql.ts";
import {
  canonicalTargetDigestInput,
  type TargetAuthorityEvidence,
} from "../../../application/ports/repair/targeted_action.ts";
import { lockActiveAuthorizationLineage } from "./authorization_lineage.ts";

type Revision = {
  id: string;
  publisher: string;
  pack: string;
  contentDigest: string;
  normalized: Record<string, unknown>;
};
type Prepared = {
  projects: unknown[];
  revisions: Revision[];
  dependencies: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  hookDeclarations: Record<string, unknown>[];
  operationRows: Array<
    {
      operationId: string;
      revisionId: string;
      componentRevisionId: string;
      componentDigest: string;
      operation: CanonicalOperation;
    }
  >;
};

export type StageAuthorizationRepositoryFactory = (
  sql: Sql,
) => AuthorizationRepository;

export class PostgresStageRepository implements StageRepository {
  constructor(
    private readonly sql: Sql,
    private readonly authorizationRepository:
      StageAuthorizationRepositoryFactory,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async hasHooks(operations: CanonicalOperation[]): Promise<boolean> {
    const identities = [...new Set(operations.map(componentIdentity))].sort();
    for (const identity of identities) {
      const parsed = parseIdentity(identity);
      const found = (await query<{ present: boolean }>(
        this.sql,
        `select exists(
           select 1 from pack_active_revisions active
           join pack_hook_attachment_revisions attachment
             on attachment.candidate_revision_id=active.candidate_revision_id
          where active.publisher=$1 and active.pack_name=$2
            and attachment.phase in ('changeset.before_stage','changeset.validate')
            and (attachment.declaration_spec->'resource'='null'::jsonb or
                 attachment.declaration_spec->>'resource'=$3)
         ) as present`,
        [parsed.publisher, parsed.pack, identity],
      )).rows[0]?.present;
      if (found) return true;
    }
    return false;
  }

  async hookInput(
    operations: CanonicalOperation[],
    auth: AuthContext,
  ): Promise<Result<StageHookInput>> {
    try {
      return await this.sql.begin(async (tx) => {
        const projects: Record<string, unknown>[] = [];
        const projectIds = [
          ...new Set(operations.map((operation) => operation.project_id)),
        ].sort();
        for (const projectId of projectIds) {
          await lockReadAuthority(tx, auth, projectId);
          const project =
            (await query<{ id: string; version: string; status: string }>(
              tx,
              "select id,version,status from projects where id=$1 for share",
              [projectId],
            )).rows[0];
          if (!project || project.status !== "active") {
            throw domain(
              "project_inactive",
              "Project is not active",
              "conflict",
            );
          }
          projects.push({
            project_id: project.id,
            version: Number(project.version),
            status: project.status,
          });
        }
        const revisions: Record<string, unknown>[] = [];
        const hookDeclarations: StageHookDeclaration[] = [];
        const packs = [
          ...new Set(operations.map((operation) => {
            const identity = parseIdentity(componentIdentity(operation));
            return `${identity.publisher}/${identity.pack}`;
          })),
        ].sort();
        for (const pack of packs) {
          const [publisher, packName] = pack.split("/");
          const revision = (await query<
            {
              id: string;
              content_digest: string;
              normalized: unknown;
              source_files: unknown;
            }
          >(
            tx,
            `select cr.id,cr.content_digest,cr.normalized,cr.source_files from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2 for share of ar,cr`,
            [publisher, packName],
          )).rows[0];
          if (!revision) {
            throw domain(
              "validation_failed",
              "Active pack revision is unavailable",
              "validation",
            );
          }
          const operationResources = new Set(operations.map(componentIdentity));
          const attachments = (await query<{
            id: string;
            hook_revision_id: string;
            hook_identity: string;
            phase: StageHookDeclaration["phase"];
            ordinal: number;
            declaration_digest: string;
            declaration_spec: unknown;
            hook_security_digest: string;
            hook_script_digest: string;
            hook_normalized_config: unknown;
            hook_script_content: string;
          }>(
            tx,
            `select a.id,a.hook_revision_id,a.hook_identity,a.phase,a.ordinal,
                    a.declaration_digest,a.declaration_spec,h.hook_security_digest,
                    h.hook_script_digest,h.hook_normalized_config,h.hook_script_content
             from pack_hook_attachment_revisions a
             join pack_component_revisions h on h.id=a.hook_revision_id
             where a.candidate_revision_id=$1
               and a.phase in ('changeset.before_stage','changeset.validate') order by
               case a.phase when 'changeset.before_stage' then 0 else 1 end,
               a.ordinal,a.hook_identity,a.id for share of a,h`,
            [revision.id],
          )).rows.filter((attachment) => {
            const declaration = record(attachment.declaration_spec);
            const resource = declaration.resource;
            const condition = declaration.condition;
            if (condition === "false") return false;
            if (
              condition !== null && condition !== "true" &&
              condition !== "active()"
            ) {
              throw domain(
                "hook_condition_invalid",
                "Hook condition cannot be evaluated in the frozen stage context",
                "validation",
              );
            }
            return resource === null ||
              operationResources.has(String(resource));
          });
          for (const attachment of attachments) {
            const declaration = record(attachment.declaration_spec);
            const config = record(attachment.hook_normalized_config);
            const permissions = record(config.permissions);
            const outputSchema = String(record(config.output).schema);
            const slots = array(config.secrets).map((value) => {
              const slot = record(value);
              return { slot: String(slot.slot), env: String(slot.env) };
            });
            const matchingOperations = operations.filter((operation) =>
              (attachment.phase !== "changeset.before_stage" ||
                ["create", "update", "transition"].includes(operation.op)) &&
              (declaration.resource === null ||
                componentIdentity(operation) === String(declaration.resource))
            );
            const operationKeys = declaration.resource === null
              ? [null]
              : matchingOperations.map((operation) => String(operation.key));
            for (const operationKey of operationKeys) {
              hookDeclarations.push({
                attachment_id: attachment.id,
                hook_revision_id: attachment.hook_revision_id,
                pack_revision_id: revision.id,
                hook: attachment.hook_identity,
                phase: attachment.phase,
                resource: declaration.resource === null
                  ? null
                  : String(declaration.resource),
                operation_key: operationKey,
                order: attachment.ordinal,
                script_digest: attachment.hook_script_digest,
                security_digest: attachment.hook_security_digest,
                script_content: attachment.hook_script_content,
                timeout_ms: Number(config.timeout_ms),
                output_schema: outputSchema as "patch.v1" | "validation.v1",
                permissions: {
                  net: array(permissions.net).map(String),
                  env: array(permissions.env).map(String),
                },
                secret_slots: slots,
                input_mapping: record(declaration.input),
                condition: declaration.condition === null
                  ? null
                  : String(declaration.condition),
                effects: array(record(config.effects).operations),
                declaration_digest: attachment.declaration_digest,
              });
            }
          }
          revisions.push({
            publisher,
            pack: packName,
            revision_id: revision.id,
            content_digest: revision.content_digest,
          });
        }
        const proposedStates: Record<string, Record<string, unknown>> = {};
        const baseStates: Record<string, Record<string, unknown> | null> = {};
        for (const operation of operations) {
          if (
            !["create", "update", "transition", "archive", "comment"]
              .includes(operation.op)
          ) {
            continue;
          }
          const key = String(operation.key);
          const parsed = parseIdentity(componentIdentity(operation));
          proposedStates[key] = await proposedState(tx, operation, parsed);
          baseStates[key] = operation.op === "create"
            ? null
            : await currentResourceState(tx, operation, parsed);
        }
        const orderedHookDeclarations = hookDeclarations.sort(
          compareHookDeclarations,
        );
        // Run the same complete current Project, operation, policy, lineage,
        // definition, and hook pin validation used by final persistence before
        // any secret resolution, provider request, or child spawn.
        await prepare(
          tx,
          operations,
          auth,
          orderedHookDeclarations,
          undefined,
          this.authorizationRepository,
        );
        return ok({
          operations,
          projects,
          pack_revisions: revisions,
          hook_declarations: orderedHookDeclarations,
          authority_snapshot: await captureHookAuthoritySnapshot(
            tx,
            auth,
            projectIds,
          ),
          proposed_states: proposedStates,
          base_states: baseStates,
        });
      }) as Result<StageHookInput>;
    } catch (error) {
      return mapError(error);
    }
  }

  async create(
    input: {
      operations: CanonicalOperation[];
      operationGraphDigest: string;
      hookResult?: StageHookResult;
      hookDeclarations?: readonly StageHookDeclaration[];
      source?: StageSource;
    },
    auth: AuthContext,
  ): Promise<Result<StageDto>> {
    try {
      const actor = policyActorFromAuthContext(auth);
      return await this.sql.begin(async (tx) => {
        const prepared = await prepare(
          tx,
          input.operations,
          auth,
          input.hookDeclarations ?? [],
          input.source,
          this.authorizationRepository,
        );
        const operationGraphDigest = `sha256:${await canonicalSha256({
          schema: "changeset.operations.v1",
          operations: input.operations,
        })}`;
        const hook = input.hookResult;
        if (
          prepared.hookDeclarations.length &&
          (hook?.hook_executions.length ?? 0) < prepared.hookDeclarations.length
        ) {
          throw domain(
            "hook_rejected",
            "Hook coordinator did not return complete execution evidence",
            "validation",
          );
        }
        const currentRevisionIds = new Set(
          prepared.revisions.map((revision) => revision.id),
        );
        for (const execution of hook?.hook_executions ?? []) {
          if (
            !currentRevisionIds.has(String(record(execution).pack_revision_id))
          ) {
            throw domain(
              "project_conflict",
              "Active pack revision changed after hook coordination",
              "conflict",
            );
          }
        }
        const dependencies: Record<string, unknown>[] = [
          ...prepared.dependencies,
          ...(input.source?.dependencies ?? []).map(record),
          ...(hook?.read_dependencies ?? []).map(record),
          ...(hook?.required_capabilities ?? []).map((capability) => ({
            kind: "policy",
            required_capability: capability,
          })),
          ...(hook?.effects ?? []).map((effect) => ({
            kind: "policy",
            required_effect: effect,
          })),
        ].map(record).sort((a, b) =>
          canonicalJson(a).localeCompare(canonicalJson(b))
        );
        const allHookExecutions = [
          ...(input.source?.hook_executions ?? []).map(record),
          ...(hook?.hook_executions ?? []).map(record),
        ];
        const approvalRequirements = canonicalizeApprovalRequirements(
          hook?.approval_requirements ?? [],
          new Set(input.operations.map((operation) => operation.project_id)),
          this.clock.now(),
        );
        const evidence = {
          operation_graph_digest: operationGraphDigest,
          projects: prepared.projects,
          pack_revisions: prepared.revisions.map(publicRevision),
          operations: input.operations,
          dependencies,
          hook_executions: allHookExecutions.map((execution) => {
            const value = record(execution);
            return Object.fromEntries(
              Object.entries(value).filter(([key]) =>
                !["stderr", "stderr_text", "duration_ms", "created_at"]
                  .includes(key)
              ),
            );
          }),
          policy_decisions: prepared.decisions,
          approval_requirements: approvalRequirements,
          required_capabilities: [
            ...prepared.decisions.map((decision) =>
              `${String(decision.project_id)}:${String(decision.action)}:${
                String(decision.resource_identity)
              }`
            ),
            ...(hook?.required_capabilities ?? []),
          ].sort(),
          effects: [
            ...input.operations.map((operation) =>
              `${operation.project_id}:${operation.op}:${
                componentIdentity(operation)
              }`
            ),
            ...(hook?.effects ?? []),
          ].sort(),
          planned_events: hook?.planned_events ?? [],
          planned_deliveries: hook?.planned_deliveries ?? [],
        };
        const digest = await stageDigest(evidence);
        const lineage = input.source?.authority?.targeted?.cutoff
          .authorization_lineage_ids ??
          (auth.authorizationId
            ? (await query<{ id: string; depth: number }>(
              tx,
              `with recursive lineage(id,depth) as (
              select $1::uuid,0 union all select a.parent_authorization_id,child.depth+1
              from agent_authorizations a join lineage child on child.id=a.id
              where a.parent_authorization_id is not null
            ) select id,depth from lineage order by depth desc`,
              [auth.authorizationId],
            )).rows.map((row) => row.id)
            : []);
        const id = uuidV7();
        await query(
          tx,
          `insert into staged_changesets(
          id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,
          operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,
          planned_events_json,planned_deliveries_json) values($1,1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb) returning created_at`,
          [
            id,
            input.source?.kind ?? "direct",
            input.source?.identity ?? {},
            auth.id,
            actor.id,
            {
              principal_id: actor.id,
              principal_type: actor.principal_type,
              human_user_id: actor.human_user_id,
              session_id: auth.sessionId,
              authorization_id: auth.authorizationId ?? null,
              authorization_lineage_ids: lineage,
            },
            operationGraphDigest,
            digest,
            {
              schema: "changeset.operations.v1",
              operations: input.operations,
            },
            prepared.projects,
            prepared.revisions.map(publicRevision),
            hook?.warnings ?? [],
            hook?.planned_events ?? [],
            hook?.planned_deliveries ?? [],
          ],
        );
        for (
          let ordinal = 0;
          ordinal < prepared.operationRows.length;
          ordinal++
        ) {
          const row = prepared.operationRows[ordinal];
          await query(
            tx,
            `insert into staged_changeset_operations(stage_id,ordinal,operation_id,project_id,pack_revision_id,resource_revision_id,component_revision_id,component_digest,operation_kind,object_id,canonical_operation_json)
            values($1,$2,$3,$4,$5,null,$6,$7,$8,$9,$10::jsonb)`,
            [
              id,
              ordinal,
              row.operationId,
              row.operation.project_id,
              row.revisionId,
              row.componentRevisionId,
              row.componentDigest,
              row.operation.op,
              operationObjectId(row.operation),
              row.operation,
            ],
          );
        }
        for (
          let ordinal = 0;
          ordinal < dependencies.length;
          ordinal++
        ) {
          const dep = dependencies[ordinal];
          await query(
            tx,
            `insert into staged_changeset_dependencies(stage_id,ordinal,dependency_kind,project_id,pack_revision_id,resource_revision_id,component_revision_id,component_digest,object_id,expected_version_id,dependency_json)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
            [
              id,
              ordinal,
              dep.kind,
              dep.project_id ?? null,
              dep.pack_revision_id ?? null,
              dep.resource_revision_id ?? null,
              dep.component_revision_id ?? null,
              dep.component_digest ?? null,
              dep.object_id ?? null,
              dep.expected_version_id ?? null,
              dep,
            ],
          );
        }
        for (let ordinal = 0; ordinal < prepared.decisions.length; ordinal++) {
          const decision = prepared.decisions[ordinal];
          await query(
            tx,
            `insert into staged_policy_decisions(id,stage_id,ordinal,project_id,action,resource_identity,decision_json) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              uuidV7(),
              id,
              ordinal,
              decision.project_id,
              decision.action,
              decision.resource_identity,
              decision,
            ],
          );
        }
        for (
          let ordinal = 0;
          ordinal < allHookExecutions.length;
          ordinal++
        ) {
          const execution = allHookExecutions[ordinal];
          await query(
            tx,
            `insert into staged_hook_executions(
               id,stage_id,ordinal,attachment_id,phase,pack_revision_id,hook_revision_id,
               input_digest,output_digest,output_json,script_digest,security_digest,
               stderr_text,logs_truncated,secrets_redacted,duration_ms,
               authority_snapshot_json,grant_snapshot_json
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)`,
            [
              execution.id,
              id,
              ordinal,
              execution.attachment_id,
              execution.phase,
              execution.pack_revision_id,
              execution.hook_revision_id,
              execution.input_digest,
              execution.output_digest,
              execution.output,
              execution.script_digest,
              execution.security_digest,
              execution.stderr,
              execution.logs_truncated,
              execution.secrets_redacted,
              execution.duration_ms,
              record(execution.authority_snapshot),
              record(execution.grant_snapshot),
            ],
          );
        }
        for (
          let ordinal = 0;
          ordinal < approvalRequirements.length;
          ordinal++
        ) {
          const requirement = record(approvalRequirements[ordinal]);
          await query(
            tx,
            `insert into staged_approval_requirements(id,stage_id,ordinal,requirement_json) values($1,$2,$3,$4::jsonb)`,
            [requirement.id, id, ordinal, requirement],
          );
        }
        await query(
          tx,
          `insert into staged_changeset_lifecycle(stage_id,status,version) values($1,$2,1)`,
          [
            id,
            approvalRequirements.length ? "awaiting_approval" : "ready",
          ],
        );
        await query(
          tx,
          `insert into audit_events(id,stage_id,auth_context_id,event_type,action,decision)
           values($1,$2,$3,'changeset.staged','changeset.stage','allowed')`,
          [uuidV7(), id, auth.id],
        );
        return ok(await load(tx, id)!);
      }) as Result<StageDto>;
    } catch (error) {
      return mapStageError(error);
    }
  }

  async inspect(id: string, auth: AuthContext): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        if (
          !await canAccess(
            tx,
            id,
            auth,
            "changeset.inspect",
            false,
            this.authorizationRepository,
          )
        ) {
          return err(notFound());
        }
        const value = await load(tx, id);
        return value ? ok(value) : err(notFound());
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }

  async approvals(id: string, auth: AuthContext): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        if (
          !await canAccess(
            tx,
            id,
            auth,
            "changeset.inspect",
            false,
            this.authorizationRepository,
          ) &&
          !await canReviewAny(
            tx,
            id,
            auth,
            this.clock.now(),
            this.authorizationRepository,
          )
        ) return err(notFound());
        const value = await load(tx, id);
        return value ? ok(value) : err(notFound());
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }

  async decideApproval(
    id: string,
    requirementId: string,
    input: { decision: "approve" | "reject"; reason: string | null },
    auth: AuthContext,
  ): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        const lifecycle = (await query<{ status: string }>(
          tx,
          "select status from staged_changeset_lifecycle where stage_id=$1 for update",
          [id],
        )).rows[0];
        if (!lifecycle) return err(notFound());
        const existing = (await query<{ id: string }>(
          tx,
          "select id from staged_approval_decisions where stage_id=$1 and requirement_id=$2 and principal_id=$3",
          [id, requirementId, auth.principalId],
        )).rows[0];
        if (existing) return ok((await load(tx, id))!);
        if (["rejected", "cancelled", "committed"].includes(lifecycle.status)) {
          throw domain(
            "approval_terminal",
            "changeset no longer accepts approval decisions",
            "conflict",
          );
        }
        const row = (await query<
          { requirement_json: unknown; created_principal_id: string }
        >(
          tx,
          `select r.requirement_json,s.created_principal_id from staged_approval_requirements r
           join staged_changesets s on s.id=r.stage_id where r.stage_id=$1 and r.id=$2 for share of r,s`,
          [id, requirementId],
        )).rows[0];
        if (!row) return err(notFound());
        const requirement = record(row.requirement_json);
        const principal = (await query<{ type: string; active: boolean }>(
          tx,
          "select type,active from principals where id=$1 for share",
          [auth.principalId],
        )).rows[0];
        if (
          !principal?.active ||
          !array(requirement.principal_types).includes(principal.type)
        ) {
          throw domain(
            "approval_denied",
            "current principal cannot satisfy this requirement",
            "authorization",
          );
        }
        if (
          !requirement.allow_initiator &&
          row.created_principal_id === auth.principalId
        ) {
          throw domain(
            "approval_denied",
            "stage initiator cannot satisfy this requirement",
            "authorization",
          );
        }
        if (
          requirement.expires_at &&
          new Date(String(requirement.expires_at)) <= this.clock.now()
        ) {
          throw domain(
            "approval_expired",
            "approval requirement has expired",
            "conflict",
          );
        }
        const boundaryValue = record(requirement.boundary);
        const boundary = boundaryValue.type === "project"
          ? {
            type: "project" as const,
            projectId: String(boundaryValue.project_id),
          }
          : boundaryValue.type === "all_projects"
          ? { type: "all_projects" as const }
          : { type: "system" as const };
        const authority = await this.authorizationRepository(
          tx as unknown as Sql,
        ).authorize({
          auth,
          boundary,
          action: "changeset.approval.decide",
          resource: "system:changeset-approval",
        });
        if (
          !authority.ok ||
          (!authority.value.superAdmin &&
            !authority.value.effectiveRoles.includes(String(requirement.role)))
        ) {
          throw domain(
            "approval_denied",
            "current approval authority is insufficient",
            "authorization",
          );
        }
        {
          const inserted = await query<{ id: string }>(
            tx,
            `insert into staged_approval_decisions(id,stage_id,requirement_id,principal_id,decision,reason,decided_auth_context_id)
             values($1,$2,$3,$4,$5,$6,$7) on conflict(requirement_id,principal_id) do nothing returning id`,
            [
              uuidV7(),
              id,
              requirementId,
              auth.principalId,
              input.decision,
              input.reason,
              auth.id,
            ],
          );
          if (inserted.rows.length) {
            await query(
              tx,
              `insert into staged_approval_audit_events(id,stage_id,requirement_id,principal_id,auth_context_id,event_type,details_json)
             values($1,$2,$3,$4,$5,'decision_recorded',$6::jsonb)`,
              [uuidV7(), id, requirementId, auth.principalId, auth.id, {
                decision: input.decision,
                reason: input.reason,
              }],
            );
          }
        }
        const rejected = (await query<{ present: boolean }>(
          tx,
          "select exists(select 1 from staged_approval_decisions where stage_id=$1 and decision='reject') present",
          [id],
        )).rows[0]?.present;
        let status = "awaiting_approval";
        if (rejected) status = "rejected";
        else {
          const unsatisfied = (await query<{ present: boolean }>(
            tx,
            `select exists(select 1 from staged_approval_requirements r where r.stage_id=$1 and
              (select count(distinct d.principal_id) from staged_approval_decisions d where d.requirement_id=r.id and d.decision='approve') <
              (r.requirement_json->>'minimum')::int) present`,
            [id],
          )).rows[0]?.present;
          if (!unsatisfied) status = "ready";
        }
        if (status !== lifecycle.status) {
          await query(
            tx,
            "update staged_changeset_lifecycle set status=$2,version=version+1 where stage_id=$1",
            [id, status],
          );
          if (status === "rejected") {
            await query(
              tx,
              `insert into audit_events(id,stage_id,auth_context_id,event_type,action,decision)
               values($1,$2,$3,'changeset.rejected','changeset.approval.reject','denied')`,
              [uuidV7(), id, auth.id],
            );
          }
        }
        return ok((await load(tx, id))!);
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }

  async cancel(
    id: string,
    reason: string | null,
    auth: AuthContext,
  ): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        if (
          !await canAccess(
            tx,
            id,
            auth,
            "changeset.cancel",
            true,
            this.authorizationRepository,
          )
        ) {
          return err(notFound());
        }
        const lifecycle = await query<{ status: string }>(
          tx,
          "select status from staged_changeset_lifecycle where stage_id=$1 for update",
          [id],
        );
        const status = lifecycle.rows[0]?.status;
        if (!status) return err(notFound());
        if (status === "cancelled") return ok((await load(tx, id))!);
        if (status === "committed") {
          return err({
            code: "already_committed",
            message: "changeset is already committed",
            severity: "conflict",
            details: {},
          });
        }
        if (status === "rejected") {
          return err({
            code: "already_rejected",
            message: "changeset is already rejected",
            severity: "conflict",
            details: {},
          });
        }
        await query(
          tx,
          `update staged_changeset_lifecycle set status='cancelled',version=version+1,cancelled_auth_context_id=$2,cancelled_at=now(),cancellation_reason=$3 where stage_id=$1`,
          [id, auth.id, reason],
        );
        await query(
          tx,
          `insert into audit_events(id,stage_id,auth_context_id,event_type,action,decision,request_metadata_json)
           values($1,$2,$3,'changeset.cancelled','changeset.cancel','committed',$4::jsonb)`,
          [uuidV7(), id, auth.id, { reason }],
        );
        return ok((await load(tx, id))!);
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }
}

async function revalidateTargetedAuthority(
  sql: Queryable,
  auth: AuthContext,
  projectId: string,
  evidence: NonNullable<NonNullable<StageSource["authority"]>["targeted"]>,
  authorizationRootId: string | undefined,
  dependencies: Record<string, unknown>[],
  decisions: Record<string, unknown>[],
): Promise<void> {
  const actor = policyActorFromAuthContext(auth);
  let lineageIds: string[] = [];
  if (auth.authorizationId) {
    const lineage = await lockActiveAuthorizationLineage(sql, {
      authorizationId: auth.authorizationId,
      principalId: actor.id,
      humanUserId: actor.human_user_id,
    });
    if (!lineage.ok) {
      throw domain(
        "project_conflict",
        "Targeted action authorization lineage changed before persistence",
        "conflict",
      );
    }
    lineageIds = lineage.value.ancestry.map((fact) => fact.authorizationId);
  }
  const currentIdentity = {
    actor,
    auth_context_id: auth.id,
    session_id: auth.sessionId,
    authorization_id: auth.authorizationId ?? null,
    authorization_root_id: authorizationRootId,
    authorization_lineage_ids: lineageIds,
  };
  if (canonicalJson(currentIdentity) !== canonicalJson(evidence.cutoff)) {
    throw domain(
      "project_conflict",
      "Targeted action authority cutoff changed before persistence",
      "conflict",
    );
  }
  const reviewed = evidence.targets.map((target) => ({
    projectId: target.project_id,
    resource: target.resource,
    ...(target.object_id && target.object_version_id
      ? {
        object: { id: target.object_id, versionId: target.object_version_id },
      }
      : {}),
  }));
  const physicalTargets: TargetedActionPolicyTarget[] = reviewed.map(
    (target) => ({
      definition: { kind: "resource", ...parseIdentity(target.resource) },
      ...(target.object ? { objectId: target.object.id } : {}),
    }),
  );
  await lockTargetedActionAuthority(sql, physicalTargets);
  let current = await evaluateExactTargetedActionAuthority(sql, {
    projectId,
    action: evidence.action,
    targets: reviewed,
  }, auth);
  if (!current.allowed) {
    throw domain(
      "policy_denied",
      "Current authority denies the action on its exact targets",
      "authorization",
    );
  }
  await lockExactTargetAuthorityDependencies(sql, current.dependencies);
  current = await evaluateExactTargetedActionAuthority(sql, {
    projectId,
    action: evidence.action,
    targets: reviewed,
  }, auth);
  if (!current.allowed) {
    throw domain(
      "policy_denied",
      "Current authority denies the action on its exact targets",
      "authorization",
    );
  }
  const authorization = {
    actor,
    authorizationRootId: authorizationRootId!,
    authorizationLineageIds: lineageIds,
    targets: current.targets,
  };
  const canonicalTargetDigest = `sha256:${await canonicalSha256(
    canonicalTargetDigestInput(authorization),
  )}`;
  const authorityFactsDigest = `sha256:${await canonicalSha256(
    current.dependencies,
  )}`;
  const expectedTargets: TargetAuthorityEvidence[] = evidence.targets.map(
    (target) => ({
      target: {
        projectId: target.project_id,
        resource: target.resource,
        ...(target.object_id && target.object_version_id
          ? {
            object: {
              id: target.object_id,
              versionId: target.object_version_id,
            },
          }
          : {}),
      },
      policyDigest: target.policy_digest,
      matchedRules: target.matched_rules.map((rule) => ({
        policy: rule.policy,
        policyVersionId: rule.policy_version_id,
        policyVersion: rule.policy_version,
        rule: rule.rule,
      })),
      roleAssignmentIds: target.role_assignment_ids,
      relationshipIds: target.relationship_ids,
    }),
  );
  if (
    canonicalTargetDigest !== evidence.canonical_target_digest ||
    authorityFactsDigest !== evidence.authority_facts_digest ||
    canonicalJson(current.targets) !== canonicalJson(expectedTargets)
  ) {
    throw domain(
      "project_conflict",
      "Targeted action authority changed before persistence",
      "conflict",
    );
  }
  dependencies.push(
    ...current.dependencies,
    ...lineageIds.map((authorizationId, ordinal) => ({
      kind: "assignment",
      target_dependency: "authorization_lineage",
      authorization_id: authorizationId,
      ordinal,
      authorization_root_id: authorizationRootId,
    })),
    {
      kind: "policy",
      target_dependency: "targeted_action_authority",
      project_id: projectId,
      action: evidence.action,
      targets: evidence.targets,
      canonical_target_digest: canonicalTargetDigest,
      authority_facts_digest: authorityFactsDigest,
      cutoff: evidence.cutoff,
    },
  );
  for (let ordinal = 0; ordinal < evidence.targets.length; ordinal++) {
    const target = evidence.targets[ordinal];
    decisions.push({
      project_id: target.project_id,
      action: evidence.action,
      resource_identity: target.resource,
      object_id: target.object_id ?? null,
      object_version_id: target.object_version_id ?? null,
      decision: "allow",
      target_ordinal: ordinal,
      policy_digest: target.policy_digest,
      matched_rules: target.matched_rules,
      role_assignment_ids: target.role_assignment_ids,
      relationship_ids: target.relationship_ids,
      canonical_target_digest: canonicalTargetDigest,
    });
  }
}

async function prepare(
  sql: Queryable,
  operations: CanonicalOperation[],
  auth: AuthContext,
  pinnedHookDeclarations: readonly StageHookDeclaration[],
  source: StageSource | undefined,
  authorizationRepository: StageAuthorizationRepositoryFactory,
): Promise<Prepared> {
  const projectIds = [
    ...new Set(operations.map((operation) => operation.project_id)),
  ].sort();
  const projects: Record<string, unknown>[] = [];
  const dependencies: Record<string, unknown>[] = [];
  const authorityRoots = new Map<string, string>();
  for (const projectId of projectIds) {
    const anchor = await lockReadAuthority(sql, auth, projectId);
    authorityRoots.set(projectId, anchor.authorizationRootId);
    const project =
      (await query<{ id: string; version: string; status: string }>(
        sql,
        "select id,version,status from projects where id=$1 for share",
        [projectId],
      )).rows[0];
    if (!project) {
      throw domain("not_found", "Project was not found", "not_found");
    }
    if (project.status !== "active") {
      throw domain("project_inactive", "Project is inactive", "conflict");
    }
    const fact = {
      project_id: project.id,
      version: Number(project.version),
      status: project.status,
    };
    projects.push(fact);
    dependencies.push({
      kind: "project",
      ...fact,
      authorization_root_id: anchor.authorizationRootId,
    });
  }
  const identities = [...new Set(operations.map(componentIdentity))].sort();
  const revisions = new Map<string, Revision>();
  for (const identity of identities) {
    const parsed = parseIdentity(identity);
    const row =
      (await query<{ id: string; content_digest: string; normalized: unknown }>(
        sql,
        `select cr.id,cr.content_digest,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2 for share of ar,cr`,
        [parsed.publisher, parsed.pack],
      )).rows[0];
    if (!row) {
      throw domain(
        "validation_failed",
        `No active revision defines ${identity}`,
        "validation",
      );
    }
    const revision = {
      id: row.id,
      publisher: parsed.publisher,
      pack: parsed.pack,
      contentDigest: row.content_digest,
      normalized: record(row.normalized),
    };
    revisions.set(`${parsed.publisher}/${parsed.pack}`, revision);
    if (source?.authority && revision.id !== source.authority.revision_id) {
      throw domain(
        "project_conflict",
        "Semantic source revision changed before persistence",
        "conflict",
      );
    }
    const collection = operationDefinitionKind(
      operations.find((op) => componentIdentity(op) === identity)!,
    );
    if (!record(revision.normalized[collection])[parsed.name]) {
      throw domain(
        "validation_failed",
        `Active revision does not define ${identity}`,
        "validation",
      );
    }
  }
  for (const rawDependency of source?.dependencies ?? []) {
    const dependency = record(rawDependency);
    if (dependency.kind === "object_version") {
      const parsed = parseIdentity(String(dependency.resource_identity));
      const table = (await query<{ table_name: string }>(
        sql,
        `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
        [parsed.publisher, parsed.pack, parsed.name],
      )).rows[0]?.table_name;
      const current = table
        ? (await query<{ current_object_version_id: string }>(
          sql,
          `select current_object_version_id from ${
            quoteIdentifier(table)
          } where project_id=$1 and id=$2 and archived_at is null for share`,
          [dependency.project_id, dependency.object_id],
        )).rows[0]
        : undefined;
      if (
        !current ||
        current.current_object_version_id !== dependency.expected_version_id
      ) {
        throw domain(
          "project_conflict",
          "Semantic source read changed before persistence",
          "conflict",
        );
      }
    } else if (dependency.kind === "uniqueness") {
      const parsed = parseIdentity(String(dependency.definition));
      const table = (await query<{ table_name: string }>(
        sql,
        `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
        [parsed.publisher, parsed.pack, parsed.name],
      )).rows[0]?.table_name;
      const currentRows = table
        ? (await query<{ id: string; current_object_version_id: string }>(
          sql,
          `select id,current_object_version_id from ${
            quoteIdentifier(table)
          } where project_id=$1 and ${
            quoteIdentifier(String(dependency.key))
          }=$2 and archived_at is null order by id for share`,
          [dependency.project_id, dependency.value],
        )).rows
        : [];
      if (currentRows.length > 1) {
        throw domain(
          "project_conflict",
          "Active seed uniqueness is violated",
          "conflict",
        );
      }
      const current = currentRows[0];
      if (
        dependency.constraint_predicate !== "active()" ||
        dependency.project_scoped !== true ||
        !Array.isArray(dependency.constraint_fields) ||
        canonicalJson(dependency.constraint_fields) !==
          canonicalJson([dependency.key]) ||
        typeof dependency.constraint_name !== "string" ||
        Boolean(current) !== Boolean(dependency.present) ||
        (current && dependency.object_id &&
          (current.id !== dependency.object_id ||
            current.current_object_version_id !==
              dependency.expected_version_id))
      ) {
        throw domain(
          "project_conflict",
          "Seed reconciliation fact changed before persistence",
          "conflict",
        );
      }
    }
  }
  const hookDeclarations: Record<string, unknown>[] = [];
  const uniqueRevisions = [
    ...new Map(
      [...revisions.values()].map((revision) => [revision.id, revision]),
    ).values(),
  ].sort((a, b) =>
    `${a.publisher}/${a.pack}`.localeCompare(`${b.publisher}/${b.pack}`)
  );
  for (const revision of uniqueRevisions) {
    dependencies.push({
      kind: "pack_revision",
      pack_revision_id: revision.id,
      publisher: revision.publisher,
      pack: revision.pack,
      content_digest: revision.contentDigest,
    });
    const revisionOperations = operations.filter((operation) => {
      const parsed = parseIdentity(componentIdentity(operation));
      return parsed.publisher === revision.publisher &&
        parsed.pack === revision.pack;
    });
    const resourceIdentities = new Set(
      revisionOperations.map(componentIdentity),
    );
    const currentAttachments = (await query<{
      id: string;
      hook_revision_id: string;
      hook_identity: string;
      phase: StageHookDeclaration["phase"];
      ordinal: number;
      declaration_digest: string;
      declaration_spec: unknown;
    }>(
      sql,
      `select id,hook_revision_id,hook_identity,phase,ordinal,declaration_digest,declaration_spec
       from pack_hook_attachment_revisions where candidate_revision_id=$1
         and phase in ('changeset.before_stage','changeset.validate') order by
         case phase when 'changeset.before_stage' then 0 else 1 end,ordinal,hook_identity,id for share`,
      [revision.id],
    )).rows.filter((attachment) => {
      const spec = record(attachment.declaration_spec);
      if (spec.condition === "false") return false;
      const resource = spec.resource;
      if (
        attachment.phase === "changeset.before_stage" &&
        !revisionOperations.some((operation) =>
          ["create", "update", "transition"].includes(operation.op) &&
          (resource === null || componentIdentity(operation) === resource)
        )
      ) return false;
      return resource === null || resourceIdentities.has(String(resource));
    });
    const pinnedForRevision = pinnedHookDeclarations.filter((declaration) =>
      declaration.pack_revision_id === revision.id
    );
    if (
      pinnedHookDeclarations.length &&
      new Set(pinnedForRevision.map((item) => item.attachment_id)).size !==
        currentAttachments.length
    ) {
      throw domain(
        "hook_rejected",
        "Pinned hook declarations no longer match active metadata",
        "validation",
      );
    }
    for (const pinned of pinnedForRevision) {
      const current = currentAttachments.find((item) =>
        item.id === pinned.attachment_id
      );
      if (!current) {
        throw domain(
          "hook_rejected",
          "Pinned hook attachment disappeared before persistence",
          "validation",
        );
      }
      const spec = record(current.declaration_spec);
      if (
        pinned.attachment_id !== current.id ||
        pinned.hook_revision_id !== current.hook_revision_id ||
        pinned.hook !== current.hook_identity ||
        pinned.phase !== current.phase ||
        pinned.resource !== spec.resource || pinned.order !== current.ordinal ||
        pinned.declaration_digest !== current.declaration_digest
      ) {
        throw domain(
          "hook_rejected",
          "Pinned hook attachment changed before persistence",
          "validation",
        );
      }
    }
    for (const declaration of pinnedForRevision) {
      hookDeclarations.push({ ...declaration });
      dependencies.push({
        kind: "resource",
        pack_revision_id: revision.id,
        component_revision_id: declaration.hook_revision_id,
        hook_declaration: declaration,
      });
    }
    if (currentAttachments.length && !pinnedHookDeclarations.length) {
      throw domain(
        "hook_coordinator_unavailable",
        "A required stage hook coordinator is unavailable",
        "unavailable",
      );
    }
  }
  const decisions: Record<string, unknown>[] = [];
  const targetedAuthority = source?.authority?.targeted;
  if (targetedAuthority) {
    await revalidateTargetedAuthority(
      sql,
      auth,
      source!.authority!.project_id,
      targetedAuthority,
      authorityRoots.get(source!.authority!.project_id),
      dependencies,
      decisions,
    );
  } else if (source?.authority) {
    // Seeds retain their existing semantic authority path. Action sources always
    // carry exact targeted evidence and never authorize a synthetic resource.
    for (const semanticAction of source.authority.actions) {
      const semanticAuthority = await authorizationRepository(
        sql as Sql,
      ).authorize({
        auth,
        boundary: { type: "project", projectId: source.authority.project_id },
        action: semanticAction,
        resource: semanticAction,
      });
      if (!semanticAuthority.ok) {
        throw domain(
          semanticAuthority.error.code,
          semanticAuthority.error.message,
          semanticAuthority.error.severity,
        );
      }
    }
  }
  const operationRows: Prepared["operationRows"] = [];
  const stagedLinkSignatures = new Set<string>();
  const stagedUniqueSignatures = new Set<string>();
  const creates = new Map(
    operations.filter((op) => op.op === "create").map((
      op,
    ) => [String(op.object_id), String(op.resource)]),
  );
  const stagedArchives = new Set(
    operations.filter((op) => op.op === "archive").map((op) =>
      String(op.object_id)
    ),
  );
  for (const operation of operations) {
    const identity = componentIdentity(operation),
      parsed = parseIdentity(identity);
    const revision = revisions.get(`${parsed.publisher}/${parsed.pack}`)!;
    const definition = record(
      record(
        revision.normalized[operationDefinitionKind(operation)],
      )[parsed.name],
    );
    const component = await loadComponentRevision(
      sql,
      revision.id,
      operation.relationship ? "relationship" : "resource",
      parsed.name,
      definition,
    );
    const componentDigest = component.digest;
    if (operation.op === "create") {
      const lifecycle = Object.values(record(revision.normalized.lifecycles))
        .map(record).find((candidate) =>
          record(candidate.spec).resource === identity
        );
      if (lifecycle) {
        const lifecycleSpec = record(lifecycle.spec);
        const field = String(lifecycleSpec.field);
        const initial = String(lifecycleSpec.initial);
        const fields = record(operation.fields);
        if (Object.hasOwn(fields, field) && fields[field] !== initial) {
          throw domain(
            "operation_conflict",
            "Create lifecycle field conflicts with initial state",
            "conflict",
          );
        }
        operation.fields = { ...fields, [field]: initial };
        const lifecycleName = String(
          record(lifecycle.metadata).name ?? "lifecycle",
        );
        const lifecycleComponent = await loadComponentRevision(
          sql,
          revision.id,
          "lifecycle",
          lifecycleName,
          lifecycle,
        );
        dependencies.push({
          kind: "lifecycle",
          project_id: operation.project_id,
          pack_revision_id: revision.id,
          component_revision_id: lifecycleComponent.id,
          component_digest: lifecycleComponent.digest,
          initial,
          field,
        });
      }
    }
    validateDeclaredFields(operation, definition);
    if (operation.op === "link") {
      const unique = Array.isArray(record(definition.spec).unique)
        ? (record(definition.spec).unique as unknown[]).map(String)
        : [];
      if (unique.length) {
        const values = record(operation.fields);
        const signature = canonicalJson([
          operation.project_id,
          identity,
          ...unique.map((field) =>
            field === "from"
              ? operation.from
              : field === "to"
              ? operation.to
              : values[field]
          ),
        ]);
        if (stagedLinkSignatures.has(signature)) {
          throw domain(
            "operation_conflict",
            "Staged links violate relationship uniqueness",
            "conflict",
          );
        }
        stagedLinkSignatures.add(signature);
      }
    }
    const action = operation.op;
    const authorizationAction = source?.authority
      ? source.authority.operation_authority[String(operation.key)]
      : action;
    if (source?.authority) {
      if (operation.project_id !== source.authority.project_id) {
        throw domain(
          "project_conflict",
          "Semantic source operations must remain in the request Project",
          "conflict",
        );
      }
      if (
        !authorizationAction ||
        !source.authority.actions.includes(authorizationAction) ||
        !source.authority.effects.some((effect) =>
          effect.resource === identity && effect.ops.includes(action) &&
          (!effect.authority_action ||
            effect.authority_action === authorizationAction)
        )
      ) {
        throw domain(
          "hook_effect_violation",
          "Semantic source emitted an operation outside its reviewed effects",
          "validation",
        );
      }
    }
    const effectiveAuthorizationAction = authorizationAction ?? action;
    const authorizationResource = source?.authority
      ? effectiveAuthorizationAction
      : identity;
    if (!targetedAuthority) {
      const authorization = await authorizationRepository(
        sql as Sql,
      ).authorize({
        auth,
        boundary: { type: "project", projectId: operation.project_id },
        action: effectiveAuthorizationAction,
        resource: authorizationResource,
      });
      if (!authorization.ok) {
        throw domain(
          authorization.error.code,
          authorization.error.message,
          authorization.error.severity,
        );
      }
      const matchingCapabilities = authorization.value.capabilities.filter((
        capability,
      ) =>
        capability.action === effectiveAuthorizationAction &&
        (capability.resource === "*" ||
          capability.resource === authorizationResource)
      );
      const policyEvaluation = authorization.value.superAdmin
        ? {
          allowed: true,
          matched_rule_ids: ["system:super_admin"],
          rule_evidence: [],
        }
        : source?.authority
        ? {
          allowed: matchingCapabilities.length > 0,
          matched_rule_ids: [],
          rule_evidence: [],
        }
        : await evaluateStagePolicy(
          sql,
          auth,
          operation,
          parsed,
          revision,
          definition,
          matchingCapabilities,
        );
      if (!policyEvaluation.allowed) {
        throw domain(
          "policy_denied",
          "Current stage policy denied the operation",
          "authorization",
        );
      }
      decisions.push({
        project_id: operation.project_id,
        action: effectiveAuthorizationAction,
        resource_identity: authorizationResource,
        decision: "allow",
        authority_digest: authorization.value.digest,
        superadmin_bypass: authorization.value.superAdmin,
        operation_key: operation.key,
        matched_rule_ids: policyEvaluation.matched_rule_ids,
        rule_evidence: policyEvaluation.rule_evidence,
      });
      dependencies.push({
        kind: "policy",
        project_id: operation.project_id,
        authority_digest: authorization.value.digest,
        action: effectiveAuthorizationAction,
        resource_identity: authorizationResource,
        capabilities: matchingCapabilities,
      });
      dependencies.push({
        kind: "assignment",
        project_id: operation.project_id,
        effective_roles: [...authorization.value.effectiveRoles].sort(),
        superadmin: authorization.value.superAdmin,
      });
    }
    dependencies.push({
      kind: "resource",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: null,
      component_revision_id: component.id,
      component_digest: componentDigest,
      identity,
    });
    await validateCurrent(
      sql,
      operation,
      parsed,
      revision,
      dependencies,
      creates,
      stagedArchives,
      component.id,
      componentDigest,
      auth,
      authorizationRepository,
    );
    validateDeclaredFields(operation, definition);
    await validateUniqueness(
      sql,
      operation,
      parsed,
      definition,
      revision,
      component.id,
      componentDigest,
      dependencies,
      stagedUniqueSignatures,
    );
    operationRows.push({
      operationId: uuidV7(),
      revisionId: revision.id,
      componentRevisionId: component.id,
      componentDigest,
      operation,
    });
  }
  dependencies.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    projects,
    revisions: uniqueRevisions,
    dependencies,
    decisions,
    hookDeclarations,
    operationRows,
  };
}

async function validateCurrent(
  sql: Queryable,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
  revision: Revision,
  dependencies: Record<string, unknown>[],
  creates: Map<string, string>,
  stagedArchives: Set<string>,
  componentRevisionId: string,
  componentDigest: string,
  auth: AuthContext,
  authorizationRepository: StageAuthorizationRepositoryFactory,
): Promise<void> {
  const actor = policyActorFromAuthContext(auth);
  if (operation.op === "create" || operation.op === "link") {
    if (operation.op === "link") {
      const relationship = record(
        record(revision.normalized.relationships)[parsed.name],
      );
      const spec = record(relationship.spec);
      const endpointFacts = [
        [String(operation.from), String(record(spec.from).resource), "from"],
        [String(operation.to), String(record(spec.to).resource), "to"],
      ] as const;
      for (const [endpoint, expectedResource, side] of endpointFacts) {
        if (creates.has(endpoint)) {
          if (creates.get(endpoint) !== expectedResource) {
            throw domain(
              "validation_failed",
              "Generated relationship endpoint does not satisfy its definition",
              "validation",
            );
          }
          continue;
        }
        if (stagedArchives.has(endpoint)) {
          throw domain(
            "operation_conflict",
            "Relationship endpoint is archived by this stage",
            "conflict",
          );
        }
        if (expectedResource === "system:principal") {
          const principal = (await query<{ id: string }>(
            sql,
            "select id from principals where id=$1 and active for share",
            [endpoint],
          )).rows[0];
          if (!principal) {
            throw domain(
              "validation_failed",
              "Relationship principal endpoint is not active",
              "validation",
            );
          }
        } else {
          const endpointIdentity = parseIdentity(expectedResource);
          const active = (await query<{
            candidate_revision_id: string;
            normalized: unknown;
            table_name: string;
          }>(
            sql,
            `select ar.candidate_revision_id,cr.normalized,rt.table_name
             from pack_active_revisions ar
             join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
             join pack_runtime_tables rt on rt.publisher=ar.publisher and rt.pack_name=ar.pack_name
              and rt.definition_kind='resource' and rt.definition_name=$3
             where ar.publisher=$1 and ar.pack_name=$2 for share of ar,cr,rt`,
            [
              endpointIdentity.publisher,
              endpointIdentity.pack,
              endpointIdentity.name,
            ],
          )).rows[0];
          const endpointDefinition = record(
            record(record(active?.normalized).resources)[endpointIdentity.name],
          );
          if (!active || !Object.keys(endpointDefinition).length) {
            throw domain(
              "validation_failed",
              "Relationship endpoint definition is not active",
              "validation",
            );
          }
          const row = (await query<{
            id: string;
            current_object_version_id: string;
          }>(
            sql,
            `select id,current_object_version_id from ${
              quoteIdentifier(active.table_name)
            } where project_id=$1 and id=$2 and archived_at is null for share`,
            [operation.project_id, endpoint],
          )).rows[0];
          if (!row?.current_object_version_id) {
            throw domain(
              "validation_failed",
              "Relationship endpoint is absent, archived, in another Project, or has the wrong definition",
              "validation",
            );
          }
          const endpointComponent = await loadComponentRevision(
            sql,
            active.candidate_revision_id,
            "resource",
            endpointIdentity.name,
            endpointDefinition,
          );
          dependencies.push({
            kind: "relationship",
            project_id: operation.project_id,
            pack_revision_id: active.candidate_revision_id,
            component_revision_id: endpointComponent.id,
            component_digest: endpointComponent.digest,
            object_id: endpoint,
            expected_version_id: row.current_object_version_id,
            endpoint: side,
            resource_identity: expectedResource,
          });
        }
      }
      const unique = Array.isArray(spec.unique) ? spec.unique.map(String) : [];
      if (unique.length) {
        const runtime = (await query<{ table_name: string }>(
          sql,
          "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='relationship' and definition_name=$3",
          [parsed.publisher, parsed.pack, parsed.name],
        )).rows[0];
        const values = record(operation.fields);
        const params: unknown[] = [operation.project_id];
        const predicates = unique.map((field) => {
          params.push(
            field === "from"
              ? operation.from
              : field === "to"
              ? operation.to
              : values[field],
          );
          const column = field === "from"
            ? "from_object_id"
            : field === "to"
            ? "to_object_id"
            : field;
          return `${
            quoteIdentifier(column)
          } is not distinct from $${params.length}`;
        });
        const duplicate = runtime && (await query<{ id: string }>(
          sql,
          `select id from ${
            quoteIdentifier(runtime.table_name)
          } where project_id=$1 and archived_at is null and ${
            predicates.join(" and ")
          } limit 1 for share`,
          params,
        )).rows[0];
        dependencies.push({
          kind: "uniqueness",
          project_id: operation.project_id,
          pack_revision_id: revision.id,
          component_revision_id: componentRevisionId,
          component_digest: componentDigest,
          fields: unique,
          values: params.slice(1),
          existing_id: duplicate?.id ?? null,
        });
        if (duplicate) {
          throw domain(
            "operation_conflict",
            "Active relationship already exists",
            "conflict",
          );
        }
      }
    }
    return;
  }
  const kind = operation.op === "unlink" ? "relationship" : "resource";
  const name = parsed.name;
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind=$3 and definition_name=$4",
    [parsed.publisher, parsed.pack, kind, name],
  )).rows[0];
  if (!runtime) {
    throw domain(
      "validation_failed",
      "Runtime definition is unavailable",
      "validation",
    );
  }
  const objectId = String(
    operation.op === "unlink" ? operation.relationship_id : operation.object_id,
  );
  if (creates.has(objectId)) {
    dependencies.push({
      kind: "object_version",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: null,
      component_revision_id: componentRevisionId,
      component_digest: componentDigest,
      object_id: objectId,
      expected_version_id: null,
      created_in_graph: true,
    });
    return;
  }
  const lifecycle = operation.op === "transition"
    ? Object.values(record(revision.normalized.lifecycles)).map(record).find(
      (candidate) =>
        record(candidate.spec).resource === componentIdentity(operation),
    )
    : undefined;
  const lifecycleField = lifecycle
    ? String(record(lifecycle.spec).field)
    : null;
  const row = (await query<
    {
      version: number;
      current_object_version_id: string;
      archived_at: unknown;
      lifecycle_value: unknown;
      snapshot: unknown;
    }
  >(
    sql,
    `select version,current_object_version_id,archived_at,to_jsonb(current_row) snapshot${
      lifecycleField
        ? `,${quoteIdentifier(lifecycleField)} lifecycle_value`
        : ",null lifecycle_value"
    } from ${
      quoteIdentifier(runtime.table_name)
    } current_row where project_id=$1 and id=$2 for share`,
    [operation.project_id, objectId],
  )).rows[0];
  if (!row) {
    throw domain("not_found", "Current object was not found", "not_found");
  }
  if (row.archived_at) {
    if (operation.op !== "comment") {
      throw domain("not_found", "Current object was not found", "not_found");
    }
    const archivedAuthority = await authorizationRepository(
      sql as Sql,
    ).authorize({
      auth,
      boundary: { type: "project", projectId: operation.project_id },
      action: "read_archived",
      resource: componentIdentity(operation),
    });
    if (!archivedAuthority.ok) {
      throw domain(
        archivedAuthority.error.code,
        archivedAuthority.error.message,
        archivedAuthority.error.severity,
      );
    }
    if (!archivedAuthority.value.superAdmin) {
      const capabilities = archivedAuthority.value.capabilities.filter((
        capability,
      ) =>
        capability.action === "read_archived" &&
        (capability.resource === "*" ||
          capability.resource === componentIdentity(operation))
      );
      const definition = record(
        record(revision.normalized.resources)[parsed.name],
      );
      const evaluated = await evaluateStagePolicy(
        sql,
        auth,
        operation,
        parsed,
        revision,
        definition,
        capabilities,
      );
      if (!evaluated.allowed) {
        throw domain(
          "policy_denied",
          "Archived comment target is not visible",
          "authorization",
        );
      }
    }
    dependencies.push({
      kind: "policy",
      project_id: operation.project_id,
      action: "read_archived",
      resource_identity: componentIdentity(operation),
      authority_digest: archivedAuthority.value.digest,
    });
  }
  if (operation.op === "transition") {
    if (!lifecycle) {
      throw domain(
        "validation_failed",
        "Resource has no active lifecycle",
        "validation",
      );
    }
    const spec = record(lifecycle.spec);
    const target = String(operation.to);
    const states = Array.isArray(spec.states)
      ? spec.states.map((state) => String(record(state).name))
      : [];
    const edge = Array.isArray(spec.transitions)
      ? spec.transitions.map(record).find((transition) =>
        transition.to === target && Array.isArray(transition.from) &&
        transition.from.includes(String(row.lifecycle_value))
      )
      : undefined;
    if (!states.includes(target) || !edge) {
      throw domain(
        "operation_conflict",
        "Lifecycle transition is not allowed",
        "conflict",
      );
    }
    const canonicalSet = { ...record(operation.set) };
    const canonicalUnset = new Set(
      (operation.unset as string[] | undefined) ?? [],
    );
    const proposed = { ...record(row.snapshot), ...canonicalSet };
    for (const field of (operation.unset as string[] | undefined) ?? []) {
      delete proposed[field];
    }
    proposed[lifecycleField!] = target;
    for (const [field, value] of Object.entries(record(edge.set))) {
      if (
        Object.hasOwn(record(operation.set), field) &&
        canonicalJson(record(operation.set)[field]) !== canonicalJson(value)
      ) {
        throw domain(
          "operation_conflict",
          "Lifecycle constant conflicts with authored mutation",
          "conflict",
        );
      }
      proposed[field] = value;
      canonicalSet[field] = value;
      canonicalUnset.delete(field);
    }
    for (const field of (edge.unset as string[] | undefined) ?? []) {
      if (Object.hasOwn(record(operation.set), field)) {
        throw domain(
          "operation_conflict",
          "Lifecycle unset conflicts with authored mutation",
          "conflict",
        );
      }
      delete proposed[field];
      delete canonicalSet[field];
      canonicalUnset.add(field);
    }
    operation.set = Object.fromEntries(
      Object.entries(canonicalSet).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (!Object.keys(record(operation.set)).length) delete operation.set;
    operation.unset = [...canonicalUnset].sort();
    if (!(operation.unset as string[]).length) delete operation.unset;
    if (edge.condition) {
      const resourceDefinition = record(
        record(revision.normalized.resources)[parsed.name],
      );
      const definitions = record(record(resourceDefinition.spec).fields);
      const fieldSpecs = Object.fromEntries(
        Object.entries(definitions).map(([name, value]) => {
          const descriptor = record(value);
          return [name, {
            type: String(descriptor.type) as FieldSpec["type"],
            ...(descriptor.required !== true ? { nullable: true } : {}),
            ...(descriptor.format === "uuid" || descriptor.ref
              ? { format: "uuid" as const }
              : {}),
          }];
        }),
      );
      const names = Object.keys(fieldSpecs).sort();
      const lowered = lowerCelToSql(String(edge.condition), {
        fields: fieldSpecs,
        actor: {
          id: { type: "string", value: actor.id },
          human_user_id: {
            type: "string",
            value: actor.human_user_id,
          },
        },
        alias: "proposed",
        parameterOffset: names.length,
        maxNodes: 80,
        maxLength: 1000,
      });
      const casts = names.map((name, index) =>
        `$${index + 1}::${fieldSqlType(fieldSpecs[name].type)} as ${
          quoteIdentifier(name)
        }`
      );
      const condition = await query<{ allowed: boolean }>(
        sql,
        `select coalesce((${lowered.sql}),false) allowed from (select ${
          casts.join(",")
        }) proposed`,
        [...names.map((name) => proposed[name] ?? null), ...lowered.params],
      );
      if (!condition.rows[0]?.allowed) {
        throw domain(
          "operation_conflict",
          "Lifecycle transition condition was not satisfied",
          "conflict",
        );
      }
    }
    const state = (spec.states as unknown[]).map(record).find((candidate) =>
      candidate.name === target
    );
    for (
      const required of (state?.required_fields as string[] | undefined) ?? []
    ) {
      if (proposed[required] === undefined || proposed[required] === null) {
        throw domain(
          "validation_failed",
          `Lifecycle state requires field '${required}'`,
          "validation",
        );
      }
    }
    const lifecycleName = String(
      record(lifecycle.metadata).name ?? "lifecycle",
    );
    const lifecycleComponent = await loadComponentRevision(
      sql,
      revision.id,
      "lifecycle",
      lifecycleName,
      lifecycle,
    );
    dependencies.push({
      kind: "lifecycle",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: null,
      component_revision_id: lifecycleComponent.id,
      component_digest: lifecycleComponent.digest,
      identity: String(
        lifecycle.identity ?? record(lifecycle.metadata).name ?? "lifecycle",
      ),
      from: row.lifecycle_value,
      to: target,
    });
  }
  if (operation.op === "update") {
    const current = record(row.snapshot);
    const set = record(operation.set);
    const unset = (operation.unset as string[] | undefined) ?? [];
    const changed = Object.entries(set).some(([field, value]) =>
      canonicalJson(current[field]) !== canonicalJson(value)
    ) || unset.some((field) =>
      current[field] !== null && current[field] !== undefined
    );
    if (!changed) {
      throw domain(
        "no_changes",
        "Update does not change current state",
        "validation",
      );
    }
  }
  if (
    operation.expected_version !== undefined &&
    Number(operation.expected_version) !== Number(row.version)
  ) {
    throw domain(
      "object_version_conflict",
      "Expected object version is not current",
      "conflict",
    );
  }
  dependencies.push({
    kind: operation.op === "unlink" ? "relationship" : "object_version",
    project_id: operation.project_id,
    pack_revision_id: revision.id,
    resource_revision_id: null,
    component_revision_id: componentRevisionId,
    component_digest: componentDigest,
    object_id: objectId,
    expected_version_id: row.current_object_version_id,
    version: Number(row.version),
  });
}

async function evaluateStagePolicy(
  sql: Queryable,
  auth: AuthContext,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
  revision: Revision,
  definition: Record<string, unknown>,
  capabilities: Array<{
    condition: string;
    ruleId: string;
    policy: string;
    policyRevisionId: string;
  }>,
): Promise<{
  allowed: boolean;
  matched_rule_ids: string[];
  rule_evidence: Record<string, unknown>[];
}> {
  const ruleIds = capabilities.map((capability) => capability.ruleId);
  if (!ruleIds.length) {
    return { allowed: false, matched_rule_ids: [], rule_evidence: [] };
  }
  const rows = (await query<{
    id: string;
    policy_definition_version_id: string;
    condition_kind: string;
    predicate: string | null;
    relation_relationship: string | null;
    relation_object_side: "from" | "to" | null;
    relation_subject_side: "from" | "to" | null;
    relation_subject: "actor.id" | "actor.human_user_id" | null;
  }>(
    sql,
    `select pr.id,pr.policy_definition_version_id,pr.condition_kind,pr.predicate,
      pr.relation_relationship,pr.relation_object_side,pr.relation_subject_side,pr.relation_subject
     from policy_rules pr join policy_definition_versions pd on pd.id=pr.policy_definition_version_id
     where pr.id=any($1::uuid[]) and pd.active and pd.candidate_revision_id=$2
       and exists(select 1 from policy_assignments pa where pa.policy_definition_version_id=pd.id and pa.active
         and (pa.boundary_type='all_projects' or (pa.boundary_type='project' and pa.project_id=$3)))
       and (exists(select 1 from role_assignments ra where ra.principal_id=$4 and ra.role_id=pr.role_id and ra.active
         and (ra.boundary_type='all_projects' or (ra.boundary_type='project' and ra.project_id=$3)))
         or exists(select 1 from agent_authorization_roles ar where ar.authorization_id=$5 and ar.role_id=pr.role_id
         and (ar.boundary_type='all_projects' or (ar.boundary_type='project' and ar.project_id=$3))))
     order by pr.id for share of pr,pd`,
    [
      ruleIds,
      revision.id,
      operation.project_id,
      auth.principalId,
      auth.authorizationId ?? null,
    ],
  )).rows;
  const proposed = await proposedState(sql, operation, parsed);
  const fieldDefinitions = record(record(definition.spec).fields);
  const fields = Object.fromEntries(
    Object.entries(fieldDefinitions).map(([name, value]) => {
      const spec = record(value);
      return [name, {
        type: String(spec.type) as FieldSpec["type"],
        ...(spec.required !== true ? { nullable: true } : {}),
        ...(spec.format === "uuid" || spec.ref
          ? { format: "uuid" as const }
          : {}),
      }];
    }),
  );
  const actor = policyActorFromAuthContext(auth);
  const matched: string[] = [];
  const evidence: Record<string, unknown>[] = [];
  for (const rule of rows) {
    let whereAllowed = true;
    let normalizedWhere: unknown = null;
    if (rule.predicate) {
      const names = Object.keys(fields).sort();
      const casts = names.map((name, index) =>
        `$${index + 1}::${fieldSqlType(fields[name].type)} as ${
          quoteIdentifier(name)
        }`
      );
      const lowered = lowerCelToSql(rule.predicate, {
        fields,
        actor: {
          id: { type: "string", value: actor.id },
          human_user_id: {
            type: "string",
            value: actor.human_user_id,
          },
        },
        alias: "proposed",
        parameterOffset: names.length,
        maxNodes: 80,
        maxLength: 1000,
      });
      normalizedWhere = lowered.normalized;
      const evaluated = await query<{ allowed: boolean }>(
        sql,
        `select coalesce((${lowered.sql}),false) allowed from (select ${
          casts.join(",")
        }) proposed`,
        [...names.map((name) => proposed[name] ?? null), ...lowered.params],
      );
      whereAllowed = evaluated.rows[0]?.allowed === true;
    }
    let relationAllowed = true;
    if (rule.relation_relationship) {
      relationAllowed = await evaluateDirectRelation(
        sql,
        auth,
        operation,
        rule,
      );
    }
    const allowed = whereAllowed && relationAllowed;
    evidence.push({
      rule_id: rule.id,
      policy_definition_version_id: rule.policy_definition_version_id,
      condition_kind: rule.condition_kind,
      normalized_where: normalizedWhere,
      where_allowed: whereAllowed,
      relation_allowed: relationAllowed,
      allowed,
    });
    if (allowed) matched.push(rule.id);
  }
  return {
    allowed: matched.length > 0,
    matched_rule_ids: matched,
    rule_evidence: evidence,
  };
}

async function currentResourceState(
  sql: Queryable,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
): Promise<Record<string, unknown>> {
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3",
    [parsed.publisher, parsed.pack, parsed.name],
  )).rows[0];
  if (!runtime) return {};
  const current = (await query<{ snapshot: unknown }>(
    sql,
    `select to_jsonb(current_row) snapshot from ${
      quoteIdentifier(runtime.table_name)
    } current_row where project_id=$1 and id=$2`,
    [operation.project_id, operation.object_id],
  )).rows[0];
  return record(current?.snapshot);
}

async function proposedState(
  sql: Queryable,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
): Promise<Record<string, unknown>> {
  if (operation.op === "create") {
    return {
      ...record(operation.fields),
      id: operation.object_id,
      project_id: operation.project_id,
    };
  }
  if (operation.op === "link") {
    return {
      ...record(operation.fields),
      id: operation.relationship_id,
      project_id: operation.project_id,
      from: operation.from,
      to: operation.to,
    };
  }
  const kind = operation.op === "unlink" ? "relationship" : "resource";
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind=$3 and definition_name=$4",
    [parsed.publisher, parsed.pack, kind, parsed.name],
  )).rows[0];
  if (!runtime) return {};
  const id = operation.op === "unlink"
    ? operation.relationship_id
    : operation.object_id;
  const current = (await query<{ snapshot: unknown }>(
    sql,
    `select to_jsonb(current_row) snapshot from ${
      quoteIdentifier(runtime.table_name)
    } current_row where project_id=$1 and id=$2`,
    [operation.project_id, id],
  )).rows[0];
  const proposed = { ...record(current?.snapshot), ...record(operation.set) };
  for (const field of (operation.unset as string[] | undefined) ?? []) {
    delete proposed[field];
  }
  if (operation.op === "transition") {
    const lifecycle = (await query<{ normalized: unknown }>(
      sql,
      `select cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2`,
      [parsed.publisher, parsed.pack],
    )).rows[0];
    const definition = Object.values(
      record(record(lifecycle?.normalized).lifecycles),
    ).map(record).find((candidate) =>
      record(candidate.spec).resource === componentIdentity(operation)
    );
    if (definition) {
      const spec = record(definition.spec);
      const lifecycleField = String(spec.field);
      const currentState = proposed[lifecycleField];
      const edge = Array.isArray(spec.transitions)
        ? spec.transitions.map(record).find((candidate) =>
          candidate.to === operation.to && Array.isArray(candidate.from) &&
          candidate.from.includes(currentState)
        )
        : undefined;
      proposed[lifecycleField] = operation.to;
      for (const [field, value] of Object.entries(record(edge?.set))) {
        proposed[field] = value;
      }
      for (const field of (edge?.unset as string[] | undefined) ?? []) {
        delete proposed[field];
      }
    }
  }
  return proposed;
}

async function evaluateDirectRelation(
  sql: Queryable,
  auth: AuthContext,
  operation: CanonicalOperation,
  rule: {
    relation_relationship: string | null;
    relation_object_side: "from" | "to" | null;
    relation_subject_side: "from" | "to" | null;
    relation_subject: "actor.id" | "actor.human_user_id" | null;
  },
): Promise<boolean> {
  if (
    !rule.relation_relationship || !rule.relation_object_side ||
    !rule.relation_subject_side || !rule.relation_subject
  ) return false;
  if (rule.relation_object_side === rule.relation_subject_side) return false;
  const relation = parseIdentity(rule.relation_relationship);
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='relationship' and definition_name=$3",
    [relation.publisher, relation.pack, relation.name],
  )).rows[0];
  if (!runtime) return false;
  const objectColumn = rule.relation_object_side === "from"
    ? "from_object_id"
    : "to_object_id";
  const subjectColumn = rule.relation_subject_side === "from"
    ? "from_object_id"
    : "to_object_id";
  const objectId = operation.op === "link" || operation.op === "unlink"
    ? operation.relationship_id
    : operation.object_id;
  const actor = policyActorFromAuthContext(auth);
  const subjectId = rule.relation_subject === "actor.id"
    ? actor.id
    : actor.human_user_id;
  return Boolean(
    (await query<{ allowed: boolean }>(
      sql,
      `select exists(select 1 from ${
        quoteIdentifier(runtime.table_name)
      } where project_id=$1 and archived_at is null and ${
        quoteIdentifier(objectColumn)
      }=$2 and ${quoteIdentifier(subjectColumn)}=$3) allowed`,
      [operation.project_id, objectId, subjectId],
    )).rows[0]?.allowed,
  );
}

function fieldSqlType(type: FieldSpec["type"]): string {
  return type === "integer"
    ? "bigint"
    : type === "decimal"
    ? "numeric"
    : type === "boolean"
    ? "boolean"
    : type === "date"
    ? "date"
    : type === "timestamp"
    ? "timestamptz"
    : "text";
}

async function validateUniqueness(
  sql: Queryable,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
  definition: Record<string, unknown>,
  revision: Revision,
  componentRevisionId: string,
  componentDigest: string,
  dependencies: Record<string, unknown>[],
  stagedUniqueSignatures: Set<string>,
): Promise<void> {
  if (!["create", "update", "transition"].includes(operation.op)) return;
  const fieldDefinitions = record(record(definition.spec).fields);
  const constraints = Array.isArray(record(definition.spec).constraints)
    ? (record(definition.spec).constraints as unknown[]).map(record)
    : [];
  const uniqueSets = [
    ...Object.entries(fieldDefinitions).filter(([, field]) =>
      record(field).unique === true
    ).map(([field]) => ({
      fields: [field],
      name: null,
      predicate: null,
    })),
    ...constraints.filter((constraint) =>
      constraint.kind === "unique" &&
      (constraint.where === undefined || constraint.where === "active()")
    ).map((constraint) => ({
      fields: (constraint.fields as unknown[]).map(String),
      name: String(constraint.name),
      predicate: constraint.where === "active()" ? "active()" : null,
    })),
  ];
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3",
    [parsed.publisher, parsed.pack, parsed.name],
  )).rows[0];
  if (!runtime) return;
  let proposed = record(operation.fields);
  const objectId = String(operation.object_id ?? "");
  if (operation.op !== "create") {
    const current = (await query<{ snapshot: unknown }>(
      sql,
      `select to_jsonb(current_row) snapshot from ${
        quoteIdentifier(runtime.table_name)
      } current_row where project_id=$1 and id=$2`,
      [operation.project_id, objectId],
    )).rows[0];
    proposed = { ...record(current?.snapshot), ...record(operation.set) };
    for (const field of (operation.unset as string[] | undefined) ?? []) {
      delete proposed[field];
    }
  }
  const fieldSpecs = Object.fromEntries(
    Object.entries(fieldDefinitions).map(([name, value]) => {
      const spec = record(value);
      return [name, {
        type: String(spec.type) as FieldSpec["type"],
        ...(spec.required !== true ? { nullable: true } : {}),
        ...(spec.format === "uuid" || spec.ref
          ? { format: "uuid" as const }
          : {}),
      }];
    }),
  );
  for (
    const constraint of constraints.filter((candidate) =>
      candidate.kind === "check"
    )
  ) {
    const names = Object.keys(fieldSpecs).sort();
    const lowered = lowerCelToSql(String(constraint.expression), {
      fields: fieldSpecs,
      alias: "proposed",
      parameterOffset: names.length,
      maxNodes: 80,
      maxLength: 1000,
    });
    const casts = names.map((name, index) =>
      `$${index + 1}::${fieldSqlType(fieldSpecs[name].type)} as ${
        quoteIdentifier(name)
      }`
    );
    const result = await query<{ allowed: boolean }>(
      sql,
      `select coalesce((${lowered.sql}),false) allowed from (select ${
        casts.join(",")
      }) proposed`,
      [...names.map((name) => proposed[name] ?? null), ...lowered.params],
    );
    if (!result.rows[0]?.allowed) {
      throw domain(
        "validation_failed",
        `Constraint '${String(constraint.name)}' rejected proposed state`,
        "validation",
      );
    }
  }
  for (
    const constraint of constraints.filter((candidate) =>
      candidate.kind === "foreign_key"
    )
  ) {
    const sourceFields = (constraint.fields as unknown[]).map(String);
    if (
      sourceFields.some((field) =>
        proposed[field] === undefined || proposed[field] === null
      )
    ) continue;
    const target = record(constraint.target);
    const targetIdentity = parseIdentity(String(target.resource));
    const targetFields = (target.fields as unknown[]).map(String);
    const targetRuntime = (await query<{ table_name: string }>(
      sql,
      "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3",
      [targetIdentity.publisher, targetIdentity.pack, targetIdentity.name],
    )).rows[0];
    if (!targetRuntime || targetFields.length !== sourceFields.length) {
      throw domain(
        "validation_failed",
        "Foreign-key target is unavailable",
        "validation",
      );
    }
    const params: unknown[] = [operation.project_id];
    const predicates = targetFields.map((field, index) => {
      params.push(proposed[sourceFields[index]]);
      return `${quoteIdentifier(field)} is not distinct from $${params.length}`;
    });
    const targetRow =
      (await query<{ id: string; current_object_version_id: string }>(
        sql,
        `select id,current_object_version_id from ${
          quoteIdentifier(targetRuntime.table_name)
        } where project_id=$1 and archived_at is null and ${
          predicates.join(" and ")
        } limit 1 for share`,
        params,
      )).rows[0];
    if (!targetRow) {
      throw domain(
        "validation_failed",
        "Foreign-key target does not exist",
        "validation",
      );
    }
    dependencies.push({
      kind: "object_version",
      project_id: operation.project_id,
      object_id: targetRow.id,
      expected_version_id: targetRow.current_object_version_id,
      foreign_key_constraint: constraint.name,
    });
  }
  for (const uniqueSet of uniqueSets) {
    const { fields } = uniqueSet;
    if (
      fields.some((field) =>
        proposed[field] === undefined || proposed[field] === null
      )
    ) continue;
    const params: unknown[] = [operation.project_id, objectId];
    const predicates = fields.map((field) => {
      params.push(proposed[field]);
      return `${quoteIdentifier(field)} is not distinct from $${params.length}`;
    });
    const signature = canonicalJson([
      operation.project_id,
      `${parsed.publisher}/${parsed.pack}:${parsed.name}`,
      fields,
      fields.map((field) => proposed[field]),
    ]);
    if (stagedUniqueSignatures.has(signature)) {
      throw domain(
        "operation_conflict",
        "Sibling proposed states violate uniqueness",
        "conflict",
      );
    }
    stagedUniqueSignatures.add(signature);
    const duplicate = (await query<{ id: string }>(
      sql,
      `select id from ${
        quoteIdentifier(runtime.table_name)
      } where project_id=$1 and id<>$2${
        uniqueSet.predicate === "active()" ? " and archived_at is null" : ""
      } and ${predicates.join(" and ")} order by id limit 2 for share`,
      params,
    )).rows[0];
    dependencies.push({
      kind: "uniqueness",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      component_revision_id: componentRevisionId,
      component_digest: componentDigest,
      fields,
      values: fields.map((field) => proposed[field]),
      constraint_name: uniqueSet.name,
      constraint_predicate: uniqueSet.predicate,
      project_scoped: true,
      existing_id: duplicate?.id ?? null,
    });
    if (duplicate) {
      throw domain(
        "operation_conflict",
        "Proposed state violates uniqueness",
        "conflict",
      );
    }
  }
}

async function canReviewAny(
  sql: Queryable,
  stageId: string,
  auth: AuthContext,
  now: Date,
  authorizationRepository: StageAuthorizationRepositoryFactory,
): Promise<boolean> {
  const rows =
    (await query<{ requirement_json: unknown; created_principal_id: string }>(
      sql,
      `select r.requirement_json,s.created_principal_id from staged_approval_requirements r join staged_changesets s on s.id=r.stage_id where r.stage_id=$1 order by r.ordinal`,
      [stageId],
    )).rows;
  const principal = (await query<{ type: string; active: boolean }>(
    sql,
    "select type,active from principals where id=$1",
    [auth.principalId],
  )).rows[0];
  if (!principal?.active) return false;
  for (const row of rows) {
    const requirement = record(row.requirement_json);
    if (!array(requirement.principal_types).includes(principal.type)) continue;
    if (
      !requirement.allow_initiator &&
      row.created_principal_id === auth.principalId
    ) continue;
    if (
      requirement.expires_at &&
      new Date(String(requirement.expires_at)) <= now
    ) continue;
    const value = record(requirement.boundary);
    const boundary = value.type === "project"
      ? { type: "project" as const, projectId: String(value.project_id) }
      : value.type === "all_projects"
      ? { type: "all_projects" as const }
      : { type: "system" as const };
    const authority = await authorizationRepository(sql as Sql)
      .authorize({
        auth,
        boundary,
        action: "changeset.approval.decide",
        resource: "system:changeset-approval",
      });
    if (
      authority.ok &&
      (authority.value.superAdmin ||
        authority.value.effectiveRoles.includes(String(requirement.role)))
    ) return true;
  }
  return false;
}

async function canAccess(
  sql: Queryable,
  stageId: string,
  auth: AuthContext,
  action: string,
  lock: boolean,
  authorizationRepository: StageAuthorizationRepositoryFactory,
): Promise<boolean> {
  const root = (await query<{
    created_auth_context_id: string;
    created_principal_id: string;
  }>(
    sql,
    `select created_auth_context_id,created_principal_id from staged_changesets where id=$1 ${
      lock ? "for share" : ""
    }`,
    [stageId],
  )).rows[0];
  if (!root) return false;
  const projects = (await query<{ project_id: string }>(
    sql,
    "select distinct project_id from staged_changeset_operations where stage_id=$1 order by project_id",
    [stageId],
  )).rows.map((row) => row.project_id);
  for (const projectId of projects) {
    await lockReadAuthority(sql, auth, projectId);
    const project = (await query<{ status: string }>(
      sql,
      "select status from projects where id=$1 for share",
      [projectId],
    )).rows[0];
    if (!project || project.status !== "active") return false;
  }
  if (root.created_principal_id === auth.principalId) return true;
  for (const projectId of projects) {
    const allowed = await authorizationRepository(sql as Sql)
      .authorize({
        auth,
        boundary: { type: "project", projectId },
        action,
        resource: "changeset",
      });
    if (!allowed.ok) return false;
    if (
      !allowed.value.superAdmin &&
      !allowed.value.capabilities.some((capability) =>
        capability.action === action &&
        (capability.resource === "*" || capability.resource === "changeset") &&
        capability.condition === "unconditional"
      )
    ) return false;
  }
  return true;
}

async function load(sql: Queryable, id: string): Promise<StageDto | null> {
  const row = (await query<Record<string, unknown>>(
    sql,
    `select s.*,l.status,l.version lifecycle_version,l.cancelled_auth_context_id,l.cancelled_at,l.cancellation_reason,l.committed_at from staged_changesets s join staged_changeset_lifecycle l on l.stage_id=s.id where s.id=$1`,
    [id],
  )).rows[0];
  if (!row) return null;
  const operations = (await query<{ canonical_operation_json: unknown }>(
    sql,
    "select canonical_operation_json from staged_changeset_operations where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) =>
    record(item.canonical_operation_json) as CanonicalOperation
  );
  const dependencies = (await query<{ dependency_json: unknown }>(
    sql,
    "select dependency_json from staged_changeset_dependencies where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.dependency_json));
  const policies = (await query<{ decision_json: unknown }>(
    sql,
    "select decision_json from staged_policy_decisions where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.decision_json));
  const hooks = (await query<Record<string, unknown>>(
    sql,
    `select id,attachment_id,phase,pack_revision_id,hook_revision_id,input_digest,output_digest,
      output_json output,script_digest,security_digest,stderr_text stderr,logs_truncated,
      secrets_redacted,duration_ms,authority_snapshot_json authority_snapshot,
      grant_snapshot_json grant_snapshot,created_at
     from staged_hook_executions where stage_id=$1 order by ordinal`,
    [id],
  )).rows.map((hook) => ({
    ...hook,
    duration_ms: Number(hook.duration_ms),
    created_at: timestamp(hook.created_at),
  }));
  const approvals = (await query<{ requirement_json: unknown }>(
    sql,
    "select requirement_json from staged_approval_requirements where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.requirement_json));
  const decisions = (await query<Record<string, unknown>>(
    sql,
    "select id,requirement_id,principal_id,decision,reason,decided_auth_context_id,decided_at from staged_approval_decisions where stage_id=$1 order by decided_at,id",
    [id],
  )).rows;
  const commit = (await query<Record<string, unknown>>(
    sql,
    "select id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest,committed_at from changeset_commits where stage_id=$1",
    [id],
  )).rows[0] ?? null;
  const cancelledAt = timestamp(row.cancelled_at);
  return {
    id: String(row.id),
    schema_version: 1,
    source: {
      kind: String(row.source_kind) as StageDto["source"]["kind"],
      identity: record(row.source_identity_json),
    },
    status: String(row.status) as StageDto["status"],
    lifecycle_version: Number(row.lifecycle_version),
    created_at: timestamp(row.created_at)!,
    created_auth_context_id: String(row.created_auth_context_id),
    operation_graph_digest: String(row.operation_graph_digest),
    stage_digest: String(row.stage_digest),
    projects: array(row.projects_json),
    pack_revisions: array(row.pack_revisions_json),
    operations,
    dependencies,
    hook_executions: hooks,
    policy_decisions: policies,
    warnings: array(row.warnings_json),
    approval_requirements: approvals,
    approval_decisions: decisions,
    planned_events: array(row.planned_events_json),
    planned_deliveries: array(row.planned_deliveries_json),
    commit,
    cancellation: cancelledAt
      ? {
        auth_context_id: String(row.cancelled_auth_context_id),
        at: cancelledAt,
        reason: row.cancellation_reason === null
          ? null
          : String(row.cancellation_reason),
      }
      : null,
  };
}

function compareHookDeclarations(
  left: StageHookDeclaration,
  right: StageHookDeclaration,
): number {
  return phaseOrder(left.phase) - phaseOrder(right.phase) ||
    left.order - right.order || left.hook.localeCompare(right.hook) ||
    left.attachment_id.localeCompare(right.attachment_id) ||
    String(left.operation_key ?? "").localeCompare(
      String(right.operation_key ?? ""),
    );
}

function phaseOrder(phase: string): number {
  return phase === "changeset.before_stage" ? 0 : 1;
}
function validateDeclaredFields(
  operation: CanonicalOperation,
  definition: Record<string, unknown>,
): void {
  const fields = record(record(definition.spec).fields);
  for (const map of [operation.fields, operation.set]) {
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [key, value] of Object.entries(map)) {
        if (!Object.hasOwn(fields, key)) {
          throw domain(
            "validation_failed",
            `Field '${key}' is not declared`,
            "validation",
          );
        }
        validateFieldValue(key, value, record(fields[key]));
      }
    }
  }
  for (const key of (operation.unset as string[] | undefined) ?? []) {
    if (!Object.hasOwn(fields, key)) {
      throw domain(
        "validation_failed",
        `Field '${key}' is not declared`,
        "validation",
      );
    }
    if (record(fields[key]).required === true) {
      throw domain(
        "validation_failed",
        `Required field '${key}' cannot be unset`,
        "validation",
      );
    }
  }
  if (operation.op === "create") {
    for (const [key, value] of Object.entries(fields)) {
      if (
        record(value).required === true &&
        !Object.hasOwn(record(operation.fields), key)
      ) {
        throw domain(
          "validation_failed",
          `Required field '${key}' is missing`,
          "validation",
        );
      }
    }
  }
}

function validateFieldValue(
  name: string,
  value: unknown,
  field: Record<string, unknown>,
): void {
  const issue = validateCanonicalFieldValue(name, value, field);
  if (issue) throw domain("validation_failed", issue, "validation");
}

function componentIdentity(operation: CanonicalOperation): string {
  return String(operation.relationship ?? operation.resource);
}
function operationDefinitionKind(
  operation: CanonicalOperation,
): "resources" | "relationships" {
  return operation.relationship ? "relationships" : "resources";
}
function operationObjectId(operation: CanonicalOperation): string | null {
  return operation.op === "link" || operation.op === "unlink"
    ? String(operation.relationship_id)
    : operation.object_id
    ? String(operation.object_id)
    : null;
}
function parseIdentity(identity: string) {
  const match = /^([^/]+)\/([^:]+):(.+)$/.exec(identity);
  if (!match) {
    throw domain(
      "validation_failed",
      "Component identity is invalid",
      "validation",
    );
  }
  return { publisher: match[1], pack: match[2], name: match[3] };
}
async function loadComponentRevision(
  sql: Queryable,
  candidateRevisionId: string,
  definitionKind: string,
  definitionName: string,
  definition: Record<string, unknown>,
): Promise<{ id: string; digest: string }> {
  const expected = `sha256:${await canonicalSha256(definition)}`;
  const component = (await query<{ id: string; definition_digest: string }>(
    sql,
    `select id,definition_digest from pack_component_revisions
     where candidate_revision_id=$1 and definition_kind=$2 and definition_name=$3 for share`,
    [candidateRevisionId, definitionKind, definitionName],
  )).rows[0];
  if (!component || component.definition_digest !== expected) {
    throw domain(
      "validation_failed",
      "Active component revision evidence is unavailable or inconsistent",
      "validation",
    );
  }
  return { id: component.id, digest: component.definition_digest };
}

function publicRevision(revision: Revision) {
  return {
    publisher: revision.publisher,
    pack: revision.pack,
    revision_id: revision.id,
    content_digest: revision.contentDigest,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function array(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}
function timestamp(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
    ? new Date(value).toISOString()
    : null;
}
async function captureHookAuthoritySnapshot(
  sql: Queryable,
  auth: AuthContext,
  projectIds: string[],
): Promise<StageHookInput["authority_snapshot"]> {
  const actor = policyActorFromAuthContext(auth);
  const assignments = (await query<{ kind: string; id: string }>(
    sql,
    `with recursive lineage(id) as (
       select $1::uuid where $1::uuid is not null
       union
       select agent_auth.parent_authorization_id
         from agent_authorizations agent_auth
         join lineage child on child.id=agent_auth.id
        where agent_auth.parent_authorization_id is not null
     )
     select kind,id::text from (
       select 'auth_session' kind,id from auth_sessions where id=$2
       union all select 'principal',id from principals where id=$3
       union all select 'human_user',id from human_users where id=$4
       union all select 'agent_authorization',id from lineage
       union all select 'role_assignment',id from role_assignments
        where principal_id=$3 and
          (boundary_type in ('system','all_projects') or project_id=any($5::uuid[]))
       union all select 'agent_authorization_role',id from agent_authorization_roles
        where authorization_id=$1 and
          (boundary_type in ('system','all_projects') or project_id=any($5::uuid[]))
       union all select 'role_definition_version',role_version.id
         from role_definition_versions role_version where role_version.role_id in (
           select role_id from role_assignments where principal_id=$3
           union select role_id from agent_authorization_roles where authorization_id=$1
         )
     ) evidence order by kind,id`,
    [
      auth.authorizationId ?? null,
      auth.sessionId,
      auth.principalId,
      auth.humanUserId,
      projectIds,
    ],
  )).rows;
  const policies = (await query<{ kind: string; id: string }>(
    sql,
    `select kind,id::text from (
       select 'policy_assignment' kind,id from policy_assignments
        where boundary_type in ('system','all_projects') or project_id=any($1::uuid[])
       union all select 'policy_definition_version',definition.id
         from policy_definition_versions definition join policy_assignments assignment
           on assignment.policy_definition_version_id=definition.id
        where assignment.boundary_type in ('system','all_projects') or
              assignment.project_id=any($1::uuid[])
       union all select 'policy_rule',rule.id from policy_rules rule
         join policy_assignments assignment
           on assignment.policy_definition_version_id=rule.policy_definition_version_id
        where assignment.boundary_type in ('system','all_projects') or
              assignment.project_id=any($1::uuid[])
     ) evidence order by kind,id`,
    [projectIds],
  )).rows;
  return {
    principal_id: actor.id,
    auth_context_id: auth.id,
    assignment_digest: `sha256:${await canonicalSha256(assignments)}`,
    policy_digest: `sha256:${await canonicalSha256(policies)}`,
  };
}

function domain(code: string, message: string, severity: string): Error {
  return Object.assign(new Error(message), { code, severity });
}
function mapError(error: unknown): Result<never> {
  const item = error as { code?: string; severity?: string; message?: string };
  if (
    item.code &&
    [
      "validation",
      "authentication",
      "authorization",
      "not_found",
      "conflict",
      "unavailable",
    ].includes(item.severity ?? "")
  ) {
    return err({
      code: item.code,
      message: item.message ?? item.code,
      severity: (item.severity ?? "validation") as never,
      details: {},
    });
  }
  console.error(error);
  return err({
    code: "internal_error",
    message: "unexpected server error",
    severity: "internal",
    details: {},
  });
}
function mapStageError(error: unknown): Result<never> {
  if (error instanceof ApprovalContractError) {
    return err({
      code: "validation_failed",
      message: "approval requirements failed validation",
      severity: "validation",
      details: {
        issues: [{
          path: error.path,
          code: "invalid_approval_requirement",
          message: error.message,
        }],
      },
    });
  }
  if (error instanceof ObjectReadAuthorityInvalidError) {
    return err({
      code: "authorization_insufficient",
      message: "current authority is no longer valid",
      severity: "authorization",
      details: {},
    });
  }
  return mapError(error);
}
function mapAccessError(error: unknown): Result<never> {
  if (error instanceof ObjectReadAuthorityInvalidError) return err(notFound());
  return mapError(error);
}
function notFound() {
  return {
    code: "not_found",
    message: "changeset was not found",
    severity: "not_found" as const,
    details: {},
  };
}
