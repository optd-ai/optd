import { makeApplication } from "./composition/application.ts";
import { loadRuntimeConfig, OPERANT_VERSION } from "./config/runtime.ts";
import { makeHttpApp } from "./adapters/inbound/http-hono/app.ts";
import {
  closePostgresClient,
  createPostgresClient,
  pingPostgres,
  query,
  type Sql,
} from "./adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
  inspectMigrationStatus,
  type MigrationApplyResult,
  type MigrationStatus,
} from "./adapters/outbound/postgres/migrations.ts";
import { assertSecretSubsystemReady } from "./adapters/outbound/use-cases/secrets/manage_secrets.ts";
import { resolveHookDenoBinary } from "./adapters/outbound/deno-hooks/hook_runner.ts";
import {
  assertSupportedPostgresVersionNumber,
  type PostgresRuntime,
  startPostgresRuntime,
} from "./adapters/outbound/postgres-process/lifecycle.ts";
import { startOutboxPollLoop } from "./application/services/outbox/poll_loop.ts";

export type StartedServer = {
  url: string;
  sql: Sql;
  shutdown(): Promise<void>;
};

export async function createFetchHandler(
  options: { hookServerPort?: number; hookServerHosts?: string[] } = {},
) {
  const postgresRuntime = await startPostgresRuntime();
  console.log(JSON.stringify({
    event: "runtime_started",
    mode: postgresRuntime.mode,
  }));
  const sql = createPostgresClient(postgresRuntime.databaseUrl);
  let migrationResult: MigrationApplyResult;
  let denoBin: string;
  try {
    const version = await query<{ server_version_num: string }>(
      sql,
      "select current_setting('server_version_num') as server_version_num",
    );
    const postgresMajor = assertSupportedPostgresVersionNumber(
      version.rows[0]?.server_version_num ?? "",
    );
    console.log(JSON.stringify({
      event: "database_validated",
      mode: postgresRuntime.mode,
      postgresMajor,
    }));
    migrationResult = await sql.begin(async (tx) =>
      await applyPlatformMigrations(tx)
    );
    await assertSecretSubsystemReady(sql);
    denoBin = await resolveHookDenoBinary();
  } catch (error) {
    await closePostgresClient(sql).catch(() => undefined);
    await postgresRuntime.stop().catch(() => undefined);
    throw error;
  }
  const database = new URL(postgresRuntime.databaseUrl);
  const databasePort = database.port || "5432";
  const application = makeApplication(sql, {
    bootstrapToken: Deno.env.get("OPERANT_BOOTSTRAP_TOKEN"),
    hookRunnerOptions: {
      denoBin,
      serverPort: options.hookServerPort ??
        Number(Deno.env.get("OPERANT_SERVER_PORT") ?? "8789"),
      serverHosts: options.hookServerHosts,
      databaseEndpoints: databaseHostAliases(database.hostname).map((host) =>
        `${host}:${databasePort}`
      ),
    },
  });
  const outboxLoop = startOutboxPollLoop(
    () => application.outbox.processBatch(),
    {
      intervalMs: application.outbox.config.pollIntervalMs,
      shutdownGraceMs: application.outbox.config.shutdownGraceMs,
    },
  );
  const app = makeHttpApp({
    authentication: application.authentication,
    bootstrap: application.bootstrap,
    humanAuth: application.humanAuth,
    agentAuth: application.agentAuth,
    projects: application.projects,
    authorization: application.authorization,
    metadata: application.metadata,
    objectReads: application.objectReads,
    packs: application.packs,
    migrations: application.migrations,
    expressions: application.expressions,
    queries: application.queries,
    actions: application.actions,
    seeds: application.seeds,
    changesets: application.changesets,
    outbox: application.outbox,
    secrets: application.secrets,
    hookSecretGrants: application.hookSecretGrants,
    health: makeHealthService(sql, postgresRuntime, migrationResult),
    version: OPERANT_VERSION,
  });
  return {
    fetch: app.fetch,
    sql,
    async shutdown() {
      console.log(JSON.stringify({
        event: "runtime_stopping",
        mode: postgresRuntime.mode,
      }));
      await outboxLoop.stop();
      await application.authentication.close();
      await closePostgresClient(sql);
      await postgresRuntime.stop();
      console.log(JSON.stringify({
        event: "runtime_stopped",
        mode: postgresRuntime.mode,
      }));
    },
  };
}

