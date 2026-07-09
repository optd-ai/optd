type Json = Record<string, unknown>;

type Cli = {
  server: string;
  args: string[];
};

export async function main(argv = Deno.args) {
  try {
    const cli = parseGlobal(argv);
    const [group, command, ...rest] = cli.args;
    if (!group || group === "help" || group === "--help" || group === "-h") {
      return print(help());
    }
    if (group === "home") {
      return print(toon(await get(cli.server, "/metadata/home")));
    }
    if (group === "metadata") {
      const kind = required(command, "metadata requires a kind");
      const name = rest[0];
      if (!name && kind === "packs") {
        return print(toon(await get(cli.server, "/metadata/packs")));
      }
      const id = required(name, `metadata ${kind} requires a name`);
      const parsed = parseDotted(id);
      return print(
        toon(
          await get(
            cli.server,
            `/metadata/${metadataKindPath(kind)}/${parsed.namespace}/${parsed.name}`,
          ),
        ),
      );
    }
    if (group === "pack" && command === "apply") {
      const packDir = required(rest[0], "pack apply requires a pack directory");
      return print(toon(await packApply(cli.server, packDir)));
    }
    if (group === "query") {
      const resource = required(command, "query requires a resource");
      const flags = parseFlags(rest);
      return print(
        toon(await query(cli.server, resourceName(resource), flags)),
      );
    }
    if (group === "changeset" && command === "commit") {
      const flags = parseFlags(rest);
      const file = required(
        String(flags.file ?? ""),
        "changeset commit requires --file <path>",
      );
      const payload = JSON.parse(await Deno.readTextFile(file));
      return print(toon(await post(cli.server, "/changesets/commit", payload)));
    }
    if (group === "action" && (command === "preview" || command === "commit")) {
      const action = required(
        rest[0],
        `action ${command} requires an action name`,
      );
      const flags = parseFlags(rest.slice(1));
      const input = flags.input ? JSON.parse(String(flags.input)) : {};
      const payload = { actor_id: flags.actor ?? "agent", input };
      return print(
        toon(
          await post(
            cli.server,
            `/actions/${resourceName(action)}/${command}`,
            payload,
          ),
        ),
      );
    }
    if (group === "history") {
      const resource = required(command, "history requires a resource");
      const id = required(rest[0], "history requires an object id");
      return print(
        toon(
          await get(
            cli.server,
            `/history/${resourceName(resource)}/${encodeURIComponent(id)}`,
          ),
        ),
      );
    }
    throw new Error(`unknown command: ${cli.args.join(" ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(toon({ ok: false, error: { code: "cli_error", message } }));
    return 1;
  }
}

function print(text: string) {
  console.log(text);
  return 0;
}

async function packApply(server: string, packDir: string) {
  const form = new FormData();
  for await (const path of walk(packDir)) {
    const rel = path.slice(packDir.replace(/\/$/, "").length + 1);
    form.append(rel, new File([await Deno.readTextFile(path)], rel));
  }
  const response = await fetch(`${server}/packs/apply`, {
    method: "POST",
    body: form,
  });
  return await readResponse(response);
}

async function query(server: string, resource: string, flags: Json) {
  const fields = typeof flags.fields === "string"
    ? String(flags.fields).split(",").filter(Boolean)
    : undefined;
  return await post(server, "/queries", {
    resource,
    filter: flags.where ?? flags.filter ?? "active()",
    fields,
    limit: flags.limit ? Number(flags.limit) : 20,
  });
}

async function post(server: string, path: string, body: unknown) {
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readResponse(response);
}

async function get(server: string, path: string) {
  const response = await fetch(`${server}${path}`);
  return await readResponse(response);
}

async function readResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) {
    return { ok: false, status: response.status, response: body };
  }
  return body;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    if (entry.isFile) yield path;
  }
}

function parseGlobal(argv: string[]): Cli {
  const args = [...argv];
  let server = "http://127.0.0.1:8789";
  for (let i = 0; i < args.length;) {
    if (args[i] === "--server") {
      server = required(args[i + 1], "--server requires a URL");
      args.splice(i, 2);
      continue;
    }
    i++;
  }
  return { server: server.replace(/\/$/, ""), args };
}

function parseFlags(args: string[]): Json {
  const flags: Json = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replaceAll("-", "_");
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function resourceName(dotted: string) {
  return parseDotted(dotted).name;
}

function parseDotted(dotted: string) {
  const parts = dotted.split(".");
  return parts.length === 2
    ? { namespace: parts[0], name: parts[1] }
    : { namespace: "default", name: parts[0] };
}

function metadataKindPath(kind: string) {
  if (kind === "resource") return "resources";
  if (kind === "action") return "actions";
  if (kind === "hook") return "hooks";
  if (kind === "policy") return "policies";
  throw new Error(`unknown metadata kind ${kind}`);
}

function required(value: string | undefined, message: string) {
  if (!value) throw new Error(message);
  return value;
}

export function toon(value: unknown): string {
  return renderValue(value, 0).replace(/\n+$/, "");
}

function renderValue(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]\n";
    return value.map((item) => {
      if (isScalar(item)) return `${pad}- ${scalar(item)}\n`;
      const rendered = renderValue(item, indent + 1);
      return `${pad}- ${rendered.trimStart()}`;
    }).join("");
  }
  if (value && typeof value === "object") {
    let out = "";
    for (const [key, child] of Object.entries(value as Json)) {
      if (Array.isArray(child)) {
        if (child.length === 0) out += `${pad}${key}: []\n`;
        else {out += `${pad}${key}[${child.length}]:\n${
            renderValue(child, indent + 1)
          }`;}
      } else if (isScalar(child)) {
        out += `${pad}${key}: ${scalar(child)}\n`;
      } else {
        out += `${pad}${key}:\n${renderValue(child, indent + 1)}`;
      }
    }
    return out;
  }
  return `${pad}${scalar(value)}\n`;
}

function isScalar(value: unknown) {
  return value === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof value);
}

function scalar(value: unknown) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") {
    return needsQuote(value) ? JSON.stringify(value) : value;
  }
  return String(value);
}

function needsQuote(value: string) {
  return value === "" || /[:\[\]{},#\n]|^\s|\s$/.test(value);
}

function help() {
  return `optctl prototype

commands:
  optctl --server http://127.0.0.1:8789 home
  optctl --server http://127.0.0.1:8789 metadata resource default.lead
  optctl --server http://127.0.0.1:8789 pack apply prototypes/crm-default-pack
  optctl --server http://127.0.0.1:8789 query default.lead --where 'status == "new" && active()' --fields id,name,email,status
  optctl --server http://127.0.0.1:8789 changeset commit --file change.json
  optctl --server http://127.0.0.1:8789 action preview default.convert_lead --input '{"lead_id":"lead_ada"}'
  optctl --server http://127.0.0.1:8789 action commit default.convert_lead --input '{"lead_id":"lead_ada"}'
  optctl --server http://127.0.0.1:8789 history default.lead lead_ada`;
}

if (import.meta.main) Deno.exit(await main());
