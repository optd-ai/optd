import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import {
  query,
  type Queryable,
} from "../../adapters/outbound/postgres/client.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";
import {
  EnvelopeCrypto,
  SecretDecryptError,
  SecretKeyMissingError,
} from "../../adapters/outbound/crypto/envelope.ts";
import {
  type ActorContext,
  auditPolicy,
  normalizeActor,
} from "../../domain/policies/policy_engine.ts";

type JsonRecord = Record<string, unknown>;

export type SecretListDto = {
  secrets: Array<{
    name: string;
    description: string | null;
    algorithm: string;
    key_id: string;
    created_by: string;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
  }>;
};
export type SecretSetRequest = {
  name: string;
  value: string;
  description?: string;
  actor?: string | JsonRecord;
  actor_id?: string;
  actor_context?: JsonRecord;
};
export type SecretDeleteRequest = {
  actor?: string | JsonRecord;
  actor_id?: string;
  actor_context?: JsonRecord;
};

export type SecretSetDto = {
  name: string;
  description: string | null;
  masked: true;
};
export type SecretDeleteDto = { name: string; deleted: boolean };

export type SecretResolver = {
  resolveSecret(name: string, actor?: ActorContext): Promise<string>;
};

export function makeSecretService(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
  crypto?: EnvelopeCrypto;
}) {
  const cryptoAdapter = deps.crypto ?? new EnvelopeCrypto();
  return {
    async list(
      input: { actor?: unknown } = {},
    ): Promise<Result<SecretListDto>> {
      try {
        await requireMasterKey(cryptoAdapter);
        const actor = normalizeActor(input.actor ?? "anonymous");
        await authorizeSecret(deps.sql, actor, "secret:list");
        const rows = await query<SecretListDto["secrets"][number]>(
          deps.sql,
          `select name,description,algorithm,key_id,created_by,updated_by,created_at::text,updated_at::text
           from platform_secrets order by name`,
        );
        return ok({ secrets: rows.rows });
      } catch (error) {
        return secretError(error, "secret_list_failed");
      }
    },

    async set(input: SecretSetRequest): Promise<Result<SecretSetDto>> {
      try {
        await requireMasterKey(cryptoAdapter);
        const name = validateSecretName(input.name);
        if (typeof input.value !== "string" || input.value.length === 0) {
          throw new Error("secret value is required");
        }
        const actor = actorOf(input);
        await authorizeSecret(deps.sql, actor, "secret:set", name);
        const encrypted = await cryptoAdapter.encrypt(input.value);
        const description = typeof input.description === "string"
          ? input.description
          : null;
        await deps.tx.transaction(async (tx) => {
          await query(
            tx,
            `insert into platform_secrets(name,description,ciphertext,nonce,algorithm,key_id,created_by,updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,null)
             on conflict (name) do update set
               description=excluded.description,
               ciphertext=excluded.ciphertext,
               nonce=excluded.nonce,
               algorithm=excluded.algorithm,
               key_id=excluded.key_id,
               updated_by=$7,
               updated_at=now()`,
            [
              name,
              description,
              encrypted.ciphertext,
              encrypted.nonce,
              encrypted.algorithm,
              encrypted.keyId,
              actor.id,
            ],
          );
          await auditSecret(tx, actor, "secret.set", name, { description });
        });
        return ok({ name, description, masked: true });
      } catch (error) {
        return secretError(error, "secret_set_failed");
      }
    },

    async delete(
      nameInput: string,
      input: SecretDeleteRequest = {},
    ): Promise<Result<SecretDeleteDto>> {
      try {
        await requireMasterKey(cryptoAdapter);
        const name = validateSecretName(nameInput);
        const actor = actorOf(input);
        await authorizeSecret(deps.sql, actor, "secret:delete", name);
        const deleted = await deps.tx.transaction(async (tx) => {
          const rows = await query<{ name: string }>(
            tx,
            "delete from platform_secrets where name=$1 returning name",
            [name],
          );
          await auditSecret(tx, actor, "secret.delete", name, {
            deleted: rows.rows.length > 0,
          });
          return rows.rows.length > 0;
        });
        return ok({ name, deleted });
      } catch (error) {
        return secretError(error, "secret_delete_failed");
      }
    },

    async resolveSecret(
      nameInput: string,
      actor: ActorContext = { id: "system:hook", roles: ["system"] },
    ): Promise<string> {
      await requireMasterKey(cryptoAdapter);
      const name = validateSecretName(nameInput);
      await authorizeSecret(deps.sql, actor, "secret:read", name);
      const rows = await query<{
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        algorithm: "AES-256-GCM";
        key_id: string;
      }>(
        deps.sql,
        "select ciphertext,nonce,algorithm,key_id from platform_secrets where name=$1",
        [name],
      );
      const row = rows.rows[0];
      if (!row) throw new Error(`secret ${name} not found`);
      return await cryptoAdapter.decrypt({
        ciphertext: bytesOf(row.ciphertext),
        nonce: bytesOf(row.nonce),
        algorithm: row.algorithm,
        keyId: row.key_id,
      });
    },
  };
}

