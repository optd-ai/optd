import { Command } from "jsr:@cliffy/command";
import { formatToon } from "../../outbound/toon/format.ts";

export type OptctlRunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type HomeOptions = {
  json?: boolean;
  server?: string;
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function render(value: unknown, asJson?: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : formatToon(value);
}

export async function runOptctl(args: string[]): Promise<OptctlRunResult> {
  let stdout = "";
  let stderr = "";
  let code = 0;

  const command = new Command()
    .name("optctl")
    .description("Operant control CLI")
    .globalOption("--server <url:string>", "Operant server URL", {
      default: "http://127.0.0.1:8789",
    })
    .command("home", "Show agent-friendly platform home metadata")
    .option("--json", "Output JSON instead of TOON")
    .option("--server <url:string>", "Operant server URL")
    .action(async (options: HomeOptions, parentOptions?: HomeOptions) => {
      const server =
        (options.server ?? parentOptions?.server ?? "http://127.0.0.1:8789")
          .replace(/\/$/, "");
      const value = await getJson(`${server}/metadata/home`);
      stdout = render(value, options.json);
    });

  try {
    await command.parse(args);
  } catch (error) {
    code = 1;
    stderr = error instanceof Error ? error.message : String(error);
  }

  return { stdout, stderr, code };
}
