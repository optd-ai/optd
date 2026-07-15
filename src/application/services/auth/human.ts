import type { AuthRepository } from "../../ports/authentication.ts";
import type {
  AuthContext,
  PasswordPolicy,
} from "../../../domain/auth/model.ts";
import {
  normalizeUsername,
  validateDisplayName,
  validatePassword,
} from "../../../domain/auth/validation.ts";

export function loadPasswordPolicy(
  env: Deno.Env = Deno.env,
  warn: (message: string) => void = (message) => console.warn(message),
): PasswordPolicy {
  const integer = env.get("OPERANT_PASSWORD_MIN_LENGTH") ?? "8";
  const minimumLength = Number(integer);
  if (!Number.isInteger(minimumLength) || minimumLength < 1) {
    throw new Error("OPERANT_PASSWORD_MIN_LENGTH must be a positive integer");
  }
  if (minimumLength < 8) {
    warn(
      `warning: OPERANT_PASSWORD_MIN_LENGTH=${minimumLength} is below the default minimum of 8`,
    );
  }
  const flag = (name: string) => {
    const value = env.get(name) ?? "false";
    if (value !== "true" && value !== "false") {
      throw new Error(`${name} must be true or false`);
    }
    return value === "true";
  };
  return {
    minimumLength,
    maximumBytes: 1024,
    requireUppercase: flag("OPERANT_PASSWORD_REQUIRE_UPPERCASE"),
    requireLowercase: flag("OPERANT_PASSWORD_REQUIRE_LOWERCASE"),
    requireDigit: flag("OPERANT_PASSWORD_REQUIRE_DIGIT"),
    requireSymbol: flag("OPERANT_PASSWORD_REQUIRE_SYMBOL"),
  };
}

export function makeHumanAuthService(
  repository: AuthRepository,
  policy: PasswordPolicy,
) {
  const password = (value: unknown) => validatePassword(value, policy);
  return {
    policy: () => ({ ok: true as const, value: policy }),
    login: async (
      input: {
        username: unknown;
        password: unknown;
        existingRequestSessionId?: unknown;
      },
    ) => {
      const username = normalizeUsername(input.username);
      if (!username.ok) return { ok: false as const, error: username.error };
      if (typeof input.password !== "string") {
        const invalid = validatePassword(input.password, policy);
        return {
          ok: false as const,
          error: invalid.ok
            ? {
              code: "password_policy_failed",
              message: "password is required",
              severity: "validation" as const,
            }
            : invalid.error,
        };
      }
      const existingRequestSessionId =
        typeof input.existingRequestSessionId === "string" &&
          /^[0-9a-f-]{36}$/.test(input.existingRequestSessionId)
          ? input.existingRequestSessionId
          : undefined;
      return await repository.login(
        username.value,
        input.password.normalize("NFC"),
        existingRequestSessionId,
      );
    },
    current: (auth: AuthContext) => repository.current(auth),
    sessions: (auth: AuthContext) => repository.sessions(auth),
    logout: (auth: AuthContext) => repository.logout(auth),
    logoutAll: async (auth: AuthContext, supplied: unknown) => {
      if (typeof supplied !== "string") {
        const invalid = password(supplied);
        return {
          ok: false as const,
          error: invalid.ok
            ? {
              code: "password_policy_failed",
              message: "password is required",
              severity: "validation" as const,
            }
            : invalid.error,
        };
      }
      return await repository.logoutAll(auth, supplied.normalize("NFC"));
    },
    changePassword: async (
      auth: AuthContext,
      current: unknown,
      replacement: unknown,
    ) => {
      if (typeof current !== "string") {
        return {
          ok: false as const,
          error: {
            code: "password_confirmation_required",
            message: "current password is required",
            severity: "validation" as const,
            details: {},
          },
        };
      }
      const valid = password(replacement);
      if (!valid.ok) return { ok: false as const, error: valid.error };
      return await repository.changePassword(
        auth,
        current.normalize("NFC"),
        valid.value,
      );
    },
    users: (auth: AuthContext) => repository.listUsers(auth),
    createUser: async (
      auth: AuthContext,
      input: { username: unknown; displayName: unknown; password: unknown },
    ) => {
      const username = normalizeUsername(input.username);
      if (!username.ok) return { ok: false as const, error: username.error };
      const displayName = validateDisplayName(input.displayName);
      if (!displayName.ok) {
        return { ok: false as const, error: displayName.error };
      }
      const validPassword = password(input.password);
      if (!validPassword.ok) {
        return { ok: false as const, error: validPassword.error };
      }
      return await repository.createUser(auth, {
        username: username.value,
        displayName: displayName.value,
        password: validPassword.value,
      });
    },
    setUserStatus: (
      auth: AuthContext,
      id: string,
      status: "active" | "disabled",
    ) => repository.setUserStatus(auth, id, status),
    requestReset: async (
      input: { username: unknown; nonceHash: unknown; idempotencyKey: unknown },
    ) => {
      const username = normalizeUsername(input.username);
      if (!username.ok) return { ok: false as const, error: username.error };
      if (
        typeof input.nonceHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.nonceHash) ||
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length < 16
      ) {
        return {
          ok: false as const,
          error: {
            code: "validation_failed",
            message: "password reset request is invalid",
            severity: "validation" as const,
            details: {},
          },
        };
      }
      return await repository.createPasswordReset({
        username: username.value,
        nonceHash: input.nonceHash,
        idempotencyKey: input.idempotencyKey,
      });
    },
    createResetWatchTicket: (id: string, nonce: string) =>
      repository.createPasswordResetWatchTicket(id, nonce),
    consumeResetWatchTicket: (id: string, ticket: string) =>
      repository.consumePasswordResetWatchTicket(id, ticket),
    resetStatus: (id: string) => repository.passwordResetStatus(id),
    subscribeReset: (id: string, listener: () => void) =>
      repository.subscribePasswordReset(id, listener),
    inspectReset: (auth: AuthContext, id: string) =>
      repository.inspectPasswordReset(auth, id),
    decideReset: (
      auth: AuthContext,
      id: string,
      decision: "approved" | "denied",
    ) => repository.decidePasswordReset(auth, id, decision),
    cancelReset: (id: string, nonce: string) =>
      repository.cancelPasswordReset(id, nonce),
    redeemReset: (id: string, nonce: string) =>
      repository.redeemPasswordReset(id, nonce),
    completeReset: async (id: string, capability: string, value: unknown) => {
      const valid = password(value);
      if (!valid.ok) return { ok: false as const, error: valid.error };
      return await repository.completePasswordReset(
        id,
        capability,
        valid.value,
      );
    },
    completeRecovery: async (
      input: { username: unknown; token: string; password: unknown },
    ) => {
      const username = normalizeUsername(input.username);
      if (!username.ok) return { ok: false as const, error: username.error };
      const valid = password(input.password);
      if (!valid.ok) return { ok: false as const, error: valid.error };
      return await repository.completeRecovery({
        username: username.value,
        token: input.token,
        password: valid.value,
      });
    },
  };
}
