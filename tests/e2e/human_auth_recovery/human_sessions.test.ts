import { assertEquals, assertFalse, assertRejects } from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { isUuidV7 } from "../../../src/domain/ids/uuid_v7.ts";

Deno.test("server warns while honoring an operator-lowered password minimum", async () => {
  const prior = Deno.env.get("OPTD_PASSWORD_MIN_LENGTH");
  Deno.env.set("OPTD_PASSWORD_MIN_LENGTH", "6");
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "lowered-policy-admin",
      password: "sixsix",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    const policy = await harness.runOptctl([
      "--json",
      "auth",
      "password-policy",
    ]);
    assertEquals(policy.code, 0, policy.stderr);
    assertEquals(JSON.parse(policy.stdout).data.minimumLength, 6);
    const diagnostics = await harness.diagnostics();
    assertEquals(
      diagnostics.server.includes(
        "warning: OPTD_PASSWORD_MIN_LENGTH=6 is below the default minimum of 8",
      ),
      true,
    );
  } finally {
    await harness.close();
    if (prior === undefined) Deno.env.delete("OPTD_PASSWORD_MIN_LENGTH");
    else Deno.env.set("OPTD_PASSWORD_MIN_LENGTH", prior);
  }
});

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
    const initialSessions = JSON.parse(sessions.stdout).data;
    assertEquals(initialSessions.length, 2);
    assertEquals(
      initialSessions.every((session: { id: string }) => isUuidV7(session.id)),
      true,
    );
    const initialRequestSessionId =
      initialSessions.find((session: { credential_kind: string }) =>
        session.credential_kind === "authorization_request"
      ).id;
    const platformIds = await query<{ id: string }>(
      harness.server.sql,
      `
      select id::text id from principals
      union all select id::text from human_users
      union all select id::text from role_assignments
      union all select id::text from auth_sessions
      union all select id::text from auth_contexts
      union all select id::text from auth_audit_events
    `,
    );
    assertEquals(platformIds.rows.every((row) => isUuidV7(row.id)), true);
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
    for (let repeat = 0; repeat < 3; repeat++) {
      const repeated = await harness.login({
        username: "human-admin",
        password: "correct horse battery staple",
      });
      assertEquals(repeated.code, 0, repeated.stderr);
    }
    const requestSessions = await query<{ id: string }>(
      harness.server.sql,
      `select id from auth_sessions where human_user_id=(select id from human_users where username='human-admin') and credential_kind='authorization_request' and revoked_at is null`,
    );
    assertEquals(requestSessions.rows.length, 1);
    assertEquals(requestSessions.rows[0].id, initialRequestSessionId);
    await harness.restart();
    const current = await harness.runOptctl(["--json", "auth", "whoami"]);
    assertEquals(current.code, 0, current.stderr);
    assertEquals(
      JSON.parse(current.stdout).data.human_user.username,
      "human-admin",
    );
  } finally {
    await harness.close();
  }
});

Deno.test("compiled optctl observes bounded hash saturation", async () => {
  const prior = Deno.env.get("OPTD_PASSWORD_MAX_CONCURRENT_HASHES");
  Deno.env.set("OPTD_PASSWORD_MAX_CONCURRENT_HASHES", "1");
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
      Deno.env.delete("OPTD_PASSWORD_MAX_CONCURRENT_HASHES");
    } else Deno.env.set("OPTD_PASSWORD_MAX_CONCURRENT_HASHES", prior);
  }
});

Deno.test("password reset request throttling is Postgres-backed and non-enumerating", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "throttle-admin",
        password: "administrator password",
      })).code,
      0,
    );
    for (const username of ["throttle-admin", "unknown-throttle-user"]) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await harness.runOptctl([
          "--json",
          "auth",
          "password-reset",
          "request",
          "--username",
          username,
        ]);
        assertEquals(result.code, 0, result.stderr);
        const requestData = JSON.parse(result.stdout).data;
        assertEquals(Object.keys(requestData), ["request_id"]);
        assertEquals(isUuidV7(requestData.request_id), true);
      }
      const throttled = await harness.runOptctl([
        "--json",
        "auth",
        "password-reset",
        "request",
        "--username",
        username,
      ]);
      assertEquals(throttled.code, 1);
      const error = JSON.parse(throttled.stderr).error;
      assertEquals(error.code, "password_reset_throttled");
      assertEquals(typeof error.details.retry_after_seconds, "number");
    }
  } finally {
    await harness.close();
  }
});

