// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { runAuxiliaryContainerCases } from "../../support/auxiliary_container_cleanup.ts";
import {
  buildReleaseImage,
  type ContainerCliLauncher,
  type ContainerHarness,
  createContainerHarness,
  runCommand,
} from "../../support/container_harness.ts";
import { startHttpProvider } from "../../support/http_provider.ts";
import { registerContainerPublicFlowMatrix } from "../../support/public_flows/register.ts";

let imagePromise: Promise<string> | undefined;
const image = () => imagePromise ??= buildReleaseImage();
const releaseExecutionAnonymousVolumesBefore = await anonymousDockerVolumeIds();

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
        lines.filter((line) => /optd/.test(line)).length,
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
        "find /opt/optd/prototypes -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort",
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
        `OPTD_BOOTSTRAP_TOKEN=${harness.bootstrapToken}`,
        harness.container,
        "sh",
        "-c",
        "printf '%s\\n' 'container release password' | OPTD_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json bootstrap init --username container-admin --password-stdin && printf '%s\\n' 'container-encrypted-value' | OPTD_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json secret create container_api_token --stdin",
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

      for (let recreation = 0; recreation < 3; recreation++) {
        await harness.docker(["kill", harness.container]);
        const retainedPid = await harness.docker([
          "run",
          "--rm",
          "--entrypoint",
          "/bin/sh",
          "--volume",
          `${harness.volume}:/data`,
          releaseImage,
          "-c",
          "test -s /data/postgres/data/postmaster.pid",
        ]);
        assertEquals(
          retainedPid.code,
          0,
          `hard recreation ${
            recreation + 1
          } must not delete postmaster.pid in the harness`,
        );
        await harness.recreateAppManaged();
        await harness.waitReady();
        const recovered = await fetch(
          `http://127.0.0.1:${harness.port}/api/v1/auth/bootstrap/status`,
        ).then((response) => response.json());
        assertEquals(recovered.data.state, "active");
      }

      await harness.docker(["stop", "--time", "25", harness.container]);
      await harness.docker(["rm", "-f", "-v", harness.container]);
      const wrongKey = btoa(
        String.fromCharCode(...new Uint8Array(32).fill(9)),
      );
      const auxiliaryCases = [
        {
          name: `${harness.id}-missing`,
          keyArgs: [] as string[],
          expected: "secret_key_unavailable",
        },
        {
          name: `${harness.id}-wrong`,
          keyArgs: ["--env", `OPTD_SECRET_MASTER_KEY=${wrongKey}`],
          expected: "secret_key_mismatch",
        },
        {
          name: `${harness.id}-malformed`,
          keyArgs: ["--env", "OPTD_SECRET_MASTER_KEY=malformed"],
          expected: "secret_master_key_invalid",
        },
      ];
      await runAuxiliaryContainerCases(
        auxiliaryCases,
        async ({ name, keyArgs, expected }) => {
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
        },
        async (name) => {
          const removed = await harness.docker(["rm", "-f", "-v", name], {
            allowFailure: true,
            timeoutMs: 20_000,
          });
          const diagnostics = `${removed.stdout}${removed.stderr}`;
          if (
            removed.code !== 0 && !diagnostics.includes("No such container")
          ) {
            throw new Error(
              `failed to remove auxiliary container ${name}: ${diagnostics}`,
            );
          }
        },
      );

      await harness.docker([
        "run",
        "--detach",
        "--name",
        harness.container,
        "--publish",
        `127.0.0.1:${harness.port}:8789`,
        "--env",
        `OPTD_BOOTSTRAP_TOKEN=${harness.bootstrapToken}`,
        "--env",
        `OPTD_SECRET_MASTER_KEY=${harness.masterKey}`,
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

registerContainerPublicFlowMatrix(image);

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
        `OPTD_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
        "--env",
        "OPTD_OUTBOX_POLL_INTERVAL_MS=60000",
        "--env",
        "OPTD_OUTBOX_BATCH_SIZE=2",
        "--env",
        "OPTD_OUTBOX_LEASE_MARGIN_MS=4000",
        "--env",
        "OPTD_OUTBOX_INITIAL_BACKOFF_MS=20",
        "--env",
        "OPTD_OUTBOX_MAX_BACKOFF_MS=100",
        "--env",
        "OPTD_OUTBOX_SHUTDOWN_GRACE_MS=100",
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
        { kind: "hold", token: "queued-recovery-generation-0" },
        {
          kind: "hold_retry",
          token: "retry-response-generation-0",
          retryAfterSeconds: 2,
        },
        { kind: "hold", token: "lease-generation-0" },
      );

      const queuedStage = await stageChangeset(harness, launcher, projectId, [{
        op: "create",
        project_id: projectId,
        resource: "test/containeroutbox:item",
        fields: { key: "queued" },
      }]);
      assertEquals(queuedStage.raw.code, 0, queuedStage.raw.stderr);
      await ok(["--json", "changeset", "commit", queuedStage.data.id]);
      const queued = await waitOutboxStatus(launcher, "pending");
      const queuedEvidence = await ok([
        "--json",
        "outbox",
        "inspect",
        String(queued.id),
      ]);
      assertEquals(queuedEvidence.status, "pending");
      assertEquals(queuedEvidence.total_attempts, 0);
      await harness.docker(["kill", harness.container]);
      await launcher.close().catch(() => undefined);
      launcher = undefined;
      launcher = await restartOutboxContainer(harness, provider.url);
      await waitProviderHold(provider, "queued-recovery-generation-0");
      assertProviderHoldActive(
        provider,
        "queued-recovery-generation-0",
        String(queued.id),
      );
      provider.release("queued-recovery-generation-0");
      await waitOutboxDeliveryStatus(
        launcher,
        String(queued.id),
        "succeeded",
      );
      const recoveredQueued = await ok([
        "--json",
        "outbox",
        "inspect",
        String(queued.id),
      ]);
      assertEquals(recoveredQueued.total_attempts, 1);
      assertEquals(
        recoveredQueued.attempts_summary.latest.outcome,
        "succeeded",
      );

      const retryStage = await stageChangeset(harness, launcher, projectId, [{
        op: "create",
        project_id: projectId,
        resource: "test/containeroutbox:item",
        fields: { key: "retry" },
      }]);
      assertEquals(retryStage.raw.code, 0, retryStage.raw.stderr);
      await ok(["--json", "changeset", "commit", retryStage.data.id]);
      await waitProviderHold(provider, "retry-response-generation-0");
      provider.release("retry-response-generation-0");
      const retrying = await waitOutboxStatus(launcher, "retry_wait");
      provider.enqueueForKey(String(retrying.id), {
        kind: "hold",
        token: "retry-recovery-generation-0",
      });
      const retryEvidence = await ok([
        "--json",
        "outbox",
        "inspect",
        String(retrying.id),
      ]);
      assertEquals(retryEvidence.status, "retry_wait");
      assertEquals(retryEvidence.retry_generation, 0);
      assertEquals(retryEvidence.attempts_in_generation, 1);
      assertEquals(retryEvidence.total_attempts, 1);
      assertEquals(retryEvidence.attempts_summary.latest.outcome, "retry");
      const retryAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(retrying.id),
      ]);
      assertEquals(retryAttempts.items[0].retry_generation, 0);
      assertEquals(retryAttempts.items[0].attempt_number, 1);
      assertEquals(retryAttempts.items[0].total_attempt_number, 1);
      assertEquals(retryAttempts.items[0].outcome, "retry");
      await waitProviderHold(provider, "retry-recovery-generation-0");
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-0",
        String(retrying.id),
      );
      const retryBeforeCrash = await ok([
        "--json",
        "outbox",
        "inspect",
        String(retrying.id),
      ]);
      assertEquals(retryBeforeCrash.status, "running");
      assertEquals(retryBeforeCrash.retry_generation, 0);
      assertEquals(retryBeforeCrash.attempts_in_generation, 2);
      assertEquals(retryBeforeCrash.total_attempts, 2);
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-0",
        String(retrying.id),
      );
      const retryBeforeCrashAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(retrying.id),
      ]);
      const activeRetryBeforeCrash = retryBeforeCrashAttempts.items.find(
        (attempt: { state: string }) => attempt.state === "running",
      );
      assert(activeRetryBeforeCrash);
      assertEquals(
        activeRetryBeforeCrash.id,
        retryBeforeCrash.attempts_summary.latest.attempt_id,
      );
      assertEquals(activeRetryBeforeCrash.retry_generation, 0);
      assertEquals(activeRetryBeforeCrash.attempt_number, 2);
      assertEquals(activeRetryBeforeCrash.total_attempt_number, 2);
      const retryBeforeCrashProviderAttempt = provider.attempts.filter(
        (attempt) => attempt.idempotencyKey === retrying.id,
      ).at(-1);
      assert(retryBeforeCrashProviderAttempt);
      assertEquals(
        JSON.parse(retryBeforeCrashProviderAttempt.body).attempt_id,
        activeRetryBeforeCrash.id,
      );
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-0",
        String(retrying.id),
      );

      await harness.docker(["kill", harness.container]);
      await launcher.close().catch(() => undefined);
      launcher = undefined;
      await releaseActiveProviderHolds(provider);
      provider.enqueueForKeyNext(String(retrying.id), {
        kind: "hold",
        token: "retry-recovery-generation-1",
      });
      launcher = await restartOutboxContainer(harness, provider.url);
      await waitProviderHold(provider, "retry-recovery-generation-1");
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-1",
        String(retrying.id),
      );
      const recoveredRetry = await ok([
        "--json",
        "outbox",
        "inspect",
        String(retrying.id),
      ]);
      assertEquals(recoveredRetry.status, "running");
      assertEquals(recoveredRetry.retry_generation, 0);
      assertEquals(recoveredRetry.attempts_in_generation, 3);
      assertEquals(recoveredRetry.total_attempts, 3);
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-1",
        String(retrying.id),
      );
      const recoveredRetryAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(retrying.id),
      ]);
      const activeRetry = recoveredRetryAttempts.items.find((attempt: {
        state: string;
      }) => attempt.state === "running");
      assertEquals(
        activeRetry.id,
        recoveredRetry.attempts_summary.latest.attempt_id,
      );
      assertEquals(activeRetry.retry_generation, 0);
      assertEquals(activeRetry.attempt_number, 3);
      assertEquals(activeRetry.total_attempt_number, 3);
      assert(activeRetry.lease_expires_at);
      const recoveredRetryProviderAttempt = provider.attempts.filter(
        (attempt) => attempt.idempotencyKey === retrying.id,
      ).at(-1);
      assert(recoveredRetryProviderAttempt);
      assertEquals(
        JSON.parse(recoveredRetryProviderAttempt.body).attempt_id,
        activeRetry.id,
      );
      assertProviderHoldActive(
        provider,
        "retry-recovery-generation-1",
        String(retrying.id),
      );
      provider.release("retry-recovery-generation-1");
      await waitOutboxDeliveryStatus(
        launcher,
        String(retrying.id),
        "succeeded",
      );

      const leasedStage = await stageChangeset(harness, launcher, projectId, [{
        op: "create",
        project_id: projectId,
        resource: "test/containeroutbox:item",
        fields: { key: "leased" },
      }]);
      assertEquals(leasedStage.raw.code, 0, leasedStage.raw.stderr);
      await ok(["--json", "changeset", "commit", leasedStage.data.id]);
      await waitProviderHold(provider, "lease-generation-0");
      assertProviderHoldActive(
        provider,
        "lease-generation-0",
        "unresolved-delivery",
      );
      const running = await waitOutboxStatus(
        launcher,
        "running",
        new Set([String(retrying.id)]),
      );
      const runningEvidence = await ok([
        "--json",
        "outbox",
        "inspect",
        String(running.id),
      ]);
      assertEquals(runningEvidence.status, "running");
      assertEquals(runningEvidence.retry_generation, 0);
      assertEquals(runningEvidence.attempts_in_generation, 1);
      assertEquals(runningEvidence.total_attempts, 1);
      assertProviderHoldActive(
        provider,
        "lease-generation-0",
        String(running.id),
      );
      const runningAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(running.id),
      ]);
      const runningAttempt = runningAttempts.items.find((attempt: {
        state: string;
      }) => attempt.state === "running");
      assertEquals(
        runningAttempt.id,
        runningEvidence.attempts_summary.latest.attempt_id,
      );
      assertEquals(runningAttempt.retry_generation, 0);
      assertEquals(runningAttempt.attempt_number, 1);
      assertEquals(runningAttempt.total_attempt_number, 1);
      assert(runningAttempt.lease_expires_at);
      const runningProviderAttempt = provider.attempts.filter((attempt) =>
        attempt.idempotencyKey === running.id
      ).at(-1);
      assert(runningProviderAttempt);
      assertEquals(
        JSON.parse(runningProviderAttempt.body).attempt_id,
        runningAttempt.id,
      );
      assertProviderHoldActive(
        provider,
        "lease-generation-0",
        String(running.id),
      );

      await harness.docker(["kill", harness.container]);
      await launcher.close().catch(() => undefined);
      launcher = undefined;
      await releaseActiveProviderHolds(provider);
      provider.enqueueForKeyNext(String(running.id), {
        kind: "hold",
        token: "lease-recovery-generation-1",
      });
      const attemptsAtLeaseRestart = provider.attempts.length;
      launcher = await restartOutboxContainer(harness, provider.url);
      await waitProviderHold(provider, "lease-recovery-generation-1");
      assertProviderHoldActive(
        provider,
        "lease-recovery-generation-1",
        String(running.id),
      );
      const recoveredProviderAttempt = provider.attempts.slice(
        attemptsAtLeaseRestart,
      ).find((attempt) => attempt.idempotencyKey === running.id);
      assert(recoveredProviderAttempt);
      assert(
        recoveredProviderAttempt.receivedAt >=
          new Date(String(runningAttempt.lease_expires_at)).getTime(),
      );
      const recoveredLease = await ok([
        "--json",
        "outbox",
        "inspect",
        String(running.id),
      ]);
      assertEquals(recoveredLease.status, "running");
      assertEquals(recoveredLease.retry_generation, 0);
      assertEquals(recoveredLease.attempts_in_generation, 2);
      assertEquals(recoveredLease.total_attempts, 2);
      assertProviderHoldActive(
        provider,
        "lease-recovery-generation-1",
        String(running.id),
      );
      const recoveredLeaseAttempts = await ok([
        "--json",
        "outbox",
        "attempts",
        String(running.id),
      ]);
      const activeLease = recoveredLeaseAttempts.items.find((attempt: {
        state: string;
      }) => attempt.state === "running");
      assert(
        activeLease,
        JSON.stringify({
          recovered_delivery: recoveredLease,
          recovered_attempts: recoveredLeaseAttempts,
          provider_attempt: recoveredProviderAttempt,
          active_holds: provider.activeHolds(),
        }),
      );
      assertEquals(
        activeLease.id,
        recoveredLease.attempts_summary.latest.attempt_id,
      );
      assertEquals(activeLease.retry_generation, 0);
      assertEquals(activeLease.attempt_number, 2);
      assertEquals(activeLease.total_attempt_number, 2);
      assert(activeLease.lease_expires_at);
      assertEquals(
        JSON.parse(recoveredProviderAttempt.body).attempt_id,
        activeLease.id,
      );
      assertProviderHoldActive(
        provider,
        "lease-recovery-generation-1",
        String(running.id),
      );
      provider.release("lease-recovery-generation-1");
      await waitOutboxDeliveryStatus(
        launcher,
        String(running.id),
        "succeeded",
      );

      for (
        const [delivery, totalAttempts] of [[retrying, 3], [
          running,
          2,
        ]] as const
      ) {
        const terminalEvidence = await ok([
          "--json",
          "outbox",
          "inspect",
          String(delivery.id),
        ]);
        assertEquals(terminalEvidence.status, "succeeded");
        assertEquals(terminalEvidence.retry_generation, 0);
        assertEquals(terminalEvidence.attempts_in_generation, totalAttempts);
        assertEquals(terminalEvidence.total_attempts, totalAttempts);
        assertEquals(
          terminalEvidence.attempts_summary.latest.outcome,
          "succeeded",
        );
        const sameDeliveryAttempts = provider.attempts.filter((attempt) =>
          attempt.idempotencyKey === delivery.id
        );
        assert(sameDeliveryAttempts.length >= 2);
        assertEquals(
          new Set(sameDeliveryAttempts.map((attempt) => attempt.idempotencyKey))
            .size,
          1,
        );
        assertEquals(
          provider.effects.filter((attempt) =>
            attempt.idempotencyKey === delivery.id
          ).length,
          1,
        );
      }
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
    const id = releaseScopedId(12);
    const malformedName = `optd-cr-bad-key-${id}`;
    const bindName = `optd-cr-bad-bind-${id}`;
    const goodBindName = `optd-cr-good-bind-${id}`;
    const root = await Deno.makeTempDir({
      prefix: "optd-container-unwritable-",
    });
    const anonymousVolumesBefore = await anonymousDockerVolumeIds();
    await Deno.chmod(root, 0o500);
    try {
      const malformed = await runCommand("docker", [
        "run",
        "--name",
        malformedName,
        "--env",
        "OPTD_BOOTSTRAP_TOKEN=not-logged",
        "--env",
        "OPTD_SECRET_MASTER_KEY=malformed",
        releaseImage,
      ], { timeoutMs: 60_000, allowFailure: true });
      assert(malformed.code !== 0);
      const malformedLogs = `${malformed.stdout}\n${malformed.stderr}`;
      assertStringIncludes(malformedLogs, "secret_master_key_invalid");
      assert(!malformedLogs.includes("not-logged"));
      assertEquals(
        (await containerAnonymousDockerVolumeIds(malformedName)).size,
        1,
      );

      const unwritable = await runCommand("docker", [
        "run",
        "--name",
        bindName,
        "--env",
        "OPTD_BOOTSTRAP_TOKEN=not-logged",
        "--env",
        "OPTD_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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
        "OPTD_BOOTSTRAP_TOKEN=bind-token",
        "--env",
        "OPTD_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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
        "-v",
        malformedName,
        bindName,
        goodBindName,
      ], {
        allowFailure: true,
      });
      await assertNoNewAnonymousDockerVolumes(
        anonymousVolumesBefore,
        "malformed key and unwritable data cleanup",
      );
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
    const id = releaseScopedId(12);
    const network = `optd-cr-net-${id}`;
    const pg = `optd-cr-pg-${id}`;
    const app = `optd-cr-ext-${id}`;
    const badPg = `optd-cr-pg16-${id}`;
    const badApp = `optd-cr-ext16-${id}`;
    const unreachableApp = `optd-cr-unreachable-${id}`;
    const badAuthApp = `optd-cr-bad-auth-${id}`;
    const token = "external-token-not-logged";
    const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const anonymousVolumesBefore = await anonymousDockerVolumeIds();
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
        "POSTGRES_USER=optd",
        "--env",
        "POSTGRES_DB=optd",
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
        `OPTD_DATABASE_URL=postgres://optd:external-pass@${pg}:5432/optd`,
        "--env",
        `OPTD_BOOTSTRAP_TOKEN=${token}`,
        "--env",
        `OPTD_SECRET_MASTER_KEY=${key}`,
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
        "POSTGRES_USER=optd",
        "--env",
        "POSTGRES_DB=optd",
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
        `OPTD_DATABASE_URL=postgres://optd:external-pass@${badPg}:5432/optd`,
        "--env",
        `OPTD_BOOTSTRAP_TOKEN=${token}`,
        "--env",
        `OPTD_SECRET_MASTER_KEY=${key}`,
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
            "postgres://optd:unreachable-secret@127.0.0.1:1/optd",
            "unreachable-secret",
          ],
          [
            badAuthApp,
            `postgres://optd:wrong-auth-secret@${pg}:5432/optd`,
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
          `OPTD_DATABASE_URL=${url}`,
          "--env",
          `OPTD_BOOTSTRAP_TOKEN=${token}`,
          "--env",
          `OPTD_SECRET_MASTER_KEY=${key}`,
          releaseImage,
        ], { allowFailure: true, timeoutMs: 30_000 });
        assert(failed.code !== 0);
        const failureLogs = `${failed.stdout}${failed.stderr}`;
        assertStringIncludes(failureLogs, '"mode":"external"');
        assert(!failureLogs.includes(credential));
        assert(!failureLogs.includes(token));
        await runCommand("docker", ["rm", "-f", "-v", name], {
          allowFailure: true,
        });
      }
    } finally {
      for (
        const candidate of [
          app,
          badApp,
          unreachableApp,
          badAuthApp,
          pg,
          badPg,
        ]
      ) {
        await runCommand("docker", ["rm", "-f", "-v", candidate], {
          allowFailure: true,
        });
      }
      await runCommand("docker", ["network", "rm", network], {
        allowFailure: true,
      });
      await assertNoNewAnonymousDockerVolumes(
        anonymousVolumesBefore,
        "external PostgreSQL cleanup",
      );
    }
  },
});

