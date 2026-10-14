import type { AuthContext } from "../../domain/auth/model.ts";
import type { Workspace } from "../../domain/workspaces/model.ts";
import type {
  WorkspaceCursorPosition,
  WorkspaceListFilter,
} from "../../domain/workspaces/pagination.ts";
import type { Result } from "../../domain/errors/result.ts";

export type CreateWorkspace = {
  slug: string;
  displayName: string;
  description: string | null;
};
export type UpdateWorkspace = {
  expectedVersion: number;
  displayName?: string;
  description?: string | null;
};

export type WorkspacePage = {
  items: Workspace[];
  nextPosition: WorkspaceCursorPosition | null;
};

export interface WorkspaceRepository {
  create(auth: AuthContext, input: CreateWorkspace): Promise<Result<Workspace>>;
  list(
    auth: AuthContext,
    input: {
      filter: WorkspaceListFilter;
      limit: number;
      after?: WorkspaceCursorPosition;
    },
  ): Promise<Result<WorkspacePage>>;
  get(auth: AuthContext, id: string): Promise<Result<Workspace>>;
  update(
    auth: AuthContext,
    id: string,
    input: UpdateWorkspace,
  ): Promise<Result<Workspace>>;
  archive(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<Result<Workspace>>;
}
