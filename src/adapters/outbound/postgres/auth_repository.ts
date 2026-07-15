import type { AuthRepository } from "../../../application/ports/authentication.ts";
import type {
  AuthContext,
  BootstrapInput,
  BootstrapResult,
  CredentialKind,
} from "../../../domain/auth/model.ts";
import { immutableAuthContext } from "../../../domain/auth/model.ts";
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
  constructor(
    private readonly sql: Sql,
    private readonly configuredBootstrapToken?: string,
  ) {}

  async bootstrapStatus() {
    const result = await query<{ completed: boolean }>(
      this.sql,
      "select completed from bootstrap_state where singleton = true",
    );
    if (result.rows[0]?.completed === true) return ok("ready" as const);
    if (!this.configuredBootstrapToken) {
      return err(authError(
        "bootstrap_token_not_configured",
        "bootstrap token is not configured",
        "unavailable",
      ));
    }
    return ok("bootstrap_required" as const);
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
      const passwordHash = await hashPassword(input.password);
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
        credentials: { token: full.token, requestToken: request.token },
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
}

async function hashPassword(password: string): Promise<string> {
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
  await writer.write(new TextEncoder().encode(password));
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `password hashing failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
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
function authError(
  code: string,
  message: string,
  severity: "authentication" | "conflict" | "unavailable",
) {
  return { code, message, severity, details: {} } as const;
}
