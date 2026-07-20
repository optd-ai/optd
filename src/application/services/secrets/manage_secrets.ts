import {
  query,
  type Queryable,
} from "../../../adapters/outbound/postgres/client.ts";
import type { TransactionManager } from "../../ports/transaction_manager.ts";
import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import {
  EnvelopeCrypto,
  SecretDecryptError,
  SecretKeyMalformedError,
  SecretKeyMismatchError,
  SecretKeyMissingError,
} from "../../../adapters/outbound/crypto/envelope.ts";

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

export function makeSecretsService(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
  authorization: AuthorizationRepository;
  crypto?: EnvelopeCrypto;
}) {
  const cryptoAdapter = deps.crypto ?? new EnvelopeCrypto();
  async function authorize(
    auth: AuthContext,
    action: string,
  ): Promise<Result<unknown> | null> {
    const decision = await deps.authorization.authorize({
      auth,
      boundary: { type: "system" },
      action,
      resource: "system:secret",
    });
    return decision.ok ? null : decision;
  }
  return {
    async list(input: { auth: AuthContext }): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.list");
      if (denied) return denied;
      const rows = await query<Record<string, unknown>>(
        deps.sql,
        `select s.id,s.name,s.description,s.status,s.value_version,
                s.created_at::text,s.updated_at::text,count(g.id)::integer as grant_count
           from platform_secrets s left join hook_secret_grants g on g.secret_id=s.id
          group by s.id order by s.name`,
      );
      return ok({ secrets: rows.rows });
    },
    async create(
      input: {
        auth: AuthContext;
        name?: unknown;
        description?: unknown;
        value?: unknown;
      },
    ): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.create");
      if (denied) return denied;
      const valid = validateMutation(input, true);
      if (!valid.ok) return valid;
      try {
        const id = uuidV7();
        const encrypted = await cryptoAdapter.encrypt(valid.value.value, {
          secret_id: id,
          value_version: 1,
        });
        const row = await deps.tx.transaction(async (tx) => {
          const inserted = await query<Record<string, unknown>>(
            tx,
            `insert into platform_secrets(
               id,name,description,ciphertext,nonce,algorithm,key_id,value_version,status,
               created_auth_context_id,updated_auth_context_id
             ) values($1,$2,$3,$4,$5,$6,$7,1,'active',$8,$8)
             returning id,name,description,status,value_version,created_at::text,updated_at::text`,
            [
              id,
              valid.value.name,
              valid.value.description,
              encrypted.ciphertext,
              encrypted.nonce,
              encrypted.algorithm,
              encrypted.keyId,
              input.auth.id,
            ],
          );
          await audit(tx, input.auth, "secret.created", id, valid.value.name);
          return inserted.rows[0];
        });
        return ok(row);
      } catch (error) {
        return safeError(error, "secret_create_failed");
      }
    },
    async rotate(
      id: string,
      input: { auth: AuthContext; value?: unknown },
    ): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.rotate");
      if (denied) return denied;
      const value = validateValue(input.value);
      if (!value.ok) return value;
      try {
        const dto = await deps.tx.transaction(async (tx) => {
          const current = (await query<SecretRow>(
            tx,
            "select * from platform_secrets where id=$1 for update",
            [id],
          )).rows[0];
          if (!current) return null;
          const version = Number(current.value_version) + 1;
          const encrypted = await cryptoAdapter.encrypt(value.value, {
            secret_id: id,
            value_version: version,
          });
          const updated = (await query<Record<string, unknown>>(
            tx,
            `update platform_secrets set ciphertext=$2,nonce=$3,algorithm=$4,key_id=$5,
               value_version=$6,status='active',disabled_at=null,disabled_auth_context_id=null,
               updated_auth_context_id=$7,updated_at=now()
             where id=$1 returning id,name,description,status,value_version,created_at::text,updated_at::text`,
            [
              id,
              encrypted.ciphertext,
              encrypted.nonce,
              encrypted.algorithm,
              encrypted.keyId,
              version,
              input.auth.id,
            ],
          )).rows[0];
          await audit(tx, input.auth, "secret.rotated", id, current.name, {
            value_version: version,
          });
          return updated;
        });
        return dto ? ok(dto) : notFound();
      } catch (error) {
        return safeError(error, "secret_rotate_failed");
      }
    },
    async disable(
      id: string,
      input: { auth: AuthContext },
    ): Promise<Result<unknown>> {
      const denied = await authorize(input.auth, "secret.disable");
      if (denied) return denied;
      const dto = await deps.tx.transaction(async (tx) => {
        const current = (await query<SecretRow>(
          tx,
          "select * from platform_secrets where id=$1 for update",
          [id],
        )).rows[0];
        if (!current) return null;
        if (current.status === "active") {
          await query(
            tx,
            `update platform_secrets set status='disabled',disabled_at=now(),disabled_auth_context_id=$2,updated_auth_context_id=$2,updated_at=now() where id=$1`,
            [id, input.auth.id],
          );
          await audit(tx, input.auth, "secret.disabled", id, current.name);
        }
        return (await query<Record<string, unknown>>(
          tx,
          `select id,name,description,status,value_version,created_at::text,updated_at::text from platform_secrets where id=$1`,
          [id],
        )).rows[0];
      });
      return dto ? ok(dto) : notFound();
    },
    async resolve(
      id: string,
    ): Promise<{ value: string; valueVersion: number }> {
      const row = (await query<SecretRow>(
        deps.sql,
        "select * from platform_secrets where id=$1 and status='active'",
        [id],
      )).rows[0];
      if (!row) throw new Error("hook secret unavailable");
      const valueVersion = Number(row.value_version);
      const value = await cryptoAdapter.decrypt({
        ciphertext: bytes(row.ciphertext),
        nonce: bytes(row.nonce),
        algorithm: row.algorithm,
        keyId: row.key_id,
        valueVersion,
      }, {
        secret_id: row.id,
        value_version: valueVersion,
        key_id: row.key_id,
      });
      return { value, valueVersion };
    },
  };
}

