import { Command } from "jsr:@cliffy/command";
import { walk } from "jsr:@std/fs/walk";
import { relative } from "jsr:@std/path";
import { formatToon } from "../../outbound/toon/format.ts";
import {
  type ErrorEnvelope,
  errorEnvelope,
} from "../../../schemas/api/contracts.ts";

export type OptctlRunResult = { stdout: string; stderr: string; code: number };
type Parsed = {
  server: string;
  json: boolean;
  verbose: boolean;
  positional: string[];
};
class OptctlError extends Error {
  constructor(readonly envelope: ErrorEnvelope, readonly exitCode = 1) {
    super(envelope.error.message);
  }
}

async function decodeJsonResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw httpError(response.status, body);
  }
  return body;
}
async function getJson(url: string): Promise<unknown> {
  return await decodeJsonResponse(await fetch(url));
}
async function postJson(url: string, payload: unknown): Promise<unknown> {
  return await decodeJsonResponse(
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
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
  return await decodeJsonResponse(
    await fetch(url, { method: "POST", body: form }),
  );
}
function render(value: unknown, asJson?: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : formatToon(value);
}
async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}
function splitDotted(id: string): [string, string] {
  const parts = id.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw usageError(`expected dotted identifier namespace.name, got ${id}`);
  }
  return [parts[0], parts[1]];
}
function parse(args: string[]): Parsed {
  const parsed: Parsed = {
    server: "http://127.0.0.1:8789",
    json: false,
    verbose: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--verbose" || arg === "-v") parsed.verbose = true;
    else if (arg === "--server") parsed.server = args[++i] ?? parsed.server;
    else if (arg.startsWith("--server=")) {
      parsed.server = arg.slice("--server=".length);
    } else parsed.positional.push(arg);
  }
  parsed.server = parsed.server.replace(/\/$/, "");
  return parsed;
}

function parseQueryPayload(
  resource: string,
  args: string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = { resource };
  const fields: string[] = [];
  const sort: Array<{ field: string; direction: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--where" || arg === "--filter") payload.where = next();
    else if (arg.startsWith("--where=")) {
      payload.where = arg.slice("--where=".length);
    } else if (arg === "--field") {
      fields.push(...next().split(",").filter(Boolean));
    } else if (arg.startsWith("--field=")) {
      fields.push(...arg.slice("--field=".length).split(",").filter(Boolean));
    } else if (arg === "--fields") {
      fields.push(...next().split(",").filter(Boolean));
    } else if (arg.startsWith("--fields=")) {
      fields.push(...arg.slice("--fields=".length).split(",").filter(Boolean));
    } else if (arg === "--sort") sort.push(parseSortArg(next()));
    else if (arg.startsWith("--sort=")) {
      sort.push(parseSortArg(arg.slice("--sort=".length)));
    } else if (arg === "--limit") payload.limit = Number(next());
    else if (arg.startsWith("--limit=")) {
      payload.limit = Number(arg.slice("--limit=".length));
    } else if (arg === "--cursor") payload.cursor = next();
    else if (arg.startsWith("--cursor=")) {
      payload.cursor = arg.slice("--cursor=".length);
    } else if (arg === "--include-archived") payload.include_archived = true;
    else if (arg === "--actor") payload.actor = parseActorArg(next());
    else if (arg.startsWith("--actor=")) {
      payload.actor = parseActorArg(arg.slice("--actor=".length));
    } else throw usageError(`unknown query option ${arg}`);
  }
  if (fields.length) payload.fields = fields;
  if (sort.length) payload.sort = sort;
  return payload;
}
function parseSortArg(value: string): { field: string; direction: string } {
  const [field, direction = "asc"] = value.split(":");
  return { field, direction };
}
function httpError(status: number, body: unknown): OptctlError {
  if (isErrorEnvelope(body)) return new OptctlError(body, 1);
  return new OptctlError(
    errorEnvelope({
      code: `http_${status}`,
      message: `HTTP ${status}`,
      details: { status },
    }),
    1,
  );
}

