import { assertEquals, assertFalse } from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";
import { makeApplication } from "../../../src/application/app.ts";

Deno.test("compiled optctl logs in, lists sessions, logs out, and survives restart", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "human-admin",
      password: "correct horse battery staple",
    });
    assertEquals(boot.code, 0, boot.stderr);
    assertFalse(boot.stdout.includes("authorization_request_token"));
    assertFalse(boot.stdout.includes('"token"'));
    const sessions = await harness.runOptctl(["--json", "auth", "sessions"]);
    assertEquals(sessions.code, 0, sessions.stderr);
    assertEquals(JSON.parse(sessions.stdout).data.length, 2);
    assertEquals(
      (await harness.runOptctl(["--json", "auth", "logout"])).code,
      0,
    );
    assertEquals(
      (await harness.runOptctl(["--json", "auth", "whoami"])).code,
      1,
    );
    const login = await harness.login({
      username: "human-admin",
      password: "correct horse battery staple",
    });
    assertEquals(login.code, 0, login.stderr);
    assertFalse(login.stdout.includes('"token"'));
    await harness.restart();
    const current = await harness.runOptctl(["--json", "auth", "whoami"]);
    assertEquals(current.code, 0, current.stderr);
    assertEquals(JSON.parse(current.stdout).data.username, "human-admin");
  } finally {
    await harness.close();
  }
});

Deno.test("compiled optctl observes bounded hash saturation", async () => {
  const prior = Deno.env.get("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES");
  Deno.env.set("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES", "1");
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "busy-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const attempts = await harness.runConcurrent([
      {
        args: [
          "--json",
          "auth",
          "login",
          "--username",
          "busy-admin",
          "--password-stdin",
        ],
        stdin: "administrator password\n",
      },
      {
        args: [
          "--json",
          "auth",
          "login",
          "--username",
          "busy-admin",
          "--password-stdin",
        ],
        stdin: "administrator password\n",
      },
    ]);
    assertEquals(attempts.filter((attempt) => attempt.code === 0).length, 1);
    const busy = attempts.find((attempt) => attempt.code !== 0)!;
    assertEquals(JSON.parse(busy.stderr).error.code, "authentication_busy");
  } finally {
    await harness.close();
    if (prior === undefined) {
      Deno.env.delete("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES");
    } else Deno.env.set("OPERANT_PASSWORD_MAX_CONCURRENT_HASHES", prior);
  }
});

Deno.test("compiled optctl completes targeted host recovery", async () => {
  const recoveryToken = "host-recovery-secret-with-at-least-32-characters";
  const prior = Deno.env.get("OPERANT_RECOVERY_TOKEN");
  Deno.env.set("OPERANT_RECOVERY_TOKEN", recoveryToken);
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "host-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const created = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "recovery-user",
      "--password-stdin",
    ], "original recovery password\n");
    const userId = JSON.parse(created.stdout).data.id;
    assertEquals(
      (await harness.runOptctl(["--json", "auth", "user", "disable", userId]))
        .code,
      0,
    );
    const repository = makeApplication(harness.server.sql).authentication;
    const initiated = await repository.beginRecovery({
      username: "recovery-user",
      token: recoveryToken,
      enableUser: true,
      restoreSuperAdmin: false,
    });
    assertEquals(initiated.ok, true);
    const recovered = await harness.runOptctl([
      "--json",
      "auth",
      "recover",
      "--username",
      "recovery-user",
      "--password-stdin",
    ], "replacement recovery password\n");
    assertEquals(recovered.code, 0, recovered.stderr);
    assertFalse(recovered.stdout.includes('"token"'));
    assertEquals(
      JSON.parse((await harness.runOptctl(["--json", "auth", "whoami"])).stdout)
        .data.username,
      "recovery-user",
    );
  } finally {
    await harness.close();
    if (prior === undefined) Deno.env.delete("OPERANT_RECOVERY_TOKEN");
    else Deno.env.set("OPERANT_RECOVERY_TOKEN", prior);
  }
});

Deno.test("compiled optctl completes non-enumerating approved password reset", async () => {
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "reset-admin",
      password: "administrator password",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    const users = await harness.runOptctl(["--json", "auth", "user", "list"]);
    const adminId = JSON.parse(users.stdout).data[0].id;
    const protectedAdmin = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "disable",
      adminId,
    ]);
    assertEquals(
      JSON.parse(protectedAdmin.stderr).error.code,
      "last_super_admin",
    );
    const created = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "reset-user",
      "--password-stdin",
    ], "original reset password\n");
    assertEquals(created.code, 0, created.stderr);
    const createdId = JSON.parse(created.stdout).data.id;
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "user",
        "disable",
        createdId,
      ])).code,
      0,
    );
    const disabledLogin = await harness.login({
      username: "reset-user",
      password: "original reset password",
    });
    assertEquals(disabledLogin.stderr.includes("login_invalid"), true);
    assertEquals(
      (await harness.runOptctl(["--json", "auth", "user", "enable", createdId]))
        .code,
      0,
    );
    const unknown = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "missing-user",
    ]);
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "reset-user",
    ]);
    assertEquals(unknown.code, 0, unknown.stderr);
    assertEquals(requested.code, 0, requested.stderr);
    const unknownData = JSON.parse(unknown.stdout).data;
    const requestData = JSON.parse(requested.stdout).data;
    assertEquals(Object.keys(unknownData), ["request_id"]);
    assertEquals(Object.keys(requestData), ["request_id"]);
    assertFalse(unknownData.request_id === requestData.request_id);
    const approved = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "approve",
      requestData.request_id,
    ]);
    assertEquals(approved.code, 0, approved.stderr);
    assertFalse(approved.stdout.includes("capability"));
    assertFalse(approved.stdout.includes("token"));
    const completed = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "complete",
      requestData.request_id,
      "--password-stdin",
    ], "replacement reset password\n");
    assertEquals(completed.code, 0, completed.stderr);
    assertFalse(completed.stdout.includes('"token"'));
    const current = await harness.runOptctl(["--json", "auth", "whoami"]);
    assertEquals(JSON.parse(current.stdout).data.username, "reset-user");
  } finally {
    await harness.close();
  }
});
