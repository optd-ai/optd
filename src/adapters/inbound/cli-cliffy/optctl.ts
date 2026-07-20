import { Command } from "jsr:@cliffy/command";
import { walk } from "jsr:@std/fs/walk";
import { relative } from "jsr:@std/path";
import { formatToon } from "../../outbound/toon/format.ts";
import {
  type ErrorEnvelope,
  errorEnvelope,
} from "../../../schemas/api/contracts.ts";
import {
  cleanupLocalAuth,
  doctorLocalAuth,
  localAuthStatus,
  readOrigin,
  removeLocalAuthorization,
  writeOrigin,
} from "./auth_store.ts";
import { opaqueToken, tokenDigest } from "../../../domain/auth/token.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type OptctlRunResult = { stdout: string; stderr: string; code: number };
type Parsed = {
  server: string;
  json: boolean;
  verbose: boolean;
  project?: string;
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
async function credentialHeaders(url: string): Promise<Record<string, string>> {
  const token = (await readOrigin(new URL(url).origin)).token;
  return token ? { authorization: `Bearer ${token}` } : {};
}
async function requestCredentialHeaders(
  url: string,
): Promise<Record<string, string>> {
  const state = await readOrigin(new URL(url).origin);
  const token = state.requestToken ?? state.token;
  return token ? { authorization: `Bearer ${token}` } : {};
}
async function getJson(url: string): Promise<unknown> {
  return await decodeJsonResponse(
    await fetch(url, {
      headers: await credentialHeaders(url),
      redirect: "error",
    }),
  );
}
async function postJson(url: string, payload: unknown): Promise<unknown> {
  return await decodeJsonResponse(
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...await credentialHeaders(url),
      },
      body: JSON.stringify(payload),
      redirect: "error",
    }),
  );
}
async function postMultipart(url: string, packDir: string): Promise<unknown> {
  const form = new FormData();
  for await (
    const entry of walk(packDir, { includeDirs: true, followSymlinks: false })
  ) {
    const rel = relative(packDir, entry.path).replaceAll("\\", "/");
    if (!rel) continue;
    if (rel === ".git" || rel.startsWith(".git/") || rel === ".DS_Store") {
      continue;
    }
    const info = await Deno.lstat(entry.path);
    if (info.isDirectory) {
      if (
        ![
          "resources",
          "relationships",
          "lifecycles",
          "actions",
          "hooks",
          "roles",
          "policies",
          "seeds",
        ].includes(rel)
      ) {
        throw usageError(`pack contains unexpected directory ${rel}`);
      }
      continue;
    }
    if (info.isSymlink || !info.isFile || (info.nlink ?? 1) > 1) {
      throw usageError(`pack contains unsupported file ${rel}`);
    }
    form.append(
      "file",
      new File([await Deno.readFile(entry.path)], rel),
    );
  }
  return await decodeJsonResponse(
    await fetch(url, {
      method: "POST",
      body: form,
      headers: await credentialHeaders(url),
      redirect: "error",
    }),
  );
}
export function authenticatedOutput(
  user: unknown,
  extra: Record<string, unknown> = {},
) {
  return { ok: true, data: { user, authenticated: true, ...extra } };
}

function render(value: unknown, asJson?: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : formatToon(value);
}
async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}
function splitPackIdentity(id: string): [string, string] {
  const match = /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62})$/.exec(id);
  if (!match) {
    throw usageError(`expected pack identity publisher/pack, got ${id}`);
  }
  return [match[1], match[2]];
}
function splitDefinitionIdentity(id: string): [string, string, string] {
  const match =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(id);
  if (!match) {
    throw usageError(
      `expected publisher-qualified identity publisher/pack:name, got ${id}`,
    );
  }
  return [match[1], match[2], match[3]];
}
function parse(args: string[]): Parsed {
  const parsed: Parsed = {
    server: "http://127.0.0.1:8789",
    json: false,
    verbose: false,
    positional: [],
  };
  let commandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      parsed.positional.push("--", ...args.slice(i + 1));
      break;
    }
    if (arg === "--json") parsed.json = true;
    else if (arg === "--verbose" || arg === "-v") parsed.verbose = true;
    else if (arg === "--server") parsed.server = args[++i] ?? parsed.server;
    else if (arg.startsWith("--server=")) {
      parsed.server = arg.slice("--server=".length);
    } else if (!commandSeen && arg === "--project") {
      parsed.project = args[++i];
      if (!parsed.project) {
        throw usageError("--project requires a UUID or slug");
      }
    } else if (!commandSeen && arg.startsWith("--project=")) {
      parsed.project = arg.slice("--project=".length);
      if (!parsed.project) {
        throw usageError("--project requires a UUID or slug");
      }
    } else {
      parsed.positional.push(arg);
      commandSeen = true;
    }
  }
  parsed.server = parsed.server.replace(/\/$/, "");
  return parsed;
}

function parseQueryPayload(
  projectId: string,
  kind: "resource" | "relationship",
  identity: string,
  args: string[],
): Record<string, unknown> {
  const match =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(identity);
  if (!match) throw usageError("query definition must be publisher/pack:name");
  const payload: Record<string, unknown> = {
    project_id: projectId,
    definition: { kind, publisher: match[1], pack: match[2], name: match[3] },
  };
  const fields: string[] = [];
  const sort: Array<{ field: string; direction: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--where") payload.where = next();
    else if (arg.startsWith("--where=")) {
      payload.where = arg.slice("--where=".length);
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
    else if (arg === "--include-total") payload.include_total = true;
    else throw usageError(`unknown query option ${arg}`);
  }
  if (fields.length) payload.fields = fields;
  if (sort.length) payload.sort = sort;
  return payload;
}
function migrationApplyOptions(args: string[]) {
  let acknowledgement: "safe" | "reviewed" | "destructive" | undefined;
  let confirmationToken: string | undefined;
  let lockTimeout: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--safe" || arg === "--reviewed") {
      if (acknowledgement) {
        throw usageError(
          "migration apply accepts exactly one acknowledgement option",
        );
      }
      acknowledgement = arg === "--safe" ? "safe" : "reviewed";
    } else if (arg === "--confirm-token") {
      if (acknowledgement) {
        throw usageError(
          "migration apply accepts exactly one acknowledgement option",
        );
      }
      acknowledgement = "destructive";
      confirmationToken = args[++i];
    } else if (arg.startsWith("--confirm-token=")) {
      if (acknowledgement) {
        throw usageError(
          "migration apply accepts exactly one acknowledgement option",
        );
      }
      acknowledgement = "destructive";
      confirmationToken = arg.slice("--confirm-token=".length);
    } else if (arg === "--timeout") lockTimeout = args[++i];
    else if (arg.startsWith("--timeout=")) {
      lockTimeout = arg.slice("--timeout=".length);
    } else throw usageError(`unknown migration apply option ${arg}`);
  }
  return { acknowledgement, confirmationToken, lockTimeout };
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
          "optctl metadata resource <publisher/pack:name>",
        ],
      },
    }),
    2,
  );
}