function usageError(message: string): OptctlError {
  return new OptctlError(
    errorEnvelope({
      code: "usage_error",
      message,
      details: {
        help: [
          "optctl --help",
          "optctl home",
          "optctl metadata resource <namespace.resource>",
        ],
      },
    }),
    2,
  );
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== false || !envelope.error || !envelope.meta) return false;
  const error = envelope.error as Record<string, unknown>;
  const meta = envelope.meta as Record<string, unknown>;
  return typeof error.code === "string" &&
    typeof error.message === "string" &&
    error.details !== null && typeof error.details === "object" &&
    !Array.isArray(error.details) && typeof meta.request_id === "string";
}

function parseActorArg(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  if (trimmed.includes(":")) {
    const [id, roles = ""] = trimmed.split(":");
    return { id, roles: roles.split(",").filter(Boolean) };
  }
  return value;
}
function parseActionPayload(args: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = { input: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--input") payload.input = JSON.parse(next());
    else if (arg.startsWith("--input=")) {
      payload.input = JSON.parse(arg.slice("--input=".length));
    } else if (arg === "--input-file") payload.input_file = next();
    else if (arg.startsWith("--input-file=")) {
      payload.input_file = arg.slice("--input-file=".length);
    } else if (arg === "--actor") payload.actor = parseActorArg(next());
    else if (arg.startsWith("--actor=")) {
      payload.actor = parseActorArg(arg.slice("--actor=".length));
    } else if (arg === "--idempotency-key") payload.idempotency_key = next();
    else if (arg.startsWith("--idempotency-key=")) {
      payload.idempotency_key = arg.slice("--idempotency-key=".length);
    } else throw usageError(`unknown action option ${arg}`);
  }
  return payload;
}
async function resolveActionPayload(
  args: string[],
): Promise<Record<string, unknown>> {
  const payload = parseActionPayload(args);
  if (typeof payload.input_file === "string") {
    payload.input = await readJsonFile(payload.input_file);
    delete payload.input_file;
  }
  return payload;
}

function appendActorQuery(base: string, args: string[]): string {
  const index = args.findIndex((arg) =>
    arg === "--actor" || arg.startsWith("--actor=")
  );
  if (index < 0) return base;
  const raw = args[index] === "--actor"
    ? args[index + 1]
    : args[index].slice("--actor=".length);
  const parsed = parseActorArg(raw ?? "");
  const value = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  return `${base}?actor=${encodeURIComponent(value)}`;
}

async function parseSecretSetPayload(
  args: string[],
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--value") payload.value = next();
    else if (arg.startsWith("--value=")) {
      payload.value = arg.slice("--value=".length);
    } else if (arg === "--value-file") {
      payload.value = await Deno.readTextFile(next());
    } else if (arg.startsWith("--value-file=")) {
      payload.value = await Deno.readTextFile(
        arg.slice("--value-file=".length),
      );
    } else if (arg === "--description") payload.description = next();
    else if (arg.startsWith("--description=")) {
      payload.description = arg.slice("--description=".length);
    } else if (arg === "--actor") payload.actor = parseActorArg(next());
    else if (arg.startsWith("--actor=")) {
      payload.actor = parseActorArg(arg.slice("--actor=".length));
    } else throw usageError(`unknown secret option ${arg}`);
  }
  return payload;
}
function parseSecretActorPayload(args: string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--actor") payload.actor = parseActorArg(args[++i] ?? "");
    else if (arg.startsWith("--actor=")) {
      payload.actor = parseActorArg(arg.slice("--actor=".length));
    } else throw usageError(`unknown secret option ${arg}`);
  }
  return payload;
}

