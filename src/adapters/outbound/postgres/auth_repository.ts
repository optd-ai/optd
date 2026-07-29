import type {
  AgentAuthorizationGrantability,
  AgentAuthorizationGrantabilitySnapshot,
  AgentAuthorizationGrantabilityState,
  AuthRepository,
} from "../../../application/ports/authentication.ts";
import { CurrentPolicyAgentAuthorizationGrantability } from "../../../application/services/auth/grantability.ts";
import type {
  AgentAuthorization,
  AgentAuthorizationRequest,
  AuthContext,
  AuthorizationBoundary,
  BootstrapInput,
  BootstrapResult,
  CredentialKind,
  CurrentIdentity,
  HumanSession,
  HumanUser,
  LoginResult,
  PasswordReset,
  RoleAssignment,
} from "../../../domain/auth/model.ts";
import { immutableAuthContext } from "../../../domain/auth/model.ts";
import { transitionPasswordReset } from "../../../domain/auth/password_reset_state.ts";
import {
  ARGON2ID_V1,
  type ArgonParameters,
  parseArgonPhc,
  planArgonMaintenance,
} from "../../../domain/auth/argon_profile.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import {
  beginBootstrap,
  completeBootstrap,
} from "../../../domain/auth/bootstrap_state.ts";
import {
  constantTimeDigestEqual,
  opaqueToken,
  tokenDigest,
} from "../../../domain/auth/token.ts";
import type { Queryable, Sql } from "./client.ts";
import { query } from "./client.ts";
import { authorizationBoundaryPredicate } from "./authorization_boundary_sql.ts";
import { loadActiveAuthorizationLineage } from "./authorization_lineage.ts";

