// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import { join } from "jsr:@std/path";
import { isUuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type CliResult,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

const CRM = "operant/crm";
const PACK = join(Deno.cwd(), "prototypes", "crm-default-pack");

Deno.test({
  name: "forced-current compiled CLI completes the public CRM acceptance flow",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startLiveHarness({
      forceFreshCompile: true,
      environment: {
        OPERANT_OUTBOX_POLL_INTERVAL_MS: "60000",
        OPERANT_SECRET_MASTER_KEY: btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        ),
      },
    });
    const launchers: CliLauncher[] = [];
    const output: string[] = [];
    try {
      assertStringIncludes(harness.binaryPath, harness.binarySourceDigest);
      assertStringIncludes(harness.binaryPath, harness.rootDir);
      const human = await launcher(harness, launchers, "human");
      const requestOnly = await launcher(harness, launchers, "request_only");
      const agent = await launcher(harness, launchers, "agent");

      const bootstrap = json(
        await ok(
          human.runOptctl([
            "--json",
            "bootstrap",
            "init",
            "--username",
            "crm-admin",
            "--display-name",
            "CRM Administrator",
            "--password-stdin",
          ], "crm acceptance password\n"),
          output,
        ),
      );
      const humanUserId = String(
        bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
          bootstrap.data.id,
      );
      assert(isUuidV7(humanUserId), JSON.stringify(bootstrap.data));

      const homeJson = json(await ok(human.runOptctl(["--json"]), output));
      const homeToon = toon(await ok(human.runOptctl([]), output));
      assertSubstantiveParity(homeToon.data, homeJson.data);

      const project = json(
        await ok(
          human.runOptctl([
            "--json",
            "project",
            "create",
            "sales",
            "--display-name",
            "Sales",
          ]),
          output,
        ),
      );
      const projectId = String(project.data.id);
      assert(isUuidV7(projectId));
      await ok(human.runOptctl(["project", "select", "sales"]), output);

      const preview = json(
        await ok(
          human.runOptctl([
            "--json",
            "pack",
            "preview",
            PACK,
          ]),
          output,
        ),
      );
      assertEquals(preview.data.plan.class, "safe");
      await ok(
        human.runOptctl(["--json", "pack", "apply", PACK, "--safe"]),
        output,
      );

      const metadataCases = [
        ["home"],
        ["metadata", "pack", CRM],
        ["metadata", "resource", `${CRM}:lead`],
        ["metadata", "action", `${CRM}:convert_lead`],
        ["metadata", "hook", `${CRM}:notify_crm_change`],
        ["metadata", "policy", `${CRM}:sales_access`],
      ];
      for (const command of metadataCases) {
        const plain = toon(
          await ok(
            human.runOptctl(["--project", projectId, ...command]),
            output,
          ),
        );
        const structured = json(
          await ok(
            human.runOptctl(["--json", "--project", projectId, ...command]),
            output,
          ),
        );
        assertSubstantiveParity(plain.data, structured.data);
        assertEquals(structured.data.axi_readiness?.ready ?? true, true);
      }
      const security = json(
        await ok(
          human.runOptctl([
            "--json",
            "--project",
            projectId,
            "metadata",
            "hook",
            `${CRM}:notify_crm_change`,
            "--include-security",
          ]),
          output,
        ),
      );
      assertExists(security.data.security_digest);

      const humanWhoami = json(
        await ok(human.runOptctl(["--json", "auth", "whoami"]), output),
      );
      assertEquals(humanWhoami.data.credential_kind, "human_full");
      assertEquals(humanWhoami.data.principal_type, "human_user");
      assertEquals(humanWhoami.data.human_user.id, humanUserId);
      assertEquals(humanWhoami.data.active, true);
      assertEquals("token" in humanWhoami.data, false);

      const firstSeed = json(
        await ok(
          human.runOptctl([
            "--json",
            "--project",
            projectId,
            "seed",
            "commit",
            CRM,
            "--all",
          ]),
          output,
        ),
      );
      assert(
        isUuidV7(String(firstSeed.data.id)),
        JSON.stringify(firstSeed.data),
      );

      await ok(
        human.runOptctl([
          "--json",
          "assignment",
          "role",
          "create",
          humanUserId,
          "--role",
          `${CRM}:sales_manager`,
          "--project",
          projectId,
        ]),
        output,
      );
      const roles = json(
        await ok(
          requestOnly.runOptctl([
            "--json",
            "auth",
            "roles",
            "--boundary",
            "project",
            "--project",
            projectId,
          ]),
          output,
        ),
      );
      assertEquals(roles.data.roles.includes(`${CRM}:sales_manager`), true);
      const request = json(
        await ok(
          requestOnly.runOptctl([
            "--json",
            "auth",
            "request",
            "--role",
            `${CRM}:sales_manager`,
            "--boundary",
            "project",
            "--project",
            projectId,
            "--reason",
            "Run the reviewed CRM acceptance flow",
          ]),
          output,
        ),
      );
      const requestId = String(request.data.id);
      const waiting = agent.runOptctl(["--json", "auth", "wait", requestId]);
      await delay(50);
      const approved = await ok(
        human.runOptctl([
          "--json",
          "auth",
          "approve",
          requestId,
          "--yes",
          "--agent-name",
          "crm-agent",
        ]),
        output,
      );
      assertEquals(/bearer|token/i.test(approved.stdout), false);
      const redeemed = json(await ok(waiting, output));
      assert(isUuidV7(String(redeemed.data.authorization.id)));
      assertEquals(redeemed.data.authorization.role_assignments, [{
        role: `${CRM}:sales_manager`,
        boundary: { type: "project", project_id: projectId },
      }]);
      const directWhoamiResponse = await fetch(
        `${harness.baseUrl}/api/v1/auth/me`,
        {
          headers: { authorization: `Bearer ${redeemed.data.token}` },
        },
      );
      const directWhoami = await directWhoamiResponse.json();
      assertEquals(
        directWhoamiResponse.status,
        200,
        JSON.stringify(directWhoami),
      );
      assertEquals(directWhoami.data.principal_type, "agent_user");
      assertEquals(directWhoami.data.credential_kind, "agent_authorization");
      assertEquals(
        directWhoami.data.agent.authorization_id,
        redeemed.data.authorization.id,
      );
      assertEquals(
        directWhoami.data.agent.root_authorization_id,
        redeemed.data.authorization.root_authorization_id,
      );
      assertEquals(directWhoami.data.agent.authorization_ancestry_ids, [
        redeemed.data.authorization.id,
      ]);
      assertEquals(directWhoami.data.role_assignments, [{
        role: `${CRM}:sales_manager`,
        boundary: { type: "project", project_id: projectId },
      }]);
      assertEquals(
        /token|password|anchor_pid/i.test(JSON.stringify(directWhoami.data)),
        false,
      );
      const whoami = json(
        await ok(agent.runOptctl(["--json", "auth", "whoami"]), output),
      );
      assertEquals(whoami.data.principal_type, "agent_user");
      assertEquals(whoami.data.server_origin, new URL(harness.baseUrl).origin);
      assertExists(whoami.data.binding);

      await ok(
        human.runOptctl([
          "--json",
          "auth",
          "revoke",
          String(redeemed.data.authorization.id),
        ]),
        output,
      );
      const revoked = await fetch(`${harness.baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${redeemed.data.token}` },
      });
      assertEquals(revoked.status, 401);
      const revokedBody = await revoked.text();
      assertEquals(revokedBody.includes("Bearer "), false);
      assertEquals(revokedBody.includes(String(redeemed.data.token)), false);

      const adminLoginResponse = await fetch(
        `${harness.baseUrl}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "crm-admin",
            password: "crm acceptance password",
          }),
        },
      );
      const adminLogin = await adminLoginResponse.json();
      assertEquals(adminLoginResponse.status, 200);
      const adminToken = String(adminLogin.data.credentials.token);
      const createdUserResponse = await fetch(
        `${harness.baseUrl}/api/v1/auth/users`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            username: "disabled-crm-user",
            display_name: "Disabled CRM User",
            password: "disabled CRM user password",
          }),
        },
      );
      const createdUser = await createdUserResponse.json();
      assertEquals(
        createdUserResponse.status,
        201,
        JSON.stringify(createdUser),
      );
      const disabledLoginResponse = await fetch(
        `${harness.baseUrl}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "disabled-crm-user",
            password: "disabled CRM user password",
          }),
        },
      );
      const disabledLogin = await disabledLoginResponse.json();
      assertEquals(disabledLoginResponse.status, 200);
      const disabledToken = String(disabledLogin.data.credentials.token);
      const disableResponse = await fetch(
        `${harness.baseUrl}/api/v1/auth/users/${createdUser.data.id}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: "disabled" }),
        },
      );
      assertEquals(disableResponse.status, 200, await disableResponse.text());
      const disabledWhoami = await fetch(`${harness.baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${disabledToken}` },
      });
      assertEquals(disabledWhoami.status, 401);
      const disabledBody = await disabledWhoami.text();
      assertEquals(disabledBody.includes(disabledToken), false);

      const replacementHuman = await harness.loginProcess({
        username: "crm-admin",
        password: "crm acceptance password",
      });
      launchers.push(replacementHuman.launcher);
      await ok(Promise.resolve(replacementHuman.result), output);

      // Frozen idempotency contract: a second complete seed reconciliation is a
      // successful no-op rather than a failed changeset.
      const secondSeed = json(
        await ok(
          replacementHuman.launcher.runOptctl([
            "--json",
            "--project",
            projectId,
            "seed",
            "commit",
            CRM,
            "--all",
          ]),
          output,
        ),
      );
      assertEquals(secondSeed.data.stage, null);
    } finally {
      await assertNoLeaks(harness, output).catch(() => undefined);
      for (const value of launchers.reverse()) {
        await value.close().catch(() => undefined);
      }
      await harness.close();
    }
  },
});

Deno.test({
  name: "CRM public output source and selected trace leak barriers",
  async fn() {
    const sources = await Promise.all([
      Deno.readTextFile(join(PACK, "hooks", "notify_crm_change.ts")),
      Deno.readTextFile(join(PACK, "hooks", "convert_lead.ts")),
    ]);
    for (const source of sources) {
      assertEquals(
        /Bearer |authorization:|OPERANT_DATABASE_URL|postgres:\/\//i.test(
          source,
        ),
        false,
      );
    }
  },
});

async function launcher(
  harness: LiveHarness,
  all: CliLauncher[],
  kind: "human" | "request_only" | "agent",
) {
  const value = await harness.createProcessTreeLauncher(kind);
  all.push(value);
  return value;
}
async function ok(promise: Promise<CliResult>, output: string[]) {
  const result = await promise;
  output.push(result.stdout, result.stderr);
  assertEquals(result.code, 0, result.stderr);
  return result;
}
function json(result: CliResult): any {
  const value = JSON.parse(result.stdout);
  assertEquals(value.ok, true);
  return value;
}
function toon(result: CliResult): any {
  const value = decodeToon(result.stdout) as any;
  assertEquals(value.ok, true);
  return value;
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function assertSubstantiveParity(actual: any, expected: any) {
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "generated_at").map((
          [key, child],
        ) => [key, normalize(child)]),
      );
    }
    return value;
  };
  assertEquals(normalize(actual), normalize(expected));
}
async function assertNoLeaks(harness: LiveHarness, output: string[]) {
  const diagnostics = await harness.diagnostics();
  const text = [...output, diagnostics.server, diagnostics.hooks].join("\n");
  for (
    const forbidden of [
      "crm acceptance password",
      "authorization: Bearer",
      "postgres://",
      "OPERANT_SECRET_MASTER_KEY",
      "BEGIN PRIVATE KEY",
      "at file://",
    ]
  ) assertEquals(text.includes(forbidden), false, `leaked ${forbidden}`);
  assertNotEquals(text.length, 0);
}