async function readChangesetInput(args: string[]): Promise<unknown> {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--file") return await readJsonFile(args[++i] ?? "");
    if (arg.startsWith("--file=")) {
      return await readJsonFile(arg.slice("--file=".length));
    }
    if (arg === "--input" || arg === "--json-input") {
      return JSON.parse(args[++i] ?? "");
    }
    if (arg.startsWith("--input=")) {
      return JSON.parse(arg.slice("--input=".length));
    }
    if (arg.startsWith("--json-input=")) {
      return JSON.parse(arg.slice("--json-input=".length));
    }
    if (arg === "--actor" || arg === "--idempotency-key") i++;
    else if (
      arg.startsWith("--actor=") || arg.startsWith("--idempotency-key=")
    ) {
      continue;
    } else if (!arg.startsWith("--")) return await readJsonFile(arg);
    else throw usageError(`unknown changeset option ${arg}`);
  }
  throw usageError(
    "changeset preview/commit requires <json-file>, --file, or --input JSON",
  );
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
    if (cmd === "status" && sub === "live") {
      result = await getJson(`${parsed.server}/live`);
    } else if (cmd === "status" && sub === "ready") {
      result = await getJson(`${parsed.server}/ready`);
    } else if (cmd === "status" && sub === "bootstrap") {
      result = await getJson(`${parsed.server}/api/v1/auth/bootstrap/status`);
    } else if (cmd === "home") {
      result = await getJson(`${parsed.server}/metadata/home`);
    } else if (cmd === "pack" && sub === "preview" && value) {
      result = await postMultipart(`${parsed.server}/packs/preview`, value);
    } else if (cmd === "pack" && sub === "apply" && value) {
      result = await postMultipart(`${parsed.server}/packs/apply`, value);
    } else if (
      cmd === "action" && (sub === "preview" || sub === "commit") && value
    ) {
      const [namespace, name] = splitDotted(value);
      result = await postJson(
        `${parsed.server}/actions/${namespace}/${name}/${sub}`,
        await resolveActionPayload(parsed.positional.slice(3)),
      );
    } else if (cmd === "secret" && sub === "list") {
      result = await getJson(
        appendActorQuery(
          `${parsed.server}/secrets`,
          parsed.positional.slice(2),
        ),
      );
    } else if (cmd === "secret" && sub === "set" && value) {
      result = await postJson(`${parsed.server}/secrets`, {
        name: value,
        ...await parseSecretSetPayload(parsed.positional.slice(3)),
      });
    } else if (cmd === "secret" && sub === "delete" && value) {
      result = await decodeJsonResponse(
        await fetch(
          `${parsed.server}/secrets/${encodeURIComponent(value)}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              parseSecretActorPayload(parsed.positional.slice(3)),
            ),
          },
        ),
      );
    } else if (cmd === "outbox" && sub === "status") {
      result = await getJson(`${parsed.server}/outbox`);
    } else if (cmd === "outbox" && sub === "drain") {
      const limitFlag = parsed.positional.findIndex((arg) =>
        arg === "--limit" || arg.startsWith("--limit=")
      );
      const limit = limitFlag >= 0
        ? Number(
          parsed.positional[limitFlag] === "--limit"
            ? parsed.positional[limitFlag + 1]
            : parsed.positional[limitFlag].slice("--limit=".length),
        )
        : undefined;
      result = await postJson(`${parsed.server}/outbox/drain`, { limit });
    } else if (cmd === "outbox" && sub === "retry" && value) {
      result = await postJson(`${parsed.server}/outbox/${value}/retry`, {});
    } else if (cmd === "migration" && sub === "inspect" && value) {
      result = await getJson(`${parsed.server}/migrations/${value}`);
    } else if (cmd === "migration" && sub === "apply" && value) {
      const mode = parsed.positional.includes("--stage") ? "stage" : "safe";
      result = await postJson(`${parsed.server}/migrations/${value}/apply`, {
        mode,
      });
    } else if (cmd === "migration" && sub === "confirm" && value) {
      const tokenFlag = parsed.positional.findIndex((arg) =>
        arg === "--token" || arg === "--confirm"
      );
      const token = tokenFlag >= 0
        ? parsed.positional[tokenFlag + 1]
        : parsed.positional[3];
      result = await postJson(`${parsed.server}/migrations/${value}/confirm`, {
        token,
      });
    } else if (cmd === "query" && sub) {
      result = await postJson(
        `${parsed.server}/queries`,
        parseQueryPayload(sub, parsed.positional.slice(2)),
      );
    } else if (cmd === "changeset" && sub === "preview") {
      result = await postJson(
        `${parsed.server}/changesets/preview`,
        await readChangesetInput(parsed.positional.slice(2)),
      );
    } else if (cmd === "changeset" && sub === "commit") {
      result = await postJson(
        `${parsed.server}/changesets/commit`,
        await readChangesetInput(parsed.positional.slice(2)),
      );
    } else if (cmd === "view" && sub && value) {
      const [namespace, name] = splitDotted(sub);
      result = await getJson(
        appendActorQuery(
          `${parsed.server}/objects/${namespace}/${name}/${value}`,
          parsed.positional.slice(3),
        ),
      );
    } else if (cmd === "history" && sub && value) {
      const [namespace, name] = splitDotted(sub);
      result = await getJson(
        `${parsed.server}/history/${namespace}/${name}/${value}`,
      );
    } else if (cmd === "metadata" && !sub) {
      result = await getJson(`${parsed.server}/metadata/packs`);
    } else if (cmd === "metadata" && sub === "packs") {
      result = await getJson(`${parsed.server}/metadata/packs`);
    } else if (cmd === "metadata" && sub === "pack" && value) {
      const [namespace, name] = splitDotted(value);
      result = await getJson(
        `${parsed.server}/metadata/packs/${namespace}/${name}`,
      );
    } else if (cmd === "metadata" && sub && value) {
      const [namespace, name] = splitDotted(value);
      const routeKind = ({
        resource: "resources",
        action: "actions",
        hook: "hooks",
        policy: "policies",
      } as Record<string, string>)[sub];
      if (!routeKind) throw usageError(`unknown metadata kind ${sub}`);
      result = await getJson(
        `${parsed.server}/metadata/${routeKind}/${namespace}/${name}`,
      );
    } else {
      throw usageError(
        "usage: optctl status live/ready/bootstrap | home | pack preview/apply <dir> | metadata [packs] | metadata pack/resource/action/hook/policy <namespace.name> | secret list/set/delete | action preview/commit <namespace.action> --input '{...}' | outbox status/drain/retry | migration inspect/apply/confirm <id> | query <namespace.resource> [--where expr] [--fields a,b] [--sort field:desc] [--limit n] [--cursor c] | changeset preview/commit (--file <json-file>|--input '{...}') | view <namespace.resource> <id> | history <namespace.resource> <id>",
      );
    }
    const output = parsed.verbose
      ? {
        command: parsed.positional.join(" "),
        server: parsed.server,
        response: result,
      }
      : result;
    return { stdout: render(output, parsed.json), stderr: "", code: 0 };
  } catch (error) {
    if (error instanceof OptctlError) {
      return {
        stdout: "",
        stderr: render(error.envelope, parse(args).json),
        code: error.exitCode,
      };
    }
    if (error instanceof SyntaxError) {
      const malformed = usageError("input is not valid JSON");
      return {
        stdout: "",
        stderr: render(malformed.envelope, parse(args).json),
        code: malformed.exitCode,
      };
    }
    const unavailable = error instanceof TypeError;
    const envelope = errorEnvelope({
      code: unavailable ? "unavailable" : "internal_error",
      message: unavailable
        ? "server is unavailable"
        : error instanceof Error
        ? error.message
        : String(error),
      details: {},
    });
    return { stdout: "", stderr: render(envelope, parse(args).json), code: 1 };
  }
}
