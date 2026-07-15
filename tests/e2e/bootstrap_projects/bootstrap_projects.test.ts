import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";

Deno.test({
  name: "compiled optctl bootstraps once and persists authenticated Projects",
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

      const bootstrap = await harness.runOptctl([
        "--json",
        "bootstrap",
        "init",
        "--username",
        "jordan",
        "--password",
        "correct horse battery staple",
        "--display-name",
        "Jordan",
      ]);
      assertEquals(bootstrap.code, 0, bootstrap.stderr);
      const bootstrapBody = JSON.parse(bootstrap.stdout);
      assertMatch(bootstrapBody.data.user.id, /^[0-9a-f-]{36}$/);

      const replay = await harness.runOptctl([
        "--json",
        "bootstrap",
        "init",
        "--username",
        "other",
        "--password",
        "another safe password",
      ]);
      assertEquals(replay.code, 1);
      assertEquals(
        JSON.parse(replay.stderr).error.code,
        "bootstrap_already_completed",
      );

      const home = await harness.runOptctl(["--json", "home"]);
      assertEquals(home.code, 0, home.stderr);

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

      const selected = await harness.selectProject("sales");
      assertEquals(selected.code, 0, selected.stderr);
      const updated = await harness.runOptctl([
        "--json",
        "project",
        "update",
        "sales",
        "--display-name",
        "Revenue Operations",
        "--expected-version",
        "1",
      ]);
      assertEquals(updated.code, 0, updated.stderr);
      assertEquals(JSON.parse(updated.stdout).data.version, 2);
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

      const authStore = JSON.parse(
        await Deno.readTextFile(
          `${harness.homeDir}/../xdg-config/operant/auth.json`,
        ),
      );
      const token = authStore.origins[harness.baseUrl].token;
      await harness.restart();
      const persisted = await fetch(
        `${harness.baseUrl}/api/v1/projects/${project.id}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assertEquals(persisted.status, 200);
      assertEquals((await persisted.json()).data.status, "archived");

      const actorInjection = await fetch(
        `${harness.baseUrl}/api/v1/projects?actor=admin`,
        { headers: { authorization: "Bearer invalid" } },
      );
      assertEquals(actorInjection.status, 422);
      assertEquals(
        (await actorInjection.json()).error.code,
        "validation_failed",
      );
      assert(
        await Deno.stat(`${harness.homeDir}/../xdg-config/operant/auth.json`),
      );
    } catch (error) {
      console.error(await harness.diagnostics());
      throw error;
    } finally {
      await harness.close();
    }
  },
});
