// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertFalse } from "jsr:@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import {
  ARGON2ID_V1,
  parseArgonPhc,
} from "../../src/domain/auth/argon_profile.ts";

Deno.test("successful concurrent login atomically upgrades a weaker Argon credential", async () => {
  const harness = await startLiveHarness();
  try {
    const password = "credential maintenance password";
    assertEquals(
      (await harness.bootstrap({ username: "rehash-admin", password })).code,
      0,
    );
    const original = (await query<{ changed_at: Date }>(
      harness.server.sql,
      `select password_changed_at changed_at from password_credentials where human_user_id=(select id from human_users where username='rehash-admin')`,
    )).rows[0];
    const weakPhc = await hashForTest(password, {
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
      outputLen: 16,
    });
    await query(
      harness.server.sql,
      `update password_credentials set profile='argon2id.v0',phc_hash=$2 where human_user_id=(select id from human_users where username=$1)`,
      ["rehash-admin", weakPhc],
    );

    const failed = await harness.login({
      username: "rehash-admin",
      password: "incorrect maintenance password",
    });
    assertEquals(failed.code, 1);
    assertFalse(failed.stderr.includes(weakPhc));
    const unchanged = (await query<{ profile: string; phc_hash: string }>(
      harness.server.sql,
      `select profile,phc_hash from password_credentials where human_user_id=(select id from human_users where username='rehash-admin')`,
    )).rows[0];
    assertEquals(unchanged, { profile: "argon2id.v0", phc_hash: weakPhc });

    const logins = await harness.runConcurrent([
      {
        args: [
          "--json",
          "auth",
          "login",
          "--username",
          "rehash-admin",
          "--password-stdin",
        ],
        stdin: `${password}\n`,
      },
      {
        args: [
          "--json",
          "auth",
          "login",
          "--username",
          "rehash-admin",
          "--password-stdin",
        ],
        stdin: `${password}\n`,
      },
    ]);
    assertEquals(logins.every((result) => result.code === 0), true);
    assertEquals(
      logins.some((result) =>
        result.stdout.includes(weakPhc) || result.stderr.includes(weakPhc)
      ),
      false,
    );
    const upgraded =
      (await query<{ profile: string; phc_hash: string; changed_at: Date }>(
        harness.server.sql,
        `select profile,phc_hash,password_changed_at changed_at from password_credentials where human_user_id=(select id from human_users where username='rehash-admin')`,
      )).rows[0];
    assertEquals(upgraded.profile, ARGON2ID_V1.profile);
    assertFalse(upgraded.phc_hash === weakPhc);
    assertEquals(
      new Date(upgraded.changed_at).getTime(),
      new Date(original.changed_at).getTime(),
    );
    const parameters = parseArgonPhc(upgraded.phc_hash)!;
    assertEquals(parameters.algorithm, ARGON2ID_V1.algorithm);
    assertEquals(parameters.version, ARGON2ID_V1.version);
    assertEquals(parameters.memoryCost >= ARGON2ID_V1.memoryCost, true);
    assertEquals(parameters.timeCost >= ARGON2ID_V1.timeCost, true);
    assertEquals(parameters.parallelism >= ARGON2ID_V1.parallelism, true);
    assertEquals(parameters.outputLen >= ARGON2ID_V1.outputLen, true);
    const activeRequests = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where human_user_id=(select id from human_users where username='rehash-admin') and credential_kind='authorization_request' and revoked_at is null`,
    );
    assertEquals(activeRequests.rows[0]?.count, "1");
  } finally {
    await harness.close();
  }
});

Deno.test("login throttle starts after delayed password verification wall clock", async () => {
  const harness = await startLiveHarness();
  const releaseLock = Promise.withResolvers<void>();
  let lockTask: Promise<void> | undefined;
  try {
    const username = "wall-clock-throttle-admin";
    const password = "administrator password";
    assertEquals((await harness.bootstrap({ username, password })).code, 0);
    for (let failure = 1; failure <= 4; failure++) {
      const result = await harness.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        username,
        "--password-stdin",
      ], `incorrect password ${failure}\n`);
      assertEquals(result.code, 1);
      assertEquals(JSON.parse(result.stderr).error.code, "login_invalid");
    }

    const locked = Promise.withResolvers<void>();
    lockTask = harness.server.sql.begin(async (tx) => {
      await query(
        tx,
        "select username from login_throttles where username=$1 for update",
        [username],
      );
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;

    const fifthFailure = harness.runOptctl([
      "--json",
      "auth",
      "login",
      "--username",
      username,
      "--password-stdin",
    ], "incorrect password five\n");
    const blocked = await waitForDelayedLoginThrottleWaiter(harness);
    assertEquals(blocked.blocked, true);
    assertEquals(blocked.transaction_age_ms >= 1_100, true);
    releaseLock.resolve();
    await lockTask;
    lockTask = undefined;

    const fifth = await fifthFailure;
    assertEquals(fifth.code, 1);
    assertEquals(JSON.parse(fifth.stderr).error.code, "login_invalid");
    const armed = (await query<{
      failure_count: number;
      next_allowed_at: Date;
      throttle_ms: number;
      remaining_ms: number;
    }>(
      harness.server.sql,
      `select failure_count,next_allowed_at,
        (extract(epoch from(next_allowed_at-updated_at))*1000)::int throttle_ms,
        (extract(epoch from(next_allowed_at-clock_timestamp()))*1000)::int remaining_ms
       from login_throttles where username=$1`,
      [username],
    )).rows[0];
    assertEquals(armed.failure_count, 5);
    assertEquals(armed.throttle_ms, 1_000);
    assertEquals(armed.remaining_ms > 0, true);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json() as {
        error: { code: string; details: { retry_after_seconds: number } };
      };
      assertEquals(response.status, 429);
      assertEquals(response.headers.get("retry-after"), "1");
      assertEquals(body.error.code, "login_throttled");
      assertEquals(body.error.details.retry_after_seconds, 1);
      const unchanged = (await query<{ next_allowed_at: Date }>(
        harness.server.sql,
        "select next_allowed_at from login_throttles where username=$1",
        [username],
      )).rows[0];
      assertEquals(
        new Date(unchanged.next_allowed_at).getTime(),
        new Date(armed.next_allowed_at).getTime(),
      );
    }

    await waitForLoginThrottleBoundary(
      harness,
      username,
      armed.next_allowed_at,
    );
    const recovered = await harness.login({ username, password });
    assertEquals(recovered.code, 0, recovered.stderr);
    const reset = (await query<{
      failure_count: number;
      next_allowed_at: Date | null;
    }>(
      harness.server.sql,
      "select failure_count,next_allowed_at from login_throttles where username=$1",
      [username],
    )).rows[0];
    assertEquals(reset.failure_count, 0);
    assertEquals(reset.next_allowed_at, null);
  } finally {
    releaseLock.resolve();
    await lockTask?.catch(() => undefined);
    await harness.close();
  }
});

Deno.test("destructive confirmations share serialized login throttling", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "destructive-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const originalRequest = await query<{ id: string }>(
      harness.server.sql,
      `select id from auth_sessions where human_user_id=(select id from human_users where username='destructive-admin') and credential_kind='authorization_request' and revoked_at is null`,
    );
    const rotatedLogin = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "destructive-admin",
        password: "administrator password",
        existing_request_session_id: crypto.randomUUID(),
      }),
    });
    const rotatedBody = await rotatedLogin.json();
    assertEquals(rotatedLogin.status, 200);
    assertFalse(
      rotatedBody.data.credentials.authorization_request_session_id ===
        originalRequest.rows[0].id,
    );
    const boundedRequests = await query<
      { active: string; old_revoked: boolean }
    >(
      harness.server.sql,
      `select count(*) filter(where revoked_at is null)::text active,bool_and(case when id=$2 then revoked_at is not null else true end) old_revoked from auth_sessions where human_user_id=(select id from human_users where username=$1) and credential_kind='authorization_request'`,
      ["destructive-admin", originalRequest.rows[0].id],
    );
    assertEquals(boundedRequests.rows[0]?.active, "1");
    assertEquals(boundedRequests.rows[0]?.old_revoked, true);
    const rotatedLogout = await fetch(`${harness.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rotatedBody.data.credentials.token}`,
      },
      body: "{}",
    });
    await rotatedLogout.body?.cancel();
    assertEquals(rotatedLogout.status, 200);
    const failures = await harness.runConcurrent([
      {
        args: [
          "--json",
          "auth",
          "logout",
          "--all",
          "--yes",
          "--password-stdin",
        ],
        stdin: "wrong password one\n",
      },
      {
        args: [
          "--json",
          "auth",
          "logout",
          "--all",
          "--yes",
          "--password-stdin",
        ],
        stdin: "wrong password two\n",
      },
      {
        args: ["--json", "auth", "password", "change", "--password-stdin"],
        stdin: "wrong password three\nunused replacement password\n",
      },
      {
        args: ["--json", "auth", "password", "change", "--password-stdin"],
        stdin: "wrong password four\nunused replacement password\n",
      },
    ]);
    assertEquals(failures.every((result) => result.code === 1), true);
    const throttle = await query<{ failure_count: number }>(
      harness.server.sql,
      `select failure_count from login_throttles where username='destructive-admin'`,
    );
    assertEquals(throttle.rows[0]?.failure_count, 4);
    const fifth = await harness.runOptctl([
      "--json",
      "auth",
      "password",
      "change",
      "--password-stdin",
    ], "wrong password five\nunused replacement password\n");
    assertEquals(
      await capturedCliErrorCode(
        harness,
        fifth,
        "fifth destructive confirmation",
      ),
      "login_invalid",
    );
    const blocked = await harness.runOptctl([
      "--json",
      "auth",
      "logout",
      "--all",
      "--yes",
      "--password-stdin",
    ], "administrator password\n");
    assertEquals(
      await capturedCliErrorCode(harness, blocked, "throttled confirmation"),
      "login_throttled",
    );
    const active = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where human_user_id=(select id from human_users where username='destructive-admin') and revoked_at is null`,
    );
    assertEquals(active.rows[0]?.count, "2");
  } finally {
    await harness.close();
  }
});

