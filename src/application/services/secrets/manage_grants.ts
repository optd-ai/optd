import {
  query,
  type Queryable,
} from "../../../adapters/outbound/postgres/client.ts";
import type { TransactionManager } from "../../ports/transaction_manager.ts";
import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export function makeHookSecretGrantService(
  deps: {
    sql: Queryable;
    tx: TransactionManager<Queryable>;
    authorization: AuthorizationRepository;
    authorizeInTransaction: (
      sql: Queryable,
      auth: AuthContext,
      action: string,
    ) => Promise<Result<unknown>>;
  },
) {
  async function dual(auth: AuthContext): Promise<Result<unknown> | null> {
    for (const action of ["secret.grant", "hook.secret.configure"]) {
      const result = await deps.authorization.authorize({
        auth,
        boundary: { type: "system" },
        action,
        resource: "system:hook-secret-grant",
      });
      if (!result.ok) return result;
    }
    return null;
  }
  async function dualInTransaction(
    sql: Queryable,
    auth: AuthContext,
  ): Promise<void> {
    for (const action of ["secret.grant", "hook.secret.configure"]) {
      const result = await deps.authorizeInTransaction(sql, auth, action);
      if (!result.ok) {
        throw Object.assign(new Error(result.error.message), {
          authorizationError: result.error,
        });
      }
    }
  }
  return {
    async list(input: { auth: AuthContext }): Promise<Result<unknown>> {
      const denied = await dual(input.auth);
      if (denied) return denied;
      const rows = await query<Record<string, unknown>>(
        deps.sql,
        grantListSql(),
      );
      return ok({ grants: rows.rows });
    },
    async create(
      input: {
        auth: AuthContext;
        hook_revision_id?: unknown;
        expected_security_digest?: unknown;
        slot?: unknown;
        secret_id?: unknown;
      },
    ): Promise<Result<unknown>> {
      if (
        ![
          input.hook_revision_id,
          input.expected_security_digest,
          input.slot,
          input.secret_id,
        ].every((value) => typeof value === "string")
      ) return invalid();
      try {
        const id = await deps.tx.transaction(async (tx) => {
          await dualInTransaction(tx, input.auth);
          const hook = (await query<
            {
              hook_security_digest: string;
              hook_normalized_config: Record<string, unknown>;
            }
          >(
            tx,
            `select h.hook_security_digest,h.hook_normalized_config from pack_component_revisions h
              join pack_active_revisions a on a.candidate_revision_id=h.candidate_revision_id
             where h.id=$1 and h.definition_kind='hook' for share`,
            [input.hook_revision_id],
          )).rows[0];
          const slots = Array.isArray(hook?.hook_normalized_config?.secrets)
            ? hook.hook_normalized_config.secrets as Array<
              Record<string, unknown>
            >
            : [];
          if (
            !hook ||
            hook.hook_security_digest !== input.expected_security_digest ||
            !slots.some((slot) => slot.slot === input.slot)
          ) {
            throw coded(
              "hook_grant_target_invalid",
              "active hook revision, digest, or slot is invalid",
              "validation",
            );
          }
          const secret = (await query<{ status: string }>(
            tx,
            "select status from platform_secrets where id=$1 for share",
            [input.secret_id],
          )).rows[0];
          if (!secret || secret.status !== "active") {
            throw coded(
              "hook_grant_secret_unavailable",
              "secret is unavailable",
              "conflict",
            );
          }
          const effective = await currentGrant(
            tx,
            input.hook_revision_id as string,
            input.slot as string,
            true,
          );
          if (effective) {
            throw coded(
              "hook_grant_conflict",
              "an effective grant already exists",
              "conflict",
            );
          }
          const id = uuidV7();
          await query(
            tx,
            `insert into hook_secret_grants(id,hook_revision_id,hook_security_digest,slot,secret_id,created_auth_context_id) values($1,$2,$3,$4,$5,$6)`,
            [
              id,
              input.hook_revision_id,
              input.expected_security_digest,
              input.slot,
              input.secret_id,
              input.auth.id,
            ],
          );
          await query(
            tx,
            `insert into hook_secret_grant_heads(hook_revision_id,slot,grant_id) values($1,$2,$3)`,
            [input.hook_revision_id, input.slot, id],
          );
          return id;
        });
        return ok(
          (await query<Record<string, unknown>>(
            deps.sql,
            `${grantListSql()} where where_view.grant_id=$1`,
            [id],
          )).rows[0],
        );
      } catch (error) {
        return grantError(error);
      }
    },
    async replace(
      grantId: string,
      input: {
        auth: AuthContext;
        expected_current_grant_id?: unknown;
        secret_id?: unknown;
      },
    ): Promise<Result<unknown>> {
      if (
        input.expected_current_grant_id !== grantId ||
        typeof input.secret_id !== "string"
      ) return invalid();
      try {
        const id = await deps.tx.transaction(async (tx) => {
          await dualInTransaction(tx, input.auth);
          const current = (await query<
            {
              hook_revision_id: string;
              hook_security_digest: string;
              slot: string;
            }
          >(
            tx,
            `select g.hook_revision_id,g.hook_security_digest,g.slot
               from hook_secret_grant_heads h join hook_secret_grants g on g.id=h.grant_id
              where h.grant_id=$1 for update of h,g`,
            [grantId],
          )).rows[0];
          if (!current) {
            throw coded(
              "hook_grant_stale",
              "expected current grant is stale",
              "conflict",
            );
          }
          const secret = (await query<{ status: string }>(
            tx,
            "select status from platform_secrets where id=$1 for share",
            [input.secret_id],
          )).rows[0];
          if (!secret || secret.status !== "active") {
            throw coded(
              "hook_grant_secret_unavailable",
              "secret is unavailable",
              "conflict",
            );
          }
          const id = uuidV7();
          await query(
            tx,
            `insert into hook_secret_grants(id,hook_revision_id,hook_security_digest,slot,secret_id,created_auth_context_id,supersedes_grant_id) values($1,$2,$3,$4,$5,$6,$7)`,
            [
              id,
              current.hook_revision_id,
              current.hook_security_digest,
              current.slot,
              input.secret_id,
              input.auth.id,
              grantId,
            ],
          );
          await query(
            tx,
            `update hook_secret_grant_heads set grant_id=$2,version=version+1,updated_at=now()
              where hook_revision_id=$3 and slot=$4 and grant_id=$1`,
            [grantId, id, current.hook_revision_id, current.slot],
          );
          return id;
        });
        return ok(
          (await query<Record<string, unknown>>(
            deps.sql,
            `${grantListSql()} where where_view.grant_id=$1`,
            [id],
          )).rows[0],
        );
      } catch (error) {
        return grantError(error);
      }
    },
    async revoke(
      grantId: string,
      input: { auth: AuthContext; reason?: unknown },
    ): Promise<Result<unknown>> {
      if (
        input.reason !== undefined &&
        (typeof input.reason !== "string" || input.reason.length < 1 ||
          input.reason.length > 1000)
      ) return invalid();
      try {
        return await deps.tx.transaction(async (tx) => {
          await dualInTransaction(tx, input.auth);
          const grant = (await query<{ id: string }>(
            tx,
            `select g.id from hook_secret_grant_heads h join hook_secret_grants g on g.id=h.grant_id
              where h.grant_id=$1 for update of h,g`,
            [grantId],
          )).rows[0];
          if (!grant) {
            return err({
              code: "hook_grant_not_found",
              message: "grant not found",
              severity: "not_found",
              details: {},
            });
          }
          const existing = (await query<{ id: string }>(
            tx,
            "select id from hook_secret_grant_revocations where grant_id=$1",
            [grantId],
          )).rows[0];
          if (existing) {
            return err({
              code: "hook_grant_revoked",
              message: "grant is already revoked",
              severity: "conflict",
              details: {},
            });
          }
          await query(
            tx,
            `insert into hook_secret_grant_revocations(id,grant_id,revoked_auth_context_id,reason) values($1,$2,$3,$4)`,
            [uuidV7(), grantId, input.auth.id, input.reason ?? null],
          );
          await query(
            tx,
            "delete from hook_secret_grant_heads where grant_id=$1",
            [grantId],
          );
          return ok({ grant_id: grantId, status: "revoked" });
        });
      } catch (error) {
        return grantError(error);
      }
    },
  };
}

