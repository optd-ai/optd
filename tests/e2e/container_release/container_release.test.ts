// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  buildReleaseImage,
  createContainerHarness,
  runCommand,
} from "../../support/container_harness.ts";

let imagePromise: Promise<string> | undefined;
const image = () => imagePromise ??= buildReleaseImage();

Deno.test({
  name:
    "container release: image metadata and app-managed restart/signal smoke",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const releaseImage = await image();
    const harness = await createContainerHarness(releaseImage);
    try {
      const inspected = await harness.docker([
        "image",
        "inspect",
        releaseImage,
        "--format",
        "{{json .Config}}",
      ]);
      const config = JSON.parse(inspected.stdout);
      assertEquals(config.User, "1993:1993");
      assertEquals(config.Entrypoint[0], "/usr/bin/tini");
      assert(config.Healthcheck.Test.join(" ").includes("/ready"));
      assert(config.Labels["org.opencontainers.image.version"]);
      assert(config.Labels["org.opencontainers.image.revision"]);
      assert(config.Labels["org.opencontainers.image.source"]);
      assert(!JSON.stringify(config).includes(harness.bootstrapToken));
      assert(!JSON.stringify(config).includes(harness.masterKey));

      await harness.startAppManaged();
      const ready = await harness.waitReady();
      assertEquals(
        (ready.data as { database: { mode: string } }).database.mode,
        "app_managed",
      );
      const topology = await harness.docker([
        "exec",
        harness.container,
        "sh",
        "-c",
        "printf '%s ' \"$(cat /proc/1/comm)\"; id -u; deno --version | head -1; postgres --version",
      ]);
      assertStringIncludes(topology.stdout, "tini");
      assertStringIncludes(topology.stdout, "1993");
      assertStringIncludes(topology.stdout, "deno 2.8.3");
      assertStringIncludes(topology.stdout, "PostgreSQL) 18.4");

      const bootstrapStatus = await fetch(
        `http://127.0.0.1:${harness.port}/api/v1/auth/bootstrap/status`,
      ).then((response) => response.json());
      assertEquals(bootstrapStatus.data.state, "bootstrap_required");
      const bootstrapped = await harness.docker([
        "exec",
        "--interactive",
        "--env",
        `OPERANT_BOOTSTRAP_TOKEN=${harness.bootstrapToken}`,
        harness.container,
        "sh",
        "-c",
        "printf '%s\\n' 'container release password' | OPERANT_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json bootstrap init --username container-admin --password-stdin && printf '%s\\n' 'container-encrypted-value' | OPERANT_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json secret create container_api_token --stdin",
      ]);
      assertStringIncludes(bootstrapped.stdout, '"ok": true');
      assertStringIncludes(bootstrapped.stdout, "container_api_token");
      assert(!bootstrapped.stdout.includes("container-encrypted-value"));

      await harness.docker(["stop", "--time", "25", harness.container]);
      const stopped = await harness.docker([
        "inspect",
        harness.container,
        "--format",
        "{{.State.ExitCode}}",
      ]);
      assertEquals(stopped.stdout.trim(), "0");
      const logs = await harness.logs();
      assertStringIncludes(logs, '"event":"shutdown_complete"');
      assert(!logs.includes(harness.bootstrapToken));
      assert(!logs.includes(harness.masterKey));
      const stalePid = await harness.docker([
        "run",
        "--rm",
        "--entrypoint",
        "/bin/sh",
        "--volume",
        `${harness.volume}:/data`,
        releaseImage,
        "-c",
        "test ! -e /data/postgres/data/postmaster.pid",
      ]);
      assertEquals(stalePid.code, 0);

      await harness.docker(["start", harness.container]);
      await harness.waitReady();
      const active = await fetch(
        `http://127.0.0.1:${harness.port}/api/v1/auth/bootstrap/status`,
      ).then((response) => response.json());
      assertEquals(active.data.state, "active");

      await harness.docker(["stop", "--time", "25", harness.container]);
      await harness.docker(["rm", harness.container]);
      const wrongKey = btoa(
        String.fromCharCode(...new Uint8Array(32).fill(9)),
      );
      for (
        const [suffix, keyArgs, expected] of [
          ["missing", [], "secret_key_unavailable"],
          [
            "wrong",
            ["--env", `OPERANT_SECRET_MASTER_KEY=${wrongKey}`],
            "secret_key_mismatch",
          ],
          [
            "malformed",
            ["--env", "OPERANT_SECRET_MASTER_KEY=malformed"],
            "secret_master_key_invalid",
          ],
        ] as const
      ) {
        const name = `${harness.id}-${suffix}`;
        const failed = await harness.docker([
          "run",
          "--name",
          name,
          "--volume",
          `${harness.volume}:/data`,
          ...keyArgs,
          harness.image,
        ], { allowFailure: true, timeoutMs: 60_000 });
        assert(failed.code !== 0);
        const diagnostics = `${failed.stdout}${failed.stderr}`;
        assertStringIncludes(diagnostics, expected);
        assert(!diagnostics.includes(harness.masterKey));
        assert(!diagnostics.includes(wrongKey));
        await harness.docker(["rm", "-f", name], { allowFailure: true });
      }

      await harness.docker([
        "run",
        "--detach",
        "--name",
        harness.container,
        "--publish",
        `127.0.0.1:${harness.port}:8789`,
        "--env",
        `OPERANT_BOOTSTRAP_TOKEN=${harness.bootstrapToken}`,
        "--env",
        `OPERANT_SECRET_MASTER_KEY=${harness.masterKey}`,
        "--volume",
        `${harness.volume}:/data`,
        harness.image,
      ]);
      await harness.waitReady();
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "container release: malformed key and unwritable data fail closed and redacted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const releaseImage = await image();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const malformedName = `operant-cr-bad-key-${id}`;
    const bindName = `operant-cr-bad-bind-${id}`;
    const goodBindName = `operant-cr-good-bind-${id}`;
    const root = await Deno.makeTempDir({
      prefix: "operant-container-unwritable-",
    });
    await Deno.chmod(root, 0o500);
    try {
      const malformed = await runCommand("docker", [
        "run",
        "--name",
        malformedName,
        "--env",
        "OPERANT_BOOTSTRAP_TOKEN=not-logged",
        "--env",
        "OPERANT_SECRET_MASTER_KEY=malformed",
        releaseImage,
      ], { timeoutMs: 60_000, allowFailure: true });
      assert(malformed.code !== 0);
      const malformedLogs = `${malformed.stdout}\n${malformed.stderr}`;
      assertStringIncludes(malformedLogs, "secret_master_key_invalid");
      assert(!malformedLogs.includes("not-logged"));

      const unwritable = await runCommand("docker", [
        "run",
        "--name",
        bindName,
        "--env",
        "OPERANT_BOOTSTRAP_TOKEN=not-logged",
        "--env",
        "OPERANT_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "--volume",
        `${root}:/data`,
        releaseImage,
      ], { timeoutMs: 30_000, allowFailure: true });
      assert(unwritable.code !== 0);
      assert(
        !`${unwritable.stdout}${unwritable.stderr}`.includes("not-logged"),
      );

      await runCommand("docker", [
        "run",
        "--rm",
        "--user",
        "0",
        "--volume",
        `${root}:/data`,
        "--entrypoint",
        "/bin/sh",
        releaseImage,
        "-c",
        "chown 1993:1993 /data && chmod 700 /data",
      ]);
      await runCommand("docker", [
        "run",
        "--detach",
        "--name",
        goodBindName,
        "--env",
        "OPERANT_BOOTSTRAP_TOKEN=bind-token",
        "--env",
        "OPERANT_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        "--volume",
        `${root}:/data`,
        releaseImage,
      ]);
      await waitContainerHealthy(goodBindName);
      await runCommand("docker", ["stop", "--time", "25", goodBindName]);
      const goodExit = await runCommand("docker", [
        "inspect",
        goodBindName,
        "--format",
        "{{.State.ExitCode}}",
      ]);
      assertEquals(goodExit.stdout.trim(), "0");
    } finally {
      await runCommand("docker", [
        "run",
        "--rm",
        "--user",
        "0",
        "--volume",
        `${root}:/data`,
        "--entrypoint",
        "/bin/chown",
        releaseImage,
        "-R",
        String(Deno.uid()),
        "/data",
      ], { allowFailure: true });
      await Deno.chmod(root, 0o700).catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
      await runCommand("docker", [
        "rm",
        "-f",
        malformedName,
        bindName,
        goodBindName,
      ], {
        allowFailure: true,
      });
    }
  },
});