async function waitForDelayedLoginThrottleWaiter(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
): Promise<{ blocked: boolean; transaction_age_ms: number }> {
  const deadline = Date.now() + 10_000;
  let last: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    last = (await query<Record<string, unknown>>(
      harness.server.sql,
      `select cardinality(pg_blocking_pids(pid))>0 blocked,
        extract(epoch from(clock_timestamp()-xact_start))*1000 transaction_age_ms,
        state,wait_event_type,wait_event,left(query,240) query
       from pg_stat_activity
       where datname=current_database() and pid<>pg_backend_pid()
         and query like '%login_throttles where username=$1 for update%'`,
    )).rows;
    const delayed = last.find((row) =>
      row.blocked === true && Number(row.transaction_age_ms) >= 1_100
    );
    if (delayed) {
      return {
        blocked: true,
        transaction_age_ms: Number(delayed.transaction_age_ms),
      };
    }
    await Promise.resolve();
  }
  throw new Error(
    `login throttle waiter was not delayed: ${JSON.stringify(last)}`,
  );
}

async function waitForLoginThrottleBoundary(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  username: string,
  expectedNextAllowedAt: Date,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let last: { next_allowed_at: Date; boundary_reached: boolean } | undefined;
  while (Date.now() < deadline) {
    last = (await query<{
      next_allowed_at: Date;
      boundary_reached: boolean;
    }>(
      harness.server.sql,
      `select next_allowed_at,clock_timestamp()>=next_allowed_at boundary_reached
       from login_throttles where username=$1`,
      [username],
    )).rows[0];
    assertEquals(
      new Date(last.next_allowed_at).getTime(),
      new Date(expectedNextAllowedAt).getTime(),
    );
    if (last.boundary_reached) return;
    await Promise.resolve();
  }
  throw new Error(
    `login throttle boundary was not reached: ${JSON.stringify(last)}`,
  );
}

