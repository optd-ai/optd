import type { AuthorizationRepository } from "../../../application/ports/authorization.ts";
import type {
  AuthContext,
  AuthorizationBoundary,
} from "../../../domain/auth/model.ts";
import { policyActorFromAuthContext } from "../../../domain/auth/policy_actor.ts";
import { boundaryDto } from "../../../domain/authorization/boundary.ts";
import type {
  BoundaryAuthority,
  Capability,
  PolicyAssignmentRecord,
  RoleAssignmentRecord,
  RoleDefinition,
} from "../../../domain/authorization/model.ts";
import { tokenDigest } from "../../../domain/auth/token.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { query, type Queryable, type Sql } from "./client.ts";
import { authorizationBoundaryPredicate } from "./authorization_boundary_sql.ts";

type AuthorityRow = {
  role_id: string | null;
  super_admin: boolean;
  policy_id: string | null;
  policy_revision_id: string | null;
  rule_id: string | null;
  action: string | null;
  resource: string | null;
  condition_kind: "unconditional" | "abac" | "rebac" | null;
  summary: string | null;
  predicate: string | null;
};

export class PostgresAuthorizationRepository
  implements AuthorizationRepository {
  constructor(private readonly sql: Sql) {}

  async authority(
    auth: AuthContext,
    boundary: AuthorizationBoundary,
    includeSecurity = false,
  ): Promise<Result<BoundaryAuthority>> {
    if (includeSecurity) {
      const system = await currentAuthority(this.sql, auth, { type: "system" });
      if (!system.ok) return system;
      if (
        !system.value.superAdmin &&
        !hasCapability(system.value, "pack.inspect_security")
      ) {
        return err(
          policyDenied(
            auth,
            { type: "system" },
            "pack.inspect_security",
            "system:policy_definition",
            system.value,
          ),
        );
      }
    }
    return currentAuthority(this.sql, auth, boundary, includeSecurity);
  }

  async authorize(
    input: {
      auth: AuthContext;
      boundary: AuthorizationBoundary;
      action: string;
      resource: string;
    },
  ): Promise<Result<BoundaryAuthority>> {
    const authority = await currentAuthority(
      this.sql,
      input.auth,
      input.boundary,
    );
    if (!authority.ok) return authority;
    if (
      authority.value.superAdmin ||
      authority.value.capabilities.some((capability) =>
        capability.action === input.action &&
        (capability.resource === "*" || capability.resource === input.resource)
      )
    ) {
      await authorizationDecisionAudit(
        this.sql,
        input.auth,
        authority.value.superAdmin ? "policy.bypassed" : "policy.allowed",
        input.boundary,
        input.action,
        input.resource,
        authority.value,
      );
      return authority;
    }
    await authorizationDecisionAudit(
      this.sql,
      input.auth,
      "policy.denied",
      input.boundary,
      input.action,
      input.resource,
      authority.value,
    );
    return err(
      policyDenied(
        input.auth,
        input.boundary,
        input.action,
        input.resource,
        authority.value,
      ),
    );
  }

  async listRoleDefinitions(
    boundary: AuthorizationBoundary,
    auth: AuthContext,
  ): Promise<Result<Array<RoleDefinition & { assigned: boolean }>>> {
    const [type, projectId] = boundaryParams(boundary);
    const rows = await query<{
      id: string;
      version_id: string;
      version: number;
      display_name: string;
      description: string | null;
      axi_summary: string | null;
      active: boolean;
      assigned: boolean;
    }>(
      this.sql,
      `
      select r.id,v.id version_id,v.version,r.display_name,r.description,r.axi_summary,r.active,
        exists(select 1 from role_assignments a where a.principal_id=$1 and a.role_id=r.id and a.active
          and ${authorizationBoundaryPredicate("a", "$2", "$3")}) assigned
      from system_roles r join role_definition_versions v on v.role_id=r.id and v.active
      order by r.id`,
      [auth.principalId, type, projectId],
    );
    return ok(rows.rows.map((row) => ({
      id: row.id,
      versionId: row.version_id,
      version: Number(row.version),
      displayName: row.display_name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.axi_summary ? { axiSummary: row.axi_summary } : {}),
      active: row.active,
      assigned: row.assigned,
    })));
  }

  async listRoleAssignments(
    auth: AuthContext,
    userId: string,
  ): Promise<Result<RoleAssignmentRecord[]>> {
    const permitted = await currentAuthority(this.sql, auth, {
      type: "system",
    });
    if (!permitted.ok) return permitted;
    if (
      !permitted.value.superAdmin && auth.humanUserId !== userId &&
      !hasCapability(permitted.value, "role.assignment.manage")
    ) {
      return err(
        policyDenied(
          auth,
          { type: "system" },
          "role.assignment.manage",
          "system:role_assignment",
          permitted.value,
        ),
      );
    }
    const rows = await query<RoleAssignmentRow>(
      this.sql,
      roleAssignmentSelect + " where u.id=$1 order by ra.created_at,ra.id",
      [userId],
    );
    return ok(rows.rows.map(mapRoleAssignment));
  }

  async createRoleAssignment(
    auth: AuthContext,
    userId: string,
    role: string,
    boundary: AuthorizationBoundary,
  ): Promise<Result<RoleAssignmentRecord>> {
    return await this.sql.begin(async (tx) => {
      const authority = await currentAuthority(tx, auth, boundary);
      if (!authority.ok) return authority;
      if (
        !authority.value.superAdmin &&
        (!hasCapability(authority.value, "role.assignment.manage") ||
          !authority.value.effectiveRoles.includes(role))
      ) {
        return await deniedDecision(
          tx,
          auth,
          boundary,
          "role.assignment.manage",
          "system:role_assignment",
          authority.value,
        );
      }
      if (role === "system:super_admin" && !authority.value.superAdmin) {
        return await deniedDecision(
          tx,
          auth,
          boundary,
          "role.assignment.manage",
          "system:super_admin",
          authority.value,
        );
      }
      const definition = await query<{ active: boolean }>(
        tx,
        `select r.active and exists(
          select 1 from role_definition_versions v
          where v.role_id=r.id and v.active
        ) active from system_roles r where r.id=$1 for share`,
        [role],
      );
      if (!definition.rows[0]?.active) {
        return err(notFound("active role definition", role));
      }
      const target = await query<{ principal_id: string }>(
        tx,
        "select principal_id from human_users where id=$1 and status='active' for share",
        [userId],
      );
      if (!target.rows[0]) return err(notFound("human user", userId));
      const exists = await query<RoleAssignmentRow>(
        tx,
        roleAssignmentSelect +
          " where u.id=$1 and ra.role_id=$2 and ra.boundary_type=$3 and ra.project_id is not distinct from $4::uuid and ra.active",
        [userId, role, ...boundaryParams(boundary)],
      );
      if (exists.rows[0]) return ok(mapRoleAssignment(exists.rows[0]));
      const id = uuidV7();
      await query(
        tx,
        `insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active,version,created_by_auth_context_id) values($1,$2,$3,$4,$5,true,1,$6)`,
        [
          id,
          target.rows[0].principal_id,
          role,
          ...boundaryParams(boundary),
          auth.id,
        ],
      );
      await assignmentAudit(tx, auth.id, "role_assignment.created", id, {
        user_id: userId,
        role,
        boundary: boundaryDto(boundary),
      });
      const created = await query<RoleAssignmentRow>(
        tx,
        roleAssignmentSelect + " where ra.id=$1",
        [id],
      );
      return ok(mapRoleAssignment(created.rows[0]));
    }) as Result<RoleAssignmentRecord>;
  }

  async disableRoleAssignment(
    auth: AuthContext,
    userId: string,
    assignmentId: string,
    expectedVersion: number,
  ): Promise<Result<RoleAssignmentRecord>> {
    return await this.sql.begin(async (tx) => {
      const locked = await query<RoleAssignmentRow>(
        tx,
        roleAssignmentSelect + " where ra.id=$1 and u.id=$2 for update of ra",
        [assignmentId, userId],
      );
      const current = locked.rows[0];
      if (!current) return err(notFound("role assignment", assignmentId));
      const boundary = rowBoundary(current);
      const authority = await currentAuthority(tx, auth, boundary);
      if (!authority.ok) return authority;
      if (
        !authority.value.superAdmin &&
        (!hasCapability(authority.value, "role.assignment.manage") ||
          !authority.value.effectiveRoles.includes(current.role_id))
      ) {
        return err(
          policyDenied(
            auth,
            boundary,
            "role.assignment.manage",
            "system:role_assignment",
            authority.value,
          ),
        );
      }
      if (
        current.role_id === "system:super_admin" && !authority.value.superAdmin
      ) {
        return err(
          policyDenied(
            auth,
            boundary,
            "role.assignment.manage",
            "system:super_admin",
            authority.value,
          ),
        );
      }
      if (!current.active) return ok(mapRoleAssignment(current));
      if (Number(current.version) !== expectedVersion) {
        return err(
          conflict("assignment_version_conflict", {
            expected_version: expectedVersion,
            current_version: Number(current.version),
          }),
        );
      }
      if (current.role_id === "system:super_admin") {
        await query(
          tx,
          "select pg_advisory_xact_lock(hashtext('operant.final_human_super_admin'))",
        );
        const count = await query<{ count: string }>(
          tx,
          `select count(distinct u.id)::text count from human_users u join role_assignments ra on ra.principal_id=u.principal_id where u.status='active' and ra.active and ra.role_id='system:super_admin' and ra.boundary_type='system'`,
          [],
        );
        if (Number(count.rows[0].count) <= 1) {
          await assignmentAudit(
            tx,
            auth.id,
            "role_assignment.disable_rejected",
            assignmentId,
            { reason: "last_human_super_admin", user_id: userId },
          );
          return err(
            conflict("last_human_super_admin", { assignment_id: assignmentId }),
          );
        }
      }
      await query(
        tx,
        "update role_assignments set active=false,disabled_at=now(),version=version+1,disabled_by_auth_context_id=$2 where id=$1",
        [assignmentId, auth.id],
      );
      await assignmentAudit(
        tx,
        auth.id,
        "role_assignment.disabled",
        assignmentId,
        { user_id: userId },
      );
      const updated = await query<RoleAssignmentRow>(
        tx,
        roleAssignmentSelect + " where ra.id=$1",
        [assignmentId],
      );
      return ok(mapRoleAssignment(updated.rows[0]));
    }) as Result<RoleAssignmentRecord>;
  }

  async listPolicyAssignments(
    auth: AuthContext,
    active?: boolean,
  ): Promise<Result<PolicyAssignmentRecord[]>> {
    const authority = await currentAuthority(this.sql, auth, {
      type: "system",
    });
    if (!authority.ok) return authority;
    if (
      !authority.value.superAdmin &&
      !hasCapability(authority.value, "policy.assignment.manage")
    ) {
      return err(
        policyDenied(
          auth,
          { type: "system" },
          "policy.assignment.manage",
          "system:policy_assignment",
          authority.value,
        ),
      );
    }
    const rows = await query<PolicyAssignmentRow>(
      this.sql,
      policyAssignmentSelect +
        " where ($1::boolean is null or pa.active=$1) order by pa.created_at,pa.id",
      [active ?? null],
    );
    return ok(rows.rows.map(mapPolicyAssignment));
  }

  async createPolicyAssignment(
    auth: AuthContext,
    revisionId: string,
    boundary: AuthorizationBoundary,
  ): Promise<Result<PolicyAssignmentRecord>> {
    return await this.sql.begin(async (tx) => {
      const authority = await currentAuthority(tx, auth, boundary);
      if (!authority.ok) return authority;
      if (
        !authority.value.superAdmin &&
        !hasCapability(authority.value, "policy.assignment.manage")
      ) {
        return err(
          policyDenied(
            auth,
            boundary,
            "policy.assignment.manage",
            "system:policy_assignment",
            authority.value,
          ),
        );
      }
      const policy = await query<{ policy_id: string }>(
        tx,
        "select policy_id from policy_definition_versions where id=$1 and active for share",
        [revisionId],
      );
      if (!policy.rows[0]) {
        return err(notFound("active policy revision", revisionId));
      }
      const id = uuidV7();
      await query(
        tx,
        `insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,version,source,created_by_auth_context_id) values($1,$2,$3,$4,true,1,'operator',$5)`,
        [id, revisionId, ...boundaryParams(boundary), auth.id],
      );
      await assignmentAudit(tx, auth.id, "policy_assignment.created", id, {
        policy_revision_id: revisionId,
        boundary: boundaryDto(boundary),
      });
      const created = await query<PolicyAssignmentRow>(
        tx,
        policyAssignmentSelect + " where pa.id=$1",
        [id],
      );
      return ok(mapPolicyAssignment(created.rows[0]));
    }) as Result<PolicyAssignmentRecord>;
  }

  async disablePolicyAssignment(
    auth: AuthContext,
    assignmentId: string,
    expectedVersion: number,
  ): Promise<Result<PolicyAssignmentRecord>> {
    return await this.sql.begin(async (tx) => {
      const locked = await query<PolicyAssignmentRow>(
        tx,
        policyAssignmentSelect + " where pa.id=$1 for update of pa",
        [assignmentId],
      );
      const current = locked.rows[0];
      if (!current) return err(notFound("policy assignment", assignmentId));
      const boundary = rowBoundary(current);
      const authority = await currentAuthority(tx, auth, boundary);
      if (!authority.ok) return authority;
      if (
        !authority.value.superAdmin &&
        !hasCapability(authority.value, "policy.assignment.manage")
      ) {
        return err(
          policyDenied(
            auth,
            boundary,
            "policy.assignment.manage",
            "system:policy_assignment",
            authority.value,
          ),
        );
      }
      if (!current.active) return ok(mapPolicyAssignment(current));
      if (Number(current.version) !== expectedVersion) {
        return err(
          conflict("assignment_version_conflict", {
            expected_version: expectedVersion,
            current_version: Number(current.version),
          }),
        );
      }
      await query(
        tx,
        "update policy_assignments set active=false,disabled_at=now(),version=version+1,disabled_by_auth_context_id=$2 where id=$1",
        [assignmentId, auth.id],
      );
      await assignmentAudit(
        tx,
        auth.id,
        "policy_assignment.disabled",
        assignmentId,
        {},
      );
      const updated = await query<PolicyAssignmentRow>(
        tx,
        policyAssignmentSelect + " where pa.id=$1",
        [assignmentId],
      );
      return ok(mapPolicyAssignment(updated.rows[0]));
    }) as Result<PolicyAssignmentRecord>;
  }
}

