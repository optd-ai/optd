import type { AuthContext } from "../../domain/auth/model.ts";
import type { Project } from "../../domain/projects/model.ts";
import type {
  ProjectCursorPosition,
  ProjectListFilter,
} from "../../domain/projects/pagination.ts";
import type { Result } from "../../domain/errors/result.ts";

export type CreateProject = {
  slug: string;
  displayName: string;
  description: string | null;
};
export type UpdateProject = {
  expectedVersion: number;
  displayName?: string;
  description?: string | null;
};

export type ProjectPage = {
  items: Project[];
  nextPosition: ProjectCursorPosition | null;
};

export interface ProjectRepository {
  create(auth: AuthContext, input: CreateProject): Promise<Result<Project>>;
  list(
    auth: AuthContext,
    input: {
      filter: ProjectListFilter;
      limit: number;
      after?: ProjectCursorPosition;
    },
  ): Promise<Result<ProjectPage>>;
  get(auth: AuthContext, id: string): Promise<Result<Project>>;
  update(
    auth: AuthContext,
    id: string,
    input: UpdateProject,
  ): Promise<Result<Project>>;
  archive(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<Result<Project>>;
}
