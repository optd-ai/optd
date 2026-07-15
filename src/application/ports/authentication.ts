import type {
  AuthContext,
  BootstrapInput,
  BootstrapResult,
} from "../../domain/auth/model.ts";
import type { Result } from "../../domain/errors/result.ts";

export interface AuthRepository {
  bootstrap(input: BootstrapInput): Promise<Result<BootstrapResult>>;
  bootstrapRequired(): Promise<boolean>;
  authenticate(token: string): Promise<Result<AuthContext>>;
}

export interface RequestAuthenticator {
  authenticate(token: string): Promise<Result<AuthContext>>;
}