function interactiveInputError(message: string): OptctlError {
  return new OptctlError(
    errorEnvelope({
      code: "interactive_input_required",
      message,
      details: {},
    }),
    2,
  );
}

async function readPassword(args: string[], confirm = true): Promise<string> {
  if (
    args.some((arg) => arg === "--password" || arg.startsWith("--password="))
  ) {
    throw usageError(
      "plaintext password arguments are not supported; use --password-stdin or an interactive prompt",
    );
  }
  if (args.includes("--password-stdin")) {
    const input = await new Response(Deno.stdin.readable).text();
    return input.replace(/\r?\n$/, "");
  }
  if (!Deno.stdin.isTerminal() || !Deno.stderr.isTerminal()) {
    throw interactiveInputError(
      "password input requires a terminal or --password-stdin",
    );
  }
  const first = await promptSecret("Password: ");
  if (!confirm) return first;
  const confirmation = await promptSecret("Confirm password: ");
  if (first !== confirmation) {
    throw new OptctlError(
      errorEnvelope({
        code: "password_confirmation_required",
        message: "password confirmation does not match",
        details: {},
      }),
      2,
    );
  }
  return first;
}

async function promptSecret(label: string): Promise<string> {
  await Deno.stderr.write(new TextEncoder().encode(label));
  Deno.stdin.setRaw(true);
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);
  try {
    while (true) {
      const count = await Deno.stdin.read(buffer);
      if (count === null || buffer[0] === 10 || buffer[0] === 13) break;
      if ((buffer[0] === 8 || buffer[0] === 127) && bytes.length) bytes.pop();
      else if (buffer[0] !== 8 && buffer[0] !== 127) bytes.push(buffer[0]);
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stderr.write(new TextEncoder().encode("\n"));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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

async function parseSecretValuePayload(
  args: string[],
  allowDescription: boolean,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--stdin") stdin = true;
    else if (allowDescription && arg === "--description") {
      payload.description = next();
    } else if (allowDescription && arg.startsWith("--description=")) {
      payload.description = arg.slice("--description=".length);
    } else throw usageError(`unknown secret option ${arg}`);
  }
  if (stdin) {
    payload.value = (await new Response(Deno.stdin.readable).text()).replace(
      /\r?\n$/,
      "",
    );
  } else {
    if (!Deno.stdin.isTerminal() || !Deno.stderr.isTerminal()) {
      throw interactiveInputError(
        "secret value requires a terminal or --stdin",
      );
    }
    payload.value = await promptSecret("Secret value: ");
  }
  return payload;
}
async function readChangesetInput(args: string[]): Promise<unknown> {
  if (args.length === 1 && !args[0].startsWith("--")) {
    return await readJsonFile(args[0]);
  }
  if (args.length === 2 && args[0] === "--file") {
    return await readJsonFile(args[1]);
  }
  if (args.length === 1 && args[0].startsWith("--file=")) {
    return await readJsonFile(args[0].slice(7));
  }
  throw usageError("changeset stage requires exactly one JSON file");
}

function changesetId(value: string | undefined): string {
  if (!value || !isUuidV7(value)) {
    throw usageError("stage id must be a lowercase UUIDv7");
  }
  return value;
}

function cancelPayload(args: string[]): { reason?: string } {
  if (!args.length) return {};
  if (args.length === 2 && args[0] === "--reason") {
    return { reason: args[1] };
  }
  if (args.length === 1 && args[0].startsWith("--reason=")) {
    return { reason: args[0].slice(9) };
  }
  throw usageError("changeset cancel accepts only --reason <text>");
}

function option(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) =>
    arg === name || arg.startsWith(`${name}=`)
  );
  if (index < 0) return undefined;
  return args[index] === name
    ? args[index + 1]
    : args[index].slice(name.length + 1);
}
function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[++index]);
    else if (args[index].startsWith(`${name}=`)) {
      values.push(args[index].slice(name.length + 1));
    }
  }
  return values;
}
function assignmentBoundary(args: string[]): Record<string, string> {
  const projectId = option(args, "--project");
  if (projectId) return { type: "project", project_id: projectId };
  const type = option(args, "--boundary");
  if (type === "system" || type === "all_projects") return { type };
  throw usageError(
    "assignment boundary requires --project <uuid> or --boundary system|all_projects",
  );
}

function issuedCredentialUpdate(
  credentials: Record<string, unknown>,
  prior: { requestToken?: string; requestSessionId?: string } = {},
) {
  return {
    token: String(credentials.token),
    requestToken: typeof credentials.authorization_request_token === "string"
      ? credentials.authorization_request_token
      : prior.requestToken,
    requestSessionId:
      typeof credentials.authorization_request_session_id === "string"
        ? credentials.authorization_request_session_id
        : prior.requestSessionId,
  };
}

function envelopeData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new Error("server returned an invalid success envelope");
  }
  return (value as { data: Record<string, unknown> }).data;
}
async function resolveProject(
  server: string,
  value: string,
): Promise<Record<string, unknown>> {
  if (isUuidV7(value)) return { id: value };
  if (/^[0-9a-f-]{36}$/.test(value)) {
    return envelopeData(await getJson(`${server}/api/v1/projects/${value}`));
  }
  const list = envelopeData(
    await getJson(
      `${server}/api/v1/projects?status=all&slug=${encodeURIComponent(value)}`,
    ),
  );
  const items = list.items;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new OptctlError(
      errorEnvelope({
        code: "project_not_found",
        message: "project was not found",
        details: { project: value },
      }),
    );
  }
  return items[0] as Record<string, unknown>;
}

async function resolveReadProject(parsed: Parsed): Promise<string> {
  const selected = await readOrigin(new URL(parsed.server).origin);
  const selector = parsed.project ?? Deno.env.get("OPERANT_PROJECT") ??
    selected.projectId ?? selected.projectSlug;
  if (!selector) {
    throw usageError(
      "view and history require global --project <uuid-or-slug> or an active local Project selection",
    );
  }
  const project = await resolveProject(parsed.server, selector);
  if (parsed.project && (selected.projectId || selected.projectSlug)) {
    const active = await resolveProject(
      parsed.server,
      selected.projectId ?? selected.projectSlug!,
    );
    if (String(active.id) !== String(project.id)) {
      throw new OptctlError(errorEnvelope({
        code: "project_conflict",
        message: "explicit and active selected Projects disagree",
        details: {},
      }));
    }
  }
  return String(project.id);
}