export async function assertSecretSubsystemReady(
  sql: Queryable,
  cryptoAdapter = new EnvelopeCrypto(),
): Promise<void> {
  const exists = (await query<{ exists: boolean }>(
    sql,
    "select to_regclass('public.platform_secrets') is not null as exists",
  )).rows[0]?.exists;
  if (!exists) return;
  const rows =
    (await query<SecretRow>(sql, "select * from platform_secrets order by id"))
      .rows;
  if (rows.length === 0) {
    if (cryptoAdapter.hasKey()) cryptoAdapter.validateKey();
    return;
  }
  cryptoAdapter.validateKey();
  const expectedKeyId = await cryptoAdapter.keyId();
  for (const row of rows) {
    if (row.key_id !== expectedKeyId) throw new SecretKeyMismatchError();
    const version = Number(row.value_version);
    await cryptoAdapter.decrypt({
      ciphertext: bytes(row.ciphertext),
      nonce: bytes(row.nonce),
      algorithm: row.algorithm,
      keyId: row.key_id,
      valueVersion: version,
    }, { secret_id: row.id, value_version: version, key_id: row.key_id });
  }
}

function validateMutation(
  input: { name?: unknown; description?: unknown; value?: unknown },
  descriptionAllowed: boolean,
): Result<{ name: string; description: string | null; value: string }> {
  if (
    typeof input.name !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.name)
  ) return invalid("secret name is invalid");
  if (
    input.description !== undefined &&
    (!descriptionAllowed || typeof input.description !== "string" ||
      input.description.length > 1000)
  ) return invalid("secret description is invalid");
  const value = validateValue(input.value);
  return value.ok
    ? ok({
      name: input.name,
      description: input.description as string | undefined ?? null,
      value: value.value,
    })
    : value;
}
function validateValue(value: unknown): Result<string> {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    new TextEncoder().encode(value).length > 1024 * 1024
  ) return invalid("secret value must be non-empty UTF-8 without NUL");
  return ok(value);
}
function invalid(message: string): ReturnType<typeof err> {
  return err({
    code: "secret_invalid",
    message,
    severity: "validation",
    details: {},
  });
}
function notFound(): ReturnType<typeof err> {
  return err({
    code: "secret_not_found",
    message: "secret not found",
    severity: "not_found",
    details: {},
  });
}
function safeError(error: unknown, code: string): ReturnType<typeof err> {
  if (error instanceof SecretKeyMissingError) {
    return err({
      code: "secret_key_unavailable",
      message: error.message,
      severity: "unavailable",
      details: {},
    });
  }
  if (
    error instanceof SecretKeyMalformedError ||
    error instanceof SecretKeyMismatchError ||
    error instanceof SecretDecryptError
  ) {
    return err({
      code: error.code,
      message: "secret cryptographic operation failed",
      severity: "internal",
      details: {},
    });
  }
  if (error instanceof Error && "code" in error && error.code === "23505") {
    return err({
      code: "secret_name_conflict",
      message: "secret name already exists",
      severity: "conflict",
      details: {},
    });
  }
  return err({
    code,
    message: "secret operation failed",
    severity: "internal",
    details: {},
  });
}
async function audit(
  sql: Queryable,
  auth: AuthContext,
  event: string,
  id: string,
  name: string,
  metadata: JsonRecord = {},
) {
  await query(
    sql,
    `insert into audit_events(id,actor_id,event_type,resource,object_id,action,request_metadata_json) values($1,$2,$3,'system:secret',$4,$3,$5::jsonb)`,
    [
      uuidV7(),
      auth.principalId,
      event,
      id,
      JSON.stringify({ secret_id: id, name, ...metadata }),
    ],
  );
}
type JsonRecord = Record<string, unknown>;
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