export class PostgresAuthRepository implements AuthRepository {
  private readonly hashes: ImmediateSemaphore;
  private resetListener: Promise<{ unlisten(): Promise<void> }> | undefined;
  private agentRequestListener:
    | Promise<{ unlisten(): Promise<void> }>
    | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly configuredBootstrapToken?: string,
    maxConcurrentHashes = 4,
    private readonly grantability: AgentAuthorizationGrantability =
      new CurrentPolicyAgentAuthorizationGrantability(),
  ) {
    this.hashes = new ImmediateSemaphore(maxConcurrentHashes);
  }

  async bootstrapStatus() {
    return await this.sql.begin(async (tx) => {
      const result = await query<{ completed: boolean }>(
        tx,
        "select completed from bootstrap_state where singleton = true",
      );
      if (result.rows[0]?.completed === true) return ok("active" as const);
      const lock = await query<{ acquired: boolean }>(
        tx,
        "select pg_try_advisory_xact_lock(hashtext('operant.auth.bootstrap')) acquired",
      );
      if (!lock.rows[0]?.acquired) return ok("bootstrap_in_progress" as const);
      if (!this.configuredBootstrapToken) {
        return err(authError(
          "bootstrap_token_not_configured",
          "bootstrap token is not configured",
          "unavailable",
        ));
      }
      return ok("bootstrap_required" as const);
    });
  }

  async bootstrap(input: BootstrapInput): Promise<Result<BootstrapResult>> {
    if (!this.configuredBootstrapToken) {
      return err(
        authError(
          "bootstrap_token_not_configured",
          "bootstrap token is not configured",
          "unavailable",
        ),
      );
    }
    const configuredDigest = await tokenDigest(this.configuredBootstrapToken);
    const suppliedDigest = await tokenDigest(input.bootstrapToken);
    return await this.sql.begin(async (tx) => {
      await query(
        tx,
        "select pg_advisory_xact_lock(hashtext('operant.auth.bootstrap'))",
      );
      await query(
        tx,
        `insert into bootstrap_state(singleton, token_digest, completed) values (true, $1, false) on conflict (singleton) do nothing`,
        [configuredDigest],
      );
      const state = await query<{ token_digest: string; completed: boolean }>(
        tx,
        "select token_digest, completed from bootstrap_state where singleton = true for update",
      );
      const row = state.rows[0];
      const transition = beginBootstrap(
        row?.completed ? "active" : "bootstrap_required",
      );
      if (!transition.ok) return transition;
      if (!row || !constantTimeDigestEqual(row.token_digest, suppliedDigest)) {
        return err(
          authError(
            "bootstrap_credential_invalid",
            "bootstrap credential is invalid",
            "authentication",
          ),
        );
      }

      const principalId = uuidV7();
      const userId = uuidV7();
      const assignmentId = uuidV7();
      const release = this.hashes.tryAcquire();
      if (!release) {
        return err(
          authError(
            "authentication_busy",
            "authentication is busy",
            "unavailable",
            { retry_after_seconds: 1 },
          ),
        );
      }
      let passwordHash: string;
      try {
        passwordHash = await hashPassword(input.password);
      } finally {
        release();
      }
      await query(
        tx,
        "insert into principals(id, type, active) values ($1, 'human_user', true)",
        [principalId],
      );
      await query(
        tx,
        `insert into human_users(id, principal_id, username, display_name, status) values ($1, $2, $3, $4, 'active')`,
        [userId, principalId, input.username, input.displayName],
      );
      await query(
        tx,
        `insert into password_credentials(human_user_id, profile, phc_hash) values ($1, 'argon2id.v1', $2)`,
        [userId, passwordHash],
      );
      await query(
        tx,
        `insert into role_assignments(id, principal_id, role_id, boundary_type, active) values ($1, $2, 'system:super_admin', 'system', true)`,
        [assignmentId, principalId],
      );
      const full = await issueSession(tx, principalId, userId, "human_full");
      const request = await issueSession(
        tx,
        principalId,
        userId,
        "authorization_request",
      );
      const completed = completeBootstrap(transition.value);
      if (!completed.ok) return completed;
      await insertBootstrapAudit(tx, {
        principalId,
        userId,
        assignmentId,
        fullSessionId: full.id,
        requestSessionId: request.id,
      });
      await query(
        tx,
        `update bootstrap_state
            set completed = true, completed_at = now(),
                completed_by_human_user_id = $1, token_digest = null,
                updated_at = now()
          where singleton = true`,
        [userId],
      );
      return ok({
        user: {
          id: userId,
          principalId,
          username: input.username,
          displayName: input.displayName,
        },
        credentials: issuedCredentials(full, request),
      });
    }) as Result<BootstrapResult>;
  }

  async authenticate(token: string): Promise<Result<AuthContext>> {
    const digest = await tokenDigest(token);
    const result = await query<{
      session_id: string;
      principal_id: string;
      human_user_id: string;
      credential_kind: CredentialKind;
      authorization_id: string | null;
      principal_type: "human_user" | "agent_user";
      created_at: Date;
      roles: string[] | null;
    }>(
      this.sql,
      `
      with recursive lineage(id,parent_authorization_id,revoked_at,superseded_at) as (
        select a.id,a.parent_authorization_id,a.revoked_at,a.superseded_at
          from auth_sessions seed join agent_authorizations a on a.id=seed.authorization_id
         where seed.token_digest=$1
        union
        select parent.id,parent.parent_authorization_id,parent.revoked_at,parent.superseded_at
          from agent_authorizations parent join lineage child on child.parent_authorization_id=parent.id
      )
      select s.id as session_id, s.principal_id, s.human_user_id, s.credential_kind,
             s.authorization_id, p.type as principal_type, now() as created_at,
             case when s.credential_kind = 'authorization_request' then '{}'::text[]
               when s.credential_kind = 'agent_authorization' then
                 array_remove(array_agg(ar.role_id order by ar.role_id), null)
               else array_remove(array_agg(ra.role_id order by ra.role_id), null)
             end as roles
        from auth_sessions s
        join principals p on p.id = s.principal_id and p.active
        join human_users u on u.id = s.human_user_id and u.status = 'active'
        left join role_assignments ra on ra.principal_id = s.principal_id and ra.active
        left join agent_authorization_roles ar on ar.authorization_id=s.authorization_id
          and not exists (
            select 1
              from lineage ancestor
              join agent_authorizations original on original.id=ancestor.id
             where ancestor.id<>s.authorization_id
               and not exists (
                 select 1
                   from agent_authorizations current
                   join agent_authorization_roles upstream on upstream.authorization_id=current.id
                  where current.agent_user_id=original.agent_user_id
                    and current.revoked_at is null and current.superseded_at is null
                    and upstream.role_id=ar.role_id
                    and upstream.boundary_type=ar.boundary_type
                    and upstream.project_id is not distinct from ar.project_id
               )
          )
       where s.token_digest = $1 and s.revoked_at is null
         and (s.authorization_id is null or not exists(select 1 from lineage where revoked_at is not null))
       group by s.id, s.principal_id, s.human_user_id, s.credential_kind, s.authorization_id, p.type
    `,
      [digest],
    );
    const row = result.rows[0];
    if (!row) {
      return err(
        authError(
          "credential_invalid",
          "bearer credential is invalid",
          "authentication",
        ),
      );
    }
    if (row.credential_kind === "agent_authorization") {
      if (!row.authorization_id || row.principal_type !== "agent_user") {
        return credentialInvalid();
      }
      const lineage = await loadActiveAuthorizationLineage(this.sql, {
        authorizationId: row.authorization_id,
        principalId: row.principal_id,
        humanUserId: row.human_user_id,
      });
      if (!lineage.ok) return credentialInvalid();
    } else if (
      row.authorization_id !== null || row.principal_type !== "human_user"
    ) {
      return credentialInvalid();
    }
    const context = immutableAuthContext({
      id: uuidV7(),
      principalId: row.principal_id,
      principalType: row.principal_type,
      humanUserId: row.human_user_id,
      sessionId: row.session_id,
      authorizationId: row.authorization_id ?? undefined,
      credentialKind: row.credential_kind,
      roles: row.roles ?? [],
      createdAt: new Date(row.created_at).toISOString(),
    });
    await query(
      this.sql,
      `insert into auth_contexts(id, principal_id, human_user_id, session_id, authorization_id, credential_kind, roles, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        context.id,
        context.principalId,
        context.humanUserId,
        context.sessionId,
        context.authorizationId ?? null,
        context.credentialKind,
        [...context.roles],
        context.createdAt,
      ],
    );
    return ok(context);
  }

  async login(
    username: string,
    password: string,
    existingRequestSessionId?: string,
  ): Promise<Result<LoginResult>> {
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      return await this.sql.begin(async (tx) => {
        await query(
          tx,
          `insert into login_throttles(username) values ($1) on conflict do nothing`,
          [username],
        );
        const throttle =
          (await query<{ failure_count: number; next_allowed_at: Date | null }>(
            tx,
            `select failure_count, next_allowed_at from login_throttles where username=$1 for update`,
            [username],
          )).rows[0]!;
        if (
          throttle.next_allowed_at &&
          new Date(throttle.next_allowed_at).getTime() > Date.now()
        ) {
          const retry = Math.max(
            1,
            Math.ceil(
              (new Date(throttle.next_allowed_at).getTime() - Date.now()) /
                1000,
            ),
          );
          return err(
            authError(
              "login_throttled",
              "login is temporarily throttled",
              "rate_limited",
              { retry_after_seconds: retry },
            ),
          );
        }
        const row = (await query<
          {
            id: string;
            principal_id: string;
            username: string;
            display_name: string;
            status: "active" | "disabled";
            phc_hash: string;
            profile: string;
          }
        >(
          tx,
          `select u.id,u.principal_id,u.username,u.display_name,u.status,pw.phc_hash,pw.profile from human_users u join password_credentials pw on pw.human_user_id=u.id where u.username=$1`,
          [username],
        )).rows[0];
        const valid = await verifyPassword(
          password,
          row?.phc_hash ?? DUMMY_PASSWORD_HASH,
        );
        if (!row || !valid || row.status !== "active") {
          const failures = throttle.failure_count + 1;
          const delay = failures < 5 ? 0 : Math.min(30, 2 ** (failures - 5));
          await query(
            tx,
            `update login_throttles set failure_count=$2, next_allowed_at=case when $3::int=0 then null else now()+make_interval(secs => $3) end, updated_at=now() where username=$1`,
            [username, failures, delay],
          );
          return err(
            authError(
              "login_invalid",
              "username or password is invalid",
              "authentication",
            ),
          );
        }
        const maintenance = planArgonMaintenance(
          row.profile,
          parseArgonPhc(row.phc_hash),
        );
        if (maintenance.rehash) {
          const upgraded = await hashPassword(password, maintenance.target);
          await query(
            tx,
            `update password_credentials set profile=$2,phc_hash=$3 where human_user_id=$1`,
            [row.id, ARGON2ID_V1.profile, upgraded],
          );
        } else if (maintenance.updateProfile) {
          await query(
            tx,
            `update password_credentials set profile=$2 where human_user_id=$1`,
            [row.id, ARGON2ID_V1.profile],
          );
        }
        await query(
          tx,
          `update login_throttles set failure_count=0,next_allowed_at=null,updated_at=now() where username=$1`,
          [username],
        );
        const full = await issueSession(
          tx,
          row.principal_id,
          row.id,
          "human_full",
        );
        const retained = existingRequestSessionId
          ? (await query<{ id: string }>(
            tx,
            `select id from auth_sessions where id=$1 and human_user_id=$2 and principal_id=$3 and credential_kind='authorization_request' and revoked_at is null for update`,
            [existingRequestSessionId, row.id, row.principal_id],
          )).rows[0]
          : undefined;
        let request: { id: string; token: string };
        if (retained) {
          request = { id: retained.id, token: "" };
        } else {
          await query(
            tx,
            `update auth_sessions set revoked_at=now() where human_user_id=$1 and credential_kind='authorization_request' and revoked_at is null`,
            [row.id],
          );
          request = await issueSession(
            tx,
            row.principal_id,
            row.id,
            "authorization_request",
          );
        }
        await audit(
          tx,
          "auth.login.succeeded",
          row.principal_id,
          row.id,
          full.id,
        );
        return ok({
          user: humanUser(row),
          credentials: retained
            ? {
              token: full.token,
              fullSessionId: full.id,
              requestSessionId: retained.id,
              requestRetained: true,
            }
            : issuedCredentials(full, request),
        });
      }) as Result<LoginResult>;
    } finally {
      release();
    }
  }

  async currentIdentity(auth: AuthContext): Promise<Result<CurrentIdentity>> {
    const base = (await query<
      UserRow & {
        session_active: boolean;
        context_active: boolean;
        principal_active: boolean;
      }
    >(
      this.sql,
      `select u.id,u.principal_id,u.username,u.display_name,u.status,
              (s.revoked_at is null) session_active,
              (c.id is not null) context_active,
              p.active principal_active
         from human_users u
         join principals p on p.id=$2
         join auth_sessions s on s.id=$3 and s.principal_id=$2
           and s.human_user_id=u.id and s.credential_kind=$4
           and s.authorization_id is not distinct from $5
         left join auth_contexts c on c.id=$6 and c.session_id=s.id
           and c.principal_id=$2 and c.credential_kind=$4
           and c.authorization_id is not distinct from $5
        where u.id=$1`,
      [
        auth.humanUserId,
        auth.principalId,
        auth.sessionId,
        auth.credentialKind,
        auth.authorizationId ?? null,
        auth.id,
      ],
    )).rows[0];
    if (
      !base || !base.session_active || !base.context_active ||
      !base.principal_active || base.status !== "active"
    ) return credentialInvalid();

    let agent: CurrentIdentity["agent"];
    let roleAssignments: RoleAssignment[];
    if (auth.credentialKind === "agent_authorization") {
      if (!auth.authorizationId || auth.principalType !== "agent_user") {
        return credentialInvalid();
      }
      const lineage = await loadActiveAuthorizationLineage(this.sql, {
        authorizationId: auth.authorizationId,
        principalId: auth.principalId,
        humanUserId: auth.humanUserId,
      });
      if (!lineage.ok) return credentialInvalid();
      const current = lineage.value.current;
      agent = {
        id: current.agentUserId,
        principalId: current.agentPrincipalId,
        name: current.agentName ?? "agent",
        authorizationId: current.authorizationId,
        ...(current.parentAuthorizationId
          ? { parentAuthorizationId: current.parentAuthorizationId }
          : {}),
        rootAuthorizationId: lineage.value.rootAuthorizationId,
        authorizationAncestryIds: lineage.value.ancestry.map((entry) =>
          entry.authorizationId
        ),
      };
      const rows = (await query<{
        role_id: string;
        boundary_type: "project" | "all_projects" | "system";
        project_id: string | null;
      }>(
        this.sql,
        `with recursive lineage(id,parent_authorization_id) as (
           select id,parent_authorization_id from agent_authorizations where id=$1
           union
           select parent.id,parent.parent_authorization_id
             from agent_authorizations parent
             join lineage child on child.parent_authorization_id=parent.id
         )
         select ar.role_id,ar.boundary_type,ar.project_id
           from agent_authorization_roles ar
          where ar.authorization_id=$1
            and not exists (
              select 1 from lineage ancestor
              join agent_authorizations original on original.id=ancestor.id
              where ancestor.id<>$1 and not exists (
                select 1 from agent_authorizations current
                join agent_authorization_roles upstream
                  on upstream.authorization_id=current.id
                where current.agent_user_id=original.agent_user_id
                  and current.revoked_at is null
                  and current.superseded_at is null
                  and upstream.role_id=ar.role_id
                  and upstream.boundary_type=ar.boundary_type
                  and upstream.project_id is not distinct from ar.project_id
              )
            )
          order by ar.role_id,ar.boundary_type,ar.project_id`,
        [auth.authorizationId],
      )).rows;
      roleAssignments = rows.map((row) => ({
        role: row.role_id,
        boundary: boundaryFromRow(row),
      }));
    } else {
      const rows = auth.credentialKind === "human_full"
        ? (await query<{
          role_id: string;
          boundary_type: "project" | "all_projects" | "system";
          project_id: string | null;
        }>(
          this.sql,
          `select role_id,boundary_type,project_id from role_assignments
            where principal_id=$1 and active
            order by role_id,boundary_type,project_id`,
          [auth.principalId],
        )).rows
        : [];
      roleAssignments = rows.map((row) => ({
        role: row.role_id,
        boundary: boundaryFromRow(row),
      }));
    }
    return ok({
      credentialKind: auth.credentialKind,
      principalType: auth.principalType,
      principalId: auth.principalId,
      humanUser: humanUser(base),
      ...(agent ? { agent } : {}),
      roleAssignments,
      sessionId: auth.sessionId,
      authContextId: auth.id,
      active: true,
    });
  }

  async current(auth: AuthContext): Promise<Result<HumanUser>> {
    const identity = await this.currentIdentity(auth);
    return identity.ok ? ok(identity.value.humanUser) : identity;
  }

  async sessions(auth: AuthContext): Promise<Result<HumanSession[]>> {
    const rows = (await query<
      { id: string; credential_kind: CredentialKind; created_at: Date }
    >(
      this.sql,
      `select id,credential_kind,created_at from auth_sessions where human_user_id=$1 and revoked_at is null order by created_at`,
      [auth.humanUserId],
    )).rows;
    return ok(
      rows.map((row) => ({
        id: row.id,
        credentialKind: row.credential_kind,
        createdAt: new Date(row.created_at).toISOString(),
        current: row.id === auth.sessionId,
      })),
    );
  }

  async logout(auth: AuthContext): Promise<Result<{ revoked: true }>> {
    await query(
      this.sql,
      `update auth_sessions set revoked_at=now() where id=$1 and revoked_at is null`,
      [auth.sessionId],
    );
    await audit(
      this.sql,
      "auth.session.revoked",
      auth.principalId,
      auth.humanUserId,
      auth.sessionId,
      auth.id,
    );
    return ok({ revoked: true });
  }

  async logoutAll(
    auth: AuthContext,
    password: string,
  ): Promise<Result<{ revoked: number }>> {
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      return await this.sql.begin(async (tx) => {
        const confirmed = await confirmHumanPassword(
          tx,
          auth.humanUserId,
          password,
        );
        if (!confirmed.ok) return confirmed;
        const result = await query(
          tx,
          `update auth_sessions set revoked_at=now() where human_user_id=$1 and revoked_at is null returning id`,
          [auth.humanUserId],
        );
        await audit(
          tx,
          "auth.sessions.revoked_all",
          auth.principalId,
          auth.humanUserId,
          auth.sessionId,
          auth.id,
        );
        return ok({ revoked: result.rows.length });
      }) as Result<{ revoked: number }>;
    } finally {
      release();
    }
  }

  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<Result<LoginResult>> {
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      return await this.sql.begin(async (tx) => {
        const confirmed = await confirmHumanPassword(
          tx,
          auth.humanUserId,
          currentPassword,
        );
        if (!confirmed.ok) return confirmed;
        const user = confirmed.value;
        const phc = await hashPassword(newPassword);
        await query(
          tx,
          `update password_credentials set phc_hash=$2,profile='argon2id.v1',password_changed_at=now() where human_user_id=$1`,
          [user.id, phc],
        );
        await revokeAnchored(tx, user.id);
        await query(
          tx,
          `update login_throttles set failure_count=0,next_allowed_at=null,updated_at=now() where username=$1`,
          [user.username],
        );
        const full = await issueSession(
          tx,
          user.principal_id,
          user.id,
          "human_full",
        );
        const request = await issueSession(
          tx,
          user.principal_id,
          user.id,
          "authorization_request",
        );
        await audit(
          tx,
          "auth.password.changed",
          user.principal_id,
          user.id,
          full.id,
          auth.id,
        );
        return ok({
          user: humanUser(user),
          credentials: issuedCredentials(full, request),
        });
      }) as Result<LoginResult>;
    } finally {
      release();
    }
  }

  async listUsers(auth: AuthContext): Promise<Result<HumanUser[]>> {
    if (!isSuperAdmin(auth)) return authorizationDenied();
    const rows = (await query<UserRow>(
      this.sql,
      `select id,principal_id,username,display_name,status from human_users order by username`,
    )).rows;
    return ok(rows.map(humanUser));
  }

  async createUser(
    auth: AuthContext,
    input: { username: string; displayName: string; password: string },
  ): Promise<Result<HumanUser>> {
    if (!isSuperAdmin(auth)) return authorizationDenied();
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      const phc = await hashPassword(input.password);
      return await this.sql.begin(async (tx) => {
        const principalId = uuidV7();
        const id = uuidV7();
        await query(
          tx,
          `insert into principals(id,type,active) values($1,'human_user',true)`,
          [principalId],
        );
        await query(
          tx,
          `insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,$4,'active')`,
          [id, principalId, input.username, input.displayName],
        );
        await query(
          tx,
          `insert into password_credentials(human_user_id,profile,phc_hash) values($1,'argon2id.v1',$2)`,
          [id, phc],
        );
        await audit(
          tx,
          "auth.human_user.created",
          auth.principalId,
          id,
          undefined,
          auth.id,
        );
        return ok({
          id,
          principalId,
          username: input.username,
          displayName: input.displayName,
          status: "active" as const,
        });
      }) as Result<HumanUser>;
    } catch (error) {
      if (String(error).includes("human_users_username_key")) {
        return err(
          authError("validation_failed", "username already exists", "conflict"),
        );
      }
      throw error;
    } finally {
      release();
    }
  }

  async setUserStatus(
    auth: AuthContext,
    userId: string,
    status: "active" | "disabled",
  ): Promise<Result<HumanUser>> {
    if (!isSuperAdmin(auth)) return authorizationDenied();
    return await this.sql.begin(async (tx) => {
      const activeSuperAdmins = status === "disabled"
        ? await lockActiveHumanSuperAdmins(tx)
        : [];
      const target = (await query<UserRow>(
        tx,
        `select id,principal_id,username,display_name,status from human_users where id=$1 for update`,
        [userId],
      )).rows[0];
      if (!target) {
        return err(authError("not_found", "user was not found", "not_found"));
      }
      if (status === "disabled") {
        const activeSuperAdminPrincipals = new Set(
          activeSuperAdmins.map((row) => row.principal_id),
        );
        const hasSuper = activeSuperAdminPrincipals.has(target.principal_id);
        if (hasSuper) {
          if (activeSuperAdminPrincipals.size <= 1) {
            return err(
              authError(
                "last_super_admin",
                "the final active human super-admin cannot be disabled",
                "conflict",
              ),
            );
          }
        }
        await revokeAnchored(tx, userId);
      }
      await query(
        tx,
        `update human_users set status=$2,disabled_at=case when $2='disabled' then now() else null end where id=$1`,
        [userId, status],
      );
      await query(tx, `update principals set active=$2 where id=$1`, [
        target.principal_id,
        status === "active",
      ]);
      await audit(
        tx,
        status === "active"
          ? "auth.human_user.enabled"
          : "auth.human_user.disabled",
        auth.principalId,
        userId,
        undefined,
        auth.id,
      );
      return ok({ ...humanUser(target), status });
    }) as Result<HumanUser>;
  }

  async createPasswordReset(
    input: { username: string; nonceHash: string; idempotencyKey: string },
  ): Promise<Result<{ requestId: string }>> {
    return await this.sql.begin(async (tx) => {
      const existing = (await query<{ id: string }>(
        tx,
        `select id from password_reset_requests where username=$1 and idempotency_key=$2`,
        [input.username, input.idempotencyKey],
      )).rows[0];
      if (existing) return ok({ requestId: existing.id });
      await query(
        tx,
        `insert into password_reset_throttles(username) values($1) on conflict do nothing`,
        [input.username],
      );
      const throttle =
        (await query<{ request_count: number; window_started_at: Date }>(
          tx,
          `select request_count,window_started_at from password_reset_throttles where username=$1 for update`,
          [input.username],
        )).rows[0]!;
      const freshWindow =
        Date.now() - new Date(throttle.window_started_at).getTime() >=
          15 * 60_000;
      if (!freshWindow && throttle.request_count >= 5) {
        const retry = Math.max(
          1,
          Math.ceil(
            (new Date(throttle.window_started_at).getTime() + 15 * 60_000 -
              Date.now()) / 1000,
          ),
        );
        return err(
          authError(
            "password_reset_throttled",
            "password reset requests are temporarily throttled",
            "rate_limited",
            { retry_after_seconds: retry },
          ),
        );
      }
      await query(
        tx,
        `update password_reset_throttles set request_count=case when $2 then 1 else request_count+1 end,window_started_at=case when $2 then now() else window_started_at end,updated_at=now() where username=$1`,
        [input.username, freshWindow],
      );
      const user = (await query<{ id: string }>(
        tx,
        `select id from human_users where username=$1`,
        [input.username],
      )).rows[0];
      const id = uuidV7();
      await query(
        tx,
        `insert into password_reset_requests(id,human_user_id,username,idempotency_key,nonce_digest,status,expires_at) values($1,$2,$3,$4,$5,'pending',now()+interval '30 minutes')`,
        [
          id,
          user?.id ?? null,
          input.username,
          input.idempotencyKey,
          input.nonceHash,
        ],
      );
      return ok({ requestId: id });
    }) as Result<{ requestId: string }>;
  }

  async createPasswordResetWatchTicket(
    id: string,
    nonce: string,
  ): Promise<Result<{ ticket: string }>> {
    return await this.sql.begin(async (tx) => {
      const row = await resetRow(tx, id, true);
      if (
        !row ||
        !constantTimeDigestEqual(row.nonce_digest, await tokenDigest(nonce))
      ) {
        return err(
          authError(
            "password_reset_not_found",
            "password reset was not found",
            "not_found",
          ),
        );
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return err(
          authError(
            "password_reset_expired",
            "password reset has expired",
            "expired",
          ),
        );
      }
      const ticket = opaqueToken();
      await query(
        tx,
        `insert into password_reset_watch_tickets(token_digest,request_id,expires_at) values($1,$2,now()+interval '60 seconds')`,
        [await tokenDigest(ticket), id],
      );
      return ok({ ticket });
    }) as Result<{ ticket: string }>;
  }

  async consumePasswordResetWatchTicket(
    id: string,
    ticket: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  > {
    return await this.sql.begin(async (tx) => {
      const digest = await tokenDigest(ticket);
      const found = (await query<
        { request_id: string; expires_at: Date; used_at: Date | null }
      >(
        tx,
        `select request_id,expires_at,used_at from password_reset_watch_tickets where token_digest=$1 for update`,
        [digest],
      )).rows[0];
      if (!found || found.request_id !== id || found.used_at) {
        return err(
          authError(
            "watch_ticket_invalid",
            "watch ticket is invalid",
            "authentication",
          ),
        );
      }
      if (new Date(found.expires_at).getTime() <= Date.now()) {
        return err(
          authError(
            "watch_ticket_expired",
            "watch ticket has expired",
            "expired",
          ),
        );
      }
      await query(
        tx,
        `update password_reset_watch_tickets set used_at=now() where token_digest=$1`,
        [digest],
      );
      return await readPasswordResetStatus(tx, id);
    }) as Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >;
  }

  async passwordResetStatus(
    id: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  > {
    return await readPasswordResetStatus(this.sql, id);
  }

  async subscribePasswordReset(
    id: string,
    listener: () => void,
  ): Promise<() => void> {
    if (!this.resetListener) {
      this.resetListener = this.sql.listen(
        "operant_password_reset",
        (requestId: string) => {
          for (
            const notify of passwordResetListeners.get(requestId) ?? []
          ) notify();
        },
      );
    }
    try {
      await this.resetListener;
    } catch (error) {
      this.resetListener = undefined;
      throw error;
    }
    let listeners = passwordResetListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      passwordResetListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) passwordResetListeners.delete(id);
    };
  }

  async close(): Promise<void> {
    const reset = this.resetListener;
    const agent = this.agentRequestListener;
    this.resetListener = undefined;
    this.agentRequestListener = undefined;
    if (reset) await (await reset).unlisten();
    if (agent) await (await agent).unlisten();
  }

  async inspectPasswordReset(
    auth: AuthContext,
    id: string,
  ): Promise<Result<PasswordReset>> {
    if (!isSuperAdmin(auth)) return authorizationDenied();
    const row = await resetRow(this.sql, id);
    if (!row || !row.human_user_id) {
      return err(
        authError(
          "password_reset_not_found",
          "password reset was not found",
          "not_found",
        ),
      );
    }
    return ok(passwordReset(row));
  }

  async decidePasswordReset(
    auth: AuthContext,
    id: string,
    decision: "approved" | "denied",
  ): Promise<Result<PasswordReset>> {
    if (!isSuperAdmin(auth)) return authorizationDenied();
    return await this.sql.begin(async (tx) => {
      const row = await resetRow(tx, id, true);
      if (!row || !row.human_user_id) {
        return err(
          authError(
            "password_reset_not_found",
            "password reset was not found",
            "not_found",
          ),
        );
      }
      const transition = transitionPasswordReset(
        row.status,
        decision === "approved" ? "approve" : "deny",
        new Date(row.expires_at).getTime() <= Date.now(),
      );
      if (!transition.ok) return transition;
      const status = transition.value;
      if (status === "expired") {
        return err(
          authError(
            "password_reset_expired",
            "password reset has expired",
            "expired",
          ),
        );
      }
      if (row.status === status) return ok(passwordReset(row));
      await query(
        tx,
        `update password_reset_requests set status=$2,version=version+1,decided_by_auth_context_id=$3,decided_at=now() where id=$1`,
        [id, status, auth.id],
      );
      await signalPasswordReset(tx, id);
      await audit(
        tx,
        `auth.password_reset.${status}`,
        auth.principalId,
        row.human_user_id,
        undefined,
        auth.id,
      );
      return ok(passwordReset({ ...row, status }));
    }) as Result<PasswordReset>;
  }

  async cancelPasswordReset(
    id: string,
    nonce: string,
  ): Promise<Result<PasswordReset>> {
    return await this.sql.begin(async (tx) => {
      const row = await resetRow(tx, id, true);
      if (
        !row ||
        !constantTimeDigestEqual(row.nonce_digest, await tokenDigest(nonce))
      ) {
        return err(
          authError(
            "password_reset_not_found",
            "password reset was not found",
            "not_found",
          ),
        );
      }
      if (row.status !== "pending") {
        return err(
          authError(
            "request_not_pending",
            "password reset is not pending",
            "conflict",
          ),
        );
      }
      await query(
        tx,
        `update password_reset_requests set status='cancelled',version=version+1 where id=$1`,
        [id],
      );
      await signalPasswordReset(tx, id);
      return ok(passwordReset({ ...row, status: "cancelled" }));
    }) as Result<PasswordReset>;
  }

  async redeemPasswordReset(
    id: string,
    nonce: string,
  ): Promise<Result<{ capability: string }>> {
    return await this.sql.begin(async (tx) => {
      const row = await resetRow(tx, id, true);
      if (
        !row || !row.human_user_id ||
        !constantTimeDigestEqual(row.nonce_digest, await tokenDigest(nonce))
      ) {
        return err(
          authError(
            "redemption_invalid",
            "redemption credential is invalid",
            "authentication",
          ),
        );
      }
      if (row.status !== "approved") {
        return err(authError(
          row.status === "denied"
            ? "password_reset_denied"
            : "request_not_pending",
          "password reset cannot be redeemed",
          "conflict",
        ));
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return err(
          authError(
            "password_reset_expired",
            "password reset has expired",
            "expired",
          ),
        );
      }
      const capability = opaqueToken();
      await query(
        tx,
        `update password_reset_requests set capability_digest=$2,redeemed_at=now() where id=$1`,
        [id, await tokenDigest(capability)],
      );
      return ok({ capability });
    }) as Result<{ capability: string }>;
  }

  async completePasswordReset(
    id: string,
    capability: string,
    password: string,
  ): Promise<Result<LoginResult>> {
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      const phc = await hashPassword(password);
      return await this.sql.begin(async (tx) => {
        const row = await resetRow(tx, id, true);
        if (row?.status === "completed") {
          return err(
            authError(
              "redemption_already_used",
              "reset capability was already used",
              "conflict",
            ),
          );
        }
        if (
          !row || !row.human_user_id || !row.capability_digest ||
          !constantTimeDigestEqual(
            row.capability_digest,
            await tokenDigest(capability),
          )
        ) {
          return err(
            authError(
              "password_reset_capability_invalid",
              "reset capability is invalid",
              "authentication",
            ),
          );
        }
        if (row.status !== "approved") {
          return err(
            authError(
              "password_reset_capability_invalid",
              "reset capability is invalid",
              "authentication",
            ),
          );
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await query(
            tx,
            `update password_reset_requests set status='expired',version=version+1,capability_digest=null where id=$1`,
            [id],
          );
          await signalPasswordReset(tx, id);
          return err(
            authError(
              "password_reset_expired",
              "password reset has expired",
              "expired",
            ),
          );
        }
        const user = (await query<UserRow>(
          tx,
          `select id,principal_id,username,display_name,status from human_users where id=$1 for update`,
          [row.human_user_id],
        )).rows[0]!;
        await query(
          tx,
          `update password_credentials set phc_hash=$2,profile='argon2id.v1',password_changed_at=now() where human_user_id=$1`,
          [user.id, phc],
        );
        await revokeAnchored(tx, user.id);
        await query(
          tx,
          `update login_throttles set failure_count=0,next_allowed_at=null,updated_at=now() where username=$1`,
          [user.username],
        );
        const full = await issueSession(
          tx,
          user.principal_id,
          user.id,
          "human_full",
        );
        const request = await issueSession(
          tx,
          user.principal_id,
          user.id,
          "authorization_request",
        );
        await query(
          tx,
          `update password_reset_requests set status='completed',version=version+1,completed_at=now(),capability_digest=null where id=$1`,
          [id],
        );
        await signalPasswordReset(tx, id);
        await audit(
          tx,
          "auth.password_reset.completed",
          user.principal_id,
          user.id,
          full.id,
        );
        return ok({
          user: humanUser(user),
          credentials: issuedCredentials(full, request),
        });
      }) as Result<LoginResult>;
    } finally {
      release();
    }
  }

  async beginRecovery(
    input: {
      username: string;
      token: string;
      enableUser: boolean;
      restoreSuperAdmin: boolean;
      replace?: boolean;
    },
  ): Promise<Result<{ challengeId: string }>> {
    if (input.token.length < 32) {
      return err(
        authError(
          "recovery_invalid",
          "recovery credential must contain at least 32 characters",
          "authentication",
        ),
      );
    }
    return await this.sql.begin(async (tx) => {
      await query(
        tx,
        `select pg_advisory_xact_lock(hashtext('operant.auth.recovery'))`,
      );
      const user = (await query<UserRow>(
        tx,
        `select id,principal_id,username,display_name,status from human_users where username=$1 for update`,
        [input.username],
      )).rows[0];
      if (!user) {
        return err(
          authError(
            "recovery_invalid",
            "recovery target is invalid",
            "authentication",
          ),
        );
      }
      let active: {
        id: string;
        created_at: Date;
        expires_at: Date;
        enable_user: boolean;
        restore_super_admin: boolean;
      } | undefined = (await query<{
        id: string;
        created_at: Date;
        expires_at: Date;
        enable_user: boolean;
        restore_super_admin: boolean;
      }>(
        tx,
        `select id,created_at,expires_at,enable_user,restore_super_admin from recovery_challenges where human_user_id=$1 and status='active' for update`,
        [user.id],
      )).rows[0];
      if (active && new Date(active.expires_at).getTime() <= Date.now()) {
        const expired = (await query<{ expired_at: Date }>(
          tx,
          `update recovery_challenges set status='expired',expired_at=now(),token_digest=null where id=$1 returning expired_at`,
          [active.id],
        )).rows[0]!;
        await auditRecovery(tx, "auth.recovery.expired", {
          targetHumanUserId: user.id,
          challengeId: active.id,
          initiatedAt: active.created_at,
          terminalAt: expired.expired_at,
          enableUser: active.enable_user,
          restoreSuperAdmin: active.restore_super_admin,
          outcome: "expired",
          reason: "challenge_expired_before_replacement",
        });
        active = undefined;
      }
      if (active && !input.replace) {
        return err(
          authError(
            "recovery_invalid",
            "an active recovery challenge already exists",
            "conflict",
          ),
        );
      }
      if (active) {
        const cancelled = (await query<{ cancelled_at: Date }>(
          tx,
          `update recovery_challenges set status='cancelled',cancelled_at=now(),token_digest=null where id=$1 returning cancelled_at`,
          [active.id],
        )).rows[0]!;
        await auditRecovery(tx, "auth.recovery.cancelled", {
          targetHumanUserId: user.id,
          challengeId: active.id,
          initiatedAt: active.created_at,
          terminalAt: cancelled.cancelled_at,
          enableUser: active.enable_user,
          restoreSuperAdmin: active.restore_super_admin,
          outcome: "cancelled",
          reason: "challenge_replaced",
        });
      }
      await revokeAnchored(tx, user.id);
      const id = uuidV7();
      const initiated = (await query<{ created_at: Date }>(
        tx,
        `insert into recovery_challenges(id,human_user_id,token_digest,enable_user,restore_super_admin,status,expires_at) values($1,$2,$3,$4,$5,'active',now()+interval '15 minutes') returning created_at`,
        [
          id,
          user.id,
          await tokenDigest(input.token),
          input.enableUser,
          input.restoreSuperAdmin,
        ],
      )).rows[0]!;
      await auditRecovery(tx, "auth.recovery.initiated", {
        targetHumanUserId: user.id,
        challengeId: id,
        initiatedAt: initiated.created_at,
        enableUser: input.enableUser,
        restoreSuperAdmin: input.restoreSuperAdmin,
        outcome: "initiated",
        reason: "host_operator_requested",
      });
      return ok({ challengeId: id });
    }) as Result<{ challengeId: string }>;
  }

  async cancelRecovery(username: string): Promise<Result<{ cancelled: true }>> {
    return await this.sql.begin(async (tx) => {
      const row = (await query<
        {
          id: string;
          human_user_id: string;
          principal_id: string;
          created_at: Date;
          enable_user: boolean;
          restore_super_admin: boolean;
        }
      >(
        tx,
        `select r.id,r.human_user_id,u.principal_id,r.created_at,r.enable_user,r.restore_super_admin from recovery_challenges r join human_users u on u.id=r.human_user_id where u.username=$1 and r.status='active' for update`,
        [username],
      )).rows[0];
      if (!row) {
        return err(
          authError(
            "recovery_invalid",
            "active recovery challenge was not found",
            "not_found",
          ),
        );
      }
      const cancelled = (await query<{ cancelled_at: Date }>(
        tx,
        `update recovery_challenges set status='cancelled',cancelled_at=now(),token_digest=null where id=$1 returning cancelled_at`,
        [row.id],
      )).rows[0]!;
      await auditRecovery(tx, "auth.recovery.cancelled", {
        targetHumanUserId: row.human_user_id,
        challengeId: row.id,
        initiatedAt: row.created_at,
        terminalAt: cancelled.cancelled_at,
        enableUser: row.enable_user,
        restoreSuperAdmin: row.restore_super_admin,
        outcome: "cancelled",
        reason: "host_operator_cancelled",
      });
      return ok({ cancelled: true as const });
    }) as Result<{ cancelled: true }>;
  }

  async completeRecovery(
    input: { username: string; token: string; password: string },
  ): Promise<Result<LoginResult>> {
    const release = this.hashes.tryAcquire();
    if (!release) {
      return err(
        authError(
          "authentication_busy",
          "authentication is busy",
          "unavailable",
          { retry_after_seconds: 1 },
        ),
      );
    }
    try {
      const phc = await hashPassword(input.password);
      return await this.sql.begin(async (tx) => {
        const row = (await query<
          UserRow & {
            token_digest: string;
            challenge_id: string;
            expires_at: Date;
            enable_user: boolean;
            restore_super_admin: boolean;
            created_at: Date;
          }
        >(
          tx,
          `select u.id,u.principal_id,u.username,u.display_name,u.status,r.id challenge_id,r.token_digest,r.expires_at,r.enable_user,r.restore_super_admin,r.created_at from recovery_challenges r join human_users u on u.id=r.human_user_id where u.username=$1 and r.status='active' for update`,
          [input.username],
        )).rows[0];
        if (
          !row ||
          !constantTimeDigestEqual(
            row.token_digest,
            await tokenDigest(input.token),
          )
        ) {
          return err(
            authError(
              "recovery_invalid",
              "recovery credential is invalid",
              "authentication",
            ),
          );
        }
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          const expired = (await query<{ expired_at: Date }>(
            tx,
            `update recovery_challenges set status='expired',expired_at=now(),token_digest=null where id=$1 returning expired_at`,
            [row.challenge_id],
          )).rows[0]!;
          await auditRecovery(tx, "auth.recovery.expired", {
            targetHumanUserId: row.id,
            challengeId: row.challenge_id,
            initiatedAt: row.created_at,
            terminalAt: expired.expired_at,
            enableUser: row.enable_user,
            restoreSuperAdmin: row.restore_super_admin,
            outcome: "expired",
            reason: "challenge_expired",
          });
          return err(
            authError(
              "recovery_expired",
              "recovery challenge has expired",
              "expired",
            ),
          );
        }
        await query(
          tx,
          `update password_credentials set phc_hash=$2,profile='argon2id.v1',password_changed_at=now() where human_user_id=$1`,
          [row.id, phc],
        );
        if (row.enable_user) {
          await query(
            tx,
            `update human_users set status='active',disabled_at=null where id=$1`,
            [row.id],
          );
          await query(tx, `update principals set active=true where id=$1`, [
            row.principal_id,
          ]);
        }
        if (row.restore_super_admin) {
          await query(
            tx,
            `insert into role_assignments(id,principal_id,role_id,boundary_type,active) select $1,$2,'system:super_admin','system',true where not exists(select 1 from role_assignments where principal_id=$2 and role_id='system:super_admin' and active)`,
            [uuidV7(), row.principal_id],
          );
        }
        const full = await issueSession(
          tx,
          row.principal_id,
          row.id,
          "human_full",
        );
        const request = await issueSession(
          tx,
          row.principal_id,
          row.id,
          "authorization_request",
        );
        const completed = (await query<{ completed_at: Date }>(
          tx,
          `update recovery_challenges set status='completed',completed_at=now(),token_digest=null where id=$1 returning completed_at`,
          [row.challenge_id],
        )).rows[0]!;
        await auditRecovery(tx, "auth.recovery.completed", {
          targetHumanUserId: row.id,
          challengeId: row.challenge_id,
          initiatedAt: row.created_at,
          terminalAt: completed.completed_at,
          enableUser: row.enable_user,
          restoreSuperAdmin: row.restore_super_admin,
          outcome: "completed",
          reason: "recovery_completed",
          replacementSessionId: full.id,
        });
        return ok({
          user: humanUser({
            ...row,
            status: row.enable_user ? "active" : row.status,
          }),
          credentials: issuedCredentials(full, request),
        });
      }) as Result<LoginResult>;
    } finally {
      release();
    }
  }

  async discoverRoles(auth: AuthContext, boundary: AuthorizationBoundary) {
    if (
      auth.credentialKind !== "authorization_request" &&
      auth.credentialKind !== "human_full" &&
      auth.credentialKind !== "agent_authorization"
    ) {
      return authorizationDenied();
    }
    const params = boundaryParams(boundary);
    const anchorSuperAdmin = Boolean(
      (await query<{ found: boolean }>(
        this.sql,
        `select exists(
         select 1 from human_users u
         join role_assignments ra on ra.principal_id=u.principal_id
         where u.id=$1 and u.status='active' and ra.active
           and ra.role_id='system:super_admin' and ra.boundary_type='system'
       ) found`,
        [auth.humanUserId],
      )).rows[0]?.found,
    );
    const rows = anchorSuperAdmin
      ? (await query<{ role_id: string }>(
        this.sql,
        `select r.id role_id from system_roles r where r.active
          and exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
         order by r.id`,
      )).rows
      : auth.authorizationId
      ? (await query<{ role_id: string }>(
        this.sql,
        `select distinct ar.role_id from agent_authorizations a
          join agent_authorization_roles ar on ar.authorization_id=a.id
          join system_roles r on r.id=ar.role_id and r.active
         where a.id=$1 and a.human_user_id=$4 and a.revoked_at is null and a.superseded_at is null
           and exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
           and ${authorizationBoundaryPredicate("ar", "$2", "$3")}
         order by ar.role_id`,
        [auth.authorizationId, ...params, auth.humanUserId],
      )).rows
      : (await query<{ role_id: string }>(
        this.sql,
        `select distinct ra.role_id from role_assignments ra
          join human_users u on u.principal_id=ra.principal_id and u.status='active'
          join system_roles r on r.id=ra.role_id and r.active
         where u.id=$1 and ra.active
           and exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
           and ${authorizationBoundaryPredicate("ra", "$2", "$3")}
         order by ra.role_id`,
        [auth.humanUserId, ...params],
      )).rows;
    return ok({
      roles: [...new Set(rows.map((row) => row.role_id))],
      boundary,
    });
  }

  async createAuthorizationRequest(
    auth: AuthContext,
    input: {
      roles: string[];
      boundary: AuthorizationBoundary;
      reason: string;
      nonceHash: string;
      idempotencyKey: string;
      agentName?: string;
    },
  ) {
    if (
      auth.credentialKind !== "authorization_request" &&
      auth.credentialKind !== "agent_authorization"
    ) return authorizationDenied();
    if (auth.authorizationId) {
      const [boundaryType, projectId] = boundaryParams(input.boundary);
      const held = (await query<{ role_id: string }>(
        this.sql,
        `select ar.role_id from agent_authorizations a
          join agent_authorization_roles ar on ar.authorization_id=a.id
         where a.id=$1 and a.human_user_id=$4 and a.revoked_at is null and a.superseded_at is null
           and ${authorizationBoundaryPredicate("ar", "$2", "$3")}`,
        [
          auth.authorizationId,
          boundaryType,
          projectId,
          auth.humanUserId,
        ],
      )).rows.map((row) => row.role_id);
      if (input.roles.every((role) => held.includes(role))) {
        return ok({
          id: auth.authorizationId,
          status: "approved" as const,
          version: 1,
          roles: input.roles,
          boundary: input.boundary,
          reason: input.reason,
          createdAt: auth.createdAt,
          alreadyAuthorized: true,
          authorizationId: auth.authorizationId,
        });
      }
    }
    return await this.sql.begin(async (tx) => {
      const existing = (await query<AgentRequestRow>(
        tx,
        `select * from agent_authorization_requests where requester_session_id=$1 and idempotency_key=$2`,
        [auth.sessionId, input.idempotencyKey],
      )).rows[0];
      if (existing) return ok(agentRequest(existing));
      const requestable = await this.discoverRoles(auth, input.boundary);
      if (!requestable.ok) return requestable;
      const unavailable = input.roles.filter((role) =>
        !requestable.value.roles.includes(role)
      );
      if (unavailable.length) {
        return err(
          authError(
            "authorization_insufficient",
            "one or more requested roles are not currently requestable",
            "authorization",
            { roles: unavailable },
          ),
        );
      }
      const id = uuidV7();
      const [boundaryType, projectId] = boundaryParams(input.boundary);
      const inserted = (await query<AgentRequestRow>(
        tx,
        `insert into agent_authorization_requests(id,requester_session_id,requester_authorization_id,human_user_id,idempotency_key,roles,boundary_type,project_id,reason,agent_name,nonce_digest,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') returning *`,
        [
          id,
          auth.sessionId,
          auth.authorizationId ?? null,
          auth.humanUserId,
          input.idempotencyKey,
          input.roles,
          boundaryType,
          projectId,
          input.reason,
          input.agentName ?? null,
          input.nonceHash,
        ],
      )).rows[0]!;
      await audit(
        tx,
        "auth.authorization_request.created",
        auth.principalId,
        auth.humanUserId,
        auth.sessionId,
        auth.id,
      );
      return ok(agentRequest(inserted));
    }) as Result<AgentAuthorizationRequest>;
  }

  async inspectAuthorizationRequest(auth: AuthContext, id: string) {
    const row = await agentRequestRow(this.sql, id);
    if (
      !row || (row.human_user_id !== auth.humanUserId && !isSuperAdmin(auth))
    ) {
      return err(
        authError(
          "not_found",
          "authorization request was not found",
          "not_found",
        ),
      );
    }
    return ok(agentRequest(row));
  }

  async decideAuthorizationRequest(
    auth: AuthContext,
    id: string,
    input: {
      decision: "approved" | "denied";
      reason?: string;
      agentName?: string;
      capabilitySummaryDigest?: string;
    },
  ) {
    return await this.sql.begin(async (tx) => {
      const row = await agentRequestRow(tx, id, true);
      if (!row || row.human_user_id !== auth.humanUserId) {
        return err(
          authError(
            "not_found",
            "authorization request was not found",
            "not_found",
          ),
        );
      }
      if (row.status !== "pending") {
        if (row.status === input.decision) return ok(agentRequest(row));
        return err(
          authError(
            "request_already_decided",
            "authorization request is already decided",
            "conflict",
          ),
        );
      }
      const grantable = await this.grantability.canDecide({
        auth,
        decision: input.decision,
        roles: row.roles,
        boundary: boundaryFromRow(row),
        state: new PostgresAgentAuthorizationGrantabilityState(tx),
      });
      if (!grantable.ok) return grantable;
      let authorizationId: string | null = null;
      if (input.decision === "approved") {
        const prior = row.requester_authorization_id
          ? (await query<
            {
              id: string;
              agent_user_id: string;
              parent_authorization_id: string | null;
              root_authorization_id: string;
            }
          >(
            tx,
            `select id,agent_user_id,parent_authorization_id,root_authorization_id from agent_authorizations where id=$1 and revoked_at is null for update`,
            [row.requester_authorization_id],
          )).rows[0]
          : undefined;
        let agentUserId = prior?.agent_user_id;
        if (!agentUserId) {
          const principalId = uuidV7();
          agentUserId = uuidV7();
          await query(
            tx,
            `insert into principals(id,type,active) values($1,'agent_user',true)`,
            [principalId],
          );
          await query(
            tx,
            `insert into agent_users(id,principal_id,human_user_id,name) values($1,$2,$3,$4)`,
            [
              agentUserId,
              principalId,
              row.human_user_id,
              input.agentName ?? row.agent_name ?? null,
            ],
          );
        }
        authorizationId = uuidV7();
        const parentId = prior
          ? prior.parent_authorization_id
          : auth.authorizationId ?? null;
        const rootId = prior
          ? prior.root_authorization_id
          : auth.authorizationId ?? authorizationId;
        await query(
          tx,
          `insert into agent_authorizations(id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id) values($1,$2,$3,$4,$5,$6)`,
          [
            authorizationId,
            agentUserId,
            row.human_user_id,
            parentId,
            rootId,
            auth.id,
          ],
        );
        if (prior) {
          const priorRoles = (await query<
            {
              role_id: string;
              boundary_type: string;
              project_id: string | null;
            }
          >(
            tx,
            `select role_id,boundary_type,project_id from agent_authorization_roles where authorization_id=$1`,
            [prior.id],
          )).rows;
          for (const role of priorRoles) {
            await query(
              tx,
              `insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type,project_id) values($1,$2,$3,$4,$5)`,
              [
                uuidV7(),
                authorizationId,
                role.role_id,
                role.boundary_type,
                role.project_id,
              ],
            );
          }
        }
        for (const role of row.roles) {
          await query(
            tx,
            `insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type,project_id) values($1,$2,$3,$4,$5) on conflict do nothing`,
            [
              uuidV7(),
              authorizationId,
              role,
              row.boundary_type,
              row.project_id,
            ],
          );
        }
      }
      const snapshot = {
        schema: "auth.authorization_decision.v1",
        request_id: id,
        requested_roles: row.roles,
        boundary: row.boundary_type === "project"
          ? { type: "project", project_id: row.project_id }
          : { type: row.boundary_type },
        approver_auth_context_id: auth.id,
        role_definition_versions: grantable.value.roleDefinitionVersions,
        policy_definition_versions: grantable.value.policyDefinitionVersions,
        capability_summary_digest: grantable.value.capabilitySummaryDigest,
      };
      const updated = (await query<AgentRequestRow>(
        tx,
        `update agent_authorization_requests set status=$2,version=version+1,authorization_id=$3,decided_by_auth_context_id=$4,denial_reason=$5,agent_name=coalesce($6,agent_name),decision_snapshot=$7::jsonb,decided_at=now() where id=$1 returning *`,
        [
          id,
          input.decision,
          authorizationId,
          auth.id,
          input.decision === "denied" ? input.reason : null,
          input.agentName ?? null,
          JSON.stringify(snapshot),
        ],
      )).rows[0]!;
      await signalAgentRequest(tx, id);
      await audit(
        tx,
        `auth.authorization_request.${input.decision}`,
        auth.principalId,
        auth.humanUserId,
        auth.sessionId,
        auth.id,
        snapshot,
      );
      return ok(agentRequest(updated));
    }) as Result<AgentAuthorizationRequest>;
  }

  async cancelAuthorizationRequest(auth: AuthContext, id: string) {
    return await this.sql.begin(async (tx) => {
      const row = await agentRequestRow(tx, id, true);
      if (!row || row.requester_session_id !== auth.sessionId) {
        return err(
          authError(
            "not_found",
            "authorization request was not found",
            "not_found",
          ),
        );
      }
      if (row.status !== "pending") {
        return err(
          authError(
            "request_not_pending",
            "authorization request is not pending",
            "conflict",
          ),
        );
      }
      const updated = (await query<AgentRequestRow>(
        tx,
        `update agent_authorization_requests set status='cancelled',version=version+1,decided_by_auth_context_id=$2,decision_snapshot=$3::jsonb,decided_at=now() where id=$1 returning *`,
        [
          id,
          auth.id,
          JSON.stringify({
            schema: "auth.authorization_decision.v1",
            request_id: id,
            outcome: "cancelled",
          }),
        ],
      )).rows[0]!;
      await signalAgentRequest(tx, id);
      await audit(
        tx,
        "auth.authorization_request.cancelled",
        auth.principalId,
        auth.humanUserId,
        auth.sessionId,
        auth.id,
        {
          schema: "auth.authorization_decision.v1",
          request_id: id,
          outcome: "cancelled",
        },
      );
      return ok(agentRequest(updated));
    }) as Result<AgentAuthorizationRequest>;
  }

  async createAuthorizationWatchTicket(auth: AuthContext, id: string) {
    const row = await agentRequestRow(this.sql, id);
    if (!row || row.requester_session_id !== auth.sessionId) {
      return err(
        authError(
          "not_found",
          "authorization request was not found",
          "not_found",
        ),
      );
    }
    const ticket = opaqueToken();
    await query(
      this.sql,
      `insert into agent_authorization_watch_tickets(token_digest,request_id,expires_at) values($1,$2,now()+interval '60 seconds')`,
      [await tokenDigest(ticket), id],
    );
    return ok({ ticket });
  }

  async consumeAuthorizationWatchTicket(id: string, ticket: string) {
    return await this.sql.begin(async (tx) => {
      const digest = await tokenDigest(ticket);
      const found = (await query<
        { request_id: string; expires_at: Date; used_at: Date | null }
      >(
        tx,
        `select request_id,expires_at,used_at from agent_authorization_watch_tickets where token_digest=$1 for update`,
        [digest],
      )).rows[0];
      if (!found || found.request_id !== id || found.used_at) {
        return err(
          authError(
            "watch_ticket_invalid",
            "watch ticket is invalid",
            "authentication",
          ),
        );
      }
      if (new Date(found.expires_at).getTime() <= Date.now()) {
        return err(
          authError(
            "watch_ticket_expired",
            "watch ticket has expired",
            "expired",
          ),
        );
      }
      await query(
        tx,
        `update agent_authorization_watch_tickets set used_at=now() where token_digest=$1`,
        [digest],
      );
      return await this.authorizationRequestStatus(id);
    }) as Result<AgentAuthorizationRequest>;
  }

  async authorizationRequestStatus(id: string) {
    const row = await agentRequestRow(this.sql, id);
    return row ? ok(agentRequest(row)) : err(
      authError(
        "not_found",
        "authorization request was not found",
        "not_found",
      ),
    );
  }

  async subscribeAuthorizationRequest(
    id: string,
    listener: () => void,
  ): Promise<() => void> {
    if (!this.agentRequestListener) {
      this.agentRequestListener = this.sql.listen(
        "operant_agent_authorization",
        (requestId: string) => {
          for (
            const notify of agentRequestListeners.get(requestId) ?? []
          ) notify();
        },
      );
    }
    try {
      await this.agentRequestListener;
    } catch (error) {
      this.agentRequestListener = undefined;
      throw error;
    }
    let listeners = agentRequestListeners.get(id);
    if (!listeners) agentRequestListeners.set(id, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) agentRequestListeners.delete(id);
    };
  }

  async redeemAuthorizationRequest(
    auth: AuthContext,
    id: string,
    nonce: string,
  ) {
    return await this.sql.begin(async (tx) => {
      const row = await agentRequestRow(tx, id, true);
      if (
        !row || row.requester_session_id !== auth.sessionId ||
        !constantTimeDigestEqual(row.nonce_digest, await tokenDigest(nonce))
      ) {
        return err(
          authError(
            "redemption_invalid",
            "redemption credential is invalid",
            "authentication",
          ),
        );
      }
      if (row.status === "denied") {
        return err(
          authError(
            "request_denied",
            "authorization request was denied",
            "authorization",
            { reason: row.denial_reason },
          ),
        );
      }
      if (row.status !== "approved" || !row.authorization_id) {
        return err(
          authError(
            "request_not_pending",
            "authorization request is not approved",
            "conflict",
          ),
        );
      }
      const lockedAuthorization = (await query<{ revoked_at: Date | null }>(
        tx,
        `select revoked_at from agent_authorizations where id=$1 for update`,
        [row.authorization_id],
      )).rows[0];
      const authorization = lockedAuthorization?.revoked_at
        ? undefined
        : await authorizationRow(tx, row.authorization_id);
      if (!authorization) {
        return err(
          authError(
            "request_invalidated",
            "authorization request was invalidated",
            "conflict",
          ),
        );
      }
      if (row.redeemed_at) {
        const used = (await query<{ used: boolean }>(
          tx,
          `select exists(
             select 1 from auth_sessions s
             join auth_contexts c on c.session_id=s.id
             where s.authorization_id=$1 and s.revoked_at is null
           ) used`,
          [authorization.id],
        )).rows[0]?.used;
        if (used) {
          return err(authError(
            "redemption_already_used",
            "authorization redemption was already used",
            "conflict",
          ));
        }
      }
      if (row.requester_authorization_id) {
        const replaced = (await query<{
          revoked_at: Date | null;
          superseded_at: Date | null;
        }>(
          tx,
          `select revoked_at,superseded_at from agent_authorizations where id=$1 for update`,
          [row.requester_authorization_id],
        )).rows[0];
        if (!replaced || replaced.revoked_at || replaced.superseded_at) {
          return err(
            authError(
              "request_invalidated",
              "authorization request was invalidated",
              "conflict",
            ),
          );
        }
        await query(
          tx,
          `update agent_authorizations set superseded_at=now() where id=$1`,
          [row.requester_authorization_id],
        );
      }
      await query(
        tx,
        `update auth_sessions set revoked_at=now() where authorization_id=$1 and revoked_at is null`,
        [authorization.id],
      );
      const principal = (await query<{ principal_id: string }>(
        tx,
        `select principal_id from agent_users where id=$1`,
        [authorization.agentUserId],
      )).rows[0]!;
      const issued = await issueAgentSession(
        tx,
        principal.principal_id,
        row.human_user_id,
        authorization.id,
      );
      await query(
        tx,
        `update agent_authorization_requests set redeemed_at=now() where id=$1`,
        [id],
      );
      await audit(
        tx,
        "auth.authorization.redeemed",
        principal.principal_id,
        row.human_user_id,
        issued.id,
        auth.id,
      );
      return ok({ authorization, token: issued.token });
    }) as Result<{ authorization: AgentAuthorization; token: string }>;
  }

  async listAuthorizations(auth: AuthContext) {
    const rows = (await query<{ id: string }>(
      this.sql,
      `select id from agent_authorizations where human_user_id=$1 order by created_at`,
      [auth.humanUserId],
    )).rows;
    const values: AgentAuthorization[] = [];
    for (const row of rows) {
      const value = await authorizationRow(this.sql, row.id);
      if (value) values.push(value);
    }
    return ok(values);
  }

  async revokeAuthorization(auth: AuthContext, id: string) {
    return await this.sql.begin(async (tx) => {
      const target =
        (await query<{ human_user_id: string; agent_user_id: string }>(
          tx,
          `select human_user_id,agent_user_id from agent_authorizations where id=$1 for update`,
          [id],
        )).rows[0];
      if (!target || target.human_user_id !== auth.humanUserId) {
        return err(
          authError("not_found", "authorization was not found", "not_found"),
        );
      }
      if (auth.authorizationId !== id && !isSuperAdmin(auth)) {
        return authorizationDenied();
      }
      await query(
        tx,
        `update agent_authorizations set revoked_at=coalesce(revoked_at,now()) where id=$1`,
        [id],
      );
      await query(
        tx,
        `update auth_sessions set revoked_at=coalesce(revoked_at,now()) where authorization_id=$1`,
        [id],
      );
      await audit(
        tx,
        "auth.authorization.revoked",
        auth.principalId,
        auth.humanUserId,
        auth.sessionId,
        auth.id,
      );
      return ok({ revoked: true as const });
    }) as Result<{ revoked: true }>;
  }
}