async function metadataQuery(parsed: Parsed, args: string[]): Promise<string> {
  const params = new URLSearchParams();
  for (const arg of args) {
    if (arg === "--include-security") params.set("include_security", "true");
    else throw usageError(`unknown metadata option ${arg}`);
  }
  const selected = await readOrigin(new URL(parsed.server).origin);
  const selector = parsed.project ?? Deno.env.get("OPERANT_PROJECT") ??
    selected.projectId ?? selected.projectSlug;
  if (selector) {
    const project = await resolveProject(parsed.server, selector);
    params.set("project_id", String(project.id));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function historyQuery(args: string[]): string {
  const url = new URL("http://local/");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--limit" || arg === "--cursor") {
      const value = args[++index];
      if (!value) throw usageError(`${arg} requires a value`);
      url.searchParams.set(arg.slice(2), value);
    } else if (arg.startsWith("--limit=") || arg.startsWith("--cursor=")) {
      const [key, value] = arg.slice(2).split("=", 2);
      if (!value) throw usageError(`--${key} requires a value`);
      url.searchParams.set(key, value);
    } else throw usageError(`unknown history option ${arg}`);
  }
  const query = url.searchParams.toString();
  return query ? `?${query}` : "";
}

async function waitForPasswordReset(
  server: string,
  requestId: string,
  nonce: string,
): Promise<string> {
  let backoff = 100;
  while (true) {
    try {
      const ticketEnvelope = await decodeJsonResponse(
        await fetch(
          `${server}/api/v1/auth/password-reset/requests/${
            encodeURIComponent(requestId)
          }/watch-ticket`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redemption_nonce: nonce }),
          },
        ),
      );
      const ticket = String(envelopeData(ticketEnvelope).ticket);
      const socketUrl = new URL(
        `${server}/api/v1/auth/password-reset/requests/${
          encodeURIComponent(requestId)
        }/watch`,
      );
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("ticket", ticket);
      const status = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(socketUrl);
        let terminal = false;
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            status?: string;
          };
          if (
            message.type !== "password_reset_status" || !message.status ||
            message.status === "pending"
          ) return;
          terminal = true;
          resolve(message.status);
          socket.close(1000);
        };
        socket.onerror = () => {
          if (!terminal) {
            try {
              socket.close();
            } catch { /* rejected handshakes still emit close */ }
          }
        };
        socket.onclose = () => {
          if (!terminal) reject(new Error("password reset watch disconnected"));
        };
      });
      return status;
    } catch (error) {
      if (
        error instanceof OptctlError &&
        ["password_reset_not_found", "password_reset_expired"].includes(
          error.envelope.error.code,
        )
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(2_000, backoff * 2);
    }
  }
}

async function waitForAuthorization(
  server: string,
  requestId: string,
): Promise<{ status: string; reason?: string }> {
  let backoff = 100;
  while (true) {
    try {
      const ticketEnvelope = await decodeJsonResponse(
        await fetch(
          `${server}/api/v1/auth/requests/${
            encodeURIComponent(requestId)
          }/watch-ticket`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...await requestCredentialHeaders(server),
            },
            body: "{}",
          },
        ),
      );
      const ticket = String(envelopeData(ticketEnvelope).ticket);
      const socketUrl = new URL(
        `${server}/api/v1/auth/requests/${encodeURIComponent(requestId)}/watch`,
      );
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("ticket", ticket);
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(socketUrl);
        let terminal = false;
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            status?: string;
            reason?: string;
          };
          if (
            message.type !== "auth_request_status" || !message.status ||
            message.status === "pending"
          ) return;
          terminal = true;
          resolve({ status: message.status, reason: message.reason });
          socket.close(1000);
        };
        socket.onerror = () => {
          if (!terminal) {
            try {
              socket.close();
            } catch { /* reconnect */ }
          }
        };
        socket.onclose = () => {
          if (!terminal) reject(new Error("authorization watch disconnected"));
        };
      });
    } catch (error) {
      if (
        error instanceof OptctlError &&
        ["request_denied", "request_cancelled", "request_invalidated"].includes(
          error.envelope.error.code,
        )
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(2_000, backoff * 2);
    }
  }
}

