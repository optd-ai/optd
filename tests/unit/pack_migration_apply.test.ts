// deno-lint-ignore-file no-import-prefix no-unversioned-import no-explicit-any require-await
import { assertEquals } from "jsr:@std/assert";
import { MigrationApplyError } from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import { makePostgresMigrationRepository } from "../../src/adapters/outbound/postgres/repositories/migration_application_repository.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";

const auth: AuthContext = Object.freeze({
  id: "01900000-0000-7000-8000-000000000001",
  principalId: "01900000-0000-7000-8000-000000000002",
  principalType: "human_user",
  humanUserId: "01900000-0000-7000-8000-000000000003",
  sessionId: "01900000-0000-7000-8000-000000000004",
  credentialKind: "human_full",
  roles: Object.freeze(["system:super_admin"]),
  createdAt: new Date(0).toISOString(),
});

Deno.test("migration validate maps stale typed failures without apply-attempt mutation", async () => {
  let transactions = 0;
  let queries = 0;
  const services = makePostgresMigrationRepository({
    sql: {
      unsafe: async () => {
        queries++;
        return [];
      },
    },
    authorization: {
      authorize: async () => ({ ok: true, value: {} }),
    } as any,
    authorizeApplyInTransaction: async () => ({ ok: true, value: {} }),
    tx: {
      transaction: async () => {
        transactions++;
        throw new MigrationApplyError(
          "migration_stale",
          "database-specific detail must not escape",
        );
      },
    },
  } as any);

  const result = await services.validate("migration", auth);
  assertEquals(result, {
    ok: false,
    error: {
      code: "migration_stale",
      message: "migration plan no longer matches the active pack revision",
      severity: "conflict",
      details: { reason: "active_pack_revision_changed" },
    },
  });
  assertEquals(transactions, 1);
  assertEquals(queries, 0);
});

Deno.test("migration apply retries only 40P01 and 40001 with fresh transactions", async () => {
  for (const state of ["40P01", "40001"]) {
    let attempts = 0;
    const services = makePostgresMigrationRepository({
      sql: { unsafe: async () => [] },
      authorization: {
        authorize: async () => ({ ok: true, value: {} }),
      } as any,
      authorizeApplyInTransaction: async () => ({ ok: true, value: {} }),
      tx: {
        transaction: async () => {
          attempts++;
          if (attempts < 3) {
            throw Object.assign(new Error("transient"), { code: state });
          }
          return {
            id: "application",
            migration_id: "migration",
            plan_digest: `sha256:${"a".repeat(64)}`,
            candidate_revision_id: "candidate",
            applied_by_auth_context_id: auth.id,
            applied_at: new Date(0).toISOString(),
          };
        },
      },
    } as any);
    const result = await services.apply("migration", {
      acknowledgement: "safe",
    }, auth);
    assertEquals(result.ok, true);
    assertEquals(attempts, 3);
  }
});

Deno.test("migration apply never retries timeout or non-transient SQLSTATEs", async () => {
  for (
    const [state, expected] of [["55P03", "pack_install_busy"], [
      "23505",
      "migration_apply_failed",
    ]] as const
  ) {
    let attempts = 0;
    const services = makePostgresMigrationRepository({
      sql: { unsafe: async () => [] },
      authorization: {
        authorize: async () => ({ ok: true, value: {} }),
      } as any,
      authorizeApplyInTransaction: async () => ({ ok: true, value: {} }),
      tx: {
        transaction: async () => {
          attempts++;
          throw Object.assign(new Error("database outcome"), { code: state });
        },
      },
    } as any);
    const result = await services.apply("migration", {
      acknowledgement: "safe",
    }, auth);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, expected);
    assertEquals(attempts, 1);
  }
});
