import { query, type Queryable } from "../client.ts";
import type { TransactionManager } from "../../../../application/ports/transaction_manager.ts";
import type {
  LockedSecretValue,
  SecretLifecyclePersistence,
  SecretMetadata,
} from "../../../../application/services/secrets/manage_secrets.ts";
import type { SecretCiphertext } from "../../../../application/ports/repair/repositories.ts";
import { uuidV7 } from "../../../../domain/ids/uuid_v7.ts";
import {
  EnvelopeCrypto,
  SecretKeyMismatchError,
} from "../../crypto/envelope.ts";

type SecretRow = {
  id: string;
  name: string;
  description: string | null;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  algorithm: "AES-256-GCM";
  key_id: string;
  value_version: string;
  status: "active" | "disabled";
};

/** PostgreSQL persistence primitives; application owns validation, auth and crypto decisions. */
export function makePostgresSecretLifecyclePersistence(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
}): SecretLifecyclePersistence {
  return Object.freeze({
    async list(): Promise<readonly SecretMetadata[]> {
      return (await query<Record<string, unknown>>(
        deps.sql,
        `select s.id,s.name,s.description,s.status,s.value_version,
                s.created_at::text,s.updated_at::text,count(g.id)::integer as grant_count
           from platform_secrets s left join hook_secret_grants g on g.secret_id=s.id
          group by s.id order by s.name`,
      )).rows;
    },

    create: (input: Parameters<SecretLifecyclePersistence["create"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        const inserted = (await query<Record<string, unknown>>(
          tx,
          `insert into platform_secrets(
             id,name,description,ciphertext,nonce,algorithm,key_id,value_version,status,
             created_auth_context_id,updated_auth_context_id
           ) values($1,$2,$3,$4,$5,$6,$7,1,'active',$8,$8)
           returning id,name,description,status,value_version,created_at::text,updated_at::text`,
          [
            input.id,
            input.name,
            input.description,
            input.encrypted.ciphertext,
            input.encrypted.nonce,
            input.encrypted.algorithm,
            input.encrypted.keyId,
            input.authContextId,
          ],
        )).rows[0];
        await audit(tx, input.actorId, "secret.created", input.id, input.name);
        return inserted;
      }),

    rotate: (input: Parameters<SecretLifecyclePersistence["rotate"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        const current = (await query<SecretRow>(
          tx,
          "select * from platform_secrets where id=$1 for update",
          [input.id],
        )).rows[0];
        if (!current) return null;
        const locked = lockedSecret(current);
        const encrypted = await input.encrypt(locked);
        const version = locked.valueVersion + 1;
        const updated = (await query<Record<string, unknown>>(
          tx,
          `update platform_secrets set ciphertext=$2,nonce=$3,algorithm=$4,key_id=$5,
             value_version=$6,status='active',disabled_at=null,disabled_auth_context_id=null,
             updated_auth_context_id=$7,updated_at=now()
           where id=$1 returning id,name,description,status,value_version,created_at::text,updated_at::text`,
          [
            input.id,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.algorithm,
            encrypted.keyId,
            version,
            input.authContextId,
          ],
        )).rows[0];
        await audit(
          tx,
          input.actorId,
          "secret.rotated",
          input.id,
          current.name,
          {
            value_version: version,
          },
        );
        return updated;
      }),

    disable: (input: Parameters<SecretLifecyclePersistence["disable"]>[0]) =>
      deps.tx.transaction(async (tx) => {
        const current = (await query<SecretRow>(
          tx,
          "select * from platform_secrets where id=$1 for update",
          [input.id],
        )).rows[0];
        if (!current) return null;
        if (current.status === "active") {
          await query(
            tx,
            `update platform_secrets set status='disabled',disabled_at=now(),
               disabled_auth_context_id=$2,updated_auth_context_id=$2,updated_at=now()
             where id=$1`,
            [input.id, input.authContextId],
          );
          await audit(
            tx,
            input.actorId,
            "secret.disabled",
            input.id,
            current.name,
          );
        }
        return (await query<Record<string, unknown>>(
          tx,
          `select id,name,description,status,value_version,created_at::text,updated_at::text
             from platform_secrets where id=$1`,
          [input.id],
        )).rows[0];
      }),

    async resolveActive(id: string): Promise<LockedSecretValue | null> {
      const row = (await query<SecretRow>(
        deps.sql,
        "select * from platform_secrets where id=$1 and status='active'",
        [id],
      )).rows[0];
      return row ? lockedSecret(row) : null;
    },
  });
}

export async function assertSecretSubsystemReady(
  sql: Queryable,
  cryptoAdapter: EnvelopeCrypto,
): Promise<void> {
  const exists = (await query<{ exists: boolean }>(
    sql,
    "select to_regclass('public.platform_secrets') is not null as exists",
  )).rows[0]?.exists;
  if (!exists) return;
  const rows = (await query<SecretRow>(
    sql,
    "select * from platform_secrets order by id",
  )).rows;
  if (rows.length === 0) {
    if (cryptoAdapter.hasKey()) cryptoAdapter.validateKey();
    return;
  }
  cryptoAdapter.validateKey();
  const expectedKeyId = await cryptoAdapter.keyId();
  for (const row of rows) {
    if (row.key_id !== expectedKeyId) throw new SecretKeyMismatchError();
    const version = Number(row.value_version);
    await cryptoAdapter.decrypt(encrypted(row), {
      secret_id: row.id,
      value_version: version,
      key_id: row.key_id,
    });
  }
}

function lockedSecret(row: SecretRow): LockedSecretValue {
  return {
    id: row.id,
    name: row.name,
    valueVersion: Number(row.value_version),
    encrypted: encrypted(row),
  };
}
function encrypted(row: SecretRow): SecretCiphertext {
  const valueVersion = Number(row.value_version);
  return {
    ciphertext: bytes(row.ciphertext),
    nonce: bytes(row.nonce),
    algorithm: row.algorithm,
    keyId: row.key_id,
    valueVersion,
  };
}
async function audit(
  sql: Queryable,
  actorId: string,
  event: string,
  id: string,
  name: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await query(
    sql,
    `insert into audit_events(id,actor_id,event_type,resource,object_id,action,request_metadata_json)
     values($1,$2,$3,'system:secret',$4,$3,$5::jsonb)`,
    [
      uuidV7(),
      actorId,
      event,
      id,
      JSON.stringify({ secret_id: id, name, ...metadata }),
    ],
  );
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(
      value.slice(2).match(/../g) ?? [],
      (part) => parseInt(part, 16),
    );
  }
  throw new Error("invalid encrypted row");
}
