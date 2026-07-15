import type {
  CreateProject,
  ProjectRepository,
  UpdateProject,
} from "../../../application/ports/project_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import type { Project, ProjectStatus } from "../../../domain/projects/model.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { query, type Queryable, type Sql } from "./client.ts";

type ProjectRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  status: ProjectStatus;
  version: string | number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};
const COLUMNS =
  "id, slug, display_name, description, status, version, created_at, updated_at, archived_at";

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly sql: Sql) {}

  async create(
    auth: AuthContext,
    input: CreateProject,
  ): Promise<Result<Project>> {
    try {
      return await this.sql.begin(async (tx) => {
        const rows = await query<ProjectRow>(
          tx,
          `insert into projects(id,slug,display_name,description,created_by_auth_context_id,updated_by_auth_context_id) values ($1,$2,$3,$4,$5,$5) returning ${COLUMNS}`,
          [uuidV7(), input.slug, input.displayName, input.description, auth.id],
        );
        await audit(tx, auth, "project.create", rows.rows[0].id);
        return ok(mapProject(rows.rows[0]));
      }) as Result<Project>;
    } catch (error) {
      if (postgresCode(error) === "23505") {
        return err(
          projectError(
            "project_slug_conflict",
            "project slug already exists",
            "conflict",
            { slug: input.slug },
          ),
        );
      }
      throw error;
    }
  }

  async list(
    _auth: AuthContext,
    filter: { status: ProjectStatus | "all"; slug?: string },
  ): Promise<Result<Project[]>> {
    return await this.sql.begin(async (tx) => {
      const rows = await query<ProjectRow>(
        tx,
        `select ${COLUMNS} from projects where ($1 = 'all' or status = $1) and ($2::text is null or slug = $2) order by slug`,
        [filter.status, filter.slug ?? null],
      );
      await audit(tx, _auth, "project.read", null, { filter });
      return ok(rows.rows.map(mapProject));
    }) as Result<Project[]>;
  }

  async get(_auth: AuthContext, id: string): Promise<Result<Project>> {
    return await this.sql.begin(async (tx) => {
      const rows = await query<ProjectRow>(
        tx,
        `select ${COLUMNS} from projects where id = $1`,
        [id],
      );
      if (!rows.rows[0]) {
        return err(
          projectError(
            "project_not_found",
            "project was not found",
            "not_found",
            { project_id: id },
          ),
        );
      }
      await audit(tx, _auth, "project.read", id);
      return ok(mapProject(rows.rows[0]));
    }) as Result<Project>;
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateProject,
  ): Promise<Result<Project>> {
    return await this.mutate(id, async (tx, current) => {
      if (current.status !== "active") {
        return err(
          projectError("project_inactive", "project is archived", "conflict", {
            project_id: id,
          }),
        );
      }
      if (Number(current.version) !== input.expectedVersion) {
        return versionConflict(id, current.version);
      }
      const rows = await query<ProjectRow>(
        tx,
        `update projects set display_name = coalesce($2, display_name), description = case when $3 then $4 else description end, version = version + 1, updated_by_auth_context_id = $5, updated_at = now() where id = $1 returning ${COLUMNS}`,
        [
          id,
          input.displayName ?? null,
          Object.hasOwn(input, "description"),
          input.description ?? null,
          auth.id,
        ],
      );
      await audit(tx, auth, "project.update", id, {
        expected_version: input.expectedVersion,
      });
      return ok(mapProject(rows.rows[0]));
    });
  }

  async archive(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<Result<Project>> {
    return await this.mutate(id, async (tx, current) => {
      if (current.status === "archived") {
        await audit(tx, auth, "project.archive", id, { idempotent: true });
        return ok(mapProject(current));
      }
      if (Number(current.version) !== expectedVersion) {
        return versionConflict(id, current.version);
      }
      const rows = await query<ProjectRow>(
        tx,
        `update projects set status='archived', version=version+1, archived_at=now(), updated_at=now(), updated_by_auth_context_id=$2 where id=$1 returning ${COLUMNS}`,
        [id, auth.id],
      );
      await audit(tx, auth, "project.archive", id, {
        expected_version: expectedVersion,
      });
      return ok(mapProject(rows.rows[0]));
    });
  }

  private async mutate(
    id: string,
    operation: (tx: Queryable, row: ProjectRow) => Promise<Result<Project>>,
  ): Promise<Result<Project>> {
    return await this.sql.begin(async (tx) => {
      const rows = await query<ProjectRow>(
        tx,
        `select ${COLUMNS} from projects where id=$1 for update`,
        [id],
      );
      if (!rows.rows[0]) {
        return err(
          projectError(
            "project_not_found",
            "project was not found",
            "not_found",
            { project_id: id },
          ),
        );
      }
      return await operation(tx, rows.rows[0]);
    }) as Result<Project>;
  }
}

async function audit(
  sql: Queryable,
  auth: AuthContext,
  action:
    | "project.read"
    | "project.create"
    | "project.update"
    | "project.archive",
  projectId: string | null,
  details: unknown = {},
): Promise<void> {
  await query(
    sql,
    `insert into project_audit_events(id, auth_context_id, project_id, action, decision, details)
     values ($1, $2, $3, $4, 'allowed', $5::jsonb)`,
    [uuidV7(), auth.id, projectId, action, JSON.stringify(details)],
  );
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at
      ? new Date(row.archived_at).toISOString()
      : null,
  };
}
function versionConflict(id: string, actual: string | number) {
  return err(
    projectError(
      "project_version_conflict",
      "project version does not match",
      "conflict",
      { project_id: id, actual_version: Number(actual) },
    ),
  );
}
function projectError(
  code: string,
  message: string,
  severity: "conflict" | "not_found",
  details: unknown,
) {
  return { code, message, severity, details } as const;
}
function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