export async function startServer(
  options: {
    hostname?: string;
    port?: number;
    onListen?: (url: string) => void;
  } = {},
): Promise<StartedServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8789;
  const controller = new AbortController();
  if (port !== 0) {
    const handler = await createFetchHandler({
      hookServerPort: port,
      hookServerHosts: databaseHostAliases(hostname),
    });
    const server = Deno.serve({
      hostname,
      port,
      signal: controller.signal,
      onListen: ({ hostname: actualHost, port: actualPort }) => {
        options.onListen?.(`http://${actualHost}:${actualPort}`);
      },
    }, handler.fetch);
    const addr = server.addr as Deno.NetAddr;
    return {
      url: `http://${addr.hostname}:${addr.port}`,
      sql: handler.sql,
      async shutdown() {
        controller.abort();
        await server.finished.catch((error) => {
          if (!(error instanceof Deno.errors.Interrupted)) throw error;
        });
        await handler.shutdown();
      },
    };
  }

  let handler: Awaited<ReturnType<typeof createFetchHandler>> | undefined;
  let resolveHandler:
    | ((value: Awaited<ReturnType<typeof createFetchHandler>>) => void)
    | undefined;
  let rejectHandler: ((reason: unknown) => void) | undefined;
  const ready = new Promise<Awaited<ReturnType<typeof createFetchHandler>>>(
    (resolve, reject) => {
      resolveHandler = resolve;
      rejectHandler = reject;
    },
  );
  const server = Deno.serve({
    hostname,
    port,
    signal: controller.signal,
    onListen: ({ hostname: actualHost, port: actualPort }) => {
      const url = `http://${actualHost}:${actualPort}`;
      options.onListen?.(url);
    },
  }, async (request) => await (handler ?? await ready).fetch(request));
  const addr = server.addr as Deno.NetAddr;
  const url = `http://${addr.hostname}:${addr.port}`;
  try {
    handler = await createFetchHandler({
      hookServerPort: addr.port,
      hookServerHosts: databaseHostAliases(addr.hostname),
    });
    resolveHandler?.(handler);
  } catch (error) {
    rejectHandler?.(error);
    controller.abort();
    await server.finished.catch(() => undefined);
    throw error;
  }
  return {
    url,
    sql: handler.sql,
    async shutdown() {
      controller.abort();
      await server.finished.catch((error) => {
        if (!(error instanceof Deno.errors.Interrupted)) throw error;
      });
      await handler!.shutdown();
    },
  };
}

function databaseHostAliases(host: string): string[] {
  const aliases = new Set([host]);
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)) {
    for (
      const alias of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]
    ) {
      aliases.add(alias);
    }
  }
  return [...aliases].sort();
}

function makeHealthService(
  sql: Sql,
  postgresRuntime: PostgresRuntime,
  migrationResult: MigrationApplyResult,
) {
  return {
    async inspect() {
      const [dbOk, migrations] = await Promise.all([
        pingPostgres(sql).catch(() => false),
        inspectMigrationStatus(sql).catch((): MigrationStatus => ({
          ok: false,
          appliedCount: 0,
          latestId: null,
        })),
      ]);
      return {
        status: dbOk && migrations.ok ? "ready" : "degraded",
        database: {
          ok: dbOk,
          mode: postgresRuntime.mode,
        },
        migrations: {
          ...migrations,
          appliedThisStart: migrationResult.applied,
        },
      };
    },
  };
}

