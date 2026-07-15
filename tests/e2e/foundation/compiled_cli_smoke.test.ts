import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";

Deno.test("fresh real server supports compiled CLI TOON/JSON, restart, and stable failures", async () => {
  let harness: Awaited<ReturnType<typeof startLiveHarness>>;
  try {
    harness = await startLiveHarness();
  } catch (error) {
    if (String(error).includes("SKIP:")) {
      console.warn(String(error));
      return;
    }
    throw error;
  }

  let failed = true;
  try {
    const homeStat = await Deno.stat(harness.homeDir);
    assertEquals((homeStat.mode ?? 0) & 0o777, 0o700);
    const uidOutput = await new Deno.Command("id", {
      args: ["-u"],
      stdout: "piped",
    }).output();
    assertEquals(
      homeStat.uid,
      Number(new TextDecoder().decode(uidOutput.stdout)),
    );

    const live = await harness.runOptctl(["status", "live"]);
    assertEquals(live.code, 0);
    assertStringIncludes(live.stdout, "status");
    assertStringIncludes(live.stdout, "live");

    const ready = await harness.runOptctl(["--json", "status", "ready"]);
    assertEquals(ready.code, 0);
    const readyEnvelope = JSON.parse(ready.stdout);
    assertEquals(readyEnvelope.ok, true);
    assertEquals(readyEnvelope.data.status, "ready");
    assert(typeof readyEnvelope.meta.request_id === "string");

    const bootstrap = await harness.runOptctl([
      "--json",
      "status",
      "bootstrap",
    ]);
    assertEquals(
      JSON.parse(bootstrap.stdout).data.status,
      "bootstrap_required",
    );

    const malformed = await harness.runOptctl([
      "--json",
      "changeset",
      "preview",
      "--input",
      "{",
    ]);
    assertEquals(malformed.code, 2);
    assertEquals(JSON.parse(malformed.stderr).error.code, "usage_error");

    await harness.restart();
    const restarted = await harness.runOptctl(["--json", "status", "ready"]);
    assertEquals(restarted.code, 0);
    assertEquals(
      JSON.parse(restarted.stdout).data.migrations.appliedThisStart,
      [],
    );

    const unavailable = await new Deno.Command(harness.binaryPath, {
      args: ["--json", "--server", "http://127.0.0.1:1", "status", "live"],
      env: { ...Deno.env.toObject(), HOME: harness.homeDir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(unavailable.code, 1);
    assertEquals(
      JSON.parse(new TextDecoder().decode(unavailable.stderr)).error.code,
      "unavailable",
    );
    failed = false;
  } finally {
    if (failed) {
      const diagnostics = await harness.diagnostics();
      console.error(
        `retained live harness diagnostics at ${harness.rootDir}\n${diagnostics.server}`,
      );
    }
    await harness.close({ retain: failed });
  }
});
