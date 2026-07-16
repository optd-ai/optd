import type {
  ObjectReadBoundary,
  ReadAddress,
} from "../../../application/ports/object_reader.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { PostgresAuthorizationRepository } from "./authorization_repository.ts";
import { PostgresObjectReader } from "./object_reader.ts";
import { query, type Queryable, type Sql } from "./client.ts";

export class PostgresObjectReadBoundary implements ObjectReadBoundary {
  constructor(private readonly sql: Sql) {}

  async execute<T>(
    auth: AuthContext,
    address: ReadAddress,
    work: (
      reader: PostgresObjectReader,
      authorization: PostgresAuthorizationRepository,
    ) => Promise<T>,
  ): Promise<T> {
    return await this.sql.begin(async (tx) => {
      await lockAuthority(tx, auth, address.projectId);
      return await work(
        new PostgresObjectReader(tx),
        new PostgresAuthorizationRepository(tx as unknown as Sql),
      );
    }) as T;
  }
}

async function lockAuthority(
  sql: Queryable,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  await query(sql, "select id from auth_sessions where id=$1 for share", [
    auth.sessionId,
  ]);
  await query(sql, "select id from principals where id=$1 for share", [
    auth.principalId,
  ]);
  await query(sql, "select id from human_users where id=$1 for share", [
    auth.humanUserId,
  ]);
  if (auth.authorizationId) {
    await query(
      sql,
      "select id from agent_authorizations where id=$1 for share",
      [auth.authorizationId],
    );
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
}
