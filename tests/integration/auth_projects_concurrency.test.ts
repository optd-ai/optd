import { assertEquals, assertRejects } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startLiveHarness } from "../support/live_harness.ts";

Deno.test({
  name:
    "Project version conflicts serialize and roll back audit facts in real Postgres",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startLiveHarness();
    try {
      const bootstrap = await harness.bootstrap({
        username: "integration-admin",
        password: "correct horse battery staple",
      });
      assertEquals(bootstrap.code, 0, bootstrap.stderr);
      const created = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "integration",
        "--display-name",
        "Integration",
      ]);
      assertEquals(created.code, 0, created.stderr);
      const project = JSON.parse(created.stdout).data;
      const store = JSON.parse(
        await Deno.readTextFile(
          `${harness.homeDir}/../xdg-config/optd/auth.json`,
        ),
      );
      const token = store.origins[harness.baseUrl].token;
      const requestToken = store.origins[harness.baseUrl].requestToken;
      const denied = await fetch(`${harness.baseUrl}/api/v1/metadata/home`, {
        headers: { authorization: `Bearer ${requestToken}` },
      });
      assertEquals(denied.status, 403);
      const requestContext = await query<{ id: string; roles: string[] }>(
        harness.server.sql,
        `select id::text, roles from auth_contexts
          where credential_kind='authorization_request' limit 1`,
      );
      assertEquals(requestContext.rows[0].roles, []);
      await assertRejects(
        () =>
          query(
            harness.server.sql,
            "update auth_contexts set roles=array['system:super_admin'] where id=$1",
            [requestContext.rows[0].id],
          ),
        Error,
        "auth contexts are immutable",
      );
      const mutate = (name: string) =>
        fetch(`${harness.baseUrl}/api/v1/projects/${project.id}/update`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ expected_version: 1, display_name: name }),
        });
      const responses = await Promise.all([mutate("First"), mutate("Second")]);
      assertEquals(
        responses.filter((response) => response.status === 200).length,
        1,
      );
      assertEquals(
        responses.filter((response) => response.status === 409).length,
        1,
      );
      const failure = responses.find((response) => response.status === 409)!;
      assertEquals(
        (await failure.json()).error.code,
        "project_version_conflict",
      );

      const facts = await query<{ version: string; updates: string }>(
        harness.server.sql,
        `select p.version::text,
                (select count(*)::text from project_audit_events a where a.project_id=p.id and a.action='project.update') updates
           from projects p where p.id=$1`,
        [project.id],
      );
      assertEquals(facts.rows[0].version, "2");
      assertEquals(facts.rows[0].updates, "1");
    } finally {
      await harness.close();
    }
  },
});