async function runRecoveryHostCommand(args: string[]): Promise<void> {
  const runtime = await startPostgresRuntime();
  const sql = createPostgresClient(runtime.databaseUrl);
  try {
    await sql.begin(async (tx) => await applyPlatformMigrations(tx));
    const application = makeApplication(sql);
    const action = args[2];
    const usernameIndex = args.indexOf("--username");
    const username = usernameIndex >= 0 ? args[usernameIndex + 1] : undefined;
    if (!username || (action !== "begin" && action !== "cancel")) {
      throw new Error(
        "usage: operant auth recovery begin|cancel --username <username>",
      );
    }
    const result = action === "begin"
      ? await application.authentication.beginRecovery({
        username,
        token: Deno.env.get("OPERANT_RECOVERY_TOKEN") ?? "",
        enableUser: args.includes("--enable-user"),
        restoreSuperAdmin: args.includes("--restore-super-admin"),
        replace: args.includes("--replace"),
      })
      : await application.authentication.cancelRecovery(username);
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    console.log(JSON.stringify({ ok: true, data: result.value }));
  } finally {
    await closePostgresClient(sql);
    await runtime.stop();
  }
}

async function runMain(): Promise<void> {
  // Deno.execPath() is the compiled executable inside the release image. The
  // password worker intentionally uses Deno.execPath(), so relay that one
  // internal `deno run` invocation to the locked runtime Deno binary.
  if (
    Deno.args[0] === "run" &&
    Deno.args.at(-1)?.endsWith("/auth_password_worker.ts")
  ) {
    const denoBin = Deno.env.get("OPERANT_DENO_BIN");
    const worker = Deno.env.get("OPERANT_AUTH_PASSWORD_WORKER");
    if (!denoBin || !worker) {
      throw new Error("compiled password worker runtime is not configured");
    }
    const args = [...Deno.args];
    args[args.length - 1] = worker;
    const status = await new (Deno.Command)(denoBin, {
      args,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn().status;
    Deno.exit(status.code);
  }

  if (Deno.args[0] === "auth" && Deno.args[1] === "recovery") {
    await runRecoveryHostCommand(Deno.args);
    return;
  }

  const config = loadRuntimeConfig();
  const server = await startServer({
    hostname: config.host,
    port: config.port,
    onListen: (url) => {
      console.log(
        JSON.stringify({
          ok: true,
          event: "server_listening",
          listening: url,
          version: OPERANT_VERSION,
        }),
      );
    },
  });
  let stopping = false;
  const stop = async (signal: "SIGTERM" | "SIGINT") => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ event: "shutdown_requested", signal }));
    Deno.removeSignalListener("SIGTERM", onTerm);
    Deno.removeSignalListener("SIGINT", onInt);
    try {
      // The listener is aborted before the poll loop, auth listener, SQL pool,
      // and (only in app-managed mode) Postgres are closed by startServer.
      await server.shutdown();
      console.log(JSON.stringify({ event: "shutdown_complete", signal }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "shutdown_failed",
        error: redactedError(error),
      }));
      Deno.exitCode = 1;
    }
  };
  const onTerm = () => void stop("SIGTERM");
  const onInt = () => void stop("SIGINT");
  Deno.addSignalListener("SIGTERM", onTerm);
  Deno.addSignalListener("SIGINT", onInt);
}

function redactedError(
  error: unknown,
): { name: string; code?: string; message: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  let message = value.message.slice(0, 1000).replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    "[redacted-database-url]",
  );
  for (
    const secret of [
      Deno.env.get("OPERANT_DATABASE_URL"),
      Deno.env.get("OPERANT_BOOTSTRAP_TOKEN"),
      Deno.env.get("OPERANT_SECRET_MASTER_KEY"),
    ]
  ) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  const code = "code" in value && typeof value.code === "string"
    ? value.code
    : undefined;
  return { name: value.name, ...code ? { code } : {}, message };
}

if (import.meta.main) {
  try {
    await runMain();
  } catch (error) {
    console.error(JSON.stringify({
      event: "startup_failed",
      error: redactedError(error),
    }));
    Deno.exit(1);
  }
}
