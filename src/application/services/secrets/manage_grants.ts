import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type { HookSecretGrantRepository } from "../../ports/repair/repositories.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  err,
  type ErrorSeverity,
  ok,
  type Result,
} from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type GrantMetadata = Readonly<Record<string, unknown>>;

/** Atomic grant persistence and in-transaction authority revalidation primitives. */
export interface HookSecretGrantPersistence extends
  Pick<
    HookSecretGrantRepository<GrantMetadata, never, never, never, never>,
    "list"
  > {
  create(
    input: Readonly<{
      id: string;
      auth: AuthContext;
      hookRevisionId: string;
      expectedSecurityDigest: string;
      slot: string;
      secretId: string;
    }>,
  ): Promise<GrantMetadata>;
  replace(
    input: Readonly<{
      id: string;
      expectedGrantId: string;
      auth: AuthContext;
      secretId: string;
    }>,
  ): Promise<GrantMetadata>;
  revoke(
    input: Readonly<{
      grantId: string;
      auth: AuthContext;
      reason: string | null;
    }>,
  ): Promise<GrantMetadata>;
}

export function makeHookSecretGrantService(deps: {
  persistence: HookSecretGrantPersistence;
  authorization: AuthorizationRepository;
}) {
  async function authorize(auth: AuthContext): Promise<Result<unknown> | null> {
    for (const action of ["secret.grant", "hook.secret.configure"]) {
      const result = await deps.authorization.authorize({
        auth,
        boundary: { type: "system" },
        action,
        resource: "system:hook-secret-grant",
      });
      if (!result.ok) return result;
    }
    return null;
  }

  return Object.freeze({
    async list(input: { auth: AuthContext }): Promise<Result<unknown>> {
      const denied = await authorize(input.auth);
      if (denied) return denied;
      return ok({ grants: await deps.persistence.list() });
    },

    async create(input: {
      auth: AuthContext;
      hook_revision_id?: unknown;
      expected_security_digest?: unknown;
      slot?: unknown;
      secret_id?: unknown;
    }): Promise<Result<unknown>> {
      const fields = [
        input.hook_revision_id,
        input.expected_security_digest,
        input.slot,
        input.secret_id,
      ];
      if (!fields.every((value) => typeof value === "string")) return invalid();
      const denied = await authorize(input.auth);
      if (denied) return denied;
      try {
        return ok(
          await deps.persistence.create({
            id: uuidV7(),
            auth: input.auth,
            hookRevisionId: input.hook_revision_id as string,
            expectedSecurityDigest: input.expected_security_digest as string,
            slot: input.slot as string,
            secretId: input.secret_id as string,
          }),
        );
      } catch (error) {
        return grantError(error);
      }
    },

    async replace(
      grantId: string,
      input: {
        auth: AuthContext;
        expected_current_grant_id?: unknown;
        secret_id?: unknown;
      },
    ): Promise<Result<unknown>> {
      if (
        input.expected_current_grant_id !== grantId ||
        typeof input.secret_id !== "string"
      ) return invalid();
      const denied = await authorize(input.auth);
      if (denied) return denied;
      try {
        return ok(
          await deps.persistence.replace({
            id: uuidV7(),
            expectedGrantId: grantId,
            auth: input.auth,
            secretId: input.secret_id,
          }),
        );
      } catch (error) {
        return grantError(error);
      }
    },

    async revoke(
      grantId: string,
      input: { auth: AuthContext; reason?: unknown },
    ): Promise<Result<unknown>> {
      if (
        input.reason !== undefined &&
        (typeof input.reason !== "string" || input.reason.length < 1 ||
          input.reason.length > 1000)
      ) return invalid();
      const denied = await authorize(input.auth);
      if (denied) return denied;
      try {
        return ok(
          await deps.persistence.revoke({
            grantId,
            auth: input.auth,
            reason: input.reason as string | undefined ?? null,
          }),
        );
      } catch (error) {
        return grantError(error);
      }
    },
  });
}

export class HookSecretGrantPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly severity: ErrorSeverity,
  ) {
    super(message);
  }
}

function invalid(): ReturnType<typeof err> {
  return err({
    code: "hook_grant_invalid",
    message: "hook grant request is invalid",
    severity: "validation",
    details: {},
  });
}
function grantError(error: unknown): ReturnType<typeof err> {
  if (error instanceof HookSecretGrantPersistenceError) {
    return err({
      code: error.code,
      message: error.message,
      severity: error.severity,
      details: {},
    });
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "23505") {
    return err({
      code: "hook_grant_conflict",
      message: "an effective grant already exists",
      severity: "conflict",
      details: {},
    });
  }
  return err({
    code: "hook_grant_failed",
    message: "hook grant operation failed",
    severity: "internal",
    details: {},
  });
}
