import { assert, assertEquals, assertRejects } from "@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";
import { opaqueToken, tokenDigest } from "../../src/domain/auth/token.ts";

Deno.test("request workspace resolution is exact, scoped, current and non-enumerating", async () => {
  const bootstrapToken = opaqueToken();
  const inheritedDatabase = Deno.env.get("OPTD_DATABASE_URL");
  Deno.env.set("OPTD_DATABASE_URL", "postgres://invalid@127.0.0.1:1/never");
  const harness = await startLiveHarness({
    bootstrapToken,
    isolateEnvironment: true,
  }).finally(() => {
    if (inheritedDatabase === undefined) Deno.env.delete("OPTD_DATABASE_URL");
    else Deno.env.set("OPTD_DATABASE_URL", inheritedDatabase);
  });
  async function api(
    path: string,
    token: string,
    body?: unknown,
    bootstrap = false,
  ) {
    const response = await fetch(`${harness.baseUrl}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `${bootstrap ? "Optd-Bootstrap" : "Bearer"} ${token}`,
        "content-type": "application/json",
        "idempotency-key": opaqueToken(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const envelope = await response.json();
    return { status: response.status, ...envelope };
  }
  async function success(
    path: string,
    token: string,
    body?: unknown,
    bootstrap = false,
  ) {
    const result = await api(path, token, body, bootstrap);
    assert(result.ok, `${path}: ${result.status} ${result.error?.code}`);
    return result.data;
  }
  try {
    assert(
      new URL(harness.baseUrl).port !== "8789",
      "must not use the main service port",
    );
    await assertRejects(
      () =>
        harness.restart({
          environment: {
            OPTD_DATABASE_URL: "postgres://invalid@127.0.0.1:1/never",
          },
        }),
      Error,
      "isolated harness",
    );
    await assertRejects(
      () =>
        harness.runOptctl(["--help"], undefined, { OPTD_AUTH_ANCHOR_PID: "1" }),
      Error,
      "isolated harness",
    );
    // Public setup only: no SQL mutations or copied local auth state.
    const root = await success("/auth/bootstrap", bootstrapToken, {
      username: "onboarding-root",
      password: "synthetic onboarding root password",
    }, true);
    const admin = root.credentials.token;
    const requestToken = root.credentials.authorization_request_token;
    const allowed = await success("/workspaces", admin, {
      slug: "onboarding-allowed",
      display_name: "Allowed",
    });
    const other = await success("/workspaces", admin, {
      slug: "onboarding-other",
      display_name: "Other",
    });
    const user = await success("/auth/users", admin, {
      username: "onboarding-scoped",
      password: "synthetic onboarding scoped password",
    });
    const assignment = await success(
      `/auth/users/${user.id}/role-assignments`,
      admin,
      {
        role: "system:admin",
        boundary: { type: "workspace", workspace_id: allowed.id },
      },
    );
    const login = await success("/auth/login", "", {
      username: "onboarding-scoped",
      password: "synthetic onboarding scoped password",
    });
    const scoped = login.credentials.authorization_request_token;
    for (const token of [scoped, login.credentials.token, requestToken]) {
      for (const selector of [allowed.id, allowed.slug]) {
        const resolved = await success("/auth/workspace/resolve", token, {
          workspace: selector,
        });
        assertEquals(resolved, { workspace_id: allowed.id });
      }
    }
    const missing = await api("/auth/workspace/resolve", scoped, {
      workspace: "does-not-exist",
    });
    for (const selector of [other.id, other.slug]) {
      const denied = await api("/auth/workspace/resolve", scoped, {
        workspace: selector,
      });
      assertEquals(denied.status, missing.status);
      assertEquals(denied.error, missing.error);
    }
    assertEquals((await api("/workspaces", scoped)).status, 403);
    assertEquals(
      (await api("/auth/workspace/resolve", scoped, {
        workspace: "onboarding-*",
      })).status,
      422,
    );
    assertEquals(
      (await api("/auth/workspace/resolve", scoped, {
        workspace: allowed.slug,
        list: true,
      })).status,
      422,
    );

    // A restricted agent anchored to a super-admin must not inherit broad lookup.
    const nonce = opaqueToken();
    const request = await success("/auth/requests", requestToken, {
      roles: ["system:admin"],
      boundary: { type: "workspace", workspace_id: allowed.id },
      reason: "isolated resolver acceptance",
      redemption_nonce_hash: await tokenDigest(nonce),
    });
    await success(`/auth/requests/${request.id}/decision`, admin, {
      decision: "approved",
    });
    const agent = await success(
      `/auth/requests/${request.id}/redeem`,
      requestToken,
      { redemption_nonce: nonce },
    );
    assertEquals(
      await success("/auth/workspace/resolve", agent.token, {
        workspace: allowed.slug,
      }),
      { workspace_id: allowed.id },
    );
    assertEquals(
      (await api("/auth/workspace/resolve", agent.token, {
        workspace: other.slug,
      })).error,
      missing.error,
    );
    await success(
      `/auth/authorizations/${agent.authorization.id}/revoke`,
      admin,
      {},
    );
    assertEquals(
      (await api("/auth/workspace/resolve", agent.token, {
        workspace: allowed.slug,
      })).status,
      401,
    );

    await success(
      `/auth/users/${user.id}/role-assignments/${assignment.id}/disable`,
      admin,
      { expected_version: assignment.version },
    );
    assertEquals(
      (await api("/auth/workspace/resolve", scoped, {
        workspace: allowed.slug,
      })).error,
      missing.error,
    );
    await success(`/workspaces/${allowed.id}/archive`, admin, {
      expected_version: allowed.version,
    });
    assertEquals(
      (await api("/auth/workspace/resolve", requestToken, {
        workspace: allowed.id,
      })).error,
      missing.error,
    );
  } finally {
    await harness.close();
  }
});
