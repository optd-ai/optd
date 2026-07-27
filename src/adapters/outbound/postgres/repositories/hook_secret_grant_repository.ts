import { query, type Queryable } from "../client.ts";
import type { TransactionManager } from "../../../../application/ports/transaction_manager.ts";
import {
  type HookSecretGrantPersistence,
  HookSecretGrantPersistenceError,
} from "../../../../application/services/secrets/manage_grants.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { Result } from "../../../../domain/errors/result.ts";
import { uuidV7 } from "../../../../domain/ids/uuid_v7.ts";

/** PostgreSQL grant integrity primitives; application owns request/auth/error orchestration. */
export function makePostgresHookSecretGrantPersistence(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
  authorizeInTransaction: (
    sql: Queryable,
    auth: AuthContext,
    action: string,
  ) => Promise<Result<unknown>>;
}): HookSecretGrantPersistence {
  async function revalidate(sql: Queryable, auth: AuthContext): Promise<void> {
    for (const action of ["secret.grant", "hook.secret.configure"]) {
      const result = await deps.authorizeInTransaction(sql, auth, action);
      if (!result.ok) {
        throw new HookSecretGrantPersistenceError(
          result.error.code,
          result.error.message,
          result.error.severity,
        );
      }
    }
  }

  return Object.freeze({
    async list() {
      return (await query<Record<string, unknown>>(deps.sql, grantListSql()))
        .rows;
    },

    create: (input: Parameters<HookSecretGrantPersistence["create"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        await revalidate(tx, input.auth);
        const hook = (await query<{
          hook_security_digest: string;
          hook_normalized_config: Record<string, unknown>;
        }>(
          tx,
          `select h.hook_security_digest,h.hook_normalized_config
             from pack_component_revisions h
             join pack_active_revisions a on a.candidate_revision_id=h.candidate_revision_id
            where h.id=$1 and h.definition_kind='hook' for share`,
          [input.hookRevisionId],
        )).rows[0];
        const slots = Array.isArray(hook?.hook_normalized_config?.secrets)
          ? hook.hook_normalized_config.secrets as Array<
            Record<string, unknown>
          >
          : [];
        if (
          !hook || hook.hook_security_digest !== input.expectedSecurityDigest ||
          !slots.some((slot) => slot.slot === input.slot)
        ) {
          throw persistenceError(
            "hook_grant_target_invalid",
            "active hook revision, digest, or slot is invalid",
            "validation",
          );
        }
        await requireActiveSecret(tx, input.secretId);
        if (await currentGrant(tx, input.hookRevisionId, input.slot, true)) {
          throw persistenceError(
            "hook_grant_conflict",
            "an effective grant already exists",
            "conflict",
          );
        }
        await query(
          tx,
          `insert into hook_secret_grants(
             id,hook_revision_id,hook_security_digest,slot,secret_id,created_auth_context_id
           ) values($1,$2,$3,$4,$5,$6)`,
          [
            input.id,
            input.hookRevisionId,
            input.expectedSecurityDigest,
            input.slot,
            input.secretId,
            input.auth.id,
          ],
        );
        await query(
          tx,
          `insert into hook_secret_grant_heads(hook_revision_id,slot,grant_id)
           values($1,$2,$3)`,
          [input.hookRevisionId, input.slot, input.id],
        );
        await auditGrant(
          tx,
          input.auth,
          "hook_secret_grant.created",
          input.id,
          {
            hook_revision_id: input.hookRevisionId,
            slot: input.slot,
            secret_id: input.secretId,
          },
        );
        return await readGrant(tx, input.id);
      }),

    replace: (input: Parameters<HookSecretGrantPersistence["replace"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        await revalidate(tx, input.auth);
        const current = (await query<{
          hook_revision_id: string;
          hook_security_digest: string;
          slot: string;
        }>(
          tx,
          `select g.hook_revision_id,g.hook_security_digest,g.slot
             from hook_secret_grant_heads h join hook_secret_grants g on g.id=h.grant_id
            where h.grant_id=$1 for update of h,g`,
          [input.expectedGrantId],
        )).rows[0];
        if (!current) {
          throw persistenceError(
            "hook_grant_stale",
            "expected current grant is stale",
            "conflict",
          );
        }
        await requireActiveSecret(tx, input.secretId);
        await query(
          tx,
          `insert into hook_secret_grants(
             id,hook_revision_id,hook_security_digest,slot,secret_id,
             created_auth_context_id,supersedes_grant_id
           ) values($1,$2,$3,$4,$5,$6,$7)`,
          [
            input.id,
            current.hook_revision_id,
            current.hook_security_digest,
            current.slot,
            input.secretId,
            input.auth.id,
            input.expectedGrantId,
          ],
        );
        const moved = await query<{ grant_id: string }>(
          tx,
          `update hook_secret_grant_heads set grant_id=$2,version=version+1,updated_at=now()
            where hook_revision_id=$3 and slot=$4 and grant_id=$1
            returning grant_id`,
          [
            input.expectedGrantId,
            input.id,
            current.hook_revision_id,
            current.slot,
          ],
        );
        if (moved.rows.length !== 1) {
          throw persistenceError(
            "hook_grant_stale",
            "expected current grant is stale",
            "conflict",
          );
        }
        await auditGrant(
          tx,
          input.auth,
          "hook_secret_grant.replaced",
          input.id,
          {
            supersedes_grant_id: input.expectedGrantId,
            hook_revision_id: current.hook_revision_id,
            slot: current.slot,
            secret_id: input.secretId,
          },
        );
        return await readGrant(tx, input.id);
      }),

    revoke: (input: Parameters<HookSecretGrantPersistence["revoke"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        await revalidate(tx, input.auth);
        const current = (await query<{ id: string }>(
          tx,
          `select g.id from hook_secret_grant_heads h
             join hook_secret_grants g on g.id=h.grant_id
            where h.grant_id=$1 for update of h,g`,
          [input.grantId],
        )).rows[0];
        if (!current) {
          throw persistenceError(
            "hook_grant_not_found",
            "grant not found",
            "not_found",
          );
        }
        const revoked = (await query<{ id: string }>(
          tx,
          "select id from hook_secret_grant_revocations where grant_id=$1",
          [input.grantId],
        )).rows[0];
        if (revoked) {
          throw persistenceError(
            "hook_grant_revoked",
            "grant is already revoked",
            "conflict",
          );
        }
        await query(
          tx,
          `insert into hook_secret_grant_revocations(
             id,grant_id,revoked_auth_context_id,reason
           ) values($1,$2,$3,$4)`,
          [uuidV7(), input.grantId, input.auth.id, input.reason],
        );
        await query(
          tx,
          "delete from hook_secret_grant_heads where grant_id=$1",
          [input.grantId],
        );
        await auditGrant(
          tx,
          input.auth,
          "hook_secret_grant.revoked",
          input.grantId,
          {
            reason: input.reason,
          },
        );
        return { grant_id: input.grantId, status: "revoked" };
      }),
  });
}