async function currentAuthority(
  sql: Queryable,
  auth: AuthContext,
  boundary: AuthorizationBoundary,
  includeSecurity = false,
): Promise<Result<BoundaryAuthority>> {
  const actor = policyActorFromAuthContext(auth);
  const [type, projectId] = boundaryParams(boundary);
  const rows = await query<AuthorityRow>(
    sql,
    `
    with valid_actor as (
      select s.principal_id,s.human_user_id,s.authorization_id
      from auth_sessions s join principals p on p.id=s.principal_id and p.active
      join human_users u on u.id=s.human_user_id and u.status='active'
      where s.id=$1 and s.principal_id=$2 and s.human_user_id=$3 and s.revoked_at is null
        and (s.authorization_id is null or exists(select 1 from agent_authorizations a where a.id=s.authorization_id and a.revoked_at is null and a.superseded_at is null))
    ), effective_roles as (
      select distinct ra.role_id from valid_actor a join role_assignments ra on a.authorization_id is null and ra.principal_id=a.principal_id and ra.active
       join system_roles r on r.id=ra.role_id and r.active
       where exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
         and ${authorizationBoundaryPredicate("ra", "$4", "$5")}
      union
      select distinct ar.role_id from valid_actor a join agent_authorization_roles ar on ar.authorization_id=a.authorization_id
       join system_roles r on r.id=ar.role_id and r.active
       where exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
         and ${authorizationBoundaryPredicate("ar", "$4", "$5")}
    ), super_admin as (
      select exists(
        select 1 from valid_actor a join role_assignments ra on a.authorization_id is null and ra.principal_id=a.principal_id and ra.active and ra.role_id='system:super_admin' and ra.boundary_type='system'
          join system_roles r on r.id=ra.role_id and r.active
        union all select 1 from valid_actor a join agent_authorization_roles ar on ar.authorization_id=a.authorization_id and ar.role_id='system:super_admin' and ar.boundary_type='system'
          join system_roles r on r.id=ar.role_id and r.active
      ) value
    ), applicable as (
      select pd.policy_id,pd.id policy_revision_id,pr.id rule_id,pr.capability action,pr.resource,pr.condition_kind,pr.summary,pr.predicate
      from policy_assignments pa join policy_definition_versions pd on pd.id=pa.policy_definition_version_id and pd.active
      join policy_rules pr on pr.policy_definition_version_id=pd.id join effective_roles er on er.role_id=pr.role_id
      where pa.active and ${authorizationBoundaryPredicate("pa", "$4", "$5")}
    )
    select er.role_id,sa.value super_admin,a.policy_id,a.policy_revision_id,a.rule_id,a.action,a.resource,a.condition_kind,a.summary,a.predicate
    from valid_actor va cross join super_admin sa left join effective_roles er on true left join applicable a on true
    order by er.role_id,a.policy_id,a.rule_id`,
    [auth.sessionId, actor.id, actor.human_user_id, type, projectId],
  );
  if (!rows.rows.length) {
    return err({
      code: "credential_invalid",
      message: "authenticated principal is no longer active",
      severity: "authentication",
      details: { auth_context_id: auth.id },
    });
  }
  const effectiveRoles = [
    ...new Set(rows.rows.flatMap((row) => row.role_id ? [row.role_id] : [])),
  ].sort();
  const capabilities: Capability[] = [];
  for (const row of rows.rows) {
    if (
      !row.policy_id || !row.policy_revision_id || !row.rule_id ||
      !row.action || !row.resource || !row.condition_kind
    ) continue;
    if (capabilities.some((item) => item.ruleId === row.rule_id)) continue;
    capabilities.push({
      action: row.action,
      resource: row.resource,
      condition: row.condition_kind,
      policy: row.policy_id,
      policyRevisionId: row.policy_revision_id,
      ruleId: row.rule_id,
      ...(row.summary ? { summary: row.summary } : {}),
      ...(includeSecurity && row.predicate ? { predicate: row.predicate } : {}),
    });
  }
  const value = {
    authContextId: auth.id,
    principal: {
      id: actor.id,
      type: actor.principal_type,
      humanUserId: actor.human_user_id,
    },
    boundary,
    effectiveRoles,
    superAdmin: rows.rows[0].super_admin,
    capabilities,
    digest: await tokenDigest(
      JSON.stringify({
        principal_id: actor.id,
        human_user_id: actor.human_user_id,
        boundary: boundaryDto(boundary),
        effective_roles: effectiveRoles,
        super_admin: rows.rows[0].super_admin,
        capabilities,
      }),
    ),
  };
  return ok(value);
}

