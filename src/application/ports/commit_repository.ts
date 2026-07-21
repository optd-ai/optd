import type { AuthContext } from "../../domain/auth/model.ts";
import type {
  CommitChangesetDto,
  CommitOptions,
} from "../../domain/changesets/commit.ts";
import type { Result } from "../../domain/errors/result.ts";

export interface CommitRepository {
  commit(
    stageId: string,
    auth: AuthContext,
    options: CommitOptions,
  ): Promise<Result<CommitChangesetDto>>;
}
