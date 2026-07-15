import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { isUuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

function assertFrozenErrorEnvelope(text: string, expectedCode: string) {
  const envelope = JSON.parse(text);
  assertEquals(Object.keys(envelope).sort(), ["error", "meta", "ok"]);
  assertEquals(Object.keys(envelope.error).sort(), [
    "code",
    "details",
    "message",
  ]);
  assertEquals(envelope.ok, false);
  assertEquals(envelope.error.code, expectedCode);
  assert(typeof envelope.error.message === "string");
  assert(
    envelope.error.details !== null &&
      typeof envelope.error.details === "object" &&
      !Array.isArray(envelope.error.details),
  );
  assert(isUuidV7(envelope.meta.request_id));
  assertEquals("help" in envelope, false);
  assertEquals("severity" in envelope.error, false);
  return envelope;
}

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
    const diagnostics = await harness.diagnostics();
    assertStringIncludes(diagnostics.postgres, "PostgreSQL");
    assert(diagnostics.server.length <= 1024 * 1024);
    assert(typeof diagnostics.hooks === "string");

    const bootstrap = await harness.runOptctl([
      "--json",
      "status",
      "bootstrap",
    ]);
    assertEquals(
      JSON.parse(bootstrap.stdout).data.state,
      "bootstrap_required",
    );

    const unauthenticated = await harness.runOptctl(["--json", "home"]);
    assertEquals(unauthenticated.code, 1);
    assertFrozenErrorEnvelope(
      unauthenticated.stderr,
      "authentication_required",
    );
    const initialized = await harness.bootstrap({
      username: "foundation-admin",
      password: "foundation bootstrap password",
    });
    assertEquals(initialized.code, 0, initialized.stderr);

    const serverError = await harness.runOptctl([
      "--json",
      "metadata",
      "pack",
      "missing.missing",
    ]);
    assertEquals(serverError.code, 1);
    assertFrozenErrorEnvelope(serverError.stderr, "not_found");

    const processTree = await harness.createAgentLauncher();
    const inherited = await processTree.runOptctl(["--json", "status", "live"]);
    assertEquals(inherited.code, 0);
    await processTree.close();

    const concurrent = await harness.runConcurrent([
      { args: ["--json", "status", "live"] },
      { args: ["--json", "status", "ready"] },
    ]);
    assertEquals(concurrent.map((result) => result.code), [0, 0]);
    assert(concurrent.every((result) => result.durationMs >= 0));

    const bootstrapFuture = await harness.bootstrapProcess({
      username: "future-admin",
      password: "not-a-real-credential",
    });
    assertEquals(bootstrapFuture.result.code, 1);
    assertFrozenErrorEnvelope(
      bootstrapFuture.result.stderr,
      "bootstrap_already_completed",
    );
    await bootstrapFuture.launcher.close();
    const loginFuture = await harness.loginProcess({
      username: "future-admin",
      password: "not-a-real-credential",
    });
    assertEquals(loginFuture.result.code, 1);
    assertFrozenErrorEnvelope(loginFuture.result.stderr, "login_invalid");
    await loginFuture.launcher.close();
    const missingProject = await harness.runOptctl([
      "--json",
      "project",
      "select",
      crypto.randomUUID(),
    ]);
    assertEquals(missingProject.code, 1);
    assertFrozenErrorEnvelope(missingProject.stderr, "validation_failed");

    const jsonInput = await harness.runJson(
      ["--json", "changeset", "preview"],
      {},
    );
    assert(jsonInput.argv.includes("--file"));
    const multipartDir = await Deno.makeTempDir({ dir: harness.rootDir });
    const multipartInput = await harness.runMultipart(
      ["--json", "pack", "preview"],
      multipartDir,
    );
    assertEquals(multipartInput.argv.at(-1), multipartDir);

    const malformed = await harness.runOptctl([
      "--json",
      "changeset",
      "preview",
      "--input",
      "{",
    ]);
    assertEquals(malformed.code, 2);
    const malformedEnvelope = assertFrozenErrorEnvelope(
      malformed.stderr,
      "usage_error",
    );
    assert(Array.isArray(malformedEnvelope.error.details.help));

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
    assertFrozenErrorEnvelope(
      new TextDecoder().decode(unavailable.stderr),
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
