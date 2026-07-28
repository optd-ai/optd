import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { CanonicalOperation } from "../../../domain/changesets/operations.ts";
import type {
  HookAuthoritySnapshot,
  HookGrantSnapshot,
} from "../../../domain/changesets/stage.ts";
import type { StageDto, StageSource } from "../../ports/stage_repository.ts";
import type {
  ActionCatalog,
  ActionPolicyAuthorizer,
  ActionStageAuthorityPort,
  ActionTargetReader,
  HookExecutionEvidenceRepository,
  PinnedActionHookCatalog,
  PinnedHookProgram,
} from "../../ports/repair/repositories.ts";
import { StageHookError } from "../../ports/hook_executor.ts";
import { validateFieldMap } from "../../../schemas/changesets/field_values.ts";
import type { TargetedActionPolicyTarget } from "../query_objects.ts";

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

export function parseResourceIdentity(value: string): {
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

export type StageActionResult = StageDto | {
  status: "no_changes";
  stage: null;
};
export type ActionStageRequest = Readonly<{
  project_id: string;
  input: Record<string, unknown>;
}>;
export type ActionIdentity = Readonly<{
  publisher: string;
  pack: string;
  name: string;
}>;
export type ActionDefinition = Readonly<{
  revisionId: string;
  normalized: unknown;
  spec: Record<string, unknown>;
}>;
export type ActionReadRequest = Readonly<{
  projectId: string;
  target: NonNullable<ReturnType<typeof parseResourceIdentity>>;
  objectId: string;
  fields: readonly string[];
}>;
export type ActionReadResult = Readonly<{
  values: Record<string, unknown>;
  objectVersionId: string;
}>;
export type ActionAuthorityResult = Readonly<{
  allowed: boolean;
  policyDigest: string;
  authorizationRootId: string;
  factsDigest: string;
}>;
export type ActionStageHookDeclaration = Readonly<{
  attachment_id: string;
  hook_revision_id: string;
  pack_revision_id: string;
  hook: string;
  phase: "action.stage";
  resource: null;
  operation_key: null;
  order: number;
  script_digest: string;
  security_digest: string;
  script_content: string;
  timeout_ms: number;
  output_schema: "changeset.operations.v1";
  permissions: { net: string[]; env: string[] };
  secret_slots: Array<{ slot: string; env: string }>;
  input_mapping: Record<string, unknown>;
  condition: string | null;
  effects: Record<string, unknown>[];
  declaration_digest: string;
}>;
export type ActionHookExecution = Readonly<{
  id: string;
  phase: "action.stage";
  output_schema: "changeset.operations.v1";
  hook: string;
  attachment_id: string;
  hook_revision_id: string;
  pack_revision_id: string;
  script_digest: string;
  security_digest: string;
  input_digest: string;
  output_digest: string;
  output: Readonly<Record<string, unknown>>;
  added_operations: readonly CanonicalOperation[];
  stderr: string;
  logs_truncated: boolean;
  secrets_redacted: boolean;
  duration_ms: number;
  authority_snapshot: HookAuthoritySnapshot;
  grant_snapshot: HookGrantSnapshot;
  read_dependencies: readonly Readonly<{
    name: string;
    project_id: string;
    resource_identity: string;
    object_id: string;
    object_version_id: string;
  }>[];
}>;
export type ActionHookResult = Readonly<{
  added_operations: CanonicalOperation[];
  hook_executions: ActionHookExecution[];
}>;

type ActionHookRequest = Readonly<{
  action: string;
  project_id: string;
  actor: { id: string; principal_type: "human_user" | "agent_user" };
  input: Readonly<Record<string, unknown>>;
  reads: Readonly<Record<string, unknown>>;
  read_dependencies: readonly Readonly<{
    name: string;
    project_id: string;
    resource_identity: string;
    object_id: string;
    object_version_id: string;
  }>[];
  declarations: readonly ActionStageHookDeclaration[];
  authority_snapshot: {
    principal_id: string;
    auth_context_id: string;
    assignment_digest: string;
    policy_digest: string;
  };
}>;

/** Granular inward capabilities; no method represents the complete stage use case. */
export interface ActionStageCapabilities
  extends
    ActionCatalog<ActionIdentity, ActionDefinition>,
    ActionTargetReader<ActionReadRequest, ActionReadResult>,
    PinnedActionHookCatalog<ActionIdentity & { revisionId: string }>,
    ActionStageAuthorityPort<
      Readonly<{
        projectId: string;
        action: string;
        targets: TargetedActionPolicyTarget[];
        auth: AuthContext;
      }>,
      ActionAuthorityResult
    >,
    ActionPolicyAuthorizer<ActionAuthorityResult, ActionAuthorityResult>,
    HookExecutionEvidenceRepository<
      Readonly<{
        input: unknown;
        source: StageSource;
        auth: AuthContext;
        cutoff: ActionAuthorityResult;
      }>,
      Result<StageDto | null>
    > {
  availabilityState(
    request: Readonly<{
      projectId: string;
      target: NonNullable<ReturnType<typeof parseResourceIdentity>>;
      objectId: string;
      field: string;
    }>,
  ): Promise<unknown | undefined>;
  availabilityCondition(
    request: Readonly<{
      projectId: string;
      target: NonNullable<ReturnType<typeof parseResourceIdentity>>;
      objectId: string;
      fields: Record<string, unknown>;
      expression: string;
      auth: AuthContext;
    }>,
  ): Promise<boolean>;
  executeHooks(request: ActionHookRequest): Promise<ActionHookResult>;
}

/** Owns action selection, reads, availability, authority, hooks and persistence ordering. */
export function makeStageActionService(port: ActionStageCapabilities) {
  return Object.freeze({
    async stage(
      publisher: string,
      pack: string,
      name: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<StageActionResult>> {
      if (!validRequest(raw)) return invalid("action stage request is invalid");
      try {
        const identity = { publisher, pack, name };
        const definition = await port.definition(identity);
        if (!definition) {
          return err({
            code: "not_found",
            message: "action was not found",
            severity: "not_found",
            details: {},
          });
        }
        const inputSpec = record(definition.spec.input);
        const inputIssue = validateActionInput(raw.input, inputSpec);
        if (inputIssue) return invalid(inputIssue);

        const semantic = `action:${publisher}/${pack}:${name}`;
        const reads: Record<string, unknown> = {};
        const readDependencies: Array<{
          name: string;
          project_id: string;
          resource_identity: string;
          object_id: string;
          object_version_id: string;
        }> = [];
        const policyTargets: TargetedActionPolicyTarget[] = [];
        const readObjectIds = new Map<string, string>();

        for (
          const readName of Object.keys(record(definition.spec.reads)).sort()
        ) {
          const declaration = record(record(definition.spec.reads)[readName]);
          const fieldName = String(declaration.id_from).replace(
            /^\$action\.input\./,
            "",
          );
          const objectId = raw.input[fieldName];
          if (objectId === undefined && declaration.required === false) {
            continue;
          }
          if (typeof objectId !== "string" || !isUuidV7(objectId)) {
            return invalid(
              `declared action read ${readName} requires a UUIDv7 input`,
            );
          }
          const resource = String(declaration.resource);
          const qualified = resource.includes(":")
            ? resource
            : `${publisher}/${pack}:${resource}`;
          const target = parseResourceIdentity(qualified);
          if (!target) {
            return invalid("declared action read resource is unavailable");
          }
          const fields = Array.isArray(declaration.fields)
            ? declaration.fields.map(String)
            : [];
          const result = await port.current({
            projectId: raw.project_id,
            target,
            objectId,
            fields,
          });
          if (!result) {
            if (declaration.required === false) continue;
            return invalid(`required action read ${readName} was not found`);
          }
          reads[readName] = result.values;
          readObjectIds.set(qualified, objectId);
          policyTargets.push({ definition: target, objectId });
          readDependencies.push({
            name: readName,
            project_id: raw.project_id,
            resource_identity: qualified,
            object_id: objectId,
            object_version_id: result.objectVersionId,
          });
        }

        const availabilityIssue = await checkAvailability(
          port,
          definition,
          raw.project_id,
          auth,
          readObjectIds,
        );
        if (availabilityIssue) {
          return err({
            code: "action_unavailable",
            message: "action is not currently available",
            severity: "conflict",
            details: { reason: availabilityIssue },
          });
        }

        const programs = await port.pinned({
          ...identity,
          revisionId: definition.revisionId,
        });
        if (!programs.length) {
          return invalid("action has no active reviewed stage attachment");
        }
        const declarations = programs.map(actionDeclaration);
        const effects = declarations.flatMap((declaration) =>
          declaration.effects
        )
          .filter(isRecord).map((effect) => ({
            resource: String(effect.resource),
            ops: array(effect.ops).map(String),
          }));
        const targets = resolveActionPolicyTargets(policyTargets, effects);
        if (!targets) {
          return invalid("action effects have no exact authorization target");
        }

        const authority = await port.assertAllowed(
          await port.lockAndEvaluate({
            projectId: raw.project_id,
            action: semantic,
            targets,
            auth,
          }),
        );
        if (!authority.allowed) {
          return policyDenied(semantic, raw.project_id, auth);
        }

        const hookResult = await port.executeHooks({
          action: `${publisher}/${pack}:${name}`,
          project_id: raw.project_id,
          actor: { id: auth.principalId, principal_type: auth.principalType },
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
        if (!hookResult.added_operations.length) {
          return ok({ status: "no_changes", stage: null });
        }

        const targetedEvidence = {
          action: semantic,
          targets: targets.map((target) => {
            const resource =
              `${target.definition.publisher}/${target.definition.pack}:${target.definition.name}`;
            if (!target.objectId) {
              return { resource, absent_effect: true as const };
            }
            const dependency = readDependencies.find((candidate) =>
              candidate.resource_identity === resource &&
              candidate.object_id === target.objectId
            );
            if (!dependency) {
              throw new Error(
                "targeted action object lacks immutable version evidence",
              );
            }
            return {
              resource,
              object_id: target.objectId,
              object_version_id: dependency.object_version_id,
            };
          }),
          policy_digest: authority.policyDigest,
          cutoff: {
            auth_context_id: auth.id,
            principal_id: auth.principalId,
            human_user_id: auth.humanUserId,
            session_id: auth.sessionId,
            authorization_id: auth.authorizationId ?? null,
            authorization_root_id: authority.authorizationRootId,
            facts_digest: authority.factsDigest,
          },
        };
        const source: StageSource = {
          kind: "action",
          identity: {
            action: `${publisher}/${pack}:${name}`,
            revision_id: definition.revisionId,
            authority_evidence: targetedEvidence,
          },
          authority: {
            project_id: raw.project_id,
            actions: [semantic],
            revision_id: definition.revisionId,
            effects: effects.map((effect) => ({
              ...effect,
              authority_action: semantic,
            })),
            operation_authority: Object.fromEntries(
              hookResult.added_operations.map((
                operation,
              ) => [operation.key, semantic]),
            ),
            targeted: targetedEvidence,
          },
          dependencies: readDependencies.map((dependency) => ({
            kind: "object_version",
            ...dependency,
            expected_version_id: dependency.object_version_id,
          })),
          hook_executions: hookResult.hook_executions.map((execution) => ({
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
            authority_snapshot: {
              ...record(execution.authority_snapshot),
              targeted_action: targetedEvidence,
            },
            grant_snapshot: execution.grant_snapshot,
          })),
        };
        const staged = await port.record({
          input: { operations: hookResult.added_operations },
          source,
          auth,
          cutoff: authority,
        });
        return staged.ok ? ok(staged.value!) : staged;
      } catch (error) {
        if (error instanceof StageHookError) {
          return err({
            code: error.code,
            message: error.message,
            severity: error.code === "hook_timeout"
              ? "unavailable"
              : "validation",
            details: error.details,
          });
        }
        if (isConcurrencyError(error)) {
          return err({
            code: "project_conflict",
            message: "action authority changed while staging",
            severity: "conflict",
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
    },
  });
}

async function checkAvailability(
  port: ActionStageCapabilities,
  definition: ActionDefinition,
  projectId: string,
  auth: AuthContext,
  readObjectIds: ReadonlyMap<string, string>,
): Promise<string | null> {
  const availability = record(definition.spec.availability);
  if (!Object.keys(availability).length) return null;
  const resource = String(availability.resource);
  const objectId = readObjectIds.get(resource);
  if (!objectId) return "availability does not bind one reviewed current read";
  const lifecycles = Object.values(
    record(record(definition.normalized).lifecycles),
  ).map(record)
    .filter((value) => String(record(value.spec).resource) === resource);
  if (lifecycles.length !== 1) {
    return "availability lifecycle is unavailable or ambiguous";
  }
  const lifecycle = record(lifecycles[0].spec);
  const target = parseResourceIdentity(resource);
  if (!target) return "availability resource is unavailable";
  const state = await port.availabilityState({
    projectId,
    target,
    objectId,
    field: String(lifecycle.field),
  });
  if (state === undefined) return "availability object is absent or archived";
  if (
    Array.isArray(availability.states) && !availability.states.includes(state)
  ) return "availability state is not allowed";
  if (typeof availability.condition === "string") {
    const resourceName = resource.split(":").pop()!;
    const definitionFields = record(
      record(record(definition.normalized).resources)[resourceName],
    );
    const allowed = await port.availabilityCondition({
      projectId,
      target,
      objectId,
      fields: record(record(definitionFields.spec).fields),
      expression: availability.condition,
      auth,
    });
    if (!allowed) return "availability condition is not satisfied";
  }
  return null;
}

function actionDeclaration(
  program: PinnedHookProgram<"action.stage">,
): ActionStageHookDeclaration {
  const declaration = record(program.declaration);
  return {
    attachment_id: String(program.attachmentId),
    hook_revision_id: program.revisionId,
    pack_revision_id: String(declaration.pack_revision_id),
    hook: program.hookIdentity,
    phase: "action.stage",
    resource: null,
    operation_key: null,
    order: program.ordinal,
    script_digest: program.scriptDigest,
    security_digest: program.securityDigest,
    script_content: program.source,
    timeout_ms: program.timeoutMs,
    output_schema: "changeset.operations.v1",
    permissions: {
      net: [...program.permissions.net],
      env: [...program.permissions.env],
    },
    secret_slots: program.secretDeclarations.map((slot) => ({ ...slot })),
    input_mapping: record(declaration.input_mapping),
    condition: declaration.condition == null
      ? null
      : String(declaration.condition),
    effects: array(declaration.effects).filter(isRecord),
    declaration_digest: String(program.declarationDigest),
  };
}

function validRequest(value: unknown): value is ActionStageRequest {
  return isRecord(value) &&
    !Object.keys(value).some((key) =>
      key !== "project_id" && key !== "input"
    ) &&
    typeof value.project_id === "string" && isUuidV7(value.project_id) &&
    isRecord(value.input);
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
function isConcurrencyError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if (
    (error as { name?: unknown }).name === "ObjectReadAuthorityInvalidError"
  ) return true;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "40P01" || code === "55P03";
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
