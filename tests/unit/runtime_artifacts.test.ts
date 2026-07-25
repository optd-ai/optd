// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  assertSupportedPostgresUrl,
  assertSupportedPostgresVersionNumber,
  planPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test("runtime guardrails reject non-Postgres database URLs", () => {
  assertSupportedPostgresUrl("postgres://user:pass@example:5432/operant");
  assertSupportedPostgresUrl("postgresql://user:pass@example:5432/operant");

  for (
    const url of [
      "sqlite:///tmp/operant.db",
      "file:///tmp/db",
      "pglite://local",
    ]
  ) {
    assertThrowsWithMessage(
      () => assertSupportedPostgresUrl(url),
      "Postgres-only",
    );
  }
});

Deno.test("runtime rejects unsupported PostgreSQL versions before migrations", () => {
  assertEquals(assertSupportedPostgresVersionNumber("170000"), 17);
  assertEquals(assertSupportedPostgresVersionNumber(180004), 18);
  assertThrowsWithMessage(
    () => assertSupportedPostgresVersionNumber("160012"),
    "requires PostgreSQL 17 or newer",
  );
});

Deno.test("runtime planning does not silently accept PGlite or SQLite URLs", () => {
  const env = new MapEnv({ OPERANT_DATABASE_URL: "pglite://prototype" });
  assertThrowsWithMessage(() => planPostgresRuntime(env), "Postgres-only");
});

Deno.test("container and deployment artifacts document Postgres-only production runtime", async () => {
  const dockerfile = await Deno.readTextFile("Dockerfile");
  assertStringIncludes(dockerfile, "postgres:18.4-bookworm@sha256:");
  assertStringIncludes(dockerfile, "operant-server");
  assertStringIncludes(dockerfile, "optctl");
  assertStringIncludes(dockerfile, "USER 1993:1993");
  assertStringIncludes(dockerfile, 'ENTRYPOINT ["/usr/bin/tini"');
  assertStringIncludes(dockerfile, "org.opencontainers.image.revision");
  assertStringIncludes(dockerfile, "/ready");

  const compose = await Deno.readTextFile("docker-compose.yml");
  assertStringIncludes(compose, "operant-data:/data");
  assertStringIncludes(compose, "OPERANT_BOOTSTRAP_TOKEN");
  assertStringIncludes(compose, "http://127.0.0.1:8789/ready");
  assert(!compose.includes("OPERANT_DATABASE_URL"));
  assertEquals((compose.match(/^\s{2}[a-z][a-z-]*:\s*$/gm) ?? []).length, 2);

  const externalCompose = await Deno.readTextFile(
    "compose.external-postgres.yml",
  );
  assertStringIncludes(externalCompose, "OPERANT_DATABASE_URL");
  assertStringIncludes(externalCompose, "postgres:18.4-bookworm@sha256:");
  assertStringIncludes(externalCompose, "OPERANT_BOOTSTRAP_TOKEN");
  assertStringIncludes(externalCompose, "pg_isready");

  const docs = await Deno.readTextFile("docs/runtime.md");
  assertStringIncludes(
    docs,
    "PGlite and SQLite are prototype-only/non-MVP",
  );
  assertStringIncludes(docs, "OPERANT_SECRET_MASTER_KEY");

  for (
    const path of [
      "k8s/operant-app-managed.example.yaml",
      "k8s/operant-external-postgres.example.yaml",
    ]
  ) {
    const manifest = await Deno.readTextFile(path);
    assertStringIncludes(manifest, "readinessProbe");
    assertStringIncludes(manifest, "path: /ready");
    assertStringIncludes(manifest, "path: /live");
    assertStringIncludes(manifest, "startupProbe");
    assertStringIncludes(manifest, "runAsNonRoot: true");
    assertStringIncludes(manifest, "runAsUser: 1993");
    assertStringIncludes(manifest, "secretKeyRef");
    assertStringIncludes(manifest, "OPERANT_DATA_DIR");
  }
});

function assertThrowsWithMessage(fn: () => unknown, message: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof Error, "expected function to throw");
  assertStringIncludes(thrown.message, message);
}

class MapEnv implements Deno.Env {
  constructor(private readonly values: Record<string, string>) {}

  get(key: string): string | undefined {
    return this.values[key];
  }

  set(): never {
    throw new Error("not implemented");
  }

  delete(): never {
    throw new Error("not implemented");
  }

  has(key: string): boolean {
    return this.values[key] !== undefined;
  }

  toObject(): { [index: string]: string } {
    return { ...this.values };
  }
}
