import type {
  AuthContext,
  BootstrapInput,
  BootstrapResult,
} from "../../domain/auth/model.ts";
import type { Result } from "../../domain/errors/result.ts";

export type BootstrapStatus =
  | "bootstrap_required"
  | "bootstrap_in_progress"
  | "active";

export interface AuthRepository {
  bootstrap(input: BootstrapInput): Promise<Result<BootstrapResult>>;
  bootstrapStatus(): Promise<Result<BootstrapStatus>>;
  authenticate(token: string): Promise<Result<AuthContext>>;
}

export interface RequestAuthenticator {
  authenticate(token: string): Promise<Result<AuthContext>>;
}