async function capturedCliErrorCode(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  result: Awaited<ReturnType<typeof harness.runOptctl>>,
  label: string,
): Promise<string> {
  if (!result.stderr) {
    const [diagnostics, processes] = await Promise.all([
      harness.diagnostics(),
      new Deno.Command("/bin/ps", {
        args: ["-u", String(Deno.uid()), "-o", "pid,ppid,state,args"],
        stdout: "piped",
        stderr: "piped",
      }).output().then((output) => new TextDecoder().decode(output.stdout))
        .catch((error) => String(error)),
    ]);
    throw new Error(`${label} produced no JSON stderr: ${
      JSON.stringify({
        code: result.code,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        argv: result.argv,
        duration_ms: result.durationMs,
        diagnostics,
        processes,
      })
    }`);
  }
  return JSON.parse(result.stderr).error.code;
}

Deno.test("reset decisions redemption completion and anchored revocation serialize", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "race-admin",
        password: "administrator password",
      })).code,
      0,
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "user",
        "create",
        "--username",
        "race-user",
        "--password-stdin",
      ], "original race password\n")).code,
      0,
    );
    assertEquals(
      (await harness.login({
        username: "race-user",
        password: "original race password",
      })).code,
      0,
    );
    const oldSessions = await query<{ id: string }>(
      harness.server.sql,
      `select id from auth_sessions where human_user_id=(select id from human_users where username='race-user') and revoked_at is null`,
    );
    assertEquals(oldSessions.rows.length, 2);
    assertEquals(
      (await harness.login({
        username: "race-admin",
        password: "administrator password",
      })).code,
      0,
    );

    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "race-user",
    ]);
    const requestId = JSON.parse(requested.stdout).data.request_id;
    const nonce = await resetNonce(harness.rootDir, harness.baseUrl, requestId);
    const decisions = await harness.runConcurrent([
      { args: ["--json", "auth", "password-reset", "approve", requestId] },
      { args: ["--json", "auth", "password-reset", "approve", requestId] },
    ]);
    assertEquals(decisions.every((result) => result.code === 0), true);

    const redeem = () =>
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/redeem`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redemption_nonce: nonce }),
        },
      );
    const redemptionResponses = await Promise.all([redeem(), redeem()]);
    const redemptionBodies = await Promise.all(
      redemptionResponses.map((response) => response.json()),
    );
    assertEquals(
      redemptionResponses.every((response) => response.status === 200),
      true,
    );
    const capabilities = redemptionBodies.map((body) =>
      body.data.capability as string
    );

    const invalid = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "invalid-capability",
          password: "replacement race password",
        }),
      },
    );
    await invalid.body?.cancel();
    assertEquals(invalid.status, 401);
    const beforeCompletion = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where id=any($1::uuid[]) and revoked_at is null`,
      [oldSessions.rows.map((row) => row.id)],
    );
    assertEquals(beforeCompletion.rows[0]?.count, "2");

    const complete = (capability: string, suffix: string) =>
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capability,
            password: `replacement race password ${suffix}`,
          }),
        },
      );
    const completionResponses = await Promise.all([
      complete(capabilities[0], "one"),
      complete(capabilities[1], "two"),
    ]);
    await Promise.all(
      completionResponses.map((response) => response.body?.cancel()),
    );
    assertEquals(
      completionResponses.filter((response) => response.status === 200).length,
      1,
    );
    const finalSessions = await query<{ active: string; old_active: string }>(
      harness.server.sql,
      `select count(*) filter(where revoked_at is null)::text active,count(*) filter(where id=any($2::uuid[]) and revoked_at is null)::text old_active from auth_sessions where human_user_id=(select id from human_users where username=$1)`,
      ["race-user", oldSessions.rows.map((row) => row.id)],
    );
    assertEquals(finalSessions.rows[0]?.active, "2");
    assertEquals(finalSessions.rows[0]?.old_active, "0");

    const second = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "race-user",
    ]);
    const secondId = JSON.parse(second.stdout).data.request_id;
    const secondNonce = await resetNonce(
      harness.rootDir,
      harness.baseUrl,
      secondId,
    );
    const [approval, cancellation] = await Promise.all([
      harness.runOptctl([
        "--json",
        "auth",
        "password-reset",
        "approve",
        secondId,
      ]),
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${secondId}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redemption_nonce: secondNonce }),
        },
      ),
    ]);
    await cancellation.body?.cancel();
    assertEquals(
      Number(approval.code === 0) + Number(cancellation.status === 200),
      1,
    );
    const terminal = await query<{ status: string }>(
      harness.server.sql,
      `select status from password_reset_requests where id=$1`,
      [secondId],
    );
    assertEquals(
      ["approved", "cancelled"].includes(terminal.rows[0]?.status),
      true,
    );
  } finally {
    await harness.close();
  }
});

