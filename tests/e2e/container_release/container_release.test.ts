// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  buildReleaseImage,
  type ContainerCliLauncher,
  type ContainerHarness,
  createContainerHarness,
  runCommand,
} from "../../support/container_harness.ts";
import { startHttpProvider } from "../../support/http_provider.ts";

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
      assertEquals(config.Volumes, { "/data": {} });
      assertEquals(config.ExposedPorts, { "8789/tcp": {} });
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
      const processes = await harness.docker([
        "exec",
        harness.container,
        "sh",
        "-c",
        'for p in /proc/[0-9]*; do pid=${p##*/}; ppid=$(sed -n \'s/^PPid:[[:space:]]*//p\' "$p/status"); comm=$(cat "$p/comm"); args=$(tr \'\\000\' \' \' < "$p/cmdline"); printf \'%s %s %s %s\\n\' "$pid" "$ppid" "$comm" "$args"; done',
      ]);
      const lines = processes.stdout.trim().split("\n");
      assertEquals(
        lines.filter((line) => /operant-server/.test(line)).length,
        1,
      );
      assertEquals(
        lines.filter((line) => /postgres .*\/data\/postgres\/data/.test(line))
          .length,
        1,
      );
      assertEquals(
        lines.filter((line) => /outbox.*worker/i.test(line)).length,
        0,
      );
      const packs = await harness.docker([
        "exec",
        harness.container,
        "sh",
        "-c",
        "find /opt/operant/prototypes -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort",
      ]);
      assertEquals(packs.stdout.trim().split("\n"), [
        "crm-default-pack",
        "project-management-pack",
      ]);

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
    "container release: in-image CLI exercises CRM and Projects production packs",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const harness = await createContainerHarness(await image());
    const output: string[] = [];
    try {
      await harness.startAppManaged([
        "--env",
        "OPERANT_OUTBOX_POLL_INTERVAL_MS=60000",
      ]);
      await harness.waitReady();
      const human = await harness.createProcessTreeLauncher();
      try {
        const run = async (args: string[], stdin?: string) => {
          const result = await human.runOptctl(args, stdin);
          output.push(result.stdout, result.stderr);
          assertEquals(
            result.code,
            0,
            `${result.argv.join(" ")}\n${result.stderr}\n${await harness
              .logs()}`,
          );
          return JSON.parse(result.stdout);
        };
        const bootstrap = await run([
          "--json",
          "bootstrap",
          "init",
          "--username",
          "proof-admin",
          "--password-stdin",
        ], "container proof password\n");
        const principalId = String(
          bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
            bootstrap.data.id,
        );
        const project = await run([
          "--json",
          "project",
          "create",
          "container-proof",
          "--display-name",
          "Container Proof",
        ]);
        const projectId = String(project.data.id);
        for (
          const [pack, identity] of [
            ["crm-default-pack", "operant/crm"],
            ["project-management-pack", "operant/projects"],
          ]
        ) {
          const path = `/opt/operant/prototypes/${pack}`;
          const preview = await run(["--json", "pack", "preview", path]);
          assertEquals(preview.data.plan.class, "safe");
          await run(["--json", "pack", "apply", path, "--safe"]);
          const metadata = await run([
            "--json",
            "--project",
            projectId,
            "metadata",
            "pack",
            identity,
          ]);
          assertEquals(metadata.data.axi_readiness?.ready ?? true, true);
          const toon = await human.runOptctl([
            "--project",
            projectId,
            "metadata",
            "pack",
            identity,
          ]);
          assertEquals(toon.code, 0, toon.stderr);
          const [publisher, name] = identity.split("/");
          assertStringIncludes(toon.stdout, `publisher: ${publisher}`);
          assertStringIncludes(toon.stdout, `name: ${name}`);
          const firstSeed = await run([
            "--json",
            "--project",
            projectId,
            "seed",
            "commit",
            identity,
            "--all",
          ]);
          assert(firstSeed.data.id);
          const repeated = await run([
            "--json",
            "--project",
            projectId,
            "seed",
            "commit",
            identity,
            "--all",
          ]);
          assertEquals(repeated.data.stage, null);
        }
        for (
          const role of [
            "operant/crm:crm_admin",
            "operant/projects:project_manager",
          ]
        ) {
          await run([
            "--json",
            "assignment",
            "role",
            "create",
            principalId,
            "--role",
            role,
            "--project",
            projectId,
          ]);
        }
        const staged = await stageChangeset(harness, human, projectId, [{
          op: "create",
          key: "company",
          project_id: projectId,
          resource: "operant/crm:company",
          fields: { name: "Container CRM", industry: "Validation" },
        }, {
          op: "create",
          key: "work_project",
          project_id: projectId,
          resource: "operant/projects:project",
          fields: {
            name: "Container Projects",
            status: "active",
            owner_id: principalId,
            visibility: "members",
          },
        }, {
          op: "create",
          key: "member",
          project_id: projectId,
          resource: "operant/projects:project_member",
          fields: {
            work_project_id: { $ref: "work_project.object_id" },
            principal_id: principalId,
          },
        }, {
          op: "create",
          key: "stage",
          project_id: projectId,
          resource: "operant/projects:task_stage",
          fields: {
            name: "Container Todo",
            state: "todo",
            sequence: 100,
            folded: false,
          },
        }, {
          op: "create",
          key: "task",
          project_id: projectId,
          resource: "operant/projects:task",
          fields: {
            title: "Validate release",
            work_project_id: { $ref: "work_project.object_id" },
            stage_id: { $ref: "stage.object_id" },
            state: "todo",
            assignee_id: principalId,
          },
        }, {
          op: "create",
          project_id: projectId,
          resource: "operant/projects:timesheet",
          fields: {
            task_id: { $ref: "task.object_id" },
            principal_id: principalId,
            hours: "1.25",
            entry_date: "2026-07-25",
          },
        }]);
        output.push(staged.raw.stdout, staged.raw.stderr);
        assertEquals(staged.raw.code, 0, staged.raw.stderr);
        await run(["--json", "changeset", "commit", staged.data.id]);
        const companyId = String(staged.data.operations[0].object_id);
        for (
          const command of [
            ["view", "operant/crm:company", companyId],
            ["history", "operant/crm:company", companyId],
            [
              "view",
              "operant/projects:project_member",
              String(staged.data.operations[2].object_id),
            ],
            [
              "view",
              "operant/projects:task",
              String(staged.data.operations[4].object_id),
            ],
            [
              "view",
              "operant/projects:timesheet",
              String(staged.data.operations[5].object_id),
            ],
          ]
        ) {
          const result = await run([
            "--json",
            "--project",
            projectId,
            ...command,
          ]);
          assert(result.data);
        }
        const stableFailure = await human.runOptctl([
          "--json",
          "--project",
          crypto.randomUUID(),
          "view",
          "operant/crm:company",
          companyId,
        ]);
        assertEquals(stableFailure.code, 1);
        assertEquals(JSON.parse(stableFailure.stderr).ok, false);
      } finally {
        await human.close();
      }
      const diagnostics = `${output.join("\n")}\n${await harness.logs()}`;
      assert(!diagnostics.includes("container proof password"));
      assert(!diagnostics.includes("authorization: Bearer"));
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "container release: durable outbox lease and retry recover across recreation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const provider = startHttpProvider([], {
      hostname: "0.0.0.0",
      advertisedHostname: "host.docker.internal",
    });
    const harness = await createContainerHarness(await image());
    const pack = await Deno.makeTempDir({ prefix: "container-outbox-pack-" });
    let launcher: ContainerCliLauncher | undefined;
    try {
      await writeContainerOutboxPack(pack, provider.url);
      await harness.startAppManaged([
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `OPERANT_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
        "--env",
        "OPERANT_OUTBOX_POLL_INTERVAL_MS=20",
        "--env",
        "OPERANT_OUTBOX_BATCH_SIZE=2",
        "--env",
        "OPERANT_OUTBOX_LEASE_MARGIN_MS=4000",
        "--env",
        "OPERANT_OUTBOX_INITIAL_BACKOFF_MS=20",
        "--env",
        "OPERANT_OUTBOX_MAX_BACKOFF_MS=100",
        "--env",
        "OPERANT_OUTBOX_SHUTDOWN_GRACE_MS=100",
      ]);
      await harness.waitReady();
      launcher = await harness.createProcessTreeLauncher();
      const ok = async (args: string[], stdin?: string) => {
        const result = await launcher!.runOptctl(args, stdin);
        assertEquals(result.code, 0, result.stderr);
        return JSON.parse(result.stdout).data;
      };
      await ok([
        "--json",
        "bootstrap",
        "init",
        "--username",
        "outbox-admin",
        "--password-stdin",
      ], "container outbox password\n");
      const project = await ok([
        "--json",
        "project",
        "create",
        "outbox-restart",
        "--display-name",
        "Outbox Restart",
      ]);
      const projectId = String(project.id);
      const containerPack = await harness.copyPack(pack);
      await ok(["--json", "pack", "apply", containerPack, "--safe"]);
      provider.enqueue(
        { kind: "retry", retryAfterSeconds: 2 },
        { kind: "hold", token: "leased" },
        { kind: "success" },
        { kind: "success" },
      );
      for (const key of ["retry", "leased"]) {
        const staged = await stageChangeset(harness, launcher, projectId, [{
          op: "create",
          project_id: projectId,
          resource: "test/containeroutbox:item",
          fields: { key },
        }]);
        assertEquals(staged.raw.code, 0, staged.raw.stderr);
        await ok(["--json", "changeset", "commit", staged.data.id]);
      }
      await provider.waitForAttempts(2, 15_000);
      const before = await waitOutboxStates(launcher, [
        "retry_wait",
        "running",
      ]);
      const running = before.find((item) => item.status === "running")!;
      const retrying = before.find((item) => item.status === "retry_wait")!;
      const runningEvidence = await ok([
        "--json",
        "outbox",
        "inspect",
        String(running.id),
      ]);
      assertEquals(runningEvidence.status, "running");
      const runningAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(running.id),
      ]);
      const runningAttempt = runningAttempts.items.find((attempt: {
        state: string;
      }) => attempt.state === "running");
      assert(runningAttempt?.lease_expires_at);
      assert(
        provider.attempts.some((attempt) =>
          attempt.idempotencyKey === running.id
        ),
      );
      await harness.docker(["kill", harness.container]);
      await launcher.close().catch(() => undefined);
      launcher = undefined;
      provider.release("leased");
      const attemptsAtRestart = provider.attempts.length;
      await harness.recreateAppManaged([
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `OPERANT_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
        "--env",
        "OPERANT_OUTBOX_POLL_INTERVAL_MS=20",
        "--env",
        "OPERANT_OUTBOX_BATCH_SIZE=2",
        "--env",
        "OPERANT_OUTBOX_LEASE_MARGIN_MS=4000",
        "--env",
        "OPERANT_OUTBOX_INITIAL_BACKOFF_MS=20",
        "--env",
        "OPERANT_OUTBOX_MAX_BACKOFF_MS=100",
      ]);
      await harness.waitReady();
      await provider.waitForAttempts(attemptsAtRestart + 2, 15_000);
      const recoveredRunningAttempt = provider.attempts.slice(attemptsAtRestart)
        .find((attempt) => attempt.idempotencyKey === running.id);
      assert(recoveredRunningAttempt);
      assert(
        recoveredRunningAttempt.receivedAt >=
          new Date(String(runningAttempt.lease_expires_at)).getTime(),
      );
      launcher = await harness.createProcessTreeLauncher();
      const login = await launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "outbox-admin",
        "--password-stdin",
      ], "container outbox password\n");
      assertEquals(login.code, 0, login.stderr);
      const recovered = await waitOutboxStates(launcher, [
        "succeeded",
        "succeeded",
      ]);
      const ids = new Set(recovered.map((item) => item.id));
      assert(ids.has(running.id));
      assert(ids.has(retrying.id));
      const sameDeliveryAttempts = provider.attempts.filter((attempt) =>
        attempt.idempotencyKey === running.id
      );
      assert(sameDeliveryAttempts.length >= 2);
      assertEquals(
        new Set(sameDeliveryAttempts.map((attempt) => attempt.idempotencyKey))
          .size,
        1,
      );
      assertEquals(
        provider.effects.filter((attempt) =>
          attempt.idempotencyKey === running.id
        )
          .length,
        1,
      );
      const topology = await harness.docker([
        "exec",
        harness.container,
        "sh",
        "-c",
        'for p in /proc/[0-9]*; do comm=$(cat "$p/comm"); args=$(tr \'\\000\' \' \' < "$p/cmdline"); printf \'%s %s\\n\' "$comm" "$args"; done',
      ]);
      assertEquals(topology.stdout.match(/outbox.*worker/gi) ?? [], []);
    } finally {
      await launcher?.close().catch(() => undefined);
      await harness.cleanup();
      await provider.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
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

Deno.test({
  name:
    "container release: external PostgreSQL compose preserves database across Operant recreation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const releaseImage = await image();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const project = `operant-ext-${id}`;
    const version = `compose-${id}`;
    const tagged = `operant:${version}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = {
      ...Deno.env.toObject(),
      COMPOSE_PROJECT_NAME: project,
      OPERANT_VERSION: version,
      OPERANT_PORT: String(port),
      OPERANT_POSTGRES_PASSWORD: `pg-${id}-password`,
      OPERANT_BOOTSTRAP_TOKEN: `bootstrap-${id}`,
      OPERANT_SECRET_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const compose = async (args: string[], allowFailure = false) =>
      await runCommand("docker", [
        "compose",
        "-f",
        "compose.external-postgres.yml",
        ...args,
      ], { timeoutMs: 180_000, allowFailure, env });
    try {
      await runCommand("docker", ["tag", releaseImage, tagged]);
      await compose(["up", "-d", "--no-build"]);
      await waitHttpReady(port);
      const pgId = (await compose(["ps", "-q", "postgres"])).stdout.trim();
      const appId = (await compose(["ps", "-q", "operant"])).stdout.trim();
      const bootstrap = await compose([
        "exec",
        "-T",
        "operant",
        "sh",
        "-c",
        "printf '%s\\n' 'compose proof password' | OPERANT_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json bootstrap init --username compose-admin --password-stdin && OPERANT_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json project create compose-fact --display-name 'Compose Persistent Fact'",
      ]);
      assertStringIncludes(bootstrap.stdout, '"ok": true');
      assertStringIncludes(bootstrap.stdout, "compose-fact");
      const processes = await runCommand("docker", [
        "exec",
        appId,
        "sh",
        "-c",
        "cat /proc/[0-9]*/comm 2>/dev/null",
      ]);
      assert(!/^postgres$/m.test(processes.stdout));
      await compose(["stop", "operant"]);
      assertEquals(
        (await runCommand("docker", [
          "inspect",
          pgId,
          "--format",
          "{{.State.Running}}",
        ]))
          .stdout.trim(),
        "true",
      );
      await compose(["rm", "-f", "operant"]);
      await compose(["up", "-d", "--no-deps", "--no-build", "operant"]);
      await waitHttpReady(port);
      assertEquals(
        (await compose(["ps", "-q", "postgres"])).stdout.trim(),
        pgId,
      );
      const status = await fetch(
        `http://127.0.0.1:${port}/api/v1/auth/bootstrap/status`,
      ).then((response) => response.json());
      assertEquals(status.data.state, "active");
    } finally {
      await compose(["down", "--volumes", "--remove-orphans"], true);
      await runCommand("docker", ["image", "rm", tagged], {
        allowFailure: true,
      });
    }
  },
});

