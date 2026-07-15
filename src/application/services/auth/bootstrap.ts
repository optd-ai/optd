import type { AuthRepository } from "../../ports/authentication.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import type { BootstrapResult } from "../../../domain/auth/model.ts";
import {
  normalizeUsername,
  validateDisplayName,
  validatePassword,
} from "../../../domain/auth/validation.ts";

export function makeBootstrapService(repository: AuthRepository) {
  return {
    status: () => repository.bootstrapStatus(),
    async initialize(
      input: {
        bootstrapToken: string;
        username: unknown;
        displayName: unknown;
        password: unknown;
      },
    ): Promise<Result<BootstrapResult>> {
      const username = normalizeUsername(input.username);
      if (!username.ok) return username;
      const displayName = validateDisplayName(input.displayName);
      if (!displayName.ok) return displayName;
      const password = validatePassword(input.password);
      if (!password.ok) return password;
      if (!input.bootstrapToken) {
        return err({
          code: "bootstrap_credential_invalid",
          message: "bootstrap credential is invalid",
          severity: "authentication",
          details: {},
        });
      }
      return await repository.bootstrap({
        bootstrapToken: input.bootstrapToken,
        username: username.value,
        displayName: displayName.value,
        password: password.value,
      });
    },
  };
}