Deno.test("compiled host command covers recovery revocation repair cancellation and expiry", async () => {
  const recoveryToken = "host-recovery-secret-with-at-least-32-characters";
  const prior = Deno.env.get("OPTD_RECOVERY_TOKEN");
  Deno.env.set("OPTD_RECOVERY_TOKEN", recoveryToken);
  const harness = await startLiveHarness();
  let serverBinary: string | undefined;
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
      (await harness.login({
        username: "recovery-user",
        password: "original recovery password",
      })).code,
      0,
    );
    assertEquals(
      (await harness.login({
        username: "host-admin",
        password: "administrator password",
      })).code,
      0,
    );
    serverBinary = `${harness.rootDir}/optd`;
    const compiled = await new Deno.Command(Deno.execPath(), {
      args: [
        "compile",
        "--allow-all",
        "--output",
        serverBinary,
        new URL("../../../src/main_server.ts", import.meta.url).pathname,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      compiled.success,
      true,
      new TextDecoder().decode(compiled.stderr),
    );
    const postmaster = (await Deno.readTextFile(
      `${harness.dataDir}/postgres/data/postmaster.pid`,
    )).split("\n");
    const hostEnv = {
      ...Deno.env.toObject(),
      OPTD_DATABASE_URL: `postgres://optd@127.0.0.1:${postmaster[3]}/postgres`,
      OPTD_RECOVERY_TOKEN: recoveryToken,
    };
    const host = (args: string[]) =>
      new Deno.Command(serverBinary!, {
        args,
        env: hostEnv,
        stdout: "piped",
        stderr: "piped",
      }).output();

    const begun = await host([
      "auth",
      "recovery",
      "begin",
      "--username",
      "recovery-user",
      "--restore-super-admin",
    ]);
    assertEquals(begun.success, true, new TextDecoder().decode(begun.stderr));
    const begunText = new TextDecoder().decode(begun.stdout);
    const begunJson = begunText.split("\n").find((line) =>
      line.startsWith('{"ok"')
    )!;
    const begunBody = JSON.parse(begunJson);
    assertEquals(isUuidV7(begunBody.data.challengeId), true);
    const activeSessions = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where human_user_id=$1 and revoked_at is null`,
      [userId],
    );
    assertEquals(activeSessions.rows[0]?.count, "0");
    const recovered = await harness.runOptctl([
      "--json",
      "auth",
      "recover",
      "--username",
      "recovery-user",
      "--password-stdin",
    ], "replacement recovery password\n");
    assertEquals(recovered.code, 0, recovered.stderr);
    const restored = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from role_assignments r join human_users u on u.principal_id=r.principal_id where u.id=$1 and r.role_id='system:super_admin' and r.active`,
      [userId],
    );
    assertEquals(restored.rows[0]?.count, "1");

    assertEquals(
      (await harness.runOptctl(["--json", "auth", "user", "disable", userId]))
        .code,
      0,
    );
    assertEquals(
      (await host([
        "auth",
        "recovery",
        "begin",
        "--username",
        "recovery-user",
        "--enable-user",
      ])).success,
      true,
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "recover",
        "--username",
        "recovery-user",
        "--password-stdin",
      ], "enabled recovery password\n")).code,
      0,
    );
    const enabled = await query<{ status: string }>(
      harness.server.sql,
      `select status from human_users where id=$1`,
      [userId],
    );
    assertEquals(enabled.rows[0]?.status, "active");

    assertEquals(
      (await host(["auth", "recovery", "begin", "--username", "recovery-user"]))
        .success,
      true,
    );
    assertEquals(
      (await host([
        "auth",
        "recovery",
        "cancel",
        "--username",
        "recovery-user",
      ])).success,
      true,
    );
    const cancelled = await harness.runOptctl([
      "--json",
      "auth",
      "recover",
      "--username",
      "recovery-user",
      "--password-stdin",
    ], "cancelled recovery password\n");
    assertEquals(JSON.parse(cancelled.stderr).error.code, "recovery_invalid");

    assertEquals(
      (await host(["auth", "recovery", "begin", "--username", "recovery-user"]))
        .success,
      true,
    );
    await query(
      harness.server.sql,
      `update recovery_challenges set expires_at=now()-interval '1 second' where human_user_id=$1 and status='active'`,
      [userId],
    );
    const expired = await harness.runOptctl([
      "--json",
      "auth",
      "recover",
      "--username",
      "recovery-user",
      "--password-stdin",
    ], "expired recovery password\n");
    assertEquals(JSON.parse(expired.stderr).error.code, "recovery_expired");
    const expiredState = await query<{ status: string }>(
      harness.server.sql,
      `select status from recovery_challenges where human_user_id=$1 order by created_at desc limit 1`,
      [userId],
    );
    assertEquals(expiredState.rows[0]?.status, "expired");

    const challenges = await query<{
      id: string;
      created_at: Date;
      completed_at: Date | null;
      cancelled_at: Date | null;
      expired_at: Date | null;
      enable_user: boolean;
      restore_super_admin: boolean;
      status: "completed" | "cancelled" | "expired";
    }>(
      harness.server.sql,
      `select id,created_at,completed_at,cancelled_at,expired_at,enable_user,restore_super_admin,status from recovery_challenges where human_user_id=$1 order by created_at`,
      [userId],
    );
    assertEquals(challenges.rows.length, 4);
    assertEquals(
      challenges.rows.every((challenge) => isUuidV7(challenge.id)),
      true,
    );
    const audits = await query<{
      id: string;
      event_type: string;
      human_user_id: string;
      session_id: string | null;
      auth_context_id: string | null;
      principal_id: string | null;
      details: Record<string, unknown> | string;
    }>(
      harness.server.sql,
      `select id,event_type,human_user_id,session_id,auth_context_id,principal_id,details from auth_audit_events where human_user_id=$1 and event_type like 'auth.recovery.%' order by created_at`,
      [userId],
    );
    assertEquals(audits.rows.length, 8);
    for (const audit of audits.rows) {
      assertEquals(isUuidV7(audit.id), true);
      assertEquals(audit.human_user_id, userId);
      assertEquals(audit.auth_context_id, null);
      assertEquals(audit.principal_id, null);
      const details = typeof audit.details === "string"
        ? JSON.parse(audit.details) as Record<string, unknown>
        : audit.details;
      const challenge = challenges.rows.find((candidate) =>
        candidate.id === details.challenge_id
      )!;
      assertEquals(Boolean(challenge), true);
      assertEquals(details.schema, "auth.recovery.audit.v1");
      assertEquals(details.target_human_user_id, userId);
      assertEquals(
        details.initiated_at,
        new Date(challenge.created_at).toISOString(),
      );
      assertEquals(details.requested_repairs, {
        enable_user: challenge.enable_user,
        restore_super_admin: challenge.restore_super_admin,
      });
      assertEquals(details.executor, {
        principal_id: "system:host_recovery",
        principal_type: "system",
        context: "host_operator",
      });
      const outcome = audit.event_type.slice("auth.recovery.".length);
      assertEquals(details.outcome, outcome);
      assertEquals(typeof details.reason, "string");
      if (outcome !== "initiated") {
        const terminal = outcome === "completed"
          ? challenge.completed_at
          : outcome === "cancelled"
          ? challenge.cancelled_at
          : challenge.expired_at;
        assertEquals(details.terminal_at, new Date(terminal!).toISOString());
      }
      const serialized = JSON.stringify(details).toLowerCase();
      assertEquals(serialized.includes(recoveryToken.toLowerCase()), false);
      assertEquals(serialized.includes("password"), false);
      assertEquals(serialized.includes("token_digest"), false);
    }
    const parsedAudits = audits.rows.map((audit) => ({
      ...audit,
      parsedDetails: typeof audit.details === "string"
        ? JSON.parse(audit.details) as Record<string, unknown>
        : audit.details,
    }));
    for (const challenge of challenges.rows) {
      assertEquals(
        parsedAudits.filter((audit) =>
          audit.parsedDetails.challenge_id === challenge.id &&
          audit.event_type === "auth.recovery.initiated"
        ).length,
        1,
      );
      assertEquals(
        parsedAudits.filter((audit) =>
          audit.parsedDetails.challenge_id === challenge.id &&
          audit.event_type === `auth.recovery.${challenge.status}`
        ).length,
        1,
      );
    }
    await assertRejects(() =>
      query(
        harness.server.sql,
        `update auth_audit_events set details='{}'::jsonb where id=$1`,
        [audits.rows[0].id],
      )
    );
  } finally {
    await harness.close();
    if (prior === undefined) Deno.env.delete("OPTD_RECOVERY_TOKEN");
    else Deno.env.set("OPTD_RECOVERY_TOKEN", prior);
  }
});

