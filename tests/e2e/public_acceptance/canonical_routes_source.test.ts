// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

Deno.test("public API source contains canonical routes and no superseded aliases", async () => {
  const files = await Promise.all([
    "app.ts",
    "auth_routes.ts",
    "authorization_routes.ts",
    "project_routes.ts",
  ].map((file) => Deno.readTextFile(`src/adapters/inbound/http-hono/${file}`)));
  const app = files[0];
  const source = files.join("\n");
  for (
    const route of [
      "/api/v1/metadata/home",
      "/api/v1/metadata/packs",
      "/api/v1/packs/preview",
      "/api/v1/queries",
      "/api/v1/changesets/stage",
      "/api/v1/actions/:publisher/:pack/:action/stage",
      "/api/v1/authorization/authority",
      "/api/v1/authorization/roles",
      "/api/v1/expressions/help",
      "/api/v1/expressions/validate",
    ]
  ) assertStringIncludes(source, route);
  for (
    const legacy of [
      "/api/v1/health",
      "/api/v1/pack/preview",
      "/api/v1/packs/apply",
      "/api/v1/query",
      "/api/v1/action/",
      "/api/v1/seeds/stage",
      "/api/v1/packs/preview-apply",
      "/api/v1/packs/preview/apply",
      "idempotency-key",
    ]
  ) {
    assertEquals(
      app.toLowerCase().includes(legacy),
      false,
      `active legacy route: ${legacy}`,
    );
  }
});

Deno.test("normative packs avoid legacy identities and authority fields", async () => {
  const roots = [
    "prototypes/crm-default-pack",
    "prototypes/project-management-pack",
  ];
  for (const root of roots) {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      for await (const child of Deno.readDir(`${root}/${entry.name}`)) {
        if (!child.isFile || !/\.(?:yaml|ts)$/.test(child.name)) continue;
        const source = await Deno.readTextFile(
          `${root}/${entry.name}/${child.name}`,
        );
        assert(!source.includes("namespace:"), `${child.name} has namespace`);
        assert(!source.includes("actor_role"), `${child.name} has actor_role`);
        assert(!source.includes("default:"), `${child.name} has default`);
        assert(
          !source.toLowerCase().includes("idempotency"),
          `${child.name} has idempotency`,
        );
        if (child.name.endsWith(".yaml")) {
          assertStringIncludes(source, "apiVersion: operant.dev/v1");
          assert(
            !/optd\.(?:crm|projects)/.test(source),
            `${child.name} has dotted identity`,
          );
        } else {
          assert(
            !source.includes("fetch("),
            `${child.name} calls the Optd self API`,
          );
        }
      }
    }
  }
  const projects = await Array.fromAsync(
    Deno.readDir("prototypes/project-management-pack/relationships"),
  );
  assertEquals(
    projects.some((entry) => entry.name === "project_member.yaml"),
    false,
  );
  assertEquals(
    projects.some((entry) => entry.name === "project_task.yaml"),
    false,
  );
  await Deno.stat(
    "prototypes/project-management-pack/resources/project_member.yaml",
  );
  await Deno.stat(
    "prototypes/crm-default-pack/relationships/opportunity_viewer.yaml",
  );
});
