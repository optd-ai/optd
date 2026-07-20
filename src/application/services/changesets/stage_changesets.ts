import type {
  StageDto,
  StageRepository,
} from "../../ports/stage_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  canonicalizeResolvedOperations,
  normalizeOperations,
  OperationError,
} from "../../../domain/changesets/operations.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { StageHookCoordinator } from "../../../domain/changesets/stage.ts";
import {
  applyPatches,
  compilePatchedMutation,
  PatchError,
} from "../../../domain/changesets/patch.ts";
import { patchOutputContract } from "../../../schemas/changesets/patch.ts";
import { ContractValidationError } from "../../../schemas/api/contracts.ts";
import {
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
        let hookProposedStates: Readonly<
          Record<string, Record<string, unknown>>
        > = {};
        let hookBaseStates: Readonly<
          Record<string, Record<string, unknown> | null>
        > = {};
        let hookWorkingStates: Record<string, Record<string, unknown>> = {};
        if (hookCoordinator) {
          const pinned = repository.hookInput
            ? await repository.hookInput(normalized.operations, auth)
            : {
              ok: true as const,
              value: {
                operations: normalized.operations,
                projects: [],
                pack_revisions: [],
              },
            };
          if (!pinned.ok) return pinned;
          const matching = pinned.value.pack_revisions.some((revision) => {
            const value = isRecord(revision)
              ? revision.matching_hooks
              : undefined;
            return Array.isArray(value) && value.length > 0;
          });
          if (matching) {
            hookProposedStates = pinned.value.proposed_states ?? {};
            hookBaseStates = pinned.value.base_states ?? {};
            hookWorkingStates = structuredClone(
              pinned.value.proposed_states ?? {},
            );
            hookResult = await hookCoordinator.coordinate(pinned.value);
            validateHookResult(hookResult);
            if (!hookResult.hook_executions.length) {
              throw new OperationError(
                "hook_rejected",
                "/hook_executions",
                "matching hooks require execution evidence",
              );
            }
          }
        }
        const operations = structuredClone(
          hookResult?.operations ?? normalized.operations,
        );
        for (const batch of hookResult?.patch_outputs ?? []) {
          if (!patchOutputContract.check(batch.output)) {
            throw new ContractValidationError(
              patchOutputContract.issues(batch.output),
            );
          }
          hookResult!.warnings = [
            ...hookResult!.warnings,
            ...(batch.output.warnings ?? []),
          ];
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
          const before = hookWorkingStates[batch.operation_key] ??
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
          ...(hookResult ? { hookResult } : {}),
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

function validateHookResult(value: unknown): void {
  if (!isRecord(value)) {
    throw new OperationError(
      "hook_rejected",
      "/",
      "hook coordinator returned a non-object result",
    );
  }
  for (
    const field of [
      "operations",
      "dependencies",
      "hook_executions",
      "warnings",
      "approval_requirements",
      "required_capabilities",
      "effects",
      "planned_events",
      "planned_deliveries",
    ]
  ) {
    if (!Array.isArray(value[field])) {
      throw new OperationError(
        "hook_rejected",
        `/${field}`,
        "hook coordinator result is incomplete",
      );
    }
  }
  for (const executionValue of value.hook_executions as unknown[]) {
    const execution = isRecord(executionValue) ? executionValue : {};
    if (
      !["changeset.before_stage", "changeset.validate"].includes(
        String(execution.phase),
      ) ||
      !isUuidV7(execution.pack_revision_id) ||
      !isUuidV7(execution.hook_revision_id) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.input_digest)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.output_digest))
    ) {
      throw new OperationError(
        "hook_rejected",
        "/hook_executions",
        "hook execution evidence is malformed",
      );
    }
  }
  for (const requirementValue of value.approval_requirements as unknown[]) {
    if (!isRecord(requirementValue) || !isUuidV7(requirementValue.id)) {
      throw new OperationError(
        "hook_rejected",
        "/approval_requirements",
        "approval requirement identity is malformed",
      );
    }
  }
  for (const field of ["planned_events", "planned_deliveries"]) {
    if (
      (value[field] as unknown[]).some((item) =>
        !isRecord(item) || typeof item.id !== "string" || item.id.length === 0
      )
    ) {
      throw new OperationError(
        "hook_rejected",
        `/${field}`,
        "planned identity is malformed",
      );
    }
  }
  for (const field of ["required_capabilities", "effects"]) {
    if ((value[field] as unknown[]).some((item) => typeof item !== "string")) {
      throw new OperationError(
        "hook_rejected",
        `/${field}`,
        "hook coordinator vocabulary must contain strings",
      );
    }
  }
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
