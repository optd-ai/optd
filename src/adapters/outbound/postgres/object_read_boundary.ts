import {
  ObjectReadAuthorityInvalidError,
  type ObjectReadBoundary,
  type ReadAddress,
  type ReadAuthorityAnchor,
} from "../../../application/ports/object_reader.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { PostgresAuthorizationRepository } from "./authorization_repository.ts";
import { PostgresObjectReader } from "./object_reader.ts";
import { query, type Queryable, type Sql } from "./client.ts";

type LineageRow = {
  id: string;
  parent_authorization_id: string | null;
  root_authorization_id: string | null;
  human_user_id: string;
  principal_id: string;
  revoked_at: Date | string | null;
  superseded_at: Date | string | null;
};

export class PostgresObjectReadBoundary implements ObjectReadBoundary {
  constructor(private readonly sql: Sql) {}

  async execute<T>(
    auth: AuthContext,
    address: ReadAddress,
    work: (
      reader: PostgresObjectReader,
      authorization: PostgresAuthorizationRepository,
      anchor: ReadAuthorityAnchor,
      sql: Queryable,
    ) => Promise<T>,
  ): Promise<T> {
    return await this.sql.begin(async (tx) => {
      const anchor = await lockReadAuthority(tx, auth, address.projectId);
      return await work(
        new PostgresObjectReader(tx),
        new PostgresAuthorizationRepository(tx as unknown as Sql),
        anchor,
        tx,
      );
    }) as T;
  }
}

export async function lockReadAuthority(
  sql: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<ReadAuthorityAnchor> {
  await requireOne(
    sql,
    "select id from auth_sessions where id=$1 and revoked_at is null for share",
    [auth.sessionId],
  );
  await requireOne(
    sql,
    "select id from principals where id=$1 and active for share",
    [auth.principalId],
  );
  await requireOne(
    sql,
    "select id from human_users where id=$1 and status='active' for share",
    [auth.humanUserId],
  );

  let authorizationRootId = auth.principalId;
  if (auth.authorizationId) {
    const discovered = await lineage(sql, auth.authorizationId);
    const root = validateLineage(discovered, auth);
    await query(
      sql,
      "select id from agent_authorizations where id=any($1::uuid[]) order by id for share",
      [discovered.map((row) => row.id).sort()],
    );
    const anchored = await lineage(sql, auth.authorizationId);
    const anchoredRoot = validateLineage(anchored, auth);
    if (
      anchoredRoot !== root ||
      anchored.map((row) => row.id).sort().join(",") !==
        discovered.map((row) => row.id).sort().join(",")
    ) throw new ObjectReadAuthorityInvalidError();
    authorizationRootId = root;
    await query(
      sql,
      `select id from agent_authorization_roles where authorization_id=$1
       and (boundary_type in ('system','all_projects') or project_id=$2)
       order by id for share`,
      [auth.authorizationId, projectId],
    );
  } else {
    await query(
      sql,
      `select id from role_assignments where principal_id=$1
       and (boundary_type in ('system','all_projects') or project_id=$2)
       order by id for share`,
      [auth.principalId, projectId],
    );
  }
  await query(
    sql,
    `select id from policy_assignments where
       boundary_type in ('system','all_projects') or project_id=$1
     order by id for share`,
    [projectId],
  );
  await query(
    sql,
    `select id from system_roles where id in (
       select role_id from role_assignments where principal_id=$1
       union select role_id from agent_authorization_roles where authorization_id=$2
     ) order by id for share`,
    [auth.principalId, auth.authorizationId ?? null],
  );
  await query(
    sql,
    `select id from role_definition_versions where role_id in (
       select role_id from role_assignments where principal_id=$1
       union select role_id from agent_authorization_roles where authorization_id=$2
     ) order by id for share`,
    [auth.principalId, auth.authorizationId ?? null],
  );
  await query(
    sql,
    `select pd.id from policy_definition_versions pd
     join policy_assignments pa on pa.policy_definition_version_id=pd.id
     where pa.boundary_type in ('system','all_projects') or pa.project_id=$1
     order by pd.id for share of pd`,
    [projectId],
  );
  await query(
    sql,
    `select pr.id from policy_rules pr
     join policy_assignments pa on pa.policy_definition_version_id=pr.policy_definition_version_id
     where pa.boundary_type in ('system','all_projects') or pa.project_id=$1
     order by pr.id for share of pr`,
    [projectId],
  );
  return { authorizationRootId };
}

async function lineage(sql: Queryable, leaf: string): Promise<LineageRow[]> {
  return (await query<LineageRow>(
    sql,
    `with recursive lineage(id) as (
       select $1::uuid
       union
       select a.parent_authorization_id from agent_authorizations a
       join lineage child on child.id=a.id where a.parent_authorization_id is not null
     )
     select a.id,a.parent_authorization_id,a.root_authorization_id,a.human_user_id,
            u.principal_id,a.revoked_at,a.superseded_at
       from lineage l join agent_authorizations a on a.id=l.id
       join agent_users u on u.id=a.agent_user_id
      order by a.id`,
    [leaf],
  )).rows;
}

function validateLineage(rows: LineageRow[], auth: AuthContext): string {
  if (!auth.authorizationId || !rows.length) {
    throw new ObjectReadAuthorityInvalidError();
  }
  const ids = new Set(rows.map((row) => row.id));
  const leaf = rows.find((row) => row.id === auth.authorizationId);
  const roots = rows.filter((row) => row.parent_authorization_id === null);
  if (
    !leaf || leaf.principal_id !== auth.principalId ||
    rows.some((row) =>
      row.revoked_at !== null || row.superseded_at !== null ||
      row.human_user_id !== auth.humanUserId ||
      (row.parent_authorization_id !== null &&
        !ids.has(row.parent_authorization_id))
    ) || roots.length !== 1
  ) throw new ObjectReadAuthorityInvalidError();
  const root = roots[0].id;
  if (rows.some((row) => row.root_authorization_id !== root)) {
    throw new ObjectReadAuthorityInvalidError();
  }
  return root;
}

async function requireOne(
  sql: Queryable,
  statement: string,
  params: unknown[],
): Promise<void> {
  if (!(await query(sql, statement, params)).rows.length) {
    throw new ObjectReadAuthorityInvalidError();
  }
}
