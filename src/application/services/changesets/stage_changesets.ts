import type {
  StageDto,
  StageRepository,
} from "../../ports/stage_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  normalizeOperations,
  OperationError,
} from "../../../domain/changesets/operations.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { ContractValidationError } from "../../../schemas/api/contracts.ts";
import {
  type StageRequest,
  stageRequestContract,
} from "../../../schemas/changesets/operations.ts";

export function makeStageChangesetService(repository: StageRepository) {
  return {
    async stage(input: unknown, auth: AuthContext): Promise<Result<StageDto>> {
      try {
        if (!stageRequestContract.check(input)) {
          throw new ContractValidationError(stageRequestContract.issues(input));
        }
        const normalized = await normalizeOperations(input as StageRequest);
        return await repository.create({
          operations: normalized.operations,
          operationGraphDigest: normalized.operationGraphDigest,
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

function validationResult(error: unknown): Result<never> {
  if (error instanceof ContractValidationError) {
    return err({
      code: "validation_failed",
      message: "request does not satisfy its contract",
      severity: "validation",
      details: { issues: error.issues },
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
