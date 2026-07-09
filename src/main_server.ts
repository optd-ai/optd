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
import {
  type PostgresRuntime,
  startPostgresRuntime,
} from "./adapters/outbound/postgres-process/lifecycle.ts";

export type StartedServer = {
  url: string;
  sql: Sql;
  shutdown(): Promise<void>;
};

export async function createFetchHandler() {
  const postgresRuntime = await startPostgresRuntime();
  const sql = createPostgresClient(postgresRuntime.databaseUrl);
  const application = makeApplication(sql);
  let migrationResult: MigrationApplyResult;
  try {
    migrationResult = await sql.begin(async (tx) =>
      await applyPlatformMigrations(tx)
    );
  } catch (error) {
    await closePostgresClient(sql).catch(() => undefined);
    await postgresRuntime.stop().catch(() => undefined);
    throw error;
  }
  const app = makeHttpApp({
    metadata: application.metadata,
    packs: application.packs,
    health: makeHealthService(sql, postgresRuntime, migrationResult),
    version: OPERANT_VERSION,
  });
  return {
    fetch: app.fetch,
    sql,
    async shutdown() {
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
  const handler = await createFetchHandler();
  const server = Deno.serve({
    hostname,
    port,
    signal: controller.signal,
    onListen: ({ hostname: actualHost, port: actualPort }) => {
      const url = `http://${actualHost}:${actualPort}`;
      options.onListen?.(url);
    },
  }, handler.fetch);
  const addr = server.addr as Deno.NetAddr;
  const url = `http://${addr.hostname}:${addr.port}`;
  return {
    url,
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

if (import.meta.main) {
  const config = loadRuntimeConfig();
  await startServer({
    hostname: config.host,
    port: config.port,
    onListen: (url) => {
      console.log(
        JSON.stringify({ ok: true, listening: url, version: OPERANT_VERSION }),
      );
    },
  });
}