async function currentGrant(
  sql: Queryable,
  hookRevisionId: string,
  slot: string,
  lock: boolean,
): Promise<{ id: string } | null> {
  return (await query<{ id: string }>(
    sql,
    `select g.id from hook_secret_grant_heads h
       join hook_secret_grants g on g.id=h.grant_id
       join platform_secrets s on s.id=g.secret_id and s.status='active'
      where h.hook_revision_id=$1 and h.slot=$2${
      lock ? " for update of h,g" : ""
    }`,
    [hookRevisionId, slot],
  )).rows[0] ?? null;
}
function grantListSql(): string {
  return `select * from (select g.id as grant_id,g.secret_id,s.name as secret_name,h.definition_name as hook_identity,g.hook_revision_id,g.hook_security_digest,g.slot,slot_decl->>'env' as env,case when r.id is not null then 'revoked' when successor.id is not null then 'superseded' when s.status<>'active' then 'unavailable' else 'effective' end as status,g.created_at::text,g.inherited_from_grant_id,g.supersedes_grant_id,r.reason as revoked_reason from hook_secret_grants g join platform_secrets s on s.id=g.secret_id join pack_component_revisions h on h.id=g.hook_revision_id left join lateral jsonb_array_elements(h.hook_normalized_config->'secrets') slot_decl on slot_decl->>'slot'=g.slot left join hook_secret_grant_revocations r on r.grant_id=g.id left join hook_secret_grants successor on successor.supersedes_grant_id=g.id order by g.created_at desc,g.id) where_view`;
}
function invalid(): ReturnType<typeof err> {
  return err({
    code: "hook_grant_invalid",
    message: "hook grant request is invalid",
    severity: "validation",
    details: {},
  });
}
function coded(
  code: string,
  message: string,
  severity: "validation" | "conflict",
): Error {
  return Object.assign(new Error(message), { code, severity });
}
function grantError(error: unknown): ReturnType<typeof err> {
  const authorizationError =
    (error as { authorizationError?: Parameters<typeof err>[0] })
      .authorizationError;
  if (authorizationError) return err(authorizationError);
  const value = error as Error & {
    code?: string;
    severity?: "validation" | "conflict";
  };
  if (value.code === "23505") {
    return err({
      code: "hook_grant_conflict",
      message: "an effective grant already exists",
      severity: "conflict",
      details: {},
    });
  }
  return err({
    code: value.code ?? "hook_grant_failed",
    message: value.code ? value.message : "hook grant operation failed",
    severity: value.severity ?? "internal",
    details: {},
  });
}