Deno.test("concurrent super-admin disablement preserves exactly one active human", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "invariant-admin-one",
      password: "administrator one password",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const first = (await query<{ id: string; principal_id: string }>(
      harness.server.sql,
      `select id,principal_id from human_users where username='invariant-admin-one'`,
    )).rows[0];
    const created = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "invariant-admin-two",
      "--password-stdin",
    ], "administrator two password\n");
    assertEquals(created.code, 0, created.stderr);
    const secondBody = JSON.parse(created.stdout).data;
    await query(
      harness.server.sql,
      `insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:super_admin','system',true)`,
      [crypto.randomUUID(), secondBody.principal_id],
    );
    const baselineAudit = Number(
      (await query<{ count: string }>(
        harness.server.sql,
        `select count(*)::text count from auth_audit_events where event_type='auth.human_user.disabled'`,
      )).rows[0]?.count ?? "0",
    );

    for (let iteration = 0; iteration < 8; iteration++) {
      await query(
        harness.server.sql,
        `update human_users set status='active',disabled_at=null where id=any($1::uuid[])`,
        [[first.id, secondBody.id]],
      );
      await query(
        harness.server.sql,
        `update principals set active=true where id=any($1::uuid[])`,
        [[first.principal_id, secondBody.principal_id]],
      );
      const login = await harness.login({
        username: "invariant-admin-one",
        password: "administrator one password",
      });
      assertEquals(login.code, 0, login.stderr);

      let releaseInvariant!: () => void;
      let invariantAcquired!: () => void;
      const acquired = new Promise<void>((resolve) =>
        invariantAcquired = resolve
      );
      const release = new Promise<void>((resolve) =>
        releaseInvariant = resolve
      );
      const blocker = harness.server.sql.begin(async (tx) => {
        await query(
          tx,
          `select pg_advisory_xact_lock(hashtext('optd.auth.super_admin_invariant'))`,
        );
        invariantAcquired();
        await release;
      });
      await acquired;
      const attemptsPromise = harness.runConcurrent([
        { args: ["--json", "auth", "user", "disable", first.id] },
        { args: ["--json", "auth", "user", "disable", secondBody.id] },
      ]);
      try {
        await waitForSuperAdminWaiters(harness.server.sql, 2);
      } finally {
        releaseInvariant();
        await blocker;
      }
      const attempts = await attemptsPromise;
      assertEquals(attempts.filter((attempt) => attempt.code === 0).length, 1);
      const rejected = attempts.find((attempt) => attempt.code !== 0)!;
      assertEquals(JSON.parse(rejected.stderr).error.code, "last_super_admin");
      const active = await query<{ users: string; assignments: string }>(
        harness.server.sql,
        `select count(distinct u.id)::text users,count(distinct r.id)::text assignments from human_users u join role_assignments r on r.principal_id=u.principal_id and r.role_id='system:super_admin' and r.active where u.status='active'`,
      );
      assertEquals(active.rows[0], { users: "1", assignments: "1" });
      const audit = Number(
        (await query<{ count: string }>(
          harness.server.sql,
          `select count(*)::text count from auth_audit_events where event_type='auth.human_user.disabled'`,
        )).rows[0]?.count ?? "0",
      );
      assertEquals(audit - baselineAudit, iteration + 1);
    }
  } finally {
    await harness.close();
  }
});