Deno.test({
  name:
    "container release: external PostgreSQL compose preserves database across Optd recreation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const releaseImage = await image();
    const id = releaseScopedId(10);
    const project = `optd-ext-${id}`;
    const version = `compose-${id}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = {
      ...Deno.env.toObject(),
      COMPOSE_PROJECT_NAME: project,
      OPTD_VERSION: version,
      OPTD_IMAGE: releaseImage,
      OPTD_RELEASE_GATE_ID: Deno.env.get("OPTD_RELEASE_GATE_ID") ??
        "standalone",
      OPTD_PORT: String(port),
      OPTD_POSTGRES_PASSWORD: `pg-${id}-password`,
      OPTD_BOOTSTRAP_TOKEN: `bootstrap-${id}`,
      OPTD_SECRET_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    };
    const compose = async (args: string[], allowFailure = false) =>
      await runCommand("docker", [
        "compose",
        "-f",
        "compose.external-postgres.yml",
        ...args,
      ], { timeoutMs: 180_000, allowFailure, env });
    const anonymousVolumesBefore = await anonymousDockerVolumeIds();
    try {
      await compose(["up", "-d", "--no-build"]);
      await waitHttpReady(port);
      const pgId = (await compose(["ps", "-q", "postgres"])).stdout.trim();
      const appId = (await compose(["ps", "-q", "optd"])).stdout.trim();
      const firstAppAnonymousVolumes = await containerAnonymousDockerVolumeIds(
        appId,
      );
      assertEquals(firstAppAnonymousVolumes.size, 0);
      const bootstrap = await compose([
        "exec",
        "-T",
        "optd",
        "sh",
        "-c",
        "printf '%s\\n' 'compose proof password' | OPTD_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json bootstrap init --username compose-admin --password-stdin && OPTD_AUTH_TREE_STOP_PID=$$ optctl --server http://127.0.0.1:8789 --json project create compose-fact --display-name 'Compose Persistent Fact'",
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
      await compose(["stop", "optd"]);
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
      await compose(["rm", "-f", "-v", "optd"]);
      await assertNoNewAnonymousDockerVolumes(
        anonymousVolumesBefore,
        "first Compose Optd removal",
      );
      await compose(["up", "-d", "--no-deps", "--no-build", "optd"]);
      await waitHttpReady(port);
      assertEquals(
        (await compose(["ps", "-q", "postgres"])).stdout.trim(),
        pgId,
      );
      const recreatedAppId = (await compose(["ps", "-q", "optd"]))
        .stdout.trim();
      assert(recreatedAppId !== appId);
      const recreatedAppAnonymousVolumes =
        await containerAnonymousDockerVolumeIds(recreatedAppId);
      assertEquals(recreatedAppAnonymousVolumes.size, 0);
      assertEquals(
        newAnonymousDockerVolumeIds(
          anonymousVolumesBefore,
          await anonymousDockerVolumeIds(),
        ),
        [...recreatedAppAnonymousVolumes].sort(),
      );
      const status = await fetch(
        `http://127.0.0.1:${port}/api/v1/auth/bootstrap/status`,
      ).then((response) => response.json());
      assertEquals(status.data.state, "active");
    } finally {
      await compose(["down", "--volumes", "--remove-orphans"], true);
      await assertNoNewAnonymousDockerVolumes(
        anonymousVolumesBefore,
        "Compose cleanup",
      );
      await assertNoNewAnonymousDockerVolumes(
        releaseExecutionAnonymousVolumesBefore,
        "complete container release execution",
      );
    }
  },
});

