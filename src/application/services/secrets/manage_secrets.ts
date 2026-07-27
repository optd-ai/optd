import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type {
  SecretCipher,
  SecretCiphertext,
  SecretRepository,
} from "../../ports/repair/repositories.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type SecretMetadata = Readonly<Record<string, unknown>>;
export type LockedSecretValue = Readonly<{
  id: string;
  name: string;
  valueVersion: number;
  encrypted: SecretCiphertext;
}>;

/** Atomic persistence primitives. Public validation, authorization and crypto stay in application. */
export interface SecretLifecyclePersistence extends
  Pick<
    SecretRepository<SecretMetadata, LockedSecretValue, never>,
    "list"
  > {
  create(
    input: Readonly<{
      id: string;
      name: string;
      description: string | null;
      encrypted: SecretCiphertext;
      authContextId: string;
      actorId: string;
    }>,
  ): Promise<SecretMetadata>;
  rotate(
    input: Readonly<{
      id: string;
      authContextId: string;
      actorId: string;
      encrypt: (current: LockedSecretValue) => Promise<SecretCiphertext>;
    }>,
  ): Promise<SecretMetadata | null>;
  disable(
    input: Readonly<{
      id: string;
      authContextId: string;
      actorId: string;
    }>,
  ): Promise<SecretMetadata | null>;
  resolveActive(id: string): Promise<LockedSecretValue | null>;
}

export function makeSecretsService(deps: {
  persistence: SecretLifecyclePersistence;
  authorization: AuthorizationRepository;
  cipher: SecretCipher;
}) {
  async function authorize(
    auth: AuthContext,
    action: string,
  ): Promise<Result<unknown> | null> {
    const decision = await deps.authorization.authorize({
      auth,
      boundary: { type: "system" },
      action,
      resource: "system:secret",
    });
    return decision.ok ? null : decision;
  }

  return Object.freeze({
    async list(input: { auth: AuthContext }): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.list");
      if (denied) return denied;
      return ok({ secrets: await deps.persistence.list() });
    },

    async create(input: {
      auth: AuthContext;
      name?: unknown;
      description?: unknown;
      value?: unknown;
    }): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.create");
      if (denied) return denied;
      const valid = validateMutation(input);
      if (!valid.ok) return valid;
      try {
        const id = uuidV7();
        const encrypted = await deps.cipher.encrypt(valid.value.value, {
          rowId: id,
          version: 1,
        });
        return ok(
          await deps.persistence.create({
            id,
            name: valid.value.name,
            description: valid.value.description,
            encrypted,
            authContextId: input.auth.id,
            actorId: input.auth.principalId,
          }),
        );
      } catch (error) {
        return secretError(error, "secret_create_failed");
      }
    },

    async rotate(
      id: string,
      input: { auth: AuthContext; value?: unknown },
    ): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.rotate");
      if (denied) return denied;
      const value = validateValue(input.value);
      if (!value.ok) return value;
      try {
        const metadata = await deps.persistence.rotate({
          id,
          authContextId: input.auth.id,
          actorId: input.auth.principalId,
          encrypt: (current) =>
            deps.cipher.encrypt(value.value, {
              rowId: current.id,
              version: current.valueVersion + 1,
            }),
        });
        return metadata ? ok(metadata) : notFound();
      } catch (error) {
        return secretError(error, "secret_rotate_failed");
      }
    },

    async disable(
      id: string,
      input: { auth: AuthContext },
    ): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.disable");
      if (denied) return denied;
      try {
        const metadata = await deps.persistence.disable({
          id,
          authContextId: input.auth.id,
          actorId: input.auth.principalId,
        });
        return metadata ? ok(metadata) : notFound();
      } catch (error) {
        return secretError(error, "secret_disable_failed");
      }
    },

    async resolve(
      id: string,
    ): Promise<{ value: string; valueVersion: number }> {
      const current = await deps.persistence.resolveActive(id);
      if (!current) throw new Error("hook secret unavailable");
      return {
        value: await deps.cipher.decrypt(current.encrypted, {
          rowId: current.id,
          version: current.valueVersion,
        }),
        valueVersion: current.valueVersion,
      };
    },
  });
}

function validateMutation(input: {
  name?: unknown;
  description?: unknown;
  value?: unknown;
}): Result<{ name: string; description: string | null; value: string }> {
  if (
    typeof input.name !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.name)
  ) return invalid("secret name is invalid");
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 1000)
  ) return invalid("secret description is invalid");
  const value = validateValue(input.value);
  return value.ok
    ? ok({
      name: input.name,
      description: input.description as string | undefined ?? null,
      value: value.value,
    })
    : value;
}

function validateValue(value: unknown): Result<string> {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    new TextEncoder().encode(value).length > 1024 * 1024
  ) return invalid("secret value must be non-empty UTF-8 without NUL");
  return ok(value);
}

function invalid(message: string): ReturnType<typeof err> {
  return err({
    code: "secret_invalid",
    message,
    severity: "validation",
    details: {},
  });
}
function notFound(): ReturnType<typeof err> {
  return err({
    code: "secret_not_found",
    message: "secret not found",
    severity: "not_found",
    details: {},
  });
}
function secretError(error: unknown, fallback: string): ReturnType<typeof err> {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : fallback;
  if (code === "secret_key_unavailable") {
    return err({
      code,
      message: error instanceof Error
        ? error.message
        : "secret encryption key is unavailable",
      severity: "unavailable",
      details: {},
    });
  }
  if (
    code === "secret_master_key_invalid" || code === "secret_key_mismatch" ||
    code === "secret_decrypt_failed"
  ) {
    return err({
      code,
      message: "secret cryptographic operation failed",
      severity: "internal",
      details: {},
    });
  }
  if (code === "23505") {
    return err({
      code: "secret_name_conflict",
      message: "secret name already exists",
      severity: "conflict",
      details: {},
    });
  }
  return err({
    code: fallback,
    message: "secret operation failed",
    severity: "internal",
    details: {},
  });
}