function hasCapability(authority: BoundaryAuthority, action: string): boolean {
  return authority.capabilities.some((capability) =>
    capability.action === action && capability.resource === "*"
  );
}
function boundaryParams(
  boundary: AuthorizationBoundary,
): [string, string | null] {
  return boundary.type === "project"
    ? ["project", boundary.projectId]
    : [boundary.type, null];
}
function policyDenied(
  auth: AuthContext,
  boundary: AuthorizationBoundary,
  action: string,
  resource: string,
  authority: BoundaryAuthority,
) {
  const actor = policyActorFromAuthContext(auth);
  return {
    code: "policy_denied",
    message: `current authority does not allow ${action} on ${resource}`,
    severity: "authorization" as const,
    details: {
      auth_context_id: auth.id,
      principal_id: actor.id,
      actor,
      boundary: boundaryDto(boundary),
      resource,
      action,
      effective_roles: authority.effectiveRoles,
      checked_policies: [
        ...new Set(authority.capabilities.map((item) => item.policy)),
      ],
    },
  };
}
function notFound(kind: string, id: string) {
  return {
    code: "not_found",
    message: `${kind} was not found`,
    severity: "not_found" as const,
    details: { id },
  };
}
function conflict(code: string, details: Record<string, unknown>) {
  return {
    code,
    message: code === "last_human_super_admin"
      ? "cannot remove the final active human super-admin"
      : "assignment version does not match",
    severity: "conflict" as const,
    details,
  };
}
async function deniedDecision(
  sql: Queryable,
  auth: AuthContext,
  boundary: AuthorizationBoundary,
  action: string,
  resource: string,
  authority: BoundaryAuthority,
) {
  await authorizationDecisionAudit(
    sql,
    auth,
    "policy.denied",
    boundary,
    action,
    resource,
    authority,
  );
  return err(policyDenied(auth, boundary, action, resource, authority));
}
async function authorizationDecisionAudit(
  sql: Queryable,
  auth: AuthContext,
  eventType: "policy.allowed" | "policy.denied" | "policy.bypassed",
  boundary: AuthorizationBoundary,
  action: string,
  resource: string,
  authority: BoundaryAuthority,
) {
  const actor = policyActorFromAuthContext(auth);
  await query(
    sql,
    "insert into authorization_audit_events(id,auth_context_id,event_type,details) values($1,$2,$3,$4::jsonb)",
    [
      uuidV7(),
      auth.id,
      eventType,
      JSON.stringify({
        principal_id: actor.id,
        actor,
        boundary: boundaryDto(boundary),
        action,
        resource,
        effective_roles: authority.effectiveRoles,
        checked_policies: [
          ...new Set(authority.capabilities.map((item) => item.policy)),
        ],
      }),
    ],
  );
}
async function assignmentAudit(
  sql: Queryable,
  authContextId: string,
  eventType: string,
  assignmentId: string,
  details: Record<string, unknown>,
) {
  await query(
    sql,
    "insert into authorization_audit_events(id,auth_context_id,event_type,assignment_id,details) values($1,$2,$3,$4,$5::jsonb)",
    [uuidV7(), authContextId, eventType, assignmentId, JSON.stringify(details)],
  );
}

