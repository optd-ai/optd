import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadRuntimeConfig, OPTD_VERSION } from "../../src/config/runtime.ts";
import {
  findPostgresBins,
  planPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { authDataRoot } from "../../src/adapters/outbound/local-auth-store/filesystem.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";

function env(values: Record<string, string>): Deno.Env {
  return {
    get: (key) => values[key],
    has: (key) => key in values,
    toObject: () => ({ ...values }),
    set: () => {
      throw new Error("read-only test environment");
    },
    delete: () => {
      throw new Error("read-only test environment");
    },
  };
}

Deno.test("optd defaults ignore adversarial legacy runtime configuration", async () => {
  // Explicitly rejected legacy inputs: none may configure or select a runtime.
  const legacy = env({
    OPERANT_HOST: "legacy.invalid",
    OPERANT_PORT: "6666",
    OPERANT_DATA_DIR: "/legacy/data",
    OPERANT_DATABASE_URL: "sqlite://legacy",
    OPERANT_PG_BIN_DIR: "/legacy/bin",
    PATH: "",
  });
  assertEquals(loadRuntimeConfig(legacy), {
    host: "127.0.0.1",
    port: 8789,
    dataDir: undefined,
    databaseUrl: undefined,
  });
  assertEquals(planPostgresRuntime(legacy), {
    mode: "app_managed",
    dataDir: undefined,
    pgBinDir: undefined,
    binariesAvailable: false,
  });
  assertEquals(await findPostgresBins(legacy), null);
  assertEquals(OPTD_VERSION, "0.1.0-dev");
});

Deno.test("canonical OPTD configuration selects external and managed modes without aliases", () => {
  const canonical = env({
    OPTD_HOST: "0.0.0.0",
    OPTD_PORT: "9123",
    OPTD_DATA_DIR: "/fresh/optd",
    OPTD_DATABASE_URL: "postgres://optd@localhost/optd",
    OPERANT_DATABASE_URL: "sqlite://adversarial",
  });
  assertEquals(loadRuntimeConfig(canonical), {
    host: "0.0.0.0",
    port: 9123,
    dataDir: "/fresh/optd",
    databaseUrl: "postgres://optd@localhost/optd",
  });
  assertEquals(planPostgresRuntime(canonical), {
    mode: "external",
    databaseUrl: "postgres://optd@localhost/optd",
    binariesAvailable: true,
  });
  assertEquals(
    planPostgresRuntime(
      env({ OPTD_DATA_DIR: "/fresh/optd", OPTD_PG_BIN_DIR: "/pg/bin" }),
    ),
    {
      mode: "app_managed",
      dataDir: "/fresh/optd",
      pgBinDir: "/pg/bin",
      binariesAvailable: false,
    },
  );
});

Deno.test("local credentials use fresh lower-case optd XDG storage", () => {
  const keys = ["HOME", "XDG_DATA_HOME", "LOCALAPPDATA"];
  const previous = keys.map((key) => Deno.env.get(key));
  try {
    for (const key of keys) Deno.env.set(key, "/identity-test");
    const root = authDataRoot().replaceAll("\\", "/");
    assert(root.endsWith("/optd/auth"));
    if (Deno.build.os === "linux") {
      assertEquals(root, "/identity-test/optd/auth");
    }
    Deno.env.delete("XDG_DATA_HOME");
    if (Deno.build.os === "linux") {
      assertEquals(authDataRoot(), "/identity-test/.local/share/optd/auth");
    }
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    });
  }
});

Deno.test("optctl retains its executable identity and /api/v1 requests", async () => {
  const help = await runOptctl(["--help"]);
  assertEquals(help.code, 0);
  assertStringIncludes(help.stdout, "optctl");
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      requests.push(new URL(req.url).pathname);
      return Response.json({ ok: true, data: {} });
    },
  );
  try {
    const result = await runOptctl([
      "--server",
      `http://127.0.0.1:${server.addr.port}`,
      "--json",
      "home",
    ]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(requests, ["/api/v1/metadata/home"]);
  } finally {
    await server.shutdown();
  }
});