Deno.test("reset completion rejects capabilities after request expiry", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "expiry-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "expiry-admin",
    ]);
    const requestId = JSON.parse(requested.stdout).data.request_id;
    const nonce = await resetNonce(harness.rootDir, harness.baseUrl, requestId);
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "password-reset",
        "approve",
        requestId,
      ])).code,
      0,
    );
    const redeemed = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/redeem`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemption_nonce: nonce }),
      },
    );
    const capability = (await redeemed.json()).data.capability;
    await query(
      harness.server.sql,
      `update password_reset_requests set expires_at=now()-interval '1 second' where id=$1`,
      [requestId],
    );
    const completion = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability,
          password: "expired replacement password",
        }),
      },
    );
    const body = await completion.json();
    assertEquals(completion.status, 410);
    assertEquals(body.error.code, "password_reset_expired");
    const state = await query<{ status: string }>(
      harness.server.sql,
      `select status from password_reset_requests where id=$1`,
      [requestId],
    );
    assertEquals(state.rows[0]?.status, "expired");
  } finally {
    await harness.close();
  }
});

async function hashForTest(
  password: string,
  parameters: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    outputLen: number;
  },
): Promise<string> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-ffi",
      "--allow-sys",
      "--allow-env",
      new URL(
        "../../src/adapters/outbound/postgres/auth_password_worker.ts",
        import.meta.url,
      ).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ operation: "hash", password, parameters }),
    ),
  );
  await writer.close();
  const output = await child.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return JSON.parse(new TextDecoder().decode(output.stdout)).phc;
}

async function waitForSuperAdminWaiters(
  sql: Parameters<typeof query>[0],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const waiting = await query<{ count: string }>(
      sql,
      `select count(*)::text count from pg_stat_activity where wait_event='advisory' and query like '%optd.auth.super_admin_invariant%'`,
    );
    if (Number(waiting.rows[0]?.count ?? "0") >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `timed out waiting for ${expected} super-admin invariant contenders`,
  );
}

async function resetNonce(
  rootDir: string,
  baseUrl: string,
  requestId: string,
): Promise<string> {
  const store = JSON.parse(
    await Deno.readTextFile(`${rootDir}/xdg-config/optd/auth.json`),
  );
  const nonce = store.origins[new URL(baseUrl).origin].resetNonces[requestId];
  assertFalse(typeof nonce !== "string");
  return nonce;
}