type BoundaryRow = { boundary_type: string; project_id: string | null };
type RoleAssignmentRow = BoundaryRow & {
  id: string;
  user_id: string;
  principal_id: string;
  role_id: string;
  active: boolean;
  version: number | string;
  created_at: Date;
  disabled_at: Date | null;
};
const roleAssignmentSelect =
  `select ra.id,u.id user_id,ra.principal_id,ra.role_id,ra.boundary_type,ra.project_id,ra.active,ra.version,ra.created_at,ra.disabled_at from role_assignments ra join human_users u on u.principal_id=ra.principal_id`;
type PolicyAssignmentRow = BoundaryRow & {
  id: string;
  policy_id: string;
  policy_revision_id: string;
  active: boolean;
  version: number | string;
  source: "operator" | "pack_default" | "platform";
  created_at: Date;
  disabled_at: Date | null;
};
const policyAssignmentSelect =
  `select pa.id,pd.policy_id,pa.policy_definition_version_id policy_revision_id,pa.boundary_type,pa.project_id,pa.active,pa.version,pa.source,pa.created_at,pa.disabled_at from policy_assignments pa join policy_definition_versions pd on pd.id=pa.policy_definition_version_id`;
function rowBoundary(row: BoundaryRow): AuthorizationBoundary {
  return row.boundary_type === "project"
    ? { type: "project", projectId: String(row.project_id) }
    : { type: row.boundary_type as "system" | "all_projects" };
}
function mapRoleAssignment(row: RoleAssignmentRow): RoleAssignmentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    principalId: row.principal_id,
    role: row.role_id,
    boundary: rowBoundary(row),
    active: row.active,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
  };
}
function mapPolicyAssignment(row: PolicyAssignmentRow): PolicyAssignmentRecord {
  return {
    id: row.id,
    policy: row.policy_id,
    policyRevisionId: row.policy_revision_id,
    boundary: rowBoundary(row),
    active: row.active,
    version: Number(row.version),
    source: row.source,
    createdAt: row.created_at.toISOString(),
    ...(row.disabled_at ? { disabledAt: row.disabled_at.toISOString() } : {}),
  };
}
