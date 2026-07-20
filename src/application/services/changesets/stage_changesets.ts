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
  StageHookResult,
} from "../../../domain/changesets/stage.ts";
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
        if (hookCoordinator) {
          const pinned = repository.hookInput
            ? await repository.hookInput(normalized.operations, auth)
            : {
              ok: true as const,
              value: {
                operations: normalized.operations,
                projects: [],
                pack_revisions: [],
                hook_declarations: [],
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
            hookResult = await hookCoordinator.coordinate(pinned.value);
            await validateHookResult(
              hookResult,
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
  hookInput: Readonly<{
    operations: readonly Record<string, unknown>[];
    projects: readonly unknown[];
    pack_revisions: readonly unknown[];
    hook_declarations: readonly StageHookDeclaration[];
    proposed_states: Readonly<Record<string, Record<string, unknown>>>;
    base_states: Readonly<Record<string, Record<string, unknown> | null>>;
  }>,
): Promise<void> {
  const reject = (path: string, message: string): never => {
    throw new OperationError("hook_rejected", path, message);
  };
  if (!isRecord(value)) {
    reject("/", "hook coordinator returned a non-object result");
  }
  const result = value as Record<string, unknown>;
  const expectedKeys = [
    "added_operations",
    "patch_outputs",
    "read_dependencies",
    "hook_executions",
    "warnings",
    "approval_requirements",
    "required_capabilities",
    "effects",
    "planned_events",
    "planned_deliveries",
  ].sort();
  if (Object.keys(result).sort().join("\0") !== expectedKeys.join("\0")) {
    reject("/", "hook coordinator result has missing or unknown fields");
  }
  for (const field of expectedKeys) {
    if (!Array.isArray(result[field])) {
      reject(`/${field}`, "hook coordinator field must be an array");
    }
  }
  for (const [index, batch] of (result.patch_outputs as unknown[]).entries()) {
    if (
      !isExactRecord(batch, ["operation_key", "output"]) ||
      typeof batch.operation_key !== "string" ||
      !patchOutputContract.check(batch.output)
    ) {
      reject(`/patch_outputs/${index}`, "patch output is malformed");
    }
  }
  const declarations = hookInput.hook_declarations;
  const executions = result.hook_executions as unknown[];
  if (executions.length !== declarations.length) {
    reject(
      "/hook_executions",
      "hook execution count does not match pinned declarations",
    );
  }
  const executionIds = new Set<string>();
  for (let index = 0; index < executions.length; index++) {
    const execution = isRecord(executions[index])
      ? executions[index] as Record<string, unknown>
      : {};
    const declaration = declarations[index];
    const keys = [
      "id",
      "attachment_id",
      "hook_revision_id",
      "pack_revision_id",
      "phase",
      "input_digest",
      "output_digest",
      "output",
      "stderr",
      "duration_ms",
      "grant_snapshot",
    ];
    if (
      !isExactRecord(execution, keys) || !isUuidV7(execution.id) ||
      !isUuidV7(execution.attachment_id) ||
      !isUuidV7(execution.hook_revision_id) ||
      !isUuidV7(execution.pack_revision_id) || !isRecord(execution.output) ||
      !isRecord(execution.grant_snapshot) ||
      typeof execution.stderr !== "string" ||
      !Number.isSafeInteger(execution.duration_ms) ||
      Number(execution.duration_ms) < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.input_digest)) ||
      !/^sha256:[0-9a-f]{64}$/.test(String(execution.output_digest))
    ) {
      reject(
        `/hook_executions/${index}`,
        "hook execution evidence is malformed",
      );
    }
    const executionId = String(execution.id);
    if (executionIds.has(executionId)) {
      reject(`/hook_executions/${index}/id`, "duplicate hook execution id");
    }
    executionIds.add(executionId);
    if (
      execution.attachment_id !== declaration.attachment_id ||
      execution.hook_revision_id !== declaration.hook_revision_id ||
      execution.pack_revision_id !== declaration.pack_revision_id ||
      execution.phase !== declaration.phase
    ) {
      reject(
        `/hook_executions/${index}`,
        "hook execution does not match pinned ordered declaration",
      );
    }
    const expectedInputDigest = `sha256:${await canonicalSha256({
      schema: "changeset.hook-input.v1",
      declaration,
      operations: hookInput.operations,
      projects: hookInput.projects,
      pack_revisions: hookInput.pack_revisions,
      proposed_states: hookInput.proposed_states,
      base_states: hookInput.base_states,
    })}`;
    if (execution.input_digest !== expectedInputDigest) {
      reject(
        `/hook_executions/${index}/input_digest`,
        "hook input digest does not match pinned input",
      );
    }
    const outputDigest = `sha256:${await canonicalSha256(execution.output)}`;
    if (execution.output_digest !== outputDigest) {
      reject(
        `/hook_executions/${index}/output_digest`,
        "hook output digest does not match canonical output",
      );
    }
  }
  for (const [index, warning] of (result.warnings as unknown[]).entries()) {
    if (
      !isRecord(warning) || Object.keys(warning).some((key) =>
        !["path", "code", "message", "details"].includes(key)
      ) ||
      typeof warning.path !== "string" || typeof warning.code !== "string" ||
      typeof warning.message !== "string" || warning.code.length === 0 ||
      warning.message.length === 0 ||
      (warning.details !== undefined && !isRecord(warning.details))
    ) {
      reject(`/warnings/${index}`, "warning is malformed");
    }
  }
  for (
    const [index, dependency] of (result.read_dependencies as unknown[])
      .entries()
  ) {
    if (
      !isRecord(dependency) || Object.keys(dependency).some((key) =>
        !["kind", "project_id", "object_id", "expected_version_id", "digest"]
          .includes(key)
      ) ||
      !["object_version", "relationship", "policy", "assignment", "uniqueness"]
        .includes(String(dependency.kind)) ||
      (dependency.project_id !== undefined &&
        !isUuidV7(dependency.project_id)) ||
      (dependency.object_id !== undefined && !isUuidV7(dependency.object_id)) ||
      (dependency.expected_version_id !== undefined &&
        !isUuidV7(dependency.expected_version_id)) ||
      (dependency.digest !== undefined &&
        !/^sha256:[0-9a-f]{64}$/.test(String(dependency.digest)))
    ) {
      reject(`/read_dependencies/${index}`, "read dependency is malformed");
    }
  }
  for (
    const [index, requirementValue]
      of (result.approval_requirements as unknown[])
        .entries()
  ) {
    const requirement = isRecord(requirementValue) ? requirementValue : {};
    if (
      !isExactRecord(
        requirement,
        requirement.project_id === undefined
          ? ["id", "capability"]
          : ["id", "capability", "project_id"],
      ) ||
      !isUuidV7(requirement.id) || typeof requirement.capability !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,255}$/.test(requirement.capability) ||
      (requirement.project_id !== undefined &&
        !isUuidV7(requirement.project_id))
    ) {
      reject(
        `/approval_requirements/${index}`,
        "approval requirement is malformed",
      );
    }
  }
  for (const field of ["planned_events", "planned_deliveries"]) {
    for (const [index, item] of (result[field] as unknown[]).entries()) {
      if (
        !isRecord(item) || Object.keys(item).some((key) =>
          !["id", "kind"].includes(key)
        ) ||
        typeof item.id !== "string" || item.id.length === 0 ||
        item.id.length > 512 ||
        (item.kind !== undefined && typeof item.kind !== "string")
      ) {
        reject(`/${field}/${index}`, "planned identity is malformed");
      }
    }
  }
  for (const field of ["required_capabilities", "effects"]) {
    if (
      (result[field] as unknown[]).some((item) =>
        typeof item !== "string" || !/^[a-z][a-z0-9_.:-]{0,255}$/.test(item)
      )
    ) reject(`/${field}`, "hook vocabulary is malformed");
  }
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join("\0") ===
      [...keys].sort().join("\0");
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
