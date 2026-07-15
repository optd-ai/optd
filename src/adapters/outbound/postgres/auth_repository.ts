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
import type { Queryable, Sql } from "./client.ts";
import { query } from "./client.ts";

export class PostgresAuthRepository implements AuthRepository {
  constructor(
    private readonly sql: Sql,
    private readonly configuredBootstrapToken?: string,
  ) {}

  async bootstrapRequired(): Promise<boolean> {
    const result = await query<{ completed: boolean }>(
      this.sql,
      "select completed from bootstrap_state where singleton = true",
    );
    return result.rows[0]?.completed !== true;
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
    const configuredDigest = await digest(this.configuredBootstrapToken);
    const suppliedDigest = await digest(input.bootstrapToken);
    return await this.sql.begin(async (tx) => {
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
      if (row?.completed) {
        return err(
          authError(
            "bootstrap_already_completed",
            "bootstrap has already been completed",
            "conflict",
          ),
        );
      }
      if (!row || !constantTimeEqual(row.token_digest, suppliedDigest)) {
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
      await query(
        tx,
        "update bootstrap_state set completed = true, completed_at = now(), token_digest = null where singleton = true",
      );
      return ok({
        user: {
          id: userId,
          principalId,
          username: input.username,
          displayName: input.displayName,
        },
        credentials: { token: full, requestToken: request },
      });
    }) as Result<BootstrapResult>;
  }

  async authenticate(token: string): Promise<Result<AuthContext>> {
    const tokenDigest = await digest(token);
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
             array_remove(array_agg(ra.role_id order by ra.role_id), null) as roles
        from auth_sessions s
        join principals p on p.id = s.principal_id and p.active
        join human_users u on u.id = s.human_user_id and u.status = 'active'
        left join role_assignments ra on ra.principal_id = s.principal_id and ra.active
       where s.token_digest = $1 and s.revoked_at is null
       group by s.id, s.principal_id, s.human_user_id, s.credential_kind
    `,
      [tokenDigest],
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
): Promise<string> {
  const token = opaqueToken();
  await query(
    sql,
    `insert into auth_sessions(id, principal_id, human_user_id, credential_kind, token_digest) values ($1,$2,$3,$4,$5)`,
    [uuidV7(), principalId, userId, kind, await digest(token)],
  );
  return token;
}

function opaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}
function authError(
  code: string,
  message: string,
  severity: "authentication" | "conflict" | "unavailable",
) {
  return { code, message, severity, details: {} } as const;
}
