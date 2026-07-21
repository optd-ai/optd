import type {
  StageDto,
  StageRepository,
} from "../../ports/stage_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  canonicalizeResolvedOperations,
  normalizeOperations,
  OperationError,
  resolveAddedOperations,
} from "../../../domain/changesets/operations.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";
import type {
  StageHookCoordinator,
  StageHookDeclaration,
  StageHookInput,
  StageHookResult,
} from "../../../domain/changesets/stage.ts";
import {
  buildHookEnvelope,
  StageHookError,
} from "../hooks/stage_hook_coordinator.ts";
import {
  applyPatches,
  compilePatchedMutation,
  PatchError,
} from "../../../domain/changesets/patch.ts";
import { patchOutputContract } from "../../../schemas/changesets/patch.ts";
import { ContractValidationError } from "../../../schemas/api/contracts.ts";
import {
  authoredOperationContract,
  resolvedOperationContract,
  type StageRequest,
  stageRequestContract,
} from "../../../schemas/changesets/operations.ts";

export function makeStageChangesetService(
  repository: StageRepository,
  hookCoordinator?: StageHookCoordinator,
) {
  return {
    async stage(input: unknown, auth: AuthContext): Promise<Result<StageDto>> {
      try {
        if (!stageRequestContract.check(input)) {
          throw new ContractValidationError(stageRequestContract.issues(input));
        }
        const normalized = await normalizeOperations(input as StageRequest);
        let hookResult;
        let hookWarnings: StageHookResult["warnings"][number][] = [];
        let hookDeclarations: readonly StageHookDeclaration[] = [];
        let hookProposedStates: Readonly<
          Record<string, Record<string, unknown>>
        > = {};
        let hookBaseStates: Readonly<
          Record<string, Record<string, unknown> | null>
        > = {};
        let hookWorkingStates: Record<string, Record<string, unknown>> = {};
        const requiresHookDiscovery = hookCoordinator &&
          (repository.hasHooks
            ? await repository.hasHooks(normalized.operations)
            : true);
        if (hookCoordinator && requiresHookDiscovery) {
          const pinned = repository.hookInput
            ? await repository.hookInput(normalized.operations, auth)
            : {
              ok: true as const,
              value: {
                operations: normalized.operations,
                projects: [],
                pack_revisions: [],
                hook_declarations: [],
                authority_snapshot: {
                  principal_id: auth.principalId,
                  auth_context_id: auth.id,
                  assignment_digest: `sha256:${"0".repeat(64)}`,
                  policy_digest: `sha256:${"0".repeat(64)}`,
                },
                proposed_states: {},
                base_states: {},
              },
            };
          if (!pinned.ok) return pinned;
          const matching = pinned.value.hook_declarations.length > 0;
          if (matching) {
            hookDeclarations = pinned.value.hook_declarations;
            hookProposedStates = pinned.value.proposed_states ?? {};
            hookBaseStates = pinned.value.base_states ?? {};
            hookWorkingStates = structuredClone(
              pinned.value.proposed_states ?? {},
            );
            const coordinated = await hookCoordinator.coordinate(pinned.value);
            hookResult = await validateHookResult(
              coordinated,
              pinned.value,
            );
            hookWarnings = [...hookResult.warnings];
            if (!hookResult.hook_executions.length) {
              throw new OperationError(
                "hook_rejected",
                "/hook_executions",
                "matching hooks require execution evidence",
              );
            }
          }
        }
        if (hookResult) {
          const addedIssues = hookResult.added_operations.flatMap((
            operation,
            index,
          ) =>
            authoredOperationContract.issues(operation).map((issue) => ({
              ...issue,
              path: `/added_operations/${index}${
                issue.path === "/" ? "" : issue.path
              }`,
            }))
          );
          if (addedIssues.length) {
            throw new ContractValidationError(addedIssues);
          }
        }
        const operations = hookResult
          ? resolveAddedOperations(
            normalized.operations,
            [...hookResult.added_operations],
          )
          : structuredClone(normalized.operations);
        for (const batch of hookResult?.patch_outputs ?? []) {
          if (!patchOutputContract.check(batch.output)) {
            throw new ContractValidationError(
              patchOutputContract.issues(batch.output),
            );
          }
          hookWarnings.push(...(batch.output.warnings ?? []));
          const operation = operations.find((candidate) =>
            candidate.key === batch.operation_key
          );
          if (
            !operation ||
            !["create", "update", "transition"].includes(operation.op)
          ) {
            throw new OperationError(
              "hook_rejected",
              "/patch_outputs",
              "patch output names an unsupported operation",
            );
          }
          const mapName = operation.op === "create" ? "fields" : "set";
          const before = operation.op === "create"
            ? (isRecord(operation.fields) ? operation.fields : {})
            : hookWorkingStates[batch.operation_key] ??
              hookProposedStates[batch.operation_key] ??
              (isRecord(operation[mapName]) ? operation[mapName] : {});
          const paths = batch.output.patches.map((patch) =>
            patch.path.slice(1).split("/")[0].replaceAll("~1", "/").replaceAll(
              "~0",
              "~",
            )
          );
          const platform = new Set([
            "id",
            "object_id",
            "relationship_id",
            "comment_id",
            "project_id",
            "version",
            "object_version_id",
            "created_at",
            "updated_at",
            "archived_at",
            "actor_id",
            "auth_context_id",
          ]);
          if (paths.some((path) => platform.has(path))) {
            throw new PatchError(
              "platform_field",
              "/patch_outputs",
              "hook patch cannot target platform-managed fields",
            );
          }
          const mutable = new Set([...Object.keys(before), ...paths]);
          const after = applyPatches(before, batch.output.patches, mutable);
          hookWorkingStates[batch.operation_key] = after;
          if (operation.op === "create") {
            operation.fields = (compilePatchedMutation(null, after) as {
              fields: Record<string, unknown>;
            }).fields;
          } else {
            const base = hookBaseStates[batch.operation_key] ?? {};
            const mutation = compilePatchedMutation(base, after) as {
              set?: Record<string, unknown>;
              unset?: string[];
            };
            operation.set = { ...(mutation.set ?? {}) };
            operation.unset = mutation.unset ?? [];
            if (!Object.keys(operation.set as Record<string, unknown>).length) {
              delete operation.set;
            }
            if (!(operation.unset as string[]).length) delete operation.unset;
          }
        }
        const issues = operations.flatMap((operation, index) =>
          resolvedOperationContract.issues(operation).map((issue) => ({
            ...issue,
            path: `/operations/${index}${issue.path === "/" ? "" : issue.path}`,
          }))
        );
        if (issues.length) throw new ContractValidationError(issues);
        const canonical = hookResult
          ? await canonicalizeResolvedOperations(operations)
          : normalized;
        return await repository.create({
          operations: canonical.operations,
          operationGraphDigest: canonical.operationGraphDigest,
          ...(hookResult
            ? {
              hookResult: { ...hookResult, warnings: hookWarnings },
              hookDeclarations,
            }
            : {}),
        }, auth);
      } catch (error) {
        return validationResult(error);
      }
    },
    async inspect(id: string, auth: AuthContext): Promise<Result<StageDto>> {
      if (!isUuidV7(id)) {
        return err({
          code: "not_found",
          message: "changeset was not found",
          severity: "not_found",
          details: {},
        });
      }
      return await repository.inspect(id, auth);
    },
    async cancel(
      id: string,
      input: unknown,
      auth: AuthContext,
    ): Promise<Result<StageDto>> {
      if (!isUuidV7(id)) {
        return err({
          code: "not_found",
          message: "changeset was not found",
          severity: "not_found",
          details: {},
        });
      }
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== "reason") ||
        (input.reason !== undefined &&
          (typeof input.reason !== "string" ||
            new TextEncoder().encode(input.reason).byteLength > 4096))
      ) {
        return err({
          code: "validation_failed",
          message: "cancel request is invalid",
          severity: "validation",
          details: {
            issues: [{
              path: "/",
              code: "invalid",
              message: "expected only an optional bounded reason",
            }],
          },
        });
      }
      return await repository.cancel(
        id,
        typeof input.reason === "string" ? input.reason : null,
        auth,
      );
    },
  };
}

