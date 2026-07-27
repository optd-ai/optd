// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  ActionCatalog,
  ActionPolicyAuthorizer,
  ActionTargetReader,
  HookExecutionEvidenceRepository,
  MigrationRepository,
  OutboxRepository,
  PinnedActionHookCatalog,
  ReadSessionPort,
  RepositoryTransaction,
  TransactionPort,
} from "../../../src/application/ports/repair/repositories.ts";
import type {
  CompletePublicFlowHarness,
  PublicFlowCommandResult,
} from "../../support/public_flow_contract.ts";

Deno.test("transaction and read-session ports expose opaque capabilities", async () => {
  const transaction: RepositoryTransaction = { id: "transaction-1" };
  const transactions: TransactionPort = {
    transaction: (work) => work(transaction),
  };
  const reads: ReadSessionPort<
    { objectId: string },
    { id: string },
    { objectId: string },
    readonly string[],
    { objectId: string }
  > = {
    execute: (work) =>
      work(
        {
          read: () => Promise.resolve({ id: "object-1" }),
          history: () => Promise.resolve([]),
        },
        { authorize: () => Promise.resolve(true) },
      ),
  };

  assertEquals(
    await transactions.transaction((context) => Promise.resolve(context.id)),
    "transaction-1",
  );
  assertEquals(
    await reads.execute(async (reader, authorization) => ({
      allowed: await authorization.authorize({ objectId: "object-1" }),
      object: await reader.read({ objectId: "object-1" }),
    })),
    { allowed: true, object: { id: "object-1" } },
  );
});

Deno.test("outbox port freezes the complete delivery and operator lifecycle", async () => {
  const transaction: RepositoryTransaction = { id: "tx-1" };
  const outbox: OutboxRepository<
    { limit: number },
    { id: string },
    { id: string; outcome: string },
    string,
    { limit: number },
    { id: string },
    { id: string; after: number },
    { number: number }
  > = {
    claim: () => Promise.resolve([{ id: "delivery-1" }]),
    complete: () => Promise.resolve("succeeded"),
    list: () => Promise.resolve([{ id: "delivery-1" }]),
    inspect: (id) => Promise.resolve({ id }),
    attempts: () => Promise.resolve([{ number: 1 }]),
    retry: async (request) =>
      await request.authority.revalidate(transaction)
        ? "pending"
        : "authorization_changed",
    cancel: async (request) =>
      await request.authority.revalidate(transaction)
        ? "cancelled"
        : "authorization_changed",
    auditDrain: () => Promise.resolve(),
  };

  assertEquals(Object.keys(outbox).toSorted(), [
    "attempts",
    "auditDrain",
    "cancel",
    "claim",
    "complete",
    "inspect",
    "list",
    "retry",
  ]);
  assertEquals(
    await outbox.retry({
      deliveryId: "delivery-1",
      authority: {
        authContextId: "context-1",
        revalidate: () => Promise.resolve(false),
      },
    }),
    "authorization_changed",
  );
});

Deno.test("run-action ports separate pinned reads, policy and evidence", async () => {
  const actions: ActionCatalog<string, { hook: string }> = {
    definition: () => Promise.resolve({ hook: "hook-1" }),
  };
  const hooks: PinnedActionHookCatalog<string, { revision: string }> = {
    pinned: () => Promise.resolve({ revision: "revision-1" }),
  };
  const targets: ActionTargetReader<string, { title: string }> = {
    current: () =>
      Promise.resolve({
        resource: "publisher/crm:lead",
        name: "lead",
        objectId: "lead-1",
        objectVersionId: "version-1",
        object: { title: "Lead" },
      }),
  };
  const policy: ActionPolicyAuthorizer<string, { allowed: true }> = {
    assertAllowed: () => Promise.resolve({ allowed: true }),
  };
  const evidence: HookExecutionEvidenceRepository<
    { operations: readonly unknown[] },
    { code: string },
    string
  > = {
    record: () => Promise.resolve("execution-1"),
  };

  assertEquals(Object.keys(actions), ["definition"]);
  assertEquals(Object.keys(hooks), ["pinned"]);
  assertEquals(Object.keys(targets), ["current"]);
  assertEquals(Object.keys(policy), ["assertAllowed"]);
  assertEquals(
    await evidence.record({
      hookIdentity: "publisher/crm:convert_lead",
      revisionId: "revision-1",
      scriptDigest: "digest-1",
      actorId: "principal-1",
      phase: "action.commit",
      status: "failed",
      durationMs: 12,
      exitCode: 1,
      logs: "redacted",
      output: null,
      error: { code: "hook_failed" },
    }),
    "execution-1",
  );
});

Deno.test("migration port exposes SQL and durable apply attempts", async () => {
  const migration: MigrationRepository<
    string,
    { id: string },
    { id: string },
    { valid: boolean },
    { id: string },
    { applied: boolean }
  > = {
    plan: (id) => Promise.resolve({ id }),
    inspect: (id) => Promise.resolve({ id }),
    validate: () => Promise.resolve({ valid: true }),
    generatedSql: () => Promise.resolve(["select 1"]),
    apply: () => Promise.resolve({ applied: true }),
    recordApplyAttempt: () => Promise.resolve(),
  };

  assertEquals(Object.keys(migration).toSorted(), [
    "apply",
    "generatedSql",
    "inspect",
    "plan",
    "recordApplyAttempt",
    "validate",
  ]);
  assertEquals(await migration.generatedSql("migration-1"), ["select 1"]);
});

Deno.test("complete public-flow harness is backend neutral", async () => {
  const ok: PublicFlowCommandResult = { code: 0, stdout: "ok", stderr: "" };
  const harness: CompletePublicFlowHarness = {
    backend: "host",
    serverOrigin: "http://127.0.0.1:8000",
    compileCurrentCli: () => Promise.resolve("/tmp/optctl"),
    runCli: () => Promise.resolve(ok),
    spawnCli: () =>
      Promise.resolve({
        pid: 42,
        wait: () => Promise.resolve(ok),
        terminate: () => Promise.resolve(),
      }),
    packPath: (pack) => Promise.resolve(`/packs/${pack}`),
    uploadPack: () => Promise.resolve("revision-1"),
    restartServer: () => Promise.resolve(),
    waitForProviderBarrier: () => Promise.resolve(),
    releaseProviderBarrier: () => Promise.resolve(),
    diagnostics: () =>
      Promise.resolve({
        serverLogs: "",
        processTree: [],
        runtimeResources: [],
      }),
    cleanup: () => Promise.resolve(),
  };

  assertEquals((await harness.runCli(["auth", "whoami"])).stdout, "ok");
  assertEquals(await harness.packPath("projects"), "/packs/projects");
});
