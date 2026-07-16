import { assertEquals } from "jsr:@std/assert";
import { makeMigrationServices } from "../../src/application/services/migration_services.ts";
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

Deno.test("migration apply retries only 40P01 and 40001 with fresh transactions", async () => {
  for (const state of ["40P01", "40001"]) {
    let attempts = 0;
    const services = makeMigrationServices({
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
    const services = makeMigrationServices({
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