async function validateHookResult(
  value: unknown,
  hookInput: StageHookInput,
): Promise<StageHookResult> {
  const reject = (path: string, message: string): never => {
    throw new OperationError("hook_rejected", path, message);
  };
  if (
    !isExactRecord(value, ["hook_executions"]) ||
    !Array.isArray((value as Record<string, unknown>).hook_executions)
  ) {
    reject("/", "hook coordinator result has missing or unknown fields");
  }
  const executions = (value as Record<string, unknown>)
    .hook_executions as unknown[];
  if (executions.length !== hookInput.hook_declarations.length) {
    reject(
      "/hook_executions",
      "hook execution count does not match pinned declarations",
    );
  }
  const outputFields = [
    "added_operations",
    "patch_outputs",
    "read_dependencies",
    "warnings",
    "approval_requirements",
    "required_capabilities",
    "effects",
    "planned_events",
    "planned_deliveries",
  ];
  const flattened: Record<string, unknown[]> = Object.fromEntries(
    outputFields.map((field) => [field, []]),
  );
  const working: Record<string, Record<string, unknown>> = structuredClone(
    hookInput.proposed_states,
  );
  const executionIds = new Set<string>();
  for (let index = 0; index < executions.length; index++) {
    const execution = isRecord(executions[index])
      ? executions[index] as Record<string, unknown>
      : {};
    const declaration = hookInput.hook_declarations[index];
    if (
      !isExactRecord(execution, [
        "id",
        "attachment_id",
        "hook_revision_id",
        "pack_revision_id",
        "phase",
        "input_digest",
        "output_digest",
        "output",
        "script_digest",
        "security_digest",
        "stderr",
        "logs_truncated",
        "secrets_redacted",
        "duration_ms",
        "authority_snapshot",
        "grant_snapshot",
      ]) || !isUuidV7(execution.id) || executionIds.has(String(execution.id)) ||
      execution.attachment_id !== declaration.attachment_id ||
      execution.hook_revision_id !== declaration.hook_revision_id ||
      execution.pack_revision_id !== declaration.pack_revision_id ||
      execution.phase !== declaration.phase ||
      execution.script_digest !== declaration.script_digest ||
      execution.security_digest !== declaration.security_digest ||
      typeof execution.stderr !== "string" ||
      new TextEncoder().encode(execution.stderr).byteLength >
        4 * 1024 * 1024 + 64 ||
      typeof execution.logs_truncated !== "boolean" ||
      typeof execution.secrets_redacted !== "boolean" ||
      !Number.isSafeInteger(execution.duration_ms) ||
      Number(execution.duration_ms) < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.input_digest)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.output_digest)) ||
      !isExactRecord(execution.output, outputFields) ||
      !outputFields.every((field) =>
        Array.isArray((execution.output as Record<string, unknown>)[field])
      ) ||
      !isExactRecord(execution.authority_snapshot, [
        "principal_id",
        "auth_context_id",
        "assignment_digest",
        "policy_digest",
      ]) ||
      await canonicalSha256(execution.authority_snapshot) !==
        await canonicalSha256(hookInput.authority_snapshot) ||
      !isExactRecord(execution.grant_snapshot, ["grants"]) ||
      !Array.isArray(
        (execution.grant_snapshot as Record<string, unknown>).grants,
      )
    ) {
      reject(
        `/hook_executions/${index}`,
        "hook execution evidence is malformed",
      );
    }
    executionIds.add(String(execution.id));
    const grants = (execution.grant_snapshot as { grants: unknown[] }).grants;
    if (grants.length !== declaration.secret_slots.length) {
      reject(
        `/hook_executions/${index}/grant_snapshot`,
        "hook grant evidence is incomplete",
      );
    }
    for (let grantIndex = 0; grantIndex < grants.length; grantIndex++) {
      const grant = isRecord(grants[grantIndex])
        ? grants[grantIndex] as Record<string, unknown>
        : {};
      const slot = declaration.secret_slots[grantIndex];
      if (
        !isExactRecord(grant, [
          "grant_id",
          "secret_id",
          "value_version",
          "slot",
          "env",
        ]) ||
        !isUuidV7(grant.grant_id) || !isUuidV7(grant.secret_id) ||
        !Number.isSafeInteger(grant.value_version) ||
        Number(grant.value_version) < 1 ||
        grant.slot !== slot.slot || grant.env !== slot.env
      ) {
        reject(
          `/hook_executions/${index}/grant_snapshot/grants/${grantIndex}`,
          "hook grant evidence is malformed",
        );
      }
    }
    const envelope = buildHookEnvelope(declaration, hookInput, working);
    if (
      execution.input_digest !== `sha256:${await canonicalSha256(envelope)}`
    ) {
      reject(
        `/hook_executions/${index}/input_digest`,
        "hook input digest does not match curated input",
      );
    }
    if (
      execution.output_digest !==
        `sha256:${await canonicalSha256(execution.output)}`
    ) {
      reject(
        `/hook_executions/${index}/output_digest`,
        "hook output digest does not match canonical output",
      );
    }
    const output = execution.output as Record<string, unknown>;
    for (const field of outputFields) {
      flattened[field].push(...output[field] as unknown[]);
    }
    if (declaration.phase === "changeset.before_stage") {
      for (const rawBatch of output.patch_outputs as unknown[]) {
        const batchValue = isRecord(rawBatch)
          ? rawBatch as Record<string, unknown>
          : {};
        if (
          batchValue.operation_key !== declaration.operation_key ||
          !isRecord(batchValue.output) ||
          !Array.isArray(batchValue.output.patches)
        ) {
          reject(
            `/hook_executions/${index}/output/patch_outputs`,
            "hook patch output does not match its operation",
          );
        }
        const batchOutput = batchValue.output as Record<string, unknown>;
        const before = working[declaration.operation_key!] ?? {};
        const paths = (batchOutput.patches as Array<{ path: string }>)
          .map((patch) =>
            patch.path.slice(1).split("/")[0].replaceAll("~1", "/").replaceAll(
              "~0",
              "~",
            )
          );
        working[declaration.operation_key!] = applyPatches(
          before,
          batchOutput.patches as never[],
          new Set([...Object.keys(before), ...paths]),
        );
      }
    }
  }
  return {
    hook_executions: executions as StageHookResult["hook_executions"],
    added_operations: flattened
      .added_operations as StageHookResult["added_operations"],
    patch_outputs: flattened.patch_outputs as StageHookResult["patch_outputs"],
    read_dependencies: flattened
      .read_dependencies as StageHookResult["read_dependencies"],
    warnings: flattened.warnings as StageHookResult["warnings"],
    approval_requirements: flattened
      .approval_requirements as StageHookResult["approval_requirements"],
    required_capabilities: flattened.required_capabilities as string[],
    effects: flattened.effects as string[],
    planned_events: flattened
      .planned_events as StageHookResult["planned_events"],
    planned_deliveries: flattened
      .planned_deliveries as StageHookResult["planned_deliveries"],
  };
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function validationResult(error: unknown): Result<never> {
  if (error instanceof ContractValidationError) {
    return err({
      code: "validation_failed",
      message: "request does not satisfy its contract",
      severity: "validation",
      details: { issues: error.issues },
    });
  }
  if (error instanceof StageHookError) {
    return err({
      code: error.code,
      message: error.message,
      severity: error.code === "hook_secret_unavailable"
        ? "unavailable"
        : "validation",
      details: error.details,
    });
  }
  if (error instanceof PatchError) {
    return err({
      code: "hook_rejected",
      message: error.message,
      severity: "validation",
      details: {
        issues: [{
          path: error.path,
          code: error.code,
          message: error.message,
        }],
      },
    });
  }
  if (error instanceof OperationError) {
    return err({
      code: error.code,
      message: error.message,
      severity:
        error.code === "operation_conflict" || error.code === "project_conflict"
          ? "conflict"
          : "validation",
      details: {
        issues: [{
          path: error.path,
          code: error.code,
          message: error.message,
        }],
      },
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