type AgentRequestRow = {
  id: string;
  requester_session_id: string;
  requester_authorization_id: string | null;
  human_user_id: string;
  roles: string[];
  boundary_type: "project" | "all_projects" | "system";
  project_id: string | null;
  reason: string;
  agent_name: string | null;
  nonce_digest: string;
  status: AgentAuthorizationRequest["status"];
  version: number;
  authorization_id: string | null;
  denial_reason: string | null;
  created_at: Date;
  redeemed_at: Date | null;
};

function boundaryParams(
  boundary: AuthorizationBoundary,
): [string, string | null] {
  return boundary.type === "project"
    ? [boundary.type, boundary.projectId]
    : [boundary.type, null];
}
function boundaryFromRow(
  row: {
    boundary_type: "project" | "all_projects" | "system";
    project_id: string | null;
  },
): AuthorizationBoundary {
  return row.boundary_type === "project"
    ? { type: "project", projectId: row.project_id! }
    : { type: row.boundary_type };
}
function agentRequest(row: AgentRequestRow): AgentAuthorizationRequest {
  return {
    id: row.id,
    status: row.status,
    version: Number(row.version),
    roles: row.roles,
    boundary: boundaryFromRow(row),
    reason: row.reason,
    ...(row.denial_reason ? { denialReason: row.denial_reason } : {}),
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
async function agentRequestRow(
  sql: Queryable,
  id: string,
  lock = false,
): Promise<AgentRequestRow | undefined> {
  return (await query<AgentRequestRow>(
    sql,
    `select * from agent_authorization_requests where id=$1${
      lock ? " for update" : ""
    }`,
    [id],
  )).rows[0];
}
async function authorizationRow(
  sql: Queryable,
  id: string,
): Promise<AgentAuthorization | undefined> {
  const row = (await query<
    {
      id: string;
      agent_user_id: string;
      human_user_id: string;
      parent_authorization_id: string | null;
      root_authorization_id: string;
      created_at: Date;
      revoked_at: Date | null;
    }
  >(
    sql,
    `select id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,created_at,revoked_at from agent_authorizations where id=$1`,
    [id],
  )).rows[0];
  if (!row) return;
  const roles = (await query<
    {
      role_id: string;
      boundary_type: "project" | "all_projects" | "system";
      project_id: string | null;
    }
  >(
    sql,
    `select role_id,boundary_type,project_id from agent_authorization_roles where authorization_id=$1 order by boundary_type,project_id,role_id`,
    [id],
  )).rows;
  return {
    id: row.id,
    agentUserId: row.agent_user_id,
    humanUserId: row.human_user_id,
    ...(row.parent_authorization_id
      ? { parentAuthorizationId: row.parent_authorization_id }
      : {}),
    rootAuthorizationId: row.root_authorization_id,
    roleAssignments: roles.map((role): RoleAssignment => ({
      role: role.role_id,
      boundary: boundaryFromRow(role),
    })),
    active: !row.revoked_at,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
async function issueAgentSession(
  sql: Queryable,
  principalId: string,
  humanUserId: string,
  authorizationId: string,
): Promise<{ id: string; token: string }> {
  const id = uuidV7();
  const token = opaqueToken();
  await query(
    sql,
    `insert into auth_sessions(id,principal_id,human_user_id,credential_kind,authorization_id,token_digest) values($1,$2,$3,'agent_authorization',$4,$5)`,
    [id, principalId, humanUserId, authorizationId, await tokenDigest(token)],
  );
  return { id, token };
}
const agentRequestListeners = new Map<string, Set<() => void>>();
async function signalAgentRequest(sql: Queryable, id: string): Promise<void> {
  await query(sql, `select pg_notify('operant_agent_authorization',$1)`, [id]);
  queueMicrotask(() => {
    for (const listener of agentRequestListeners.get(id) ?? []) listener();
  });
}

const passwordResetListeners = new Map<string, Set<() => void>>();

async function signalPasswordReset(sql: Queryable, id: string): Promise<void> {
  await query(sql, `select pg_notify('operant_password_reset', $1)`, [id]);
  setTimeout(() => {
    for (const listener of passwordResetListeners.get(id) ?? []) listener();
  }, 0);
}

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$hVNuIMcQVCGTBSGnJ6Bg8A$IA2Q5Wevful1bg2s1x2mfuyqmNlXMfR/M+jIUD4U85w";

export class PostgresAgentAuthorizationGrantabilityState
  implements AgentAuthorizationGrantabilityState {
  constructor(private readonly sql: Queryable) {}

  async current(input: {
    auth: AuthContext;
    roles: readonly string[];
    boundary: AuthorizationBoundary;
  }): Promise<
    Result<{
      superAdmin: boolean;
      canDecide: boolean;
      effectiveRoles: readonly string[];
      snapshot: AgentAuthorizationGrantabilitySnapshot;
    }>
  > {
    const [boundaryType, projectId] = boundaryParams(input.boundary);
    const assignments = input.auth.authorizationId
      ? (await query<{ role_id: string }>(
        this.sql,
        `select ar.role_id
           from agent_authorizations a
           join agent_users au on au.id=a.agent_user_id
           join principals p on p.id=au.principal_id and p.active
           join human_users u on u.id=a.human_user_id and u.status='active'
           join agent_authorization_roles ar on ar.authorization_id=a.id
           join system_roles r on r.id=ar.role_id and r.active
          where a.id=$1 and a.human_user_id=$2 and a.revoked_at is null
            and a.superseded_at is null
            and exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
            and ${authorizationBoundaryPredicate("ar", "$3", "$4")}
          order by ar.role_id
          for share of a,au,p,u,ar,r`,
        [
          input.auth.authorizationId,
          input.auth.humanUserId,
          boundaryType,
          projectId,
        ],
      )).rows
      : (await query<{ role_id: string }>(
        this.sql,
        `select ra.role_id
           from role_assignments ra
           join human_users u on u.principal_id=ra.principal_id
           join principals p on p.id=u.principal_id and p.active
           join system_roles r on r.id=ra.role_id and r.active
          where u.id=$1 and u.status='active' and ra.active
            and exists(select 1 from role_definition_versions rv where rv.role_id=r.id and rv.active)
            and ${authorizationBoundaryPredicate("ra", "$2", "$3")}
          order by ra.role_id
          for share of u,p,ra,r`,
        [input.auth.humanUserId, boundaryType, projectId],
      )).rows;
    const effectiveRoles = [...new Set(assignments.map((row) => row.role_id))];
    const superAdmin = isSuperAdmin(input.auth) && await currentSuperAdmin(
      this.sql,
      input.auth,
    );

    const policies = effectiveRoles.length
      ? (await query<{
        policy_id: string;
        policy_version_id: string;
        version: number;
        capability: string;
      }>(
        this.sql,
        `select pd.policy_id,pd.id policy_version_id,pd.version,pr.capability
           from policy_assignments pa
           join policy_definition_versions pd on pd.id=pa.policy_definition_version_id and pd.active
           join policy_rules pr on pr.policy_definition_version_id=pd.id
          where pa.active and ${
          authorizationBoundaryPredicate("pa", "$1", "$2")
        }
            and pr.role_id=any($3::text[])
          order by pd.policy_id,pd.version,pr.capability
          for share of pa,pd,pr`,
        [boundaryType, projectId, effectiveRoles],
      )).rows
      : [];
    const roleVersions = input.roles.length
      ? (await query<{ role_id: string; id: string; version: number }>(
        this.sql,
        `select role_id,id,version from role_definition_versions
          where active and role_id=any($1::text[]) order by role_id,version for share`,
        [input.roles],
      )).rows
      : [];
    const snapshot = {
      roleDefinitionVersions: roleVersions.map((row) => ({
        role: row.role_id,
        versionId: row.id,
        version: Number(row.version),
      })),
      policyDefinitionVersions: policies.map((row) => ({
        policy: row.policy_id,
        versionId: row.policy_version_id,
        version: Number(row.version),
      })).filter((value, index, values) =>
        index ===
          values.findIndex((other) => other.versionId === value.versionId)
      ),
      capabilitySummaryDigest: "",
    };
    snapshot.capabilitySummaryDigest = await tokenDigest(JSON.stringify({
      boundary: input.boundary,
      roles: input.roles,
      effective_roles: effectiveRoles,
      policies: snapshot.policyDefinitionVersions,
      capabilities: policies.map((row) => row.capability).sort(),
    }));
    return ok({
      superAdmin,
      canDecide: policies.some((row) =>
        row.capability === "auth.request.decide"
      ),
      effectiveRoles,
      snapshot,
    });
  }
}

async function currentSuperAdmin(
  sql: Queryable,
  auth: AuthContext,
): Promise<boolean> {
  if (auth.authorizationId) {
    return Boolean(
      (await query<{ found: boolean }>(
        sql,
        `select exists(
         select 1 from agent_authorizations a
         join agent_authorization_roles ar on ar.authorization_id=a.id
         where a.id=$1 and a.human_user_id=$2 and a.revoked_at is null
           and ar.role_id='system:super_admin' and ar.boundary_type='system'
       ) found`,
        [auth.authorizationId, auth.humanUserId],
      )).rows[0]?.found,
    );
  }
  return Boolean(
    (await query<{ found: boolean }>(
      sql,
      `select exists(
       select 1 from role_assignments ra
       join human_users u on u.principal_id=ra.principal_id
       where u.id=$1 and u.status='active' and ra.active
         and ra.role_id='system:super_admin' and ra.boundary_type='system'
     ) found`,
      [auth.humanUserId],
    )).rows[0]?.found,
  );
}

export class ImmediateSemaphore {
  private active = 0;
  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error(
        "OPERANT_PASSWORD_MAX_CONCURRENT_HASHES must be a positive integer",
      );
    }
  }
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}

async function hashPassword(
  password: string,
  parameters?: ArgonParameters,
): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-ffi",
      "--allow-sys",
      "--allow-env",
      new URL("./auth_password_worker.ts", import.meta.url).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({
      operation: "hash",
      password,
      ...(parameters
        ? {
          parameters: {
            memoryCost: parameters.memoryCost,
            timeCost: parameters.timeCost,
            parallelism: parameters.parallelism,
            outputLen: parameters.outputLen,
          },
        }
        : {}),
    })),
  );
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `password hashing failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return (JSON.parse(new TextDecoder().decode(output.stdout)) as {
    phc: string;
  }).phc;
}

async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-ffi",
      "--allow-sys",
      "--allow-env",
      new URL("./auth_password_worker.ts", import.meta.url).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ operation: "verify", password, phc }),
    ),
  );
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `password verification failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return (JSON.parse(new TextDecoder().decode(output.stdout)) as {
    valid: boolean;
  }).valid;
}

