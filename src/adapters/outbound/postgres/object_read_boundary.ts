import {
  type ObjectPolicyReader,
  ObjectReadAuthorityInvalidError,
  type ObjectReadBoundary,
  type ObjectReader,
  type ReadAddress,
  type ReadAuthorityAnchor,
} from "../../../application/ports/object_reader.ts";
import type { AuthorizationRepository } from "../../../application/ports/authorization.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { query, type Queryable, type Sql } from "./client.ts";
import { lockActiveAuthorizationLineage } from "./authorization_lineage.ts";

export type ObjectReadBoundaryFactories = Readonly<{
  reader(sql: Queryable): ObjectReader;
  authorization(sql: Queryable): AuthorizationRepository;
  policy(sql: Queryable): ObjectPolicyReader;
}>;

export class PostgresObjectReadBoundary implements ObjectReadBoundary {
  constructor(
    private readonly sql: Sql,
    private readonly factories: ObjectReadBoundaryFactories,
  ) {}

  async execute<T>(
    auth: AuthContext,
    address: ReadAddress,
    work: (
      reader: ObjectReader,
      authorization: AuthorizationRepository,
      anchor: ReadAuthorityAnchor,
      policy: ObjectPolicyReader,
    ) => Promise<T>,
  ): Promise<T> {
    return await this.sql.begin(async (tx) => {
      const anchor = await lockReadAuthority(tx, auth, address.projectId);
      return await work(
        this.factories.reader(tx),
        this.factories.authorization(tx),
        anchor,
        this.factories.policy(tx),
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
    const lineage = await lockActiveAuthorizationLineage(sql, {
      authorizationId: auth.authorizationId,
      principalId: auth.principalId,
      humanUserId: auth.humanUserId,
    });
    if (!lineage.ok) throw new ObjectReadAuthorityInvalidError();
    authorizationRootId = lineage.value.rootAuthorizationId;
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

async function requireOne(
  sql: Queryable,
  statement: string,
  params: unknown[],
): Promise<void> {
  if (!(await query(sql, statement, params)).rows.length) {
    throw new ObjectReadAuthorityInvalidError();
  }
}
