import type { HookSecretGrantEvidence } from "../../../domain/changesets/stage.ts";
import type { EnvelopeCrypto } from "../crypto/envelope.ts";
import { query, type Sql } from "./client.ts";

export class HookSecretGrantUnavailableError extends Error {
  readonly code = "hook_secret_grant_unavailable";
  constructor(readonly slot: string) {
    super("pinned hook-secret grant is unavailable");
  }
}

export class HookSecretUnavailableError extends Error {
  readonly code = "hook_secret_unavailable";
  constructor(readonly slot: string) {
    super("required hook secret is unavailable");
  }
}

export type ResolvedHookSecrets = {
  values: Record<string, string>;
  evidence: HookSecretGrantEvidence[];
};

export class PostgresHookSecretRepository {
  constructor(
    private readonly sql: Sql,
    private readonly crypto: EnvelopeCrypto,
  ) {}

  async resolve(
    hookRevisionId: string,
    securityDigest: string,
    slots: readonly Readonly<{
      slot: string;
      env: string;
      grant_id?: string | null;
      secret_id?: string | null;
    }>[],
  ): Promise<ResolvedHookSecrets> {
    return await this.sql.begin(async (tx) => {
      const values: Record<string, string> = {};
      const evidence: HookSecretGrantEvidence[] = [];
      for (const declaration of slots) {
        const row = (await query<{
          grant_id: string;
          hook_security_digest: string;
          secret_id: string;
          ciphertext: Uint8Array;
          nonce: Uint8Array;
          algorithm: "AES-256-GCM";
          key_id: string;
          value_version: string;
          status: string;
        }>(
          tx,
          `select g.id as grant_id,g.hook_security_digest,s.id as secret_id,
                  s.ciphertext,s.nonce,s.algorithm,s.key_id,s.value_version,s.status
             from hook_secret_grant_heads head
             join hook_secret_grants g on g.id=head.grant_id
             join platform_secrets s on s.id=g.secret_id
            where head.hook_revision_id=$1 and head.slot=$2
              and not exists(select 1 from hook_secret_grant_revocations r where r.grant_id=g.id)
            for update of head,g,s`,
          [hookRevisionId, declaration.slot],
        )).rows[0];
        if (
          !row || row.hook_security_digest !== securityDigest ||
          (declaration.grant_id !== undefined &&
            row.grant_id !== declaration.grant_id) ||
          (declaration.secret_id !== undefined &&
            row.secret_id !== declaration.secret_id)
        ) throw new HookSecretGrantUnavailableError(declaration.slot);
        if (row.status !== "active") {
          throw new HookSecretUnavailableError(declaration.slot);
        }
        const valueVersion = Number(row.value_version);
        let value: string;
        try {
          value = await this.crypto.decrypt({
            ciphertext: bytes(row.ciphertext),
            nonce: bytes(row.nonce),
            algorithm: row.algorithm,
            keyId: row.key_id,
            valueVersion,
          }, {
            secret_id: row.secret_id,
            value_version: valueVersion,
            key_id: row.key_id,
          });
        } catch {
          throw new HookSecretUnavailableError(declaration.slot);
        }
        values[declaration.env] = value;
        evidence.push({
          grant_id: row.grant_id,
          secret_id: row.secret_id,
          value_version: valueVersion,
          slot: declaration.slot,
          env: declaration.env,
        });
      }
      return { values, evidence };
    });
  }
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string" && value.startsWith("\\x")) {
    return Uint8Array.from(
      value.slice(2).match(/../g) ?? [],
      (part) => parseInt(part, 16),
    );
  }
  throw new Error("invalid encrypted secret bytes");
}
