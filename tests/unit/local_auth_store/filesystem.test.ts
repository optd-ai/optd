import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import type {
  ProcessIdentity,
  ProcessInspector,
} from "../../../src/application/ports/process_inspection.ts";
import {
  FilesystemLocalAuthStore,
  normalizeOrigin,
} from "../../../src/adapters/outbound/local-auth-store/filesystem.ts";

const human: ProcessIdentity = {
  pid: 100,
  parentPid: 1,
  startTicks: "1000",
  uid: Deno.uid() ?? 0,
  bootId: "boot-a",
};
const child: ProcessIdentity = {
  ...human,
  pid: 200,
  parentPid: 100,
  startTicks: "2000",
};
const agent: ProcessIdentity = {
  ...human,
  pid: 300,
  parentPid: 200,
  startTicks: "3000",
};

class FakeInspector implements ProcessInspector {
  constructor(readonly chain: ProcessIdentity[]) {}
  inspect(pid: number): Promise<ProcessIdentity> {
    const value = this.chain.find((item) => item.pid === pid);
    if (!value) return Promise.reject(new Deno.errors.NotFound());
    return Promise.resolve(value);
  }
  ancestry(_startPid: number, _stopPid?: number): Promise<ProcessIdentity[]> {
    return Promise.resolve(this.chain);
  }
}

async function temporaryStore(chain = [agent, child, human]) {
  const root = await Deno.makeTempDir();
  if (Deno.build.os !== "windows") await Deno.chmod(root, 0o700);
  return {
    root,
    store: new FilesystemLocalAuthStore(root, new FakeInspector(chain)),
  };
}

Deno.test("local store partitions origins and selects exactly the nearest binding", async () => {
  const { root, store } = await temporaryStore();
  try {
    await store.updateState("http://127.0.0.1:8789", {
      token: "human-token",
      username: "jordan",
    }, human);
    await store.updateState("http://127.0.0.1:8789", {
      token: "agent-token",
      authorizationId: "auth-agent",
    }, child);
    await store.updateState(
      "http://127.0.0.1:8790",
      { token: "other-token" },
      human,
    );

    assertEquals(
      (await store.select("http://127.0.0.1:8789", agent.pid))?.token,
      "agent-token",
    );
    assertEquals(
      (await store.select("http://127.0.0.1:8790", agent.pid))?.token,
      "other-token",
    );
    assertEquals(await store.select("http://localhost:8789", agent.pid), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stale or PID-reused anchors are never selected", async () => {
  const { root, store } = await temporaryStore([{
    ...human,
    startTicks: "reused",
  }]);
  try {
    await store.updateState(
      "http://127.0.0.1:8789",
      { token: "secret" },
      human,
    );
    assertEquals(await store.select("http://127.0.0.1:8789", human.pid), null);
    assertEquals(await store.cleanup("http://127.0.0.1:8789"), 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("atomic records are private and doctor safely repairs current-owner modes", async () => {
  if (Deno.build.os === "windows") return;
  const { root, store } = await temporaryStore([human]);
  try {
    await store.updateState(
      "http://127.0.0.1:8789",
      { token: "secret" },
      human,
    );
    let tokenPath = "";
    for await (const entry of Deno.readDir(`${root}/instances`)) {
      for await (
        const session of Deno.readDir(
          `${root}/instances/${entry.name}/sessions`,
        )
      ) {
        const candidate =
          `${root}/instances/${entry.name}/sessions/${session.name}/token`;
        try {
          await Deno.stat(candidate);
          tokenPath = candidate;
        } catch { /* request session has no token */ }
      }
    }
    assertEquals((await Deno.stat(tokenPath)).mode! & 0o777, 0o600);
    await Deno.chmod(tokenPath, 0o644);
    await assertRejects(
      () => store.select("http://127.0.0.1:8789", human.pid),
      Error,
      "permissions",
    );
    assertEquals((await store.doctor()).healthy, false);
    const repaired = await store.doctor(true);
    assertEquals(
      repaired.fixes.some((fix) => fix.action === "chmod_0600"),
      true,
    );
    assertEquals(
      (await store.select("http://127.0.0.1:8789", human.pid))?.token,
      "secret",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("origin normalization is exact and remote HTTP is fail closed", () => {
  assertEquals(
    normalizeOrigin("HTTPS://Example.COM:443"),
    "https://example.com",
  );
  assertThrows(
    () => normalizeOrigin("https://example.com/path"),
    Error,
    "must not contain",
  );
});
