import { assertEquals } from "jsr:@std/assert";
import { type StartedServer, startServer } from "../../src/main_server.ts";

export type LiveHarness = {
  dataDir: string;
  server: StartedServer;
  baseUrl: string;
  runOptctl(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
};

export async function startLiveHarness(): Promise<LiveHarness> {
  const dataDir = await Deno.makeTempDir({ prefix: "operant-scenario-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", dataDir);
  const server = startServer({ hostname: "127.0.0.1", port: 0 });

  async function runOptctl(args: string[]) {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "src/main_optctl.ts",
        "--server",
        server.url,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  }

  return {
    dataDir,
    server,
    baseUrl: server.url,
    runOptctl,
    async close() {
      await server.shutdown();
      if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
      else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
    },
  };
}

export async function assertHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/health`);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.data.status, "ready");
  return body;
}