function issuedCredentials(
  full: { id: string; token: string },
  request: { id: string; token: string },
) {
  return {
    token: full.token,
    fullSessionId: full.id,
    requestToken: request.token,
    requestSessionId: request.id,
    requestRetained: false,
  };
}

async function issueSession(
  sql: Queryable,
  principalId: string,
  userId: string,
  kind: CredentialKind,
): Promise<{ id: string; token: string }> {
  const id = uuidV7();
  const token = opaqueToken();
  await query(
    sql,
    `insert into auth_sessions(id, principal_id, human_user_id, credential_kind, token_digest) values ($1,$2,$3,$4,$5)`,
    [id, principalId, userId, kind, await tokenDigest(token)],
  );
  return { id, token };
}

async function insertBootstrapAudit(
  sql: Queryable,
  provenance: {
    principalId: string;
    userId: string;
    assignmentId: string;
    fullSessionId: string;
    requestSessionId: string;
  },
): Promise<void> {
  const common = [provenance.principalId, provenance.userId];
  await query(
    sql,
    `
    insert into auth_audit_events(
      id, event_type, auth_context_id, principal_id, human_user_id,
      session_id, role_assignment_id, role_id, credential_kind,
      boundary_type, details
    ) values
      ($1, 'auth.human_user.created', null, $2, $3, null, null, null, null, null, '{}'::jsonb),
      ($4, 'auth.role_assignment.created', null, $2, $3, null, $5, 'system:super_admin', null, 'system', '{}'::jsonb),
      ($6, 'auth.session.created', null, $2, $3, $7, null, null, 'human_full', null, '{}'::jsonb),
      ($8, 'auth.session.created', null, $2, $3, $9, null, null, 'authorization_request', null, '{}'::jsonb),
      ($10, 'auth.bootstrap.completed', null, $2, $3, null, $5, 'system:super_admin', null, 'system',
       jsonb_build_object('full_session_id', $7::text, 'authorization_request_session_id', $9::text))
  `,
    [
      uuidV7(),
      ...common,
      uuidV7(),
      provenance.assignmentId,
      uuidV7(),
      provenance.fullSessionId,
      uuidV7(),
      provenance.requestSessionId,
      uuidV7(),
    ],
  );
}
type UserRow = {
  id: string;
  principal_id: string;
  username: string;
  display_name: string;
  status: "active" | "disabled";
};
type ResetRow = {
  id: string;
  human_user_id: string | null;
  username: string;
  nonce_digest: string;
  capability_digest: string | null;
  status: PasswordReset["status"];
  created_at: Date;
  expires_at: Date;
};