export async function assertSecretSubsystemReady(
  sql: Queryable,
  cryptoAdapter = new EnvelopeCrypto(),
): Promise<void> {
  const table = await query<{ exists: boolean }>(
    sql,
    "select to_regclass('public.platform_secrets') is not null as exists",
  );
  if (!table.rows[0]?.exists) return;
  const count = await query<{ count: string }>(
    sql,
    "select count(*)::text as count from platform_secrets",
  );
  if (Number(count.rows[0]?.count ?? 0) > 0 && !cryptoAdapter.hasKey()) {
    throw new SecretKeyMissingError();
  }
}

async function authorizeSecret(
  sql: Queryable,
  actor: ActorContext,
  action: string,
  name?: string,
) {
  const allowed = actor.roles.includes("super_admin") ||
    actor.roles.includes("admin") || actor.roles.includes("system");
  const decision = {
    allowed,
    bypassed: actor.roles.includes("super_admin"),
    digest: "builtin-secret-policy-v1",
    matched_rules: allowed
      ? [
        actor.roles.includes("super_admin")
          ? "super_admin_bypass"
          : "builtin_secret_admin",
      ]
      : [],
    checked_rules: ["builtin_secret_admin"],
    reason: allowed
      ? "builtin secret policy"
      : "admin role required for secrets",
  };
  if (!allowed) {
    await auditPolicy(
      sql,
      { actor, resource: "platform.secret", action, object_id: name },
      decision,
      "policy.denied",
    );
    const error = new Error(
      `actor is not allowed to ${action} platform.secret`,
    );
    (error as Error & { code?: string; details?: JsonRecord }).code =
      "policy_denied";
    (error as Error & { code?: string; details?: JsonRecord }).details = {
      actor_id: actor.id,
      action,
      secret: name,
    };
    throw error;
  }
  if (decision.bypassed) {
    await auditPolicy(
      sql,
      { actor, resource: "platform.secret", action, object_id: name },
      decision,
      "policy.bypassed",
    );
  }
}

async function auditSecret(
  sql: Queryable,
  actor: ActorContext,
  eventType: string,
  name: string,
  metadata: JsonRecord,
) {
  await query(
    sql,
    `insert into audit_events(id,actor_id,event_type,resource,object_id,action,request_metadata_json)
     values ($1,$2,$3,'platform.secret',$4,$5,$6::jsonb)`,
    [
      crypto.randomUUID(),
      actor.id,
      eventType,
      name,
      eventType,
      JSON.stringify({ name, ...metadata }),
    ],
  );
}

function actorOf(
  input: { actor?: unknown; actor_id?: string; actor_context?: JsonRecord },
): ActorContext {
  if (input.actor_context) return normalizeActor(input.actor_context);
  if (input.actor_id) return normalizeActor(input.actor_id);
  return normalizeActor(input.actor ?? "anonymous");
}
async function requireMasterKey(cryptoAdapter: EnvelopeCrypto) {
  if (!cryptoAdapter.hasKey()) throw new SecretKeyMissingError();
}
function validateSecretName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error(
      "secret name must start with a letter or underscore and contain only letters, numbers, _, ., or -",
    );
  }
  return name;
}
function secretError<T>(error: unknown, fallbackCode: string): Result<T> {
  if (
    error instanceof SecretKeyMissingError ||
    error instanceof SecretDecryptError
  ) {
    return err(validationError(error.code, error.message));
  }
  const coded = error as Error & { code?: string; details?: JsonRecord };
  return err(
    validationError(
      coded.code ?? fallbackCode,
      error instanceof Error ? error.message : String(error),
      coded.details,
    ),
  );
}
function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string" && value.startsWith("\\x")) {
    const hex = value.slice(2);
    return new Uint8Array(
      hex.match(/../g)?.map((part) => parseInt(part, 16)) ?? [],
    );
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("invalid encrypted secret bytes");
}