async function requireActiveSecret(sql: Queryable, id: string): Promise<void> {
  const secret = (await query<{ status: string }>(
    sql,
    "select status from platform_secrets where id=$1 for share",
    [id],
  )).rows[0];
  if (!secret || secret.status !== "active") {
    throw persistenceError(
      "hook_grant_secret_unavailable",
      "secret is unavailable",
      "conflict",
    );
  }
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
async function readGrant(
  sql: Queryable,
  id: string,
): Promise<Record<string, unknown>> {
  const row = (await query<Record<string, unknown>>(
    sql,
    `${grantListSql()} where where_view.grant_id=$1`,
    [id],
  )).rows[0];
  if (!row) {
    throw persistenceError(
      "hook_grant_failed",
      "persisted grant is unavailable",
      "internal",
    );
  }
  return row;
}
function grantListSql(): string {
  return `select * from (select g.id as grant_id,g.secret_id,s.name as secret_name,h.definition_name as hook_identity,g.hook_revision_id,g.hook_security_digest,g.slot,slot_decl->>'env' as env,case when r.id is not null then 'revoked' when successor.id is not null then 'superseded' when s.status<>'active' then 'unavailable' else 'effective' end as status,g.created_at::text,g.inherited_from_grant_id,g.supersedes_grant_id,r.reason as revoked_reason from hook_secret_grants g join platform_secrets s on s.id=g.secret_id join pack_component_revisions h on h.id=g.hook_revision_id left join lateral jsonb_array_elements(h.hook_normalized_config->'secrets') slot_decl on slot_decl->>'slot'=g.slot left join hook_secret_grant_revocations r on r.grant_id=g.id left join hook_secret_grants successor on successor.supersedes_grant_id=g.id order by g.created_at desc,g.id) where_view`;
}
async function auditGrant(
  sql: Queryable,
  auth: AuthContext,
  eventType: string,
  grantId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    sql,
    `insert into audit_events(
       id,actor_id,event_type,resource,object_id,action,request_metadata_json
     ) values($1,$2,$3,'system:hook-secret-grant',$4,$3,$5::jsonb)`,
    [
      uuidV7(),
      auth.principalId,
      eventType,
      grantId,
      JSON.stringify({
        grant_id: grantId,
        auth_context_id: auth.id,
        super_admin_bypass: auth.roles.includes("system:super_admin"),
        ...metadata,
      }),
    ],
  );
}
function persistenceError(
  code: string,
  message: string,
  severity: "validation" | "conflict" | "not_found" | "internal",
): HookSecretGrantPersistenceError {
  return new HookSecretGrantPersistenceError(code, message, severity);
}