Deno.test({
  name:
    "container release: external PostgreSQL is preserved and unsupported major has no fallback",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const releaseImage = await image();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const network = `operant-cr-net-${id}`;
    const pg = `operant-cr-pg-${id}`;
    const app = `operant-cr-ext-${id}`;
    const badPg = `operant-cr-pg16-${id}`;
    const badApp = `operant-cr-ext16-${id}`;
    const unreachableApp = `operant-cr-unreachable-${id}`;
    const badAuthApp = `operant-cr-bad-auth-${id}`;
    const token = "external-token-not-logged";
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    try {
      await runCommand("docker", ["network", "create", network]);
      await runCommand("docker", [
        "run",
        "-d",
        "--name",
        pg,
        "--network",
        network,
        "--env",
        "POSTGRES_PASSWORD=external-pass",
        "--env",
        "POSTGRES_USER=operant",
        "--env",
        "POSTGRES_DB=operant",
        "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
      ]);
      await waitPg(pg);
      await runCommand("docker", [
        "run",
        "-d",
        "--name",
        app,
        "--network",
        network,
        "--env",
        `OPERANT_DATABASE_URL=postgres://operant:external-pass@${pg}:5432/operant`,
        "--env",
        `OPERANT_BOOTSTRAP_TOKEN=${token}`,
        "--env",
        `OPERANT_SECRET_MASTER_KEY=${key}`,
        releaseImage,
      ]);
      await waitContainerHealthy(app);
      const children = await runCommand("docker", [
        "exec",
        app,
        "sh",
        "-c",
        "cat /proc/[0-9]*/comm 2>/dev/null",
      ]);
      assert(!/^postgres$/m.test(children.stdout));
      await runCommand("docker", ["stop", "--time", "25", app]);
      const pgStillRunning = await runCommand("docker", [
        "inspect",
        pg,
        "--format",
        "{{.State.Running}}",
      ]);
      assertEquals(pgStillRunning.stdout.trim(), "true");

      await runCommand("docker", [
        "run",
        "-d",
        "--name",
        badPg,
        "--network",
        network,
        "--env",
        "POSTGRES_PASSWORD=external-pass",
        "--env",
        "POSTGRES_USER=operant",
        "--env",
        "POSTGRES_DB=operant",
        "postgres:16-bookworm",
      ]);
      await waitPg(badPg);
      const unsupported = await runCommand("docker", [
        "run",
        "--name",
        badApp,
        "--network",
        network,
        "--env",
        `OPERANT_DATABASE_URL=postgres://operant:external-pass@${badPg}:5432/operant`,
        "--env",
        `OPERANT_BOOTSTRAP_TOKEN=${token}`,
        "--env",
        `OPERANT_SECRET_MASTER_KEY=${key}`,
        releaseImage,
      ], { allowFailure: true, timeoutMs: 30_000 });
      assert(unsupported.code !== 0);
      const diagnostics = `${unsupported.stdout}\n${unsupported.stderr}`;
      assertStringIncludes(diagnostics, "requires PostgreSQL 17 or newer");
      assert(!diagnostics.includes("external-pass"));
      assert(!diagnostics.includes(token));

      for (
        const [name, url, credential] of [
          [
            unreachableApp,
            "postgres://operant:unreachable-secret@127.0.0.1:1/operant",
            "unreachable-secret",
          ],
          [
            badAuthApp,
            `postgres://operant:wrong-auth-secret@${pg}:5432/operant`,
            "wrong-auth-secret",
          ],
        ]
      ) {
        const failed = await runCommand("docker", [
          "run",
          "--name",
          name,
          "--network",
          network,
          "--env",
          `OPERANT_DATABASE_URL=${url}`,
          "--env",
          `OPERANT_BOOTSTRAP_TOKEN=${token}`,
          "--env",
          `OPERANT_SECRET_MASTER_KEY=${key}`,
          releaseImage,
        ], { allowFailure: true, timeoutMs: 30_000 });
        assert(failed.code !== 0);
        const failureLogs = `${failed.stdout}${failed.stderr}`;
        assertStringIncludes(failureLogs, '"mode":"external"');
        assert(!failureLogs.includes(credential));
        assert(!failureLogs.includes(token));
        await runCommand("docker", ["rm", "-f", name], {
          allowFailure: true,
        });
      }
    } finally {
      await runCommand("docker", [
        "rm",
        "-f",
        app,
        badApp,
        unreachableApp,
        badAuthApp,
        pg,
        badPg,
      ], {
        allowFailure: true,
      });
      await runCommand("docker", ["network", "rm", network], {
        allowFailure: true,
      });
    }
  },
});

async function waitPg(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await runCommand("docker", [
      "exec",
      name,
      "pg_isready",
      "-U",
      "operant",
      "-d",
      "operant",
    ], { allowFailure: true, timeoutMs: 5_000 });
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Postgres container ${name} did not become ready`);
}

async function waitContainerHealthy(name: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await runCommand("docker", [
      "inspect",
      name,
      "--format",
      "{{.State.Health.Status}}",
    ], { allowFailure: true });
    if (result.stdout.trim() === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const logs = await runCommand("docker", ["logs", name], {
    allowFailure: true,
  });
  throw new Error(`container ${name} unhealthy: ${logs.stdout}${logs.stderr}`);
}
