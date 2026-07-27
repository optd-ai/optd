import type { CommitRepository } from "../../ports/commit_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  type CommitChangesetDto,
  DEFAULT_COMMIT_LOCK_TIMEOUT_MS,
} from "../../../domain/changesets/commit.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

export function makeCommitChangesetService(
  repository: CommitRepository,
  config: Readonly<{
    lockTimeout?: string;
    maximumLockTimeout?: string;
  }> = {},
) {
  const configured = durationMs(config.lockTimeout ?? "10s") ??
    DEFAULT_COMMIT_LOCK_TIMEOUT_MS;
  const safetyMaximum = config.maximumLockTimeout
    ? durationMs(config.maximumLockTimeout)
    : null;
  return {
    async commit(
      stageId: string,
      input: unknown,
      auth: AuthContext,
    ): Promise<Result<CommitChangesetDto>> {
      if (!isUuidV7(stageId)) return err(notFound());
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== "lock_timeout")
      ) {
        return err(invalid());
      }
      const timeout = input.lock_timeout === undefined
        ? configured
        : typeof input.lock_timeout === "string"
        ? durationMs(input.lock_timeout)
        : null;
      if (
        timeout === null ||
        (safetyMaximum !== null && timeout > safetyMaximum)
      ) return err(invalid());
      return await repository.commit(stageId, auth, { lockTimeoutMs: timeout });
    },
  };
}

function durationMs(value: string): number | null {
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match) return null;
  const multiplier = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000;
  const result = Number(match[1]) * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid() {
  return {
    code: "validation_failed",
    message: "commit request is invalid",
    severity: "validation" as const,
    details: {
      issues: [{
        path: "/",
        code: "invalid",
        message: "expected only an optional positive lock_timeout duration",
      }],
    },
  };
}
function notFound() {
  return {
    code: "not_found",
    message: "changeset was not found",
    severity: "not_found" as const,
    details: {},
  };
}
