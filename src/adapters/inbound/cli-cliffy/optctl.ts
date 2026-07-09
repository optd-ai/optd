import { Command } from "jsr:@cliffy/command";
import { walk } from "jsr:@std/fs/walk";
import { relative } from "jsr:@std/path";
import { formatToon } from "../../outbound/toon/format.ts";

export type OptctlRunResult = { stdout: string; stderr: string; code: number };
type Parsed = { server: string; json: boolean; positional: string[] };

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
async function postMultipart(url: string, packDir: string): Promise<unknown> {
  const form = new FormData();
  for await (
    const entry of walk(packDir, { includeDirs: false, followSymlinks: false })
  ) {
    const rel = relative(packDir, entry.path).replaceAll("\\", "/");
    if (rel.startsWith(".git/") || rel === ".DS_Store") continue;
    if (!rel.endsWith(".yaml") && !rel.endsWith(".ts")) continue;
    form.append(rel, new File([await Deno.readFile(entry.path)], rel));
  }
  const response = await fetch(url, { method: "POST", body: form });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}
function render(value: unknown, asJson?: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : formatToon(value);
}
function splitDotted(id: string): [string, string] {
  const parts = id.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected dotted identifier namespace.name, got ${id}`);
  }
  return [parts[0], parts[1]];
}
function parse(args: string[]): Parsed {
  const parsed: Parsed = {
    server: "http://127.0.0.1:8789",
    json: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--server") parsed.server = args[++i] ?? parsed.server;
    else if (arg.startsWith("--server=")) {
      parsed.server = arg.slice("--server=".length);
    } else parsed.positional.push(arg);
  }
  parsed.server = parsed.server.replace(/\/$/, "");
  return parsed;
}

function helpText(): string {
  return new Command()
    .name("optctl")
    .description("Operant control CLI")
    .getHelp();
}

export async function runOptctl(args: string[]): Promise<OptctlRunResult> {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      return { stdout: helpText(), stderr: "", code: 0 };
    }
    const parsed = parse(args);
    const [cmd, sub, value] = parsed.positional;
    let result: unknown;
    if (cmd === "home") {
      result = await getJson(`${parsed.server}/metadata/home`);
    } else if (cmd === "pack" && sub === "preview" && value) {
      result = await postMultipart(`${parsed.server}/packs/preview`, value);
    } else if (cmd === "pack" && sub === "apply" && value) {
      result = await postMultipart(`${parsed.server}/packs/apply`, value);
    } else if (cmd === "metadata" && sub && value) {
      const [namespace, name] = splitDotted(value);
      const routeKind = ({
        resource: "resources",
        action: "actions",
        hook: "hooks",
        policy: "policies",
      } as Record<string, string>)[sub];
      if (!routeKind) throw new Error(`unknown metadata kind ${sub}`);
      result = await getJson(
        `${parsed.server}/metadata/${routeKind}/${namespace}/${name}`,
      );
    } else {
      throw new Error(
        "usage: optctl home | pack preview/apply <dir> | metadata resource/action/hook/policy <namespace.name>",
      );
    }
    return { stdout: render(result, parsed.json), stderr: "", code: 0 };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    };
  }
}