function releaseScopedId(randomLength: number): string {
  const gateId = Deno.env.get("OPTD_RELEASE_GATE_ID");
  const random = crypto.randomUUID().replaceAll("-", "").slice(
    0,
    randomLength,
  );
  return gateId ? `${gateId.slice(0, 12)}-${random}` : random;
}

async function anonymousDockerVolumeIds(): Promise<Set<string>> {
  const result = await runCommand("docker", [
    "volume",
    "ls",
    "--filter",
    "label=com.docker.volume.anonymous",
    "--quiet",
  ]);
  return new Set(
    result.stdout.split("\n").map((id) => id.trim()).filter(
      Boolean,
    ),
  );
}

async function containerAnonymousDockerVolumeIds(
  container: string,
): Promise<Set<string>> {
  const inspected = await runCommand("docker", [
    "inspect",
    container,
    "--format",
    "{{json .Mounts}}",
  ]);
  const mounts = JSON.parse(inspected.stdout) as Array<{
    Type: string;
    Name?: string;
  }>;
  const anonymous = await anonymousDockerVolumeIds();
  return new Set(
    mounts
      .filter((mount) =>
        mount.Type === "volume" && mount.Name && anonymous.has(mount.Name)
      )
      .map((mount) => mount.Name!),
  );
}