async function runIsolatedCommand(
  childArgs: string[],
  env: Record<string, string>,
  origin: string,
  asJson: boolean,
): Promise<OptctlRunResult> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(childArgs[0], {
      args: childArgs.slice(1),
      clearEnv: true,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        stdout: "",
        stderr: render(
          errorEnvelope({
            code: "isolate_child_not_found",
            message: "isolate child command was not found",
            details: { command: childArgs[0] },
          }),
          asJson,
        ),
        code: 127,
      };
    }
    throw new OptctlError(errorEnvelope({
      code: "isolate_launch_failed",
      message: "failed to launch isolate child",
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
    }));
  }

  const forwarded: Deno.Signal[] = ["SIGINT", "SIGTERM"];
  const listeners = new Map<Deno.Signal, () => void>();
  for (const signal of forwarded) {
    const listener = () => {
      try {
        child.kill(signal);
      } catch { /* child already exited */ }
    };
    try {
      Deno.addSignalListener(signal, listener);
      listeners.set(signal, listener);
    } catch { /* signal unsupported on this platform */ }
  }
  try {
    const status = await child.status;
    if (status.signal === "SIGINT") {
      return { stdout: "", stderr: "", code: 130 };
    }
    if (status.signal === "SIGTERM") {
      return { stdout: "", stderr: "", code: 143 };
    }
    return { stdout: "", stderr: "", code: status.code };
  } finally {
    for (const [signal, listener] of listeners) {
      Deno.removeSignalListener(signal, listener);
    }
    await cleanupLocalAuth(origin).catch(() => undefined);
  }
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
    } else if (cmd === "bootstrap" && sub === "init") {
      const bootstrapArgs = parsed.positional.slice(2);
      const username = option(bootstrapArgs, "--username");
      const password = await readPassword(bootstrapArgs);
      const displayName = option(bootstrapArgs, "--display-name") ?? username;
      const bootstrapToken = Deno.env.get("OPERANT_BOOTSTRAP_TOKEN");
      if (!username || !bootstrapToken) {
        throw usageError(
          "bootstrap init requires --username and OPERANT_BOOTSTRAP_TOKEN configured",
        );
      }
      result = await decodeJsonResponse(
        await fetch(`${parsed.server}/api/v1/auth/bootstrap`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Operant-Bootstrap ${bootstrapToken}`,
          },
          body: JSON.stringify({
            username,
            display_name: displayName,
            password,
          }),
        }),
      );
      const credentials = envelopeData(result).credentials as Record<
        string,
        unknown
      >;
      await writeOrigin(parsed.server, {
        ...issuedCredentialUpdate(credentials),
        username,
      });
      result = authenticatedOutput(envelopeData(result).user);
    } else if (cmd === "auth" && sub === "login") {
      const authArgs = parsed.positional.slice(2);
      const prior = await readOrigin(parsed.server);
      const username = option(authArgs, "--username") ?? prior.username;
      if (!username) {
        throw usageError("auth login requires --username on first use");
      }
      const password = await readPassword(authArgs, false);
      result = await decodeJsonResponse(
        await fetch(`${parsed.server}/api/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username,
            password,
            ...(prior.requestSessionId
              ? { existing_request_session_id: prior.requestSessionId }
              : {}),
          }),
        }),
      );
      const credentials = envelopeData(result).credentials as Record<
        string,
        unknown
      >;
      await writeOrigin(parsed.server, {
        ...issuedCredentialUpdate(credentials, prior),
        username,
      });
      result = authenticatedOutput(envelopeData(result).user);
    } else if (cmd === "auth" && sub === "status") {
      result = await localAuthStatus(parsed.server);
    } else if (cmd === "auth" && sub === "whoami") {
      result = await getJson(`${parsed.server}/api/v1/auth/me`);
    } else if (cmd === "auth" && sub === "session-pid") {
      return { stdout: `${Deno.ppid}\n`, stderr: "", code: 0 };
    } else if (cmd === "auth" && sub === "doctor") {
      const doctorArgs = parsed.positional.slice(2);
      const fix = doctorArgs.includes("--fix");
      if (fix && !doctorArgs.includes("--yes")) {
        throw usageError("auth doctor --fix requires --yes");
      }
      const report = await doctorLocalAuth(fix);
      const fails = !report.healthy ||
        (doctorArgs.includes("--strict") &&
          report.findings.some((finding) => finding.severity === "warning"));
      return {
        stdout: render(report, parsed.json),
        stderr: "",
        code: fails ? 1 : 0,
      };
    } else if (cmd === "auth" && sub === "cleanup") {
      result = {
        ok: true,
        data: { removed: await cleanupLocalAuth(parsed.server) },
      };
    } else if (cmd === "auth" && sub === "isolate") {
      const separator = parsed.positional.indexOf("--");
      if (separator < 0) {
        throw usageError("auth isolate requires -- before the child command");
      }
      const childArgs = parsed.positional.slice(separator + 1);
      if (!childArgs.length) {
        return {
          stdout: "",
          stderr: render(
            errorEnvelope({
              code: "isolate_child_not_found",
              message: "auth isolate requires a child command after --",
              details: {},
            }),
            parsed.json,
          ),
          code: 127,
        };
      }
      const local = await readOrigin(parsed.server);
      if (!local.requestToken) {
        throw new OptctlError(errorEnvelope({
          code: "authorization_request_credential_missing",
          message: "an authorization-request credential is required",
          details: {},
        }));
      }
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        OPERANT_AUTH_TREE_STOP_PID: String(Deno.pid),
      };
      for (const key of Object.keys(env)) {
        if (
          /^OPERANT_.*(?:TOKEN|BEARER|CREDENTIAL).*$/.test(key) ||
          key === "OPERANT_MASTER_KEY"
        ) delete env[key];
      }
      return await runIsolatedCommand(
        childArgs,
        env,
        parsed.server,
        parsed.json,
      );
    } else if (cmd === "auth" && sub === "sessions") {
      result = await getJson(`${parsed.server}/api/v1/auth/sessions`);
    } else if (cmd === "auth" && sub === "logout") {
      const authArgs = parsed.positional.slice(2);
      if (authArgs.includes("--all")) {
        if (!authArgs.includes("--yes")) {
          throw usageError("auth logout --all requires --yes");
        }
        result = await postJson(`${parsed.server}/api/v1/auth/logout-all`, {
          password: await readPassword(authArgs, false),
        });
        await writeOrigin(parsed.server, {
          token: undefined,
          requestToken: undefined,
          requestSessionId: undefined,
        });
      } else {
        result = await postJson(`${parsed.server}/api/v1/auth/logout`, {});
        await writeOrigin(parsed.server, { token: undefined });
      }
    } else if (cmd === "auth" && sub === "user" && value === "list") {
      result = await getJson(`${parsed.server}/api/v1/auth/users`);
    } else if (cmd === "auth" && sub === "user" && value === "create") {
      const userArgs = parsed.positional.slice(3);
      const username = option(userArgs, "--username");
      if (!username) throw usageError("auth user create requires --username");
      result = await postJson(`${parsed.server}/api/v1/auth/users`, {
        username,
        display_name: option(userArgs, "--display-name") ?? username,
        password: await readPassword(userArgs),
      });
    } else if (
      cmd === "auth" && sub === "user" &&
      (value === "disable" || value === "enable")
    ) {
      const userId = parsed.positional[3];
      if (!userId) throw usageError(`auth user ${value} requires a user id`);
      result = await decodeJsonResponse(
        await fetch(
          `${parsed.server}/api/v1/auth/users/${encodeURIComponent(userId)}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              ...await credentialHeaders(parsed.server),
            },
            body: JSON.stringify({
              status: value === "enable" ? "active" : "disabled",
            }),
          },
        ),
      );
    } else if (cmd === "auth" && sub === "password" && value === "change") {
      const passwordArgs = parsed.positional.slice(3);
      if (!passwordArgs.includes("--password-stdin")) {
        throw interactiveInputError(
          "password change currently requires --password-stdin with current and new password lines",
        );
      }
      const lines = (await new Response(Deno.stdin.readable).text()).replace(
        /\r/g,
        "",
      ).split("\n");
      if (!lines[0] || !lines[1]) {
        throw interactiveInputError(
          "password change requires current and new password lines",
        );
      }
      result = await postJson(`${parsed.server}/api/v1/auth/password/change`, {
        current_password: lines[0],
        new_password: lines[1],
      });
      const data = envelopeData(result);
      const credentials = data.credentials as Record<string, unknown>;
      const user = data.user as Record<string, unknown>;
      await writeOrigin(parsed.server, {
        token: String(credentials.token),
        requestToken: String(credentials.authorization_request_token),
        requestSessionId: String(credentials.authorization_request_session_id),
        username: String(user.username),
      });
      result = authenticatedOutput(user);
    } else if (cmd === "auth" && sub === "password-policy") {
      result = await getJson(`${parsed.server}/api/v1/auth/password-policy`);
    } else if (cmd === "auth" && sub === "wait" && value) {
      const waitArgs = parsed.positional.slice(3);
      if (
        waitArgs.some((arg) =>
          arg === "--timeout" || arg.startsWith("--timeout=")
        )
      ) throw usageError("auth wait has no timeout option");
      const prior = await readOrigin(parsed.server);
      const authorizationNonce = prior.authorizationNonces?.[value];
      if (authorizationNonce) {
        const state = await waitForAuthorization(parsed.server, value);
        if (state.status !== "approved") {
          throw new OptctlError(errorEnvelope({
            code: state.status === "denied"
              ? "request_denied"
              : `request_${state.status}`,
            message: state.reason ?? `authorization request is ${state.status}`,
            details: { request_id: value, status: state.status },
          }));
        }
        const redeemed = await decodeJsonResponse(
          await fetch(
            `${parsed.server}/api/v1/auth/requests/${
              encodeURIComponent(value)
            }/redeem`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...await requestCredentialHeaders(parsed.server),
              },
              body: JSON.stringify({ redemption_nonce: authorizationNonce }),
            },
          ),
        );
        const data = envelopeData(redeemed);
        const authorization = data.authorization as
          | Record<string, unknown>
          | undefined;
        await writeOrigin(parsed.server, {
          token: String(data.token),
          requestToken: undefined,
          authorizationId: typeof authorization?.id === "string"
            ? authorization.id
            : value,
        });
        result = redeemed;
      } else {
        const nonce = prior.resetNonces?.[value];
        if (!nonce) {
          throw usageError(
            "requester nonce is unavailable in this local auth store",
          );
        }
        const status = await waitForPasswordReset(parsed.server, value, nonce);
        if (status !== "approved") {
          const code = status === "denied"
            ? "password_reset_denied"
            : status === "expired"
            ? "password_reset_expired"
            : "request_cancelled";
          throw new OptctlError(
            errorEnvelope({
              code,
              message: `password reset is ${status}`,
              details: { request_id: value, status },
            }),
          );
        }
        const redeemed = await decodeJsonResponse(
          await fetch(
            `${parsed.server}/api/v1/auth/password-reset/requests/${
              encodeURIComponent(value)
            }/redeem`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ redemption_nonce: nonce }),
            },
          ),
        );
        const capability = String(envelopeData(redeemed).capability);
        const password = await readPassword(waitArgs);
        result = await decodeJsonResponse(
          await fetch(
            `${parsed.server}/api/v1/auth/password-reset/requests/${
              encodeURIComponent(value)
            }/complete`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ capability, password }),
            },
          ),
        );
        const data = envelopeData(result);
        const credentials = data.credentials as Record<string, unknown>;
        const user = data.user as Record<string, unknown>;
        await writeOrigin(parsed.server, {
          token: String(credentials.token),
          requestToken: String(credentials.authorization_request_token),
          requestSessionId: String(
            credentials.authorization_request_session_id,
          ),
          username: String(user.username),
        });
        result = authenticatedOutput(user, { request_id: value });
      }
    } else if (cmd === "auth" && sub === "roles") {
      const authArgs = parsed.positional.slice(2);
      const projectId = option(authArgs, "--project");
      const boundaryType = projectId
        ? "project"
        : option(authArgs, "--boundary") ?? "system";
      const url = new URL(`${parsed.server}/api/v1/auth/roles`);
      url.searchParams.set("boundary_type", boundaryType);
      if (projectId) url.searchParams.set("project_id", projectId);
      result = await decodeJsonResponse(
        await fetch(url, {
          headers: await requestCredentialHeaders(parsed.server),
        }),
      );
    } else if (cmd === "auth" && sub === "request") {
      const authArgs = parsed.positional.slice(2);
      const roles = options(authArgs, "--role");
      const reason = option(authArgs, "--reason") ?? "";
      const projectId = option(authArgs, "--project");
      const boundaryType = projectId
        ? "project"
        : option(authArgs, "--boundary") ?? "system";
      if (!roles.length) {
        throw usageError("auth request requires at least one --role");
      }
      const nonce = opaqueToken();
      result = await decodeJsonResponse(
        await fetch(`${parsed.server}/api/v1/auth/requests`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": opaqueToken(),
            ...await requestCredentialHeaders(parsed.server),
          },
          body: JSON.stringify({
            roles,
            boundary: projectId
              ? { type: "project", project_id: projectId }
              : { type: boundaryType },
            reason,
            redemption_nonce_hash: await tokenDigest(nonce),
            agent: option(authArgs, "--agent-name")
              ? { name: option(authArgs, "--agent-name") }
              : undefined,
          }),
        }),
      );
      const id = String(envelopeData(result).id);
      await writeOrigin(parsed.server, {
        authorizationNonces: {
          ...(await readOrigin(parsed.server)).authorizationNonces,
          [id]: nonce,
        },
      });
    } else if (
      cmd === "auth" && (sub === "approve" || sub === "deny") && value
    ) {
      const authArgs = parsed.positional.slice(3);
      result = await postJson(
        `${parsed.server}/api/v1/auth/requests/${
          encodeURIComponent(value)
        }/decision`,
        sub === "approve"
          ? {
            decision: "approved",
            agent_name: option(authArgs, "--agent-name"),
          }
          : { decision: "denied", reason: option(authArgs, "--reason") },
      );
    } else if (cmd === "auth" && sub === "authorizations") {
      result = await getJson(`${parsed.server}/api/v1/auth/authorizations`);
    } else if (cmd === "auth" && sub === "revoke" && value) {
      result = await postJson(
        `${parsed.server}/api/v1/auth/authorizations/${
          encodeURIComponent(value)
        }/revoke`,
        {},
      );
      await removeLocalAuthorization(parsed.server, value);
    } else if (cmd === "auth" && sub === "password-reset") {
      const action = value;
      const resetArgs = parsed.positional.slice(3);
      const requestId = resetArgs.find((arg) => !arg.startsWith("--"));
      if (action === "request") {
        const username = option(resetArgs, "--username");
        if (!username) {
          throw usageError("password-reset request requires --username");
        }
        const nonce = opaqueToken();
        const idempotencyKey = opaqueToken();
        result = await decodeJsonResponse(
          await fetch(`${parsed.server}/api/v1/auth/password-reset/requests`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify({
              username,
              redemption_nonce_hash: await tokenDigest(nonce),
            }),
          }),
        );
        const id = String(envelopeData(result).request_id);
        const prior = await readOrigin(parsed.server);
        await writeOrigin(parsed.server, {
          resetNonces: { ...(prior.resetNonces ?? {}), [id]: nonce },
        });
      } else if (action === "inspect" && requestId) {
        result = await getJson(
          `${parsed.server}/api/v1/auth/password-reset/requests/${
            encodeURIComponent(requestId)
          }`,
        );
      } else if ((action === "approve" || action === "deny") && requestId) {
        result = await postJson(
          `${parsed.server}/api/v1/auth/password-reset/requests/${
            encodeURIComponent(requestId)
          }/decision`,
          { decision: action === "approve" ? "approved" : "denied" },
        );
      } else if ((action === "complete" || action === "cancel") && requestId) {
        const prior = await readOrigin(parsed.server);
        const nonce = prior.resetNonces?.[requestId];
        if (!nonce) {
          throw usageError(
            "password-reset requester nonce is unavailable in this local auth store",
          );
        }
        if (action === "cancel") {
          result = await decodeJsonResponse(
            await fetch(
              `${parsed.server}/api/v1/auth/password-reset/requests/${
                encodeURIComponent(requestId)
              }/cancel`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ redemption_nonce: nonce }),
              },
            ),
          );
        } else {
          const redeemed = await decodeJsonResponse(
            await fetch(
              `${parsed.server}/api/v1/auth/password-reset/requests/${
                encodeURIComponent(requestId)
              }/redeem`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ redemption_nonce: nonce }),
              },
            ),
          );
          const capability = String(envelopeData(redeemed).capability);
          const password = await readPassword(resetArgs);
          result = await decodeJsonResponse(
            await fetch(
              `${parsed.server}/api/v1/auth/password-reset/requests/${
                encodeURIComponent(requestId)
              }/complete`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ capability, password }),
              },
            ),
          );
          const data = envelopeData(result);
          const credentials = data.credentials as Record<string, unknown>;
          const user = data.user as Record<string, unknown>;
          await writeOrigin(parsed.server, {
            token: String(credentials.token),
            requestToken: String(credentials.authorization_request_token),
            requestSessionId: String(
              credentials.authorization_request_session_id,
            ),
            username: String(user.username),
          });
          result = authenticatedOutput(user);
        }
      } else throw usageError("invalid auth password-reset command");
    } else if (cmd === "auth" && sub === "recover") {
      const recoveryArgs = parsed.positional.slice(2);
      const username = option(recoveryArgs, "--username");
      const recoveryToken = Deno.env.get("OPERANT_RECOVERY_TOKEN");
      if (!username || !recoveryToken) {
        throw usageError(
          "auth recover requires --username and OPERANT_RECOVERY_TOKEN",
        );
      }
      const password = await readPassword(recoveryArgs);
      result = await decodeJsonResponse(
        await fetch(`${parsed.server}/api/v1/auth/recovery/complete`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Operant-Recovery ${recoveryToken}`,
          },
          body: JSON.stringify({ username, password }),
        }),
      );
      const data = envelopeData(result);
      const credentials = data.credentials as Record<string, unknown>;
      await writeOrigin(parsed.server, {
        token: String(credentials.token),
        requestToken: String(credentials.authorization_request_token),
        requestSessionId: String(credentials.authorization_request_session_id),
        username,
      });
      result = authenticatedOutput(data.user);
    } else if (cmd === "auth" && sub === "authority") {
      const authArgs = parsed.positional.slice(2);
      const boundary = assignmentBoundary(authArgs);
      const url = new URL(`${parsed.server}/api/v1/authorization/authority`);
      url.searchParams.set("boundary_type", String(boundary.type));
      if (boundary.project_id) {
        url.searchParams.set("project_id", String(boundary.project_id));
      }
      if (authArgs.includes("--include-security")) {
        url.searchParams.set("include_security", "true");
      }
      result = await getJson(url.toString());
    } else if (cmd === "assignment" && sub === "role" && value === "list") {
      const userId = parsed.positional[3];
      if (!userId) throw usageError("assignment role list requires <user-id>");
      result = await getJson(
        `${parsed.server}/api/v1/auth/users/${
          encodeURIComponent(userId)
        }/role-assignments`,
      );
    } else if (cmd === "assignment" && sub === "role" && value === "create") {
      const assignmentArgs = parsed.positional.slice(4);
      const userId = parsed.positional[3];
      const role = option(assignmentArgs, "--role");
      if (!userId || !role) {
        throw usageError(
          "assignment role create requires <user-id> and --role",
        );
      }
      result = await postJson(
        `${parsed.server}/api/v1/auth/users/${
          encodeURIComponent(userId)
        }/role-assignments`,
        { role, boundary: assignmentBoundary(assignmentArgs) },
      );
    } else if (cmd === "assignment" && sub === "role" && value === "disable") {
      const assignmentArgs = parsed.positional.slice(4);
      const userId = parsed.positional[3];
      const assignmentId = option(assignmentArgs, "--assignment");
      const expected = option(assignmentArgs, "--expected-version");
      if (!userId || !assignmentId || !expected) {
        throw usageError(
          "assignment role disable requires <user-id>, --assignment, and --expected-version",
        );
      }
      result = await postJson(
        `${parsed.server}/api/v1/auth/users/${
          encodeURIComponent(userId)
        }/role-assignments/${encodeURIComponent(assignmentId)}/disable`,
        { expected_version: Number(expected) },
      );
    } else if (cmd === "policy" && sub === "assignment" && value === "list") {
      const assignmentArgs = parsed.positional.slice(3);
      const active = option(assignmentArgs, "--active");
      result = await getJson(
        `${parsed.server}/api/v1/policy-assignments${
          active === undefined ? "" : `?active=${encodeURIComponent(active)}`
        }`,
      );
    } else if (cmd === "policy" && sub === "assignment" && value === "create") {
      const assignmentArgs = parsed.positional.slice(3);
      const revision = option(assignmentArgs, "--policy-revision");
      if (!revision) {
        throw usageError("policy assignment create requires --policy-revision");
      }
      result = await postJson(`${parsed.server}/api/v1/policy-assignments`, {
        policy_revision_id: revision,
        boundary: assignmentBoundary(assignmentArgs),
      });
    } else if (
      cmd === "policy" && sub === "assignment" && value === "disable"
    ) {
      const assignmentArgs = parsed.positional.slice(3);
      const assignmentId = option(assignmentArgs, "--assignment");
      const expected = option(assignmentArgs, "--expected-version");
      if (!assignmentId || !expected) {
        throw usageError(
          "policy assignment disable requires --assignment and --expected-version",
        );
      }
      result = await postJson(
        `${parsed.server}/api/v1/policy-assignments/${
          encodeURIComponent(assignmentId)
        }/disable`,
        { expected_version: Number(expected) },
      );
    } else if (cmd === "project" && sub === "list") {
      const listArgs = parsed.positional.slice(2);
      const parameters = new URLSearchParams();
      for (
        const [flag, query] of [
          ["--status", "status"],
          ["--slug", "slug"],
          ["--limit", "limit"],
          ["--cursor", "cursor"],
        ] as const
      ) {
        const value = option(listArgs, flag);
        if (value !== undefined) parameters.set(query, value);
      }
      const query = parameters.size ? `?${parameters}` : "";
      result = await getJson(`${parsed.server}/api/v1/projects${query}`);
    } else if (cmd === "project" && sub === "create" && value) {
      const displayName = option(parsed.positional.slice(3), "--display-name");
      if (!displayName) {
        throw usageError("project create requires --display-name");
      }
      const description = option(parsed.positional.slice(3), "--description");
      result = await postJson(`${parsed.server}/api/v1/projects`, {
        slug: value,
        display_name: displayName,
        ...description === undefined ? {} : { description },
      });
    } else if (cmd === "project" && sub === "view" && value) {
      const project = await resolveProject(parsed.server, value);
      result = { ok: true, data: project };
    } else if (cmd === "project" && sub === "update" && value) {
      const project = await resolveProject(parsed.server, value);
      const expected = option(parsed.positional.slice(3), "--expected-version");
      if (!expected) {
        throw usageError("project update requires --expected-version");
      }
      const displayName = option(parsed.positional.slice(3), "--display-name");
      const description = option(parsed.positional.slice(3), "--description");
      result = await postJson(
        `${parsed.server}/api/v1/projects/${project.id}/update`,
        {
          expected_version: Number(expected),
          ...displayName === undefined ? {} : { display_name: displayName },
          ...description === undefined ? {} : { description },
        },
      );
    } else if (cmd === "project" && sub === "archive" && value) {
      const project = await resolveProject(parsed.server, value);
      const expected = option(parsed.positional.slice(3), "--expected-version");
      if (!expected) {
        throw usageError("project archive requires --expected-version");
      }
      result = await postJson(
        `${parsed.server}/api/v1/projects/${project.id}/archive`,
        { expected_version: Number(expected) },
      );
    } else if (
      (cmd === "project" && sub === "select" && value) ||
      (cmd === "context" && sub === "set-project" && value)
    ) {
      const project = await resolveProject(parsed.server, value);
      await writeOrigin(parsed.server, {
        projectId: String(project.id),
        projectSlug: String(project.slug),
      });
      result = {
        ok: true,
        data: { project_id: project.id, slug: project.slug },
      };
    } else if (cmd === "home") {
      result = await getJson(`${parsed.server}/metadata/home`);
    } else if (cmd === "pack" && sub === "preview" && value) {
      result = await postMultipart(
        `${parsed.server}/packs/preview`,
        value,
      );
    } else if (cmd === "pack" && sub === "apply" && value) {
      const options = migrationApplyOptions(parsed.positional.slice(3));
      if (options.acknowledgement === "destructive") {
        throw usageError(
          "pack apply cannot reuse a confirmation token across a new preview; run pack apply <dir> to obtain the exact migration token, then migration apply <id> --confirm-token <token>",
        );
      }
      const preview = await postMultipart(
        `${parsed.server}/packs/preview`,
        value,
      ) as {
        data: { plan: { id: string; plan_digest: string; class: string } };
      };
      const plan = preview.data.plan;
      const validation = await postJson(
        `${parsed.server}/migrations/${plan.id}/validate`,
        {},
      ) as { data: Record<string, unknown> };
      if (plan.class === "destructive") {
        if (options.acknowledgement) {
          throw usageError(
            "destructive pack apply has no acknowledgement flag; use the returned exact migration id and confirmation token with migration apply",
          );
        }
        result = {
          ok: true,
          data: {
            plan,
            validation: validation.data,
            application: null,
            next_command:
              `optctl migration apply ${plan.id} --confirm-token <token>`,
          },
        };
      } else {
        const expected = plan.class === "safe" ? "safe" : "reviewed";
        if (options.acknowledgement !== expected) {
          throw usageError(
            `pack apply for a ${plan.class} plan requires --${expected}`,
          );
        }
        const application = await postJson(
          `${parsed.server}/migrations/${plan.id}/apply`,
          {
            acknowledgement: expected,
            confirmation_token: null,
            ...options.lockTimeout ? { lock_timeout: options.lockTimeout } : {},
          },
        ) as { data: Record<string, unknown> };
        result = {
          ok: true,
          data: {
            plan,
            validation: validation.data,
            application: application.data,
          },
        };
      }
    } else if (
      cmd === "action" && (sub === "preview" || sub === "commit") && value
    ) {
      const [publisher, pack, name] = splitDefinitionIdentity(value);
      result = await postJson(
        `${parsed.server}/actions/${publisher}/${pack}/${name}/${sub}`,
        await resolveActionPayload(parsed.positional.slice(3)),
      );
    } else if (cmd === "secret" && sub === "list") {
      result = await getJson(`${parsed.server}/secrets`);
    } else if (cmd === "secret" && sub === "create" && value) {
      result = await postJson(`${parsed.server}/secrets`, {
        name: value,
        ...await parseSecretValuePayload(parsed.positional.slice(3), true),
      });
    } else if (cmd === "secret" && sub === "rotate" && value) {
      const listed = await getJson(`${parsed.server}/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) => item.name === value);
      if (!secret) throw usageError(`unknown secret ${value}`);
      result = await postJson(
        `${parsed.server}/secrets/${secret.id}/rotate`,
        await parseSecretValuePayload(parsed.positional.slice(3), false),
      );
    } else if (cmd === "secret" && sub === "disable" && value) {
      const listed = await getJson(`${parsed.server}/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) => item.name === value);
      if (!secret) throw usageError(`unknown secret ${value}`);
      result = await postJson(
        `${parsed.server}/secrets/${secret.id}/disable`,
        {},
      );
    } else if (cmd === "secret" && sub === "grants") {
      result = await getJson(`${parsed.server}/hook-secret-grants`);
    } else if (cmd === "secret" && sub === "replace-grant" && value) {
      const option = parsed.positional.slice(3);
      if (option.length !== 2 || option[0] !== "--secret") {
        throw usageError("replace-grant requires --secret <name>");
      }
      const listed = await getJson(`${parsed.server}/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) =>
        item.name === option[1]
      );
      if (!secret) throw usageError(`unknown secret ${option[1]}`);
      result = await postJson(
        `${parsed.server}/hook-secret-grants/${value}/replace`,
        { expected_current_grant_id: value, secret_id: secret.id },
      );
    } else if (cmd === "secret" && sub === "revoke-grant" && value) {
      result = await postJson(
        `${parsed.server}/hook-secret-grants/${value}/revoke`,
        {},
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
    } else if (cmd === "migration" && sub === "validate" && value) {
      result = await postJson(
        `${parsed.server}/migrations/${value}/validate`,
        {},
      );
    } else if (cmd === "migration" && sub === "apply" && value) {
      const {
        acknowledgement,
        confirmationToken,
        lockTimeout,
      } = migrationApplyOptions(parsed.positional.slice(3));
      if (
        !acknowledgement ||
        (acknowledgement === "destructive" && !confirmationToken)
      ) {
        throw usageError(
          "migration apply requires exactly one of --safe, --reviewed, or --confirm-token <token>",
        );
      }
      result = await postJson(`${parsed.server}/migrations/${value}/apply`, {
        acknowledgement,
        confirmation_token: confirmationToken ?? null,
        ...lockTimeout ? { lock_timeout: lockTimeout } : {},
      });
    } else if (cmd === "migration" && sub === "inspect" && value) {
      const projection = parsed.positional.includes("--sql")
        ? "sql"
        : parsed.positional.includes("--violations")
        ? "violations"
        : "";
      result = await getJson(
        `${parsed.server}/migrations/${value}${
          projection ? `/${projection}` : ""
        }`,
      );
    } else if (cmd === "expression" && sub === "help") {
      const context = value ?? "query";
      result = await getJson(
        `${parsed.server}/api/v1/expressions/help?context=${
          encodeURIComponent(context)
        }`,
      );
    } else if (cmd === "expression" && sub === "validate" && value) {
      const args = parsed.positional.slice(3);
      const contextIndex = args.findIndex((arg) => arg === "--context");
      if (contextIndex < 0 || !args[contextIndex + 1]) {
        throw usageError("expression validate requires --context <context>");
      }
      const source = args.filter((_, index) =>
        index !== contextIndex && index !== contextIndex + 1
      ).join(" ");
      if (!source) {
        throw usageError("expression validate requires an expression");
      }
      const [publisher, pack, name] = splitDefinitionIdentity(value);
      result = await postJson(`${parsed.server}/api/v1/expressions/validate`, {
        definition: { kind: "resource", publisher, pack, name },
        context: args[contextIndex + 1],
        expression: source,
      });
    } else if (cmd === "query" && sub) {
      const relationship = sub === "relationship";
      const identity = relationship ? parsed.positional[2] : sub;
      if (!identity) throw usageError("query requires publisher/pack:name");
      if (!parsed.project) {
        throw usageError("query requires --project <UUID-or-slug>");
      }
      const project = await resolveProject(parsed.server, parsed.project);
      result = await postJson(
        `${parsed.server}/api/v1/queries`,
        parseQueryPayload(
          String(project.id),
          relationship ? "relationship" : "resource",
          identity,
          parsed.positional.slice(relationship ? 3 : 2),
        ),
      );
    } else if (cmd === "changeset" && sub === "stage") {
      result = await postJson(
        `${parsed.server}/api/v1/changesets/stage`,
        await readChangesetInput(parsed.positional.slice(2)),
      );
    } else if (cmd === "changeset" && sub === "inspect") {
      if (parsed.positional.length !== 3) {
        throw usageError("changeset inspect requires one stage id");
      }
      result = await getJson(
        `${parsed.server}/api/v1/changesets/${changesetId(value)}`,
      );
    } else if (cmd === "changeset" && sub === "cancel") {
      const id = changesetId(value);
      result = await postJson(
        `${parsed.server}/api/v1/changesets/${id}/cancel`,
        cancelPayload(parsed.positional.slice(3)),
      );
    } else if ((cmd === "view" || cmd === "history") && sub && value) {
      const relationship = sub === "relationship";
      const identity = relationship ? value : sub;
      const objectId = relationship ? parsed.positional[3] : value;
      if (!objectId) {
        throw usageError(
          `${cmd} relationship requires publisher/pack:name and UUID`,
        );
      }
      if (!isUuidV7(objectId)) {
        throw usageError("object id must be a lowercase UUIDv7");
      }
      const [publisher, pack, name] = splitDefinitionIdentity(identity);
      const projectId = await resolveReadProject(parsed);
      const options = cmd === "history"
        ? historyQuery(parsed.positional.slice(relationship ? 4 : 3))
        : (parsed.positional.length > (relationship ? 4 : 3)
          ? (() => {
            throw usageError("view does not accept additional options");
          })()
          : "");
      result = await getJson(
        `${parsed.server}/api/v1/projects/${projectId}/${
          relationship ? "relationships" : "objects"
        }/${publisher}/${pack}/${name}/${objectId}${
          cmd === "history" ? "/history" : ""
        }${options}`,
      );
    } else if (cmd === "metadata" && !sub) {
      result = await getJson(
        `${parsed.server}/metadata/packs${await metadataQuery(parsed, [])}`,
      );
    } else if (cmd === "metadata" && sub === "packs") {
      result = await getJson(
        `${parsed.server}/metadata/packs${await metadataQuery(
          parsed,
          parsed.positional.slice(2),
        )}`,
      );
    } else if (cmd === "metadata" && sub === "pack" && value) {
      const [publisher, pack] = splitPackIdentity(value);
      result = await getJson(
        `${parsed.server}/metadata/packs/${publisher}/${pack}${await metadataQuery(
          parsed,
          parsed.positional.slice(3),
        )}`,
      );
    } else if (cmd === "metadata" && sub && value) {
      const [publisher, pack, name] = splitDefinitionIdentity(value);
      const routeKind = ({
        resource: "resources",
        relationship: "relationships",
        lifecycle: "lifecycles",
        action: "actions",
        hook: "hooks",
        role: "roles",
        policy: "policies",
        seed: "seeds",
      } as Record<string, string>)[sub];
      if (!routeKind) throw usageError(`unknown metadata kind ${sub}`);
      result = await getJson(
        `${parsed.server}/metadata/packs/${publisher}/${pack}/${routeKind}/${name}${await metadataQuery(
          parsed,
          parsed.positional.slice(3),
        )}`,
      );
    } else {
      throw usageError(
        "usage: optctl status live/ready/bootstrap | bootstrap init | home | project list/create/view/update/archive/select | context set-project | pack preview <dir> | pack apply <dir> [--safe|--reviewed] [--timeout duration] | metadata [packs] | metadata pack <publisher/pack> | metadata resource/relationship/lifecycle/action/hook/role/policy/seed <publisher/pack:name> | secret list/create/rotate/disable/grants/grant/replace-grant/revoke-grant | action preview/commit <namespace.action> --input '{...}' | outbox status/drain/retry | migration inspect <id> [--sql|--violations] | migration validate <id> | migration apply <id> (--safe|--reviewed|--confirm-token <token>) [--timeout duration] | query <namespace.resource> [--where expr] [--fields a,b] [--sort field:desc] [--limit n] [--cursor c] | changeset stage <json-file> | changeset inspect <stage-id> | changeset cancel <stage-id> [--reason text] | --project <selector> view publisher/pack:name <uuid> | --project <selector> history publisher/pack:name <uuid> [--limit n] [--cursor c] | --project <selector> view relationship publisher/pack:name <uuid> | --project <selector> history relationship publisher/pack:name <uuid> [--limit n] [--cursor c]",
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
    const unsupported = error instanceof Error &&
      error.message === "process_inspection_unsupported";
    const unavailable = error instanceof TypeError;
    const envelope = errorEnvelope({
      code: unsupported
        ? "process_inspection_unsupported"
        : unavailable
        ? "unavailable"
        : "internal_error",
      message: unsupported
        ? "process inspection is unsupported on this operating system"
        : unavailable
        ? "server is unavailable"
        : error instanceof Error
        ? error.message
        : String(error),
      details: {},
    });
    return { stdout: "", stderr: render(envelope, parse(args).json), code: 1 };
  }
}
