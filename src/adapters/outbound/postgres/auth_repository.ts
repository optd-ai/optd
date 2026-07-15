import type { AuthRepository } from "../../../application/ports/authentication.ts";
import type {
  AuthContext,
  BootstrapInput,
  BootstrapResult,
  CredentialKind,
  HumanSession,
  HumanUser,
  LoginResult,
  PasswordReset,
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

export class PostgresAuthRepository implements AuthRepository {
  private readonly hashes: ImmediateSemaphore;
  private resetListener: Promise<{ unlisten(): Promise<void> }> | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly configuredBootstrapToken?: string,
    maxConcurrentHashes = 4,
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
      created_at: Date;
      roles: string[] | null;
    }>(
      this.sql,
      `
      select s.id as session_id, s.principal_id, s.human_user_id, s.credential_kind,
             now() as created_at,
             case when s.credential_kind = 'authorization_request'
               then '{}'::text[]
               else array_remove(array_agg(ra.role_id order by ra.role_id), null)
             end as roles
        from auth_sessions s
        join principals p on p.id = s.principal_id and p.active
        join human_users u on u.id = s.human_user_id and u.status = 'active'
        left join role_assignments ra on ra.principal_id = s.principal_id and ra.active
       where s.token_digest = $1 and s.revoked_at is null
       group by s.id, s.principal_id, s.human_user_id, s.credential_kind
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
    const context = immutableAuthContext({
      id: uuidV7(),
      principalId: row.principal_id,
      principalType: "human_user",
      humanUserId: row.human_user_id,
      sessionId: row.session_id,
      credentialKind: row.credential_kind,
      roles: row.roles ?? [],
      createdAt: new Date(row.created_at).toISOString(),
    });
    await query(
      this.sql,
      `insert into auth_contexts(id, principal_id, human_user_id, session_id, credential_kind, roles, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        context.id,
        context.principalId,
        context.humanUserId,
        context.sessionId,
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

  async current(auth: AuthContext): Promise<Result<HumanUser>> {
    const row = (await query<UserRow>(
      this.sql,
      `select id,principal_id,username,display_name,status from human_users where id=$1`,
      [auth.humanUserId],
    )).rows[0];
    return row ? ok(humanUser(row)) : err(
      authError(
        "credential_invalid",
        "credential is invalid",
        "authentication",
      ),
    );
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

  subscribePasswordReset(id: string, listener: () => void): () => void {
    if (!this.resetListener) {
      this.resetListener = this.sql.listen(
        "operant_password_reset",
        (requestId: string) => {
          for (
            const notify of passwordResetListeners.get(requestId) ?? []
          ) notify();
        },
      );
      void this.resetListener.catch(() => {
        this.resetListener = undefined;
      });
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
    const listener = this.resetListener;
    this.resetListener = undefined;
    if (listener) await (await listener).unlisten();
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
  return auth.credentialKind === "human_full" &&
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
): Promise<void> {
  await query(
    sql,
    `insert into auth_audit_events(id,event_type,auth_context_id,principal_id,human_user_id,session_id,details) values($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
    [
      uuidV7(),
      eventType,
      authContextId ?? null,
      principalId,
      humanUserId,
      sessionId ?? null,
    ],
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