function newAnonymousDockerVolumeIds(
  before: Set<string>,
  after: Set<string>,
): string[] {
  return [...after].filter((id) => !before.has(id)).sort();
}

async function assertNoNewAnonymousDockerVolumes(
  before: Set<string>,
  context: string,
): Promise<void> {
  assertEquals(
    newAnonymousDockerVolumeIds(before, await anonymousDockerVolumeIds()),
    [],
    `${context} leaked anonymous Docker volume IDs`,
  );
}

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

async function waitOutboxStatus(
  launcher: ContainerCliLauncher,
  status: string,
  excludedIds = new Set<string>(),
): Promise<Record<string, unknown>> {
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
      const matched = items.find((item) =>
        item.status === status && !excludedIds.has(String(item.id))
      );
      if (matched) return matched;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `outbox status ${status} not reached: ${JSON.stringify(items)}`,
  );
}

async function waitOutboxDeliveryStatus(
  launcher: ContainerCliLauncher,
  id: string,
  status: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  let last: { code: number; stdout: string; stderr: string } | undefined;
  while (Date.now() < deadline) {
    last = await launcher.runOptctl([
      "--json",
      "outbox",
      "inspect",
      id,
    ]);
    if (last.code === 0) {
      const delivery = JSON.parse(last.stdout).data as Record<string, unknown>;
      if (delivery.status === status) return delivery;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `outbox delivery ${id} did not reach ${status}: ${JSON.stringify(last)}`,
  );
}

async function waitProviderHold(
  provider: ReturnType<typeof startHttpProvider>,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (provider.activeHolds().includes(token)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `provider hold ${token} was not reached: ${
      JSON.stringify({
        active_holds: provider.activeHolds(),
        attempts: provider.attempts.map((attempt) => ({
          id: attempt.id,
          idempotency_key: attempt.idempotencyKey,
          received_at: attempt.receivedAt,
          body: attempt.body,
        })),
      })
    }`,
  );
}

function assertProviderHoldActive(
  provider: ReturnType<typeof startHttpProvider>,
  token: string,
  deliveryId: string,
): void {
  assertEquals(
    provider.activeHolds().includes(token),
    true,
    JSON.stringify({
      expected_hold: token,
      delivery_id: deliveryId,
      active_holds: provider.activeHolds(),
      provider_attempts: provider.attempts.filter((attempt) =>
        deliveryId === "unresolved-delivery" ||
        attempt.idempotencyKey === deliveryId
      ).map((attempt) => ({
        id: attempt.id,
        idempotency_key: attempt.idempotencyKey,
        received_at: attempt.receivedAt,
        body: attempt.body,
      })),
    }),
  );
}

async function releaseActiveProviderHolds(
  provider: ReturnType<typeof startHttpProvider>,
): Promise<void> {
  for (let settled = 0; settled < 2;) {
    const active = provider.activeHolds();
    if (active.length === 0) settled++;
    else {
      settled = 0;
      for (const token of active) provider.release(token);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function restartOutboxContainer(
  harness: ContainerHarness,
  providerUrl: string,
): Promise<ContainerCliLauncher> {
  await harness.recreateAppManaged([
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    `OPTD_HOOK_NET_ALLOW=${new URL(providerUrl).host}`,
    "--env",
    "OPTD_OUTBOX_POLL_INTERVAL_MS=20",
    "--env",
    "OPTD_OUTBOX_BATCH_SIZE=2",
    "--env",
    "OPTD_OUTBOX_LEASE_MARGIN_MS=4000",
    "--env",
    "OPTD_OUTBOX_INITIAL_BACKOFF_MS=20",
    "--env",
    "OPTD_OUTBOX_MAX_BACKOFF_MS=100",
  ]);
  await harness.waitReady();
  const launcher = await harness.createProcessTreeLauncher();
  const login = await launcher.runOptctl([
    "--json",
    "auth",
    "login",
    "--username",
    "outbox-admin",
    "--password-stdin",
  ], "container outbox password\n");
  assertEquals(login.code, 0, login.stderr);
  return launcher;
}

async function writeContainerOutboxPack(root: string, providerUrl: string) {
  await Deno.mkdir(`${root}/resources`, { recursive: true });
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    "kind: Pack\napiVersion: optd.dev/v1\nmetadata: { publisher: test, name: containeroutbox, version: 1.0.0 }\nspec: { purpose: Container restart delivery proof., axi: {} }\n",
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    "kind: Resource\napiVersion: optd.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n  axi: {}\n",
  );
  const host = new URL(providerUrl).host;
  await Deno.writeTextFile(
    `${root}/hooks/deliver.yaml`,
    `kind: Hook\napiVersion: optd.dev/v1\nmetadata: { name: deliver }\nspec:\n  script: deliver.ts\n  timeout: 30s\n  permissions: { net: [${host}], env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: delivery.v1 }\n  attachments:\n    - phase: event.after_commit\n      event: object.created\n      order: 10\n      condition: 'event_type == "object.created"'\n      input: { event: '$event' }\n  axi: {}\n`,
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
      "optd",
      "-d",
      "optd",
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
