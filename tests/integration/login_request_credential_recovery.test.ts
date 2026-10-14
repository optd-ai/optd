import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { FilesystemLocalAuthStore } from "../../src/adapters/outbound/local-auth-store/filesystem.ts";
import { platformProcessInspector } from "../../src/adapters/outbound/process-inspection/linux.ts";
import { startLiveHarness } from "../support/live_harness.ts";

Deno.test("login reuses an intact request credential but replaces a missing one", async () => {
  const harness = await startLiveHarness();
  try {
    const credentials = {
      username: "recovery-admin",
      password: "Recovery-test-password-42!",
    };
    const bootstrapped = await harness.bootstrap(credentials);
    assertEquals(bootstrapped.code, 0, bootstrapped.stderr);
    const store = new FilesystemLocalAuthStore(
      join(harness.homeDir, ".local/share/optd/auth"),
      platformProcessInspector(),
    );
    const origin = harness.baseUrl;
    const original = await store.requestCredential(origin);
    assertEquals(original !== null, true);
    const originalId = (await store.readState(origin)).requestSessionId;
    assertEquals(typeof originalId, "string");

    const reused = await harness.login(credentials);
    assertEquals(reused.code, 0, reused.stderr);
    assertEquals(
      (await store.requestCredential(origin))?.token === original?.token,
      true,
    );
    assertEquals((await store.readState(origin)).requestSessionId, originalId);

    // Reproduce older redemption: the secret is gone but its session ID remains.
    await store.updateState(origin, { requestToken: undefined });
    assertEquals(await store.requestCredential(origin), null);
    assertEquals((await store.readState(origin)).requestSessionId, originalId);
    const recovered = await harness.login(credentials);
    assertEquals(recovered.code, 0, recovered.stderr);
    const replacement = await store.requestCredential(origin);
    assertEquals(replacement !== null, true);
    assertEquals(replacement?.token === original?.token, false);
    assertNotEquals(
      (await store.readState(origin)).requestSessionId,
      originalId,
    );
    for (const result of [reused, recovered]) {
      for (const token of [original?.token, replacement?.token]) {
        if (token) {
          assertEquals((result.stdout + result.stderr).includes(token), false);
        }
      }
    }
    const agent = await harness.createAgentLauncher();
    try {
      const requested = await agent.runOptctl([
        "--json",
        "auth",
        "request",
        "--role",
        "system:admin",
        "--boundary",
        "system",
        "--reason",
        "recovered request credential",
      ]);
      assertEquals(requested.code, 0, requested.stderr);
      assertEquals(JSON.parse(requested.stdout).data.status, "pending");
    } finally {
      await agent.close();
    }
  } finally {
    await harness.close();
  }
});
