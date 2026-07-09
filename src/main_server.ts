import { makeApplication } from "./application/app.ts";
import { loadRuntimeConfig, OPERANT_VERSION } from "./config/runtime.ts";
import { makeHttpApp } from "./adapters/inbound/http-hono/app.ts";

export type StartedServer = {
  url: string;
  shutdown(): Promise<void>;
};

export function createFetchHandler() {
  const application = makeApplication();
  const app = makeHttpApp({
    metadata: application.metadata,
    version: OPERANT_VERSION,
  });
  return app.fetch;
}

export function startServer(
  options: {
    hostname?: string;
    port?: number;
    onListen?: (url: string) => void;
  } = {},
): StartedServer {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8789;
  const controller = new AbortController();
  const handler = createFetchHandler();
  const server = Deno.serve({
    hostname,
    port,
    signal: controller.signal,
    onListen: ({ hostname: actualHost, port: actualPort }) => {
      const url = `http://${actualHost}:${actualPort}`;
      options.onListen?.(url);
    },
  }, handler);
  const addr = server.addr as Deno.NetAddr;
  const url = `http://${addr.hostname}:${addr.port}`;
  return {
    url,
    async shutdown() {
      controller.abort();
      await server.finished.catch((error) => {
        if (!(error instanceof Deno.errors.Interrupted)) throw error;
      });
    },
  };
}

if (import.meta.main) {
  const config = loadRuntimeConfig();
  startServer({
    hostname: config.host,
    port: config.port,
    onListen: (url) => {
      console.log(
        JSON.stringify({ ok: true, listening: url, version: OPERANT_VERSION }),
      );
    },
  });
}
