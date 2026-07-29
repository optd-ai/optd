import type {
  AuthorizationLineageFact,
  AuthorizationLineageValidation,
} from "../../../domain/auth/authorization_lineage.ts";
import { validateActiveAuthorizationLineage } from "../../../domain/auth/authorization_lineage.ts";
import { query, type Queryable } from "./client.ts";

type AuthorizationLineageRow = {
  authorization_id: string;
  agent_user_id: string;
  authorization_human_user_id: string;
  parent_authorization_id: string | null;
  root_authorization_id: string;
  revoked: boolean;
  superseded: boolean;
  agent_principal_id: string | null;
  agent_name: string | null;
  agent_human_user_id: string | null;
  agent_principal_type: "human_user" | "agent_user" | null;
  agent_principal_active: boolean | null;
};

export async function loadActiveAuthorizationLineage(
  sql: Queryable,
  expected: Readonly<{
    authorizationId: string;
    principalId: string;
    humanUserId: string;
  }>,
): Promise<AuthorizationLineageValidation> {
  const rows = (await query<AuthorizationLineageRow>(
    sql,
    `with recursive ancestry as (
       select a.id,a.agent_user_id,a.human_user_id,a.parent_authorization_id,
              a.root_authorization_id,a.revoked_at,a.superseded_at,
              array[a.id]::uuid[] path,false cycle
         from agent_authorizations a where a.id=$1
       union all
       select parent.id,parent.agent_user_id,parent.human_user_id,
              parent.parent_authorization_id,parent.root_authorization_id,
              parent.revoked_at,parent.superseded_at,
              child.path || parent.id,parent.id=any(child.path)
         from ancestry child
         join agent_authorizations parent on parent.id=child.parent_authorization_id
        where not child.cycle
     ), lineage_facts as (
       select * from ancestry
       union all
       select root.id,root.agent_user_id,root.human_user_id,
              root.parent_authorization_id,root.root_authorization_id,
              root.revoked_at,root.superseded_at,array[root.id]::uuid[],false
         from agent_authorizations root
        where root.id=(select root_authorization_id from ancestry where id=$1 limit 1)
          and not exists(select 1 from ancestry where id=root.id)
     )
     select f.id authorization_id,f.agent_user_id,
            f.human_user_id authorization_human_user_id,
            f.parent_authorization_id,f.root_authorization_id,
            f.revoked_at is not null revoked,
            f.superseded_at is not null superseded,
            au.principal_id agent_principal_id,au.name agent_name,
            au.human_user_id agent_human_user_id,
            p.type agent_principal_type,p.active agent_principal_active
       from lineage_facts f
       left join agent_users au on au.id=f.agent_user_id
       left join principals p on p.id=au.principal_id`,
    [expected.authorizationId],
  )).rows;
  return validateActiveAuthorizationLineage({
    currentAuthorizationId: expected.authorizationId,
    expectedPrincipalId: expected.principalId,
    expectedHumanUserId: expected.humanUserId,
    facts: rows.map(lineageFact),
  });
}

function lineageFact(row: AuthorizationLineageRow): AuthorizationLineageFact {
  return {
    authorizationId: row.authorization_id,
    agentUserId: row.agent_user_id,
    authorizationHumanUserId: row.authorization_human_user_id,
    parentAuthorizationId: row.parent_authorization_id,
    rootAuthorizationId: row.root_authorization_id,
    revoked: row.revoked,
    superseded: row.superseded,
    agentPrincipalId: row.agent_principal_id ?? "",
    agentName: row.agent_name,
    agentHumanUserId: row.agent_human_user_id ?? "",
    agentPrincipalType: row.agent_principal_type,
    agentPrincipalActive: row.agent_principal_active === true,
  };
}
