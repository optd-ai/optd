import { makeApplication } from "./application/app.ts";
import { loadRuntimeConfig, OPERANT_VERSION } from "./config/runtime.ts";
import { makeHttpApp } from "./adapters/inbound/http-hono/app.ts";
import {
  closePostgresClient,
  createPostgresClient,
  pingPostgres,
  type Sql,
} from "./adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
  inspectMigrationStatus,
  type MigrationApplyResult,
  type MigrationStatus,
} from "./adapters/outbound/postgres/migrations.ts";
import { assertSecretSubsystemReady } from "./application/services/secrets/manage_secrets.ts";
import { resolveHookDenoBinary } from "./adapters/outbound/deno-hooks/hook_runner.ts";
import {
  type PostgresRuntime,
  startPostgresRuntime,
} from "./adapters/outbound/postgres-process/lifecycle.ts";

export type StartedServer = {
  url: string;
  sql: Sql;
  shutdown(): Promise<void>;
};

export async function createFetchHandler(
  options: { hookServerPort?: number; hookServerHosts?: string[] } = {},
) {
  const postgresRuntime = await startPostgresRuntime();
  const sql = createPostgresClient(postgresRuntime.databaseUrl);
  let migrationResult: MigrationApplyResult;
  let denoBin: string;
  try {
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
      await application.authentication.close();
      await closePostgresClient(sql);
      await postgresRuntime.stop();
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

if (
  import.meta.main && Deno.args[0] === "auth" && Deno.args[1] === "recovery"
) {
  await runRecoveryHostCommand(Deno.args);
} else if (import.meta.main) {
  const config = loadRuntimeConfig();
  const server = await startServer({
    hostname: config.host,
    port: config.port,
    onListen: (url) => {
      console.log(
        JSON.stringify({ ok: true, listening: url, version: OPERANT_VERSION }),
      );
    },
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
    await server.shutdown();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
}
