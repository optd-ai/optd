// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
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
