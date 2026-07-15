import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

Deno.test({
  name:
    "compiled optctl serializes bootstrap and persists transactional Projects",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startLiveHarness();
    try {
      const unauthenticated = await fetch(`${harness.baseUrl}/metadata/home`);
      assertEquals(unauthenticated.status, 401);
      assertEquals(
        (await unauthenticated.json()).error.code,
        "authentication_required",
      );

      const bootstrapArgs = (username: string) => [
        "--json",
        "bootstrap",
        "init",
        "--username",
        username,
        "--password-stdin",
        "--display-name",
        username,
      ];
      const attempts = await harness.runConcurrent([
        {
          args: bootstrapArgs("jordan"),
          stdin: "correct horse battery staple\n",
        },
        {
          args: bootstrapArgs("casey"),
          stdin: "another correct horse password\n",
        },
      ]);
      for (const attempt of attempts) {
        assert(!attempt.argv.includes("correct horse battery staple"));
        assert(!attempt.argv.includes("another correct horse password"));
      }
      const winners = attempts.filter((attempt) => attempt.code === 0);
      const losers = attempts.filter((attempt) => attempt.code === 1);
      assertEquals(winners.length, 1);
      assertEquals(losers.length, 1);
      assertEquals(
        JSON.parse(losers[0].stderr).error.code,
        "bootstrap_already_completed",
      );
      assertMatch(
        JSON.parse(winners[0].stdout).data.user.id,
        /^[0-9a-f-]{36}$/,
      );

      const bootstrapFacts = await query<
        { users: string; assignments: string; phc: string }
      >(
        harness.server.sql,
        `select (select count(*)::text from human_users) users,
                (select count(*)::text from role_assignments where role_id='system:super_admin' and active) assignments,
                (select phc_hash from password_credentials limit 1) phc`,
      );
      assertEquals(bootstrapFacts.rows[0].users, "1");
      assertEquals(bootstrapFacts.rows[0].assignments, "1");
      assertMatch(bootstrapFacts.rows[0].phc, /^\$argon2id\$/);

      const missingInput = await harness.runOptctl([
        "--json",
        "bootstrap",
        "init",
        "--username",
        "nobody",
      ]);
      assertEquals(missingInput.code, 2);
      assertEquals(
        JSON.parse(missingInput.stderr).error.code,
        "interactive_input_required",
      );

      const home = await harness.runOptctl(["--json", "home"]);
      assertEquals(home.code, 0, home.stderr);

      const authStorePath =
        `${harness.homeDir}/../xdg-config/operant/auth.json`;
      const authStore = JSON.parse(await Deno.readTextFile(authStorePath));
      const originCredentials = authStore.origins[harness.baseUrl];
      const requestOnly = await fetch(`${harness.baseUrl}/metadata/home`, {
        headers: { authorization: `Bearer ${originCredentials.requestToken}` },
      });
      assertEquals(requestOnly.status, 403);
      assertEquals(
        (await requestOnly.json()).error.code,
        "authorization_insufficient",
      );

      const created = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "sales",
        "--display-name",
        "Sales",
        "--description",
        "CRM",
      ]);
      assertEquals(created.code, 0, created.stderr);
      const project = JSON.parse(created.stdout).data;
      assertMatch(
        project.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assertEquals(project.version, 1);
      assertEquals((await harness.selectProject("sales")).code, 0);

      const updates = await harness.runConcurrent([
        {
          args: [
            "--json",
            "project",
            "update",
            "sales",
            "--display-name",
            "Revenue",
            "--expected-version",
            "1",
          ],
        },
        {
          args: [
            "--json",
            "project",
            "update",
            "sales",
            "--display-name",
            "Operations",
            "--expected-version",
            "1",
          ],
        },
      ]);
      assertEquals(updates.filter((result) => result.code === 0).length, 1);
      const conflict = updates.find((result) => result.code === 1);
      assert(conflict);
      assertEquals(
        JSON.parse(conflict.stderr).error.code,
        "project_version_conflict",
      );

      const current = await harness.runOptctl([
        "--json",
        "project",
        "view",
        "sales",
      ]);
      assertEquals(JSON.parse(current.stdout).data.version, 2);
      const archived = await harness.runOptctl([
        "--json",
        "project",
        "archive",
        "sales",
        "--expected-version",
        "2",
      ]);
      assertEquals(archived.code, 0, archived.stderr);
      assertEquals(JSON.parse(archived.stdout).data.status, "archived");

      const audit = await query<{ action: string; auth_context_id: string }>(
        harness.server.sql,
        `select action, auth_context_id::text from project_audit_events order by created_at`,
      );
      assert(audit.rows.some((row) => row.action === "project.create"));
      assert(audit.rows.some((row) => row.action === "project.read"));
      assert(audit.rows.some((row) => row.action === "project.update"));
      assert(audit.rows.some((row) => row.action === "project.archive"));
      assert(
        audit.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.auth_context_id)),
      );

      const origin = harness.baseUrl;
      await harness.restart();
      assertEquals(harness.baseUrl, origin);
      const persisted = await harness.runOptctl([
        "--json",
        "project",
        "view",
        "sales",
      ]);
      assertEquals(persisted.code, 0, persisted.stderr);
      assertEquals(JSON.parse(persisted.stdout).data.status, "archived");

      const actorInjection = await fetch(
        `${harness.baseUrl}/api/v1/projects?actor=admin`,
        {
          headers: { authorization: "Bearer invalid" },
        },
      );
      assertEquals(actorInjection.status, 422);
      assertEquals(
        (await actorInjection.json()).error.code,
        "validation_failed",
      );
      assert(await Deno.stat(authStorePath));
    } catch (error) {
      console.error(await harness.diagnostics());
      throw error;
    } finally {
      await harness.close();
    }
  },
});
