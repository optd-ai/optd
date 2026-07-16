import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
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

Deno.test("store rejects ancestor and final token symlinks", async () => {
  if (Deno.build.os === "windows") return;
  const parent = await Deno.makeTempDir();
  const real = `${parent}/real`;
  const linked = `${parent}/linked`;
  await Deno.mkdir(real, { mode: 0o700 });
  await Deno.symlink(real, linked);
  const inspector = new FakeInspector([human]);
  try {
    const ancestorStore = new FilesystemLocalAuthStore(
      `${linked}/auth`,
      inspector,
    );
    await assertRejects(
      () =>
        ancestorStore.updateState(
          "http://127.0.0.1:8789",
          { token: "secret" },
          human,
        ),
      Error,
      "symlink",
    );
    assertEquals(
      (await ancestorStore.doctor()).findings[0].code,
      "auth_store_symlink",
    );

    const root = `${parent}/safe`;
    await Deno.mkdir(root, { mode: 0o700 });
    const store = new FilesystemLocalAuthStore(root, inspector);
    await store.updateState(
      "http://127.0.0.1:8789",
      { token: "secret" },
      human,
    );
    const layout = await storeLayout(root);
    await Deno.remove(layout.token);
    await Deno.writeTextFile(`${parent}/outside`, "stolen", { mode: 0o600 });
    await Deno.symlink(`${parent}/outside`, layout.token);
    await assertRejects(
      () => store.select("http://127.0.0.1:8789", human.pid),
      Error,
      "symlink",
    );
    assertEquals(
      (await store.doctor()).findings.some((finding) =>
        finding.code === "auth_store_symlink"
      ),
      true,
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("doctor reports references, liveness, partitions, orphans, temp files, and stale locks", async () => {
  const chain = [human];
  const { root, store } = await temporaryStore(chain);
  try {
    await store.updateState(
      "http://127.0.0.1:8789",
      { token: "secret" },
      human,
    );
    const layout = await storeLayout(root);
    const originalBinding = JSON.parse(await Deno.readTextFile(layout.binding));
    const serverValue = await Deno.readTextFile(layout.server);
    const serverRecord = JSON.parse(serverValue);
    await Deno.writeTextFile(
      layout.server,
      JSON.stringify({ ...serverRecord, state: { projectId: 42 } }),
      { mode: 0o600 },
    );
    assert(
      (await store.doctor()).findings.some((finding) =>
        finding.code === "server_record_invalid"
      ),
    );
    await Deno.writeTextFile(layout.server, serverValue, { mode: 0o600 });
    const identityPath = `${root}/identity.json`;
    const identityValue = await Deno.readTextFile(identityPath);
    await Deno.writeTextFile(
      identityPath,
      JSON.stringify({ schema_version: 1, record_type: "wrong" }),
      { mode: 0o600 },
    );
    assert(
      (await store.doctor()).findings.some((finding) =>
        finding.code === "local_identity_invalid"
      ),
    );
    await Deno.writeTextFile(identityPath, identityValue, { mode: 0o600 });

    const orphan = `${layout.sessions}/orphan`;
    await Deno.mkdir(orphan, { mode: 0o700 });
    const metadata = JSON.parse(await Deno.readTextFile(layout.metadata));
    await Deno.writeTextFile(
      `${orphan}/metadata.json`,
      JSON.stringify({ ...metadata, id: "orphan" }),
      { mode: 0o600 },
    );
    await Deno.writeTextFile(`${orphan}/token`, "orphan-secret", {
      mode: 0o600,
    });
    await Deno.writeTextFile(
      `${layout.bindings}/.binding.partial.tmp`,
      "partial",
      { mode: 0o600 },
    );
    const lock = `${layout.instance}/.lock`;
    await Deno.mkdir(lock, { mode: 0o700 });
    await Deno.utime(lock, new Date(0), new Date(0));
    await Deno.mkdir(`${root}/instances/not-a-digest`, { mode: 0o700 });

    const duplicateBinding = `${layout.bindings}/duplicate.json`;
    await Deno.writeTextFile(
      duplicateBinding,
      JSON.stringify({ ...originalBinding, id: "duplicate" }),
      { mode: 0o600 },
    );
    let duplicateReport = await store.doctor();
    assert(
      duplicateReport.findings.some((finding) =>
        finding.code === "session_binding_duplicate"
      ),
    );
    await Deno.remove(duplicateBinding);

    const tokenValue = await Deno.readTextFile(layout.token);
    await Deno.remove(layout.token);
    assert(
      (await store.doctor()).findings.some((finding) =>
        finding.code === "session_token_missing_or_invalid"
      ),
    );
    await Deno.writeTextFile(layout.token, tokenValue, { mode: 0o600 });
    const metadataValue = await Deno.readTextFile(layout.metadata);
    await Deno.remove(layout.metadata);
    assert(
      (await store.doctor()).findings.some((finding) =>
        finding.code === "session_metadata_invalid"
      ),
    );
    await Deno.writeTextFile(layout.metadata, metadataValue, { mode: 0o600 });

    await Deno.writeTextFile(
      layout.binding,
      JSON.stringify({ ...originalBinding, session_id: "missing" }),
      { mode: 0o600 },
    );
    let report = await store.doctor();
    for (
      const code of [
        "binding_session_reference_broken",
        "orphan_session",
        "stale_auth_temporary",
        "stale_auth_lock",
        "origin_partition_invalid",
      ]
    ) assert(report.findings.some((finding) => finding.code === code), code);

    await Deno.writeTextFile(layout.binding, JSON.stringify(originalBinding), {
      mode: 0o600,
    });
    chain.splice(0, 1, { ...human, startTicks: "reused" });
    report = await store.doctor();
    assert(
      report.findings.some((finding) =>
        finding.code === "process_binding_stale"
      ),
    );
    const fixed = await store.doctor(true);
    assert(fixed.fixes.some((item) => item.action === "remove_stale_binding"));
    assert(fixed.fixes.some((item) => item.action === "remove_orphan_session"));
    assert(
      fixed.fixes.some((item) => item.action === "remove_stale_temporary"),
    );
    assert(fixed.fixes.some((item) => item.action === "remove_stale_lock"));
    assertEquals(await store.select("http://127.0.0.1:8789", human.pid), null);
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

async function storeLayout(root: string) {
  const instances = `${root}/instances`;
  const instanceEntry = (await Array.fromAsync(Deno.readDir(instances))).find((
    entry,
  ) => entry.isDirectory);
  if (!instanceEntry) throw new Error("instance missing");
  const instance = `${instances}/${instanceEntry.name}`;
  const bindings = `${instance}/bindings`;
  const bindingEntry = (await Array.fromAsync(Deno.readDir(bindings))).find((
    entry,
  ) => entry.name.endsWith(".json"));
  if (!bindingEntry) throw new Error("binding missing");
  const binding = `${bindings}/${bindingEntry.name}`;
  const record = JSON.parse(await Deno.readTextFile(binding));
  const sessions = `${instance}/sessions`;
  const session = `${sessions}/${record.session_id}`;
  return {
    instance,
    server: `${instance}/server.json`,
    bindings,
    binding,
    sessions,
    metadata: `${session}/metadata.json`,
    token: `${session}/token`,
  };
}