async function stageChangeset(
  harness: ContainerHarness,
  launcher: ContainerCliLauncher,
  projectId: string,
  operations: unknown[],
) {
  const path =
    `/data/.container-test-clients/input-${crypto.randomUUID()}.json`;
  const payload = JSON.stringify({ project_id: projectId, operations });
  await harness.docker([
    "exec",
    "--interactive",
    harness.container,
    "sh",
    "-c",
    `umask 077; cat > '${path}'`,
  ], { stdin: payload });
  const raw = await launcher.runOptctl([
    "--json",
    "changeset",
    "stage",
    "--file",
    path,
  ]);
  return { raw, data: raw.code === 0 ? JSON.parse(raw.stdout).data : {} };
}

async function waitOutboxStates(
  launcher: ContainerCliLauncher,
  expected: string[],
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 20_000;
  let items: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const result = await launcher.runOptctl([
      "--json",
      "outbox",
      "list",
      "--limit",
      "20",
    ]);
    if (result.code === 0) {
      items = JSON.parse(result.stdout).data.items;
      const available = items.map((item) => String(item.status));
      const remaining = [...available];
      const matched = expected.every((status) => {
        const index = remaining.indexOf(status);
        if (index < 0) return false;
        remaining.splice(index, 1);
        return true;
      });
      if (matched) {
        const candidates = [...items];
        return expected.map((status) => {
          const index = candidates.findIndex((item) => item.status === status);
          return candidates.splice(index, 1)[0];
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `outbox states ${expected.join(",")} not reached: ${JSON.stringify(items)}`,
  );
}

async function writeContainerOutboxPack(root: string, providerUrl: string) {
  await Deno.mkdir(`${root}/resources`, { recursive: true });
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    "kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: containeroutbox, version: 1.0.0 }\nspec: { purpose: Container restart delivery proof., axi: {} }\n",
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    "kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n  axi: {}\n",
  );
  const host = new URL(providerUrl).host;
  await Deno.writeTextFile(
    `${root}/hooks/deliver.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: deliver }\nspec:\n  script: deliver.ts\n  timeout: 1s\n  permissions: { net: [${host}], env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: delivery.v1 }\n  attachments:\n    - phase: event.after_commit\n      event: object.created\n      order: 10\n      condition: 'event_type == "object.created"'\n      input: { event: '$event' }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/deliver.ts`,
    `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text());\nconst delivery=envelope.metadata.delivery;\nconst response=await fetch(${
      JSON.stringify(`${providerUrl}/effect`)
    },{method:"POST",headers:{"content-type":"application/json","idempotency-key":delivery.idempotency_key},body:JSON.stringify({attempt_id:delivery.attempt_id})});\nif(response.status===503) console.log(JSON.stringify({outcome:"retry",code:"provider_unavailable",message:"retry",retry_after:(response.headers.get("retry-after")??"1")+"s"}));\nelse console.log(JSON.stringify({outcome:"succeeded",external_id:"container-provider"}));\n`,
  );
}

async function waitHttpReady(port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`container on port ${port} did not become ready`);
}

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