Deno.test("compiled optctl reset wait reconnects by WebSocket without polling", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "wait-admin",
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
      "wait-user",
      "--password-stdin",
    ], "original wait password\n");
    assertEquals(created.code, 0, created.stderr);
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "wait-user",
    ]);
    const requestId = JSON.parse(requested.stdout).data.request_id;
    const store = JSON.parse(
      await Deno.readTextFile(
        `${harness.rootDir}/xdg-config/optd/auth.json`,
      ),
    );
    const nonce =
      store.origins[new URL(harness.baseUrl).origin].resetNonces[requestId];
    const wrong = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/watch-ticket`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemption_nonce: "wrong-requester-nonce" }),
      },
    );
    assertEquals(wrong.status, 404);
    await wrong.body?.cancel();
    const ticketResponse = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/watch-ticket`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemption_nonce: nonce }),
      },
    );
    const ticket = (await ticketResponse.json()).data.ticket;
    const watchUrl = new URL(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/watch`,
    );
    watchUrl.protocol = "ws:";
    watchUrl.searchParams.set("ticket", ticket);
    const initial = await watchOnce(watchUrl);
    assertEquals(initial.message.status, "pending");
    await closeWebSocket(initial.socket);
    const reused = await watchOnce(watchUrl, true);
    assertEquals(
      ["watch_ticket_invalid", "connection_rejected"].includes(
        reused.closeReason,
      ),
      true,
    );
    const child = new Deno.Command(harness.binaryPath, {
      args: [
        "--server",
        harness.baseUrl,
        "--json",
        "auth",
        "wait",
        requestId,
        "--password-stdin",
      ],
      env: {
        ...Deno.env.toObject(),
        HOME: harness.homeDir,
        XDG_CONFIG_HOME: `${harness.rootDir}/xdg-config`,
        XDG_STATE_HOME: `${harness.rootDir}/xdg-state`,
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("replacement wait password\n"));
    await writer.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await harness.restart();
    const approved = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "approve",
      requestId,
    ]);
    assertEquals(approved.code, 0, approved.stderr);
    const output = await child.output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertFalse(new TextDecoder().decode(output.stdout).includes('"token"'));
    const repeated = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "complete",
      requestId,
      "--password-stdin",
    ], "another replacement password\n");
    assertEquals(repeated.code, 1);
  } finally {
    await harness.close();
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
    assertEquals(isUuidV7(unknownData.request_id), true);
    assertEquals(isUuidV7(requestData.request_id), true);
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
    assertEquals(
      JSON.parse(current.stdout).data.human_user.username,
      "reset-user",
    );
  } finally {
    await harness.close();
  }
});

async function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close(1000);
  });
}

async function watchOnce(
  url: URL,
  expectClose = false,
): Promise<
  { socket: WebSocket; message: Record<string, unknown>; closeReason: string }
> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onmessage = (event) => {
      if (!expectClose) {
        resolve({
          socket,
          message: JSON.parse(String(event.data)),
          closeReason: "",
        });
      }
    };
    socket.onclose = (event) => {
      if (expectClose) {
        resolve({ socket, message: {}, closeReason: event.reason });
      } else reject(new Error(`watch closed before state: ${event.reason}`));
    };
    socket.onerror = () => {
      if (expectClose) {
        try {
          socket.close();
        } catch { /* rejected handshake will emit close */ }
      } else {
        try {
          socket.close();
        } catch { /* handshake was already rejected */ }
        reject(new Error("watch socket failed"));
      }
    };
  });
}
