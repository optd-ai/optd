// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  ActionCatalog,
  ActionCuratedReadRepository,
  ActionPolicyAuthorizer,
  ActionStageHookCatalog,
  ActionTargetReader,
  HookExecutionEvidenceRepository,
  HookExecutor,
  HookSecretResolver,
  MetadataCatalog,
  MigrationRepository,
  OutboxRepository,
  PackCatalog,
  PinnedActionHookCatalog,
  PinnedDeliveryHookCatalog,
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
    { objectId: string },
    { id: string },
    { objectId: string }
  > = {
    execute: (_auth, _address, work) =>
      work({
        reader: {
          read: () => Promise.resolve({ id: "object-1" }),
          history: () => Promise.resolve([]),
        },
        authorization: { authorize: () => Promise.resolve(true) },
        authorizationRootId: "authorization-root",
      }),
  };

  assertEquals(
    await transactions.transaction((context) => Promise.resolve(context.id)),
    "transaction-1",
  );
  assertEquals(
    await reads.execute(
      { id: "auth-context" },
      { objectId: "object-1" },
      async ({ reader, authorization, authorizationRootId }) => ({
        allowed: await authorization.authorize({ objectId: "object-1" }),
        object: await reader.read({ objectId: "object-1" }),
        authorizationRootId,
      }),
    ),
    {
      allowed: true,
      object: { id: "object-1" },
      authorizationRootId: "authorization-root",
    },
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

Deno.test("catalog ports cover action staging, metadata, packs, and delivery pins", () => {
  const curated: ActionCuratedReadRepository<string, { versionId: string }> = {
    read: () => Promise.resolve({ versionId: "version-1" }),
  };
  const stageHooks: ActionStageHookCatalog<string> = {
    stageHooks: () => Promise.resolve([]),
  };
  const deliveryHooks: PinnedDeliveryHookCatalog<string> = {
    deliveryHook: () => Promise.resolve(null),
  };
  const metadata: MetadataCatalog<
    string,
    { ready: true },
    { id: string },
    { identity: string },
    { id: string }
  > = {
    home: () => Promise.resolve({ ready: true }),
    listPacks: () => Promise.resolve([]),
    pack: () => Promise.resolve(null),
    definition: () => Promise.resolve(null),
    hookScriptDigest: () => Promise.resolve(null),
  };
  const packs: PackCatalog<string, { id: string }, { id: string }> = {
    list: () => Promise.resolve([]),
    active: () => Promise.resolve(null),
    revision: () => Promise.resolve(null),
    revisionCount: () => Promise.resolve(0),
    storeOrReuseCandidate: (candidate) => Promise.resolve(candidate),
  };
  assertEquals(Object.keys(curated), ["read"]);
  assertEquals(Object.keys(stageHooks), ["stageHooks"]);
  assertEquals(Object.keys(deliveryHooks), ["deliveryHook"]);
  assertEquals(Object.keys(metadata).toSorted(), [
    "definition",
    "home",
    "hookScriptDigest",
    "listPacks",
    "pack",
  ]);
  assertEquals(Object.keys(packs).toSorted(), [
    "active",
    "list",
    "revision",
    "revisionCount",
    "storeOrReuseCandidate",
  ]);
});

Deno.test("run-action ports separate pinned reads, policy and evidence", async () => {
  const actions: ActionCatalog<string, { hook: string }> = {
    definition: () => Promise.resolve({ hook: "hook-1" }),
    availability: () => Promise.resolve({ hook: "hook-1" }),
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

  assertEquals(Object.keys(actions).toSorted(), ["availability", "definition"]);
  assertEquals(Object.keys(hooks), ["pinned"]);
  assertEquals(Object.keys(targets), ["current"]);
  assertEquals(Object.keys(policy), ["assertAllowed"]);
  assertEquals(
    await evidence.record({
      hookIdentity: "publisher/crm:convert_lead",
      revisionId: "revision-1",
      sourceDigest: "source-digest-1",
      scriptDigest: "script-digest-1",
      securityDigest: "security-digest-1",
      attachmentId: "attachment-1",
      attachmentDigest: "attachment-digest-1",
      configurationDigest: "configuration-digest-1",
      outputSchema: "changeset.operations.v1",
      actorId: "principal-1",
      phase: "action.commit",
      status: "failed",
      durationMs: 12,
      exitCode: 1,
      logs: "redacted",
      logsTruncated: false,
      secretsRedacted: true,
      grants: [],
      output: null,
      error: { code: "hook_failed" },
    }),
    "execution-1",
  );
});

Deno.test("hook ports preserve pinned execution and grant evidence", async () => {
  const secrets: HookSecretResolver = {
    resolve: (request) =>
      Promise.resolve({
        values: Object.fromEntries(
          request.declarations.map(({ env }) => [env, "redacted"]),
        ),
        grants: request.declarations.map(({ slot, env }) => ({
          grantId: `grant-${slot}`,
          secretId: `secret-${slot}`,
          secretVersion: 2,
          hookRevisionId: request.revisionId,
          securityDigest: request.securityDigest,
          slot,
          env,
        })),
      }),
  };
  const executor: HookExecutor = {
    execute: (_invocation) =>
      Promise.resolve({
        status: "succeeded",
        output: { kind: "validation", valid: true },
        logs: "secret=[REDACTED]",
        logsTruncated: false,
        secretsRedacted: true,
        durationMs: 4,
        exitCode: 0,
        error: null,
      }),
  };
  const resolved = await secrets.resolve({
    revisionId: "revision-1",
    hookIdentity: "publisher/pack:validate",
    securityDigest: "security-digest",
    declarations: [{ slot: "api", env: "API_TOKEN" }],
  });
  const result = await executor.execute({
    program: {
      hookIdentity: "publisher/pack:validate",
      revisionId: "revision-1",
      source: "export default () => ({valid:true})",
      sourceDigest: "source-digest",
      scriptDigest: "script-digest",
      securityDigest: "security-digest",
      attachmentId: "attachment-1",
      attachmentDigest: "attachment-digest",
      configurationDigest: "config-digest",
      declarationDigest: "declaration-digest",
      declaration: { condition: "true", input: {} },
      ordinal: 0,
      phase: "validate",
      timeoutMs: 1000,
      outputSchema: "validation.v1",
      permissions: { net: [], env: ["API_TOKEN"] },
      secretDeclarations: [{ slot: "api", env: "API_TOKEN" }],
      enabled: true,
    },
    input: { object: { id: "object-1" } },
    capabilities: { net: [], env: {}, secrets: resolved },
  });
  assertEquals(resolved.grants[0].grantId, "grant-api");
  assertEquals(result.secretsRedacted, true);
  assertEquals(result.output, { kind: "validation", valid: true });
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
    createProcessTreeLauncher: (kind) =>
      Promise.resolve({
        kind,
        runCli: () => Promise.resolve(ok),
        spawnCli: () =>
          Promise.resolve({
            pid: 43,
            wait: () => Promise.resolve(ok),
            terminate: () => Promise.resolve(),
          }),
        close: () => Promise.resolve(),
      }),
    runConcurrent: (requests) => Promise.resolve(requests.map(() => ok)),
    packPath: (pack) => Promise.resolve(`/packs/${pack}`),
    uploadPack: () => Promise.resolve("revision-1"),
    crashServer: () => Promise.resolve(),
    restartServer: () => Promise.resolve(),
    waitUntilReady: () => Promise.resolve(),
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

  assertEquals(
    (await harness.runCli(["auth", "login"], { stdin: "password\n" }))
      .stdout,
    "ok",
  );
  const launcher = await harness.createProcessTreeLauncher("agent");
  assertEquals(
    (await launcher.runCli(["auth", "whoami"])).stdout,
    "ok",
  );
  assertEquals(
    (await harness.runConcurrent([
      { args: ["query"] },
      { args: ["query"], launcher },
    ])).length,
    2,
  );
  assertEquals(await harness.packPath("projects"), "/packs/projects");
});
