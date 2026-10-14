import type {
  CreateWorkspace,
  UpdateWorkspace,
  WorkspacePage,
  WorkspaceRepository,
} from "../../../application/ports/workspace_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import type {
  Workspace,
  WorkspaceStatus,
} from "../../../domain/workspaces/model.ts";
import type {
  WorkspaceCursorPosition,
  WorkspaceListFilter,
} from "../../../domain/workspaces/pagination.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { query, type Queryable, type Sql } from "./client.ts";
import { PostgresAuthorizationRepository } from "./authorization_repository.ts";

type WorkspaceRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  status: WorkspaceStatus;
  version: string | number;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};
const COLUMNS =
  "id, slug, display_name, description, status, version, created_at, updated_at, archived_at";

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly sql: Sql) {}

  async create(
    auth: AuthContext,
    input: CreateWorkspace,
  ): Promise<Result<Workspace>> {
    try {
      return await this.sql.begin(async (tx) => {
        const permit = await authorizeWorkspace(tx, auth, "workspace.create");
        if (!permit.ok) return permit;
        const rows = await query<WorkspaceRow>(
          tx,
          `insert into workspaces(id,slug,display_name,description,created_by_auth_context_id,updated_by_auth_context_id) values ($1,$2,$3,$4,$5,$5) returning ${COLUMNS}`,
          [uuidV7(), input.slug, input.displayName, input.description, auth.id],
        );
        await audit(tx, auth, "workspace.create", rows.rows[0].id);
        return ok(mapWorkspace(rows.rows[0]));
      }) as Result<Workspace>;
    } catch (error) {
      if (postgresCode(error) === "23505") {
        return err(
          workspaceError(
            "workspace_slug_conflict",
            "workspace slug already exists",
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
    input: {
      filter: WorkspaceListFilter;
      limit: number;
      after?: WorkspaceCursorPosition;
    },
  ): Promise<Result<WorkspacePage>> {
    return await this.sql.begin(async (tx) => {
      const authority = new PostgresAuthorizationRepository(
        tx as unknown as Sql,
      );
      const system = await authority.authority(_auth, { type: "system" });
      if (!system.ok) return system;
      const globalRead = system.value.superAdmin ||
        system.value.capabilities.some((c) =>
          c.action === "workspace.read" && c.condition === "unconditional" &&
          (c.resource === "*" || c.resource === "system:workspace")
        );
      const rows = await query<WorkspaceRow>(
        tx,
        `select ${COLUMNS}
           from workspaces
          where ($1 = 'all' or status = $1)
            and ($2::text is null or slug = $2)
            and ($3::text is null or (slug, id) > ($3, $4::uuid))
          order by slug, id
          `,
        [
          input.filter.status,
          input.filter.slug ?? null,
          input.after?.slug ?? null,
          input.after?.id ?? null,
        ],
      );
      const permitted: WorkspaceRow[] = [];
      for (const row of rows.rows) {
        if (
          globalRead ||
          (await authorizeWorkspace(tx, _auth, "workspace.read", row.id)).ok
        ) permitted.push(row);
        if (permitted.length > input.limit) break;
      }
      const hasMore = permitted.length > input.limit;
      const visible = permitted.slice(0, input.limit);
      const last = hasMore ? visible.at(-1) : undefined;
      await audit(tx, _auth, "workspace.read", null, { input });
      return ok({
        items: visible.map(mapWorkspace),
        nextPosition: last ? { slug: last.slug, id: last.id } : null,
      });
    }) as Result<WorkspacePage>;
  }

  async get(_auth: AuthContext, id: string): Promise<Result<Workspace>> {
    return await this.sql.begin(async (tx) => {
      const permit = await authorizeWorkspace(tx, _auth, "workspace.read", id);
      if (!permit.ok) return permit;
      const rows = await query<WorkspaceRow>(
        tx,
        `select ${COLUMNS} from workspaces where id = $1`,
        [id],
      );
      if (!rows.rows[0]) {
        return err(
          workspaceError(
            "workspace_not_found",
            "workspace was not found",
            "not_found",
            { workspace_id: id },
          ),
        );
      }
      await audit(tx, _auth, "workspace.read", id);
      return ok(mapWorkspace(rows.rows[0]));
    }) as Result<Workspace>;
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateWorkspace,
  ): Promise<Result<Workspace>> {
    return await this.mutate(id, async (tx, current) => {
      const permit = await authorizeWorkspace(tx, auth, "workspace.update", id);
      if (!permit.ok) return permit;
      if (current.status !== "active") {
        return err(
          workspaceError(
            "workspace_inactive",
            "workspace is archived",
            "conflict",
            {
              workspace_id: id,
            },
          ),
        );
      }
      if (Number(current.version) !== input.expectedVersion) {
        return versionConflict(id, current.version);
      }
      const rows = await query<WorkspaceRow>(
        tx,
        `update workspaces set display_name = coalesce($2, display_name), description = case when $3 then $4 else description end, version = version + 1, updated_by_auth_context_id = $5, updated_at = now() where id = $1 returning ${COLUMNS}`,
        [
          id,
          input.displayName ?? null,
          Object.hasOwn(input, "description"),
          input.description ?? null,
          auth.id,
        ],
      );
      await audit(tx, auth, "workspace.update", id, {
        expected_version: input.expectedVersion,
      });
      return ok(mapWorkspace(rows.rows[0]));
    });
  }

  async archive(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
  ): Promise<Result<Workspace>> {
    return await this.mutate(id, async (tx, current) => {
      const permit = await authorizeWorkspace(
        tx,
        auth,
        "workspace.archive",
        id,
      );
      if (!permit.ok) return permit;
      if (current.status === "archived") {
        await audit(tx, auth, "workspace.archive", id, { idempotent: true });
        return ok(mapWorkspace(current));
      }
      if (Number(current.version) !== expectedVersion) {
        return versionConflict(id, current.version);
      }
      const rows = await query<WorkspaceRow>(
        tx,
        `update workspaces set status='archived', version=version+1, archived_at=now(), updated_at=now(), updated_by_auth_context_id=$2 where id=$1 returning ${COLUMNS}`,
        [id, auth.id],
      );
      await audit(tx, auth, "workspace.archive", id, {
        expected_version: expectedVersion,
      });
      return ok(mapWorkspace(rows.rows[0]));
    });
  }

  private async mutate(
    id: string,
    operation: (tx: Queryable, row: WorkspaceRow) => Promise<Result<Workspace>>,
  ): Promise<Result<Workspace>> {
    return await this.sql.begin(async (tx) => {
      const rows = await query<WorkspaceRow>(
        tx,
        `select ${COLUMNS} from workspaces where id=$1 for update`,
        [id],
      );
      if (!rows.rows[0]) {
        return err(
          workspaceError(
            "workspace_not_found",
            "workspace was not found",
            "not_found",
            { workspace_id: id },
          ),
        );
      }
      return await operation(tx, rows.rows[0]);
    }) as Result<Workspace>;
  }
}

async function authorizeWorkspace(
  sql: Queryable,
  auth: AuthContext,
  action: string,
  workspaceId?: string,
): Promise<Result<true>> {
  const repository = new PostgresAuthorizationRepository(sql as Sql);
  const system = await repository.authority(auth, { type: "system" });
  if (!system.ok) return system;
  const permits = (authority: typeof system.value) =>
    authority.superAdmin ||
    authority.capabilities.some((c) =>
      c.action === action && c.condition === "unconditional" &&
      (c.resource === "*" || c.resource === "system:workspace")
    );
  if (permits(system.value)) return ok(true);
  if (workspaceId) {
    const scoped = await repository.authority(auth, {
      type: "workspace",
      workspaceId,
    });
    if (!scoped.ok) return scoped;
    if (
      permits(scoped.value) ||
      (action === "workspace.read" && scoped.value.effectiveRoles.length > 0)
    ) return ok(true);
  }
  return err({
    code: "authorization_insufficient",
    severity: "authorization",
    message: `credential is not authorized for ${action}`,
    details: { action },
  });
}

async function audit(
  sql: Queryable,
  auth: AuthContext,
  action:
    | "workspace.read"
    | "workspace.create"
    | "workspace.update"
    | "workspace.archive",
  workspaceId: string | null,
  details: unknown = {},
): Promise<void> {
  await query(
    sql,
    `insert into workspace_audit_events(id, auth_context_id, workspace_id, action, decision, details)
     values ($1, $2, $3, $4, 'allowed', $5::jsonb)`,
    [uuidV7(), auth.id, workspaceId, action, JSON.stringify(details)],
  );
}

function mapWorkspace(row: WorkspaceRow): Workspace {
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
    workspaceError(
      "workspace_version_conflict",
      "workspace version does not match",
      "conflict",
      { workspace_id: id, actual_version: Number(actual) },
    ),
  );
}
function workspaceError(
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