function humanUser(row: UserRow): HumanUser {
  return {
    id: row.id,
    principalId: row.principal_id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
  };
}
function passwordReset(row: ResetRow): PasswordReset {
  return {
    id: row.id,
    username: row.username,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
async function readPasswordResetStatus(
  sql: Queryable,
  id: string,
): Promise<
  Result<
    { requestId: string; version: number; status: PasswordReset["status"] }
  >
> {
  const row = (await query<
    {
      id: string;
      version: number;
      status: PasswordReset["status"];
      expires_at: Date;
    }
  >(
    sql,
    `select id,version,status,expires_at from password_reset_requests where id=$1`,
    [id],
  )).rows[0];
  if (!row) {
    return err(
      authError(
        "password_reset_not_found",
        "password reset was not found",
        "not_found",
      ),
    );
  }
  const status =
    row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now()
      ? "expired"
      : row.status;
  return ok({ requestId: row.id, version: Number(row.version), status });
}

async function resetRow(
  sql: Queryable,
  id: string,
  lock = false,
): Promise<ResetRow | undefined> {
  return (await query<ResetRow>(
    sql,
    `select id,human_user_id,username,nonce_digest,capability_digest,status,created_at,expires_at from password_reset_requests where id=$1${
      lock ? " for update" : ""
    }`,
    [id],
  )).rows[0];
}
function isSuperAdmin(auth: AuthContext): boolean {
  return auth.credentialKind !== "authorization_request" &&
    auth.roles.includes("system:super_admin");
}
function authorizationDenied() {
  return err(
    authError(
      "authorization_insufficient",
      "super-admin authority is required",
      "authorization",
    ),
  );
}
type ActiveHumanSuperAdmin = {
  user_id: string;
  principal_id: string;
  assignment_id: string;
};

async function lockActiveHumanSuperAdmins(
  sql: Queryable,
): Promise<ActiveHumanSuperAdmin[]> {
  // Every current or future path that can remove human super-admin authority must acquire this first.
  await query(
    sql,
    `select pg_advisory_xact_lock(hashtext('operant.auth.super_admin_invariant'))`,
  );
  return (await query<ActiveHumanSuperAdmin>(
    sql,
    `select u.id user_id,u.principal_id,r.id assignment_id
       from human_users u
       join role_assignments r on r.principal_id=u.principal_id
      where u.status='active' and r.role_id='system:super_admin' and r.active
      order by u.id,r.id
      for update of u,r`,
  )).rows;
}

async function confirmHumanPassword(
  sql: Queryable,
  userId: string,
  password: string,
): Promise<Result<UserRow>> {
  const user = (await query<UserRow & { phc_hash: string }>(
    sql,
    `select u.id,u.principal_id,u.username,u.display_name,u.status,p.phc_hash from human_users u join password_credentials p on p.human_user_id=u.id where u.id=$1 for update`,
    [userId],
  )).rows[0];
  if (!user) {
    return err(
      authError(
        "login_invalid",
        "username or password is invalid",
        "authentication",
      ),
    );
  }
  await query(
    sql,
    `insert into login_throttles(username) values($1) on conflict do nothing`,
    [user.username],
  );
  const throttle =
    (await query<{ failure_count: number; next_allowed_at: Date | null }>(
      sql,
      `select failure_count,next_allowed_at from login_throttles where username=$1 for update`,
      [user.username],
    )).rows[0]!;
  if (
    throttle.next_allowed_at &&
    new Date(throttle.next_allowed_at).getTime() > Date.now()
  ) {
    const retry = Math.max(
      1,
      Math.ceil(
        (new Date(throttle.next_allowed_at).getTime() - Date.now()) / 1000,
      ),
    );
    return err(
      authError(
        "login_throttled",
        "login is temporarily throttled",
        "rate_limited",
        { retry_after_seconds: retry },
      ),
    );
  }
  const valid = user.status === "active" &&
    await verifyPassword(password, user.phc_hash);
  if (!valid) {
    const failures = throttle.failure_count + 1;
    const delay = failures < 5 ? 0 : Math.min(30, 2 ** (failures - 5));
    await query(
      sql,
      `update login_throttles set failure_count=$2,next_allowed_at=case when $3::int=0 then null else now()+make_interval(secs=>$3) end,updated_at=now() where username=$1`,
      [user.username, failures, delay],
    );
    return err(
      authError(
        "login_invalid",
        "username or password is invalid",
        "authentication",
      ),
    );
  }
  await query(
    sql,
    `update login_throttles set failure_count=0,next_allowed_at=null,updated_at=now() where username=$1`,
    [user.username],
  );
  return ok(humanUserRow(user));
}

function humanUserRow(row: UserRow): UserRow {
  return {
    id: row.id,
    principal_id: row.principal_id,
    username: row.username,
    display_name: row.display_name,
    status: row.status,
  };
}

async function revokeAnchored(sql: Queryable, userId: string): Promise<void> {
  // Keep every anchor-owned authority revocation in this transaction; later agent tables extend this helper.
  await query(
    sql,
    `update auth_sessions set revoked_at=coalesce(revoked_at,now()) where human_user_id=$1 and revoked_at is null`,
    [userId],
  );
  await query(
    sql,
    `update agent_authorizations set revoked_at=coalesce(revoked_at,now()) where human_user_id=$1 and revoked_at is null`,
    [userId],
  );
  await query(
    sql,
    `update agent_authorization_requests set status='invalidated',version=version+1 where human_user_id=$1 and status='pending'`,
    [userId],
  );
}
type RecoveryAuditInput = {
  targetHumanUserId: string;
  challengeId: string;
  initiatedAt: Date;
  terminalAt?: Date;
  enableUser: boolean;
  restoreSuperAdmin: boolean;
  outcome: "initiated" | "completed" | "cancelled" | "expired";
  reason: string;
  replacementSessionId?: string;
};

async function auditRecovery(
  sql: Queryable,
  eventType:
    | "auth.recovery.initiated"
    | "auth.recovery.completed"
    | "auth.recovery.cancelled"
    | "auth.recovery.expired",
  input: RecoveryAuditInput,
): Promise<void> {
  const details = {
    schema: "auth.recovery.audit.v1",
    target_human_user_id: input.targetHumanUserId,
    challenge_id: input.challengeId,
    initiated_at: new Date(input.initiatedAt).toISOString(),
    ...(input.terminalAt
      ? { terminal_at: new Date(input.terminalAt).toISOString() }
      : {}),
    requested_repairs: {
      enable_user: input.enableUser,
      restore_super_admin: input.restoreSuperAdmin,
    },
    executor: {
      principal_id: "system:host_recovery",
      principal_type: "system",
      context: "host_operator",
    },
    outcome: input.outcome,
    reason: input.reason,
  };
  await query(
    sql,
    `insert into auth_audit_events(id,event_type,auth_context_id,principal_id,human_user_id,session_id,details) values($1,$2,null,null,$3,$4,$5::jsonb)`,
    [
      uuidV7(),
      eventType,
      input.targetHumanUserId,
      input.replacementSessionId ?? null,
      JSON.stringify(details),
    ],
  );
}

async function audit(
  sql: Queryable,
  eventType: string,
  principalId: string,
  humanUserId: string,
  sessionId?: string,
  authContextId?: string,
  details: unknown = {},
): Promise<void> {
  await query(
    sql,
    `insert into auth_audit_events(id,event_type,auth_context_id,principal_id,human_user_id,session_id,details) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      uuidV7(),
      eventType,
      authContextId ?? null,
      principalId,
      humanUserId,
      sessionId ?? null,
      JSON.stringify(details),
    ],
  );
}
function credentialInvalid() {
  return err(
    authError(
      "credential_invalid",
      "credential is invalid",
      "authentication",
    ),
  );
}
function authError(
  code: string,
  message: string,
  severity:
    | "authentication"
    | "authorization"
    | "not_found"
    | "conflict"
    | "expired"
    | "rate_limited"
    | "unavailable",
  details: unknown = {},
) {
  return { code, message, severity, details } as const;
}
