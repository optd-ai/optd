import type { AuthContext } from "../../domain/auth/model.ts";
import type { Project, ProjectStatus } from "../../domain/projects/model.ts";
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

export interface ProjectRepository {
  create(auth: AuthContext, input: CreateProject): Promise<Result<Project>>;
  list(
    auth: AuthContext,
    filter: { status: ProjectStatus | "all"; slug?: string },
  ): Promise<Result<Project[]>>;
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
