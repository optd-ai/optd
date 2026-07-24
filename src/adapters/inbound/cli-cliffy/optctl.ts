// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { Command } from "jsr:@cliffy/command";
import { walk } from "jsr:@std/fs/walk";
import { relative } from "jsr:@std/path";
import { formatToon } from "../../outbound/toon/format.ts";
import {
  type ErrorEnvelope,
  errorEnvelope,
} from "../../../schemas/api/contracts.ts";
import {
  activeContextOrigin,
  addContext,
  cleanupLocalAuth,
  doctorLocalAuth,
  ensureContext,
  listContexts,
  localAuthStatus,
  readOrigin,
  removeContext,
  removeLocalAuthorization,
  showContext,
  useContext,
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

const REQUEST_DEADLINE_MS = 30_000;
function boundedFetch(input: string | URL | Request, init: RequestInit = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_DEADLINE_MS),
  });
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
    await boundedFetch(url, {
      headers: await credentialHeaders(url),
      redirect: "error",
    }),
  );
}
async function postJson(url: string, payload: unknown): Promise<unknown> {
  return await decodeJsonResponse(
    await boundedFetch(url, {
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
    await boundedFetch(url, {
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
    else if (!commandSeen && arg === "--server") {
      parsed.server = args[++i] ?? parsed.server;
    } else if (!commandSeen && arg.startsWith("--server=")) {
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

async function resourceMetadata(
  server: string,
  identity: string,
): Promise<Record<string, unknown>> {
  const [publisher, pack, name] = splitDefinitionIdentity(identity);
  return envelopeData(
    await getJson(
      `${server}/api/v1/metadata/packs/${publisher}/${pack}/resources/${name}`,
    ),
  );
}

async function stageResourceCommand(
  parsed: Parsed,
  command: "create" | "update" | "transition",
): Promise<unknown> {
  const identity = parsed.positional[1];
  if (!identity) throw usageError(`${command} requires publisher/pack:name`);
  splitDefinitionIdentity(identity);
  const projectId = await resolveReadProject(parsed);
  const args = parsed.positional.slice(2);
  const commit = commitPayloadOptions(args);
  const remaining = commit.remaining;
  const stageOnly = remaining.includes("--stage");
  const filtered = remaining.filter((arg) => arg !== "--stage");
  const inputAt = filtered.findIndex((arg) => arg === "--input");
  if (inputAt < 0 || !filtered[inputAt + 1]) {
    throw usageError(`${command} requires --input <JSON-or-file>`);
  }
  const fields = await resolveActionInput(filtered.slice(inputAt, inputAt + 2));
  const before = filtered.slice(0, inputAt);
  const after = filtered.slice(inputAt + 2);
  const operation: Record<string, unknown> = {
    op: command,
    project_id: projectId,
    resource: identity,
  };
  if (command === "create") operation.fields = fields;
  else {
    const objectId = before[0];
    if (!objectId || !isUuidV7(objectId)) {
      throw usageError(`${command} requires a lowercase UUIDv7 object id`);
    }
    operation.object_id = objectId;
    const expected = option(after, "--version") ??
      option(before.slice(1), "--version");
    if (!expected || !/^[1-9][0-9]*$/.test(expected)) {
      throw usageError(`${command} requires --version <positive-integer>`);
    }
    operation.expected_version = Number(expected);
    if (command === "update") operation.set = fields;
    else {
      const to = option(after, "--to") ?? option(before.slice(1), "--to");
      if (!to) throw usageError("transition requires --to <state>");
      operation.to = to;
      operation.set = fields;
    }
  }
  const known = new Set(["--version", "--to"]);
  for (let index = 0; index < after.length; index++) {
    const arg = after[index];
    if (known.has(arg)) index++;
    else if (![...known].some((name) => arg.startsWith(`${name}=`))) {
      throw usageError(`unknown ${command} option ${arg}`);
    }
  }
  const staged = await postJson(`${parsed.server}/api/v1/changesets/stage`, {
    operations: [operation],
  });
  if (stageOnly) return staged;
  const stage = envelopeData(staged);
  return await postJson(
    `${parsed.server}/api/v1/changesets/${String(stage.id)}/commit`,
    commit.payload,
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

async function resolveActionInput(
  args: string[],
): Promise<Record<string, unknown>> {
  if (args.length !== 2 || args[0] !== "--input") {
    throw usageError("action stage requires exactly --input <JSON-or-file>");
  }
  try {
    const value = JSON.parse(args[1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value;
  } catch {
    const value = await readJsonFile(args[1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw usageError("action input must be a JSON object");
    }
    return value as Record<string, unknown>;
  }
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

function commitPayload(args: string[]): { lock_timeout?: string } {
  if (!args.length) return {};
  const parsed = commitPayloadOptions(args);
  if (parsed.remaining.length) {
    throw usageError(
      "changeset commit accepts only --timeout <positive-duration>",
    );
  }
  return parsed.payload;
}

function commitPayloadOptions(args: string[]): {
  payload: { lock_timeout?: string };
  remaining: string[];
} {
  const remaining: string[] = [];
  let timeout: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--timeout") {
      if (timeout !== undefined) throw usageError("duplicate option --timeout");
      timeout = args[++index];
    } else if (arg.startsWith("--timeout=")) {
      if (timeout !== undefined) throw usageError("duplicate option --timeout");
      timeout = arg.slice("--timeout=".length);
    } else remaining.push(arg);
  }
  if (timeout !== undefined && !/^[1-9][0-9]*(ms|s|m)$/.test(timeout)) {
    throw usageError("--timeout requires a positive duration");
  }
  return {
    payload: timeout === undefined ? {} : { lock_timeout: timeout },
    remaining,
  };
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
      "command requires global --project <uuid-or-slug> or an active local Project selection",
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
        await boundedFetch(
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
        await boundedFetch(
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

const CLI_GROUPS: ReadonlyArray<readonly [string, string, readonly string[]]> =
  [
    ["status", "Inspect liveness, readiness, and bootstrap state.", [
      "live",
      "ready",
      "bootstrap",
    ]],
    ["bootstrap", "Create the first authenticated human.", ["init"]],
    ["auth", "Manage human and agent authentication.", [
      "login",
      "logout",
      "status",
      "whoami",
      "sessions",
      "roles",
      "request",
      "approve",
      "deny",
      "wait",
      "authorizations",
      "revoke",
      "isolate",
      "doctor",
      "cleanup",
      "user",
      "password",
      "password-policy",
      "password-reset",
      "recover",
    ]],
    ["context", "Manage local server and Project contexts.", [
      "list",
      "show",
      "add",
      "use",
      "set-project",
      "remove",
    ]],
    ["project", "Manage platform Projects.", [
      "list",
      "create",
      "view",
      "update",
      "archive",
      "select",
    ]],
    ["metadata", "Inspect active pack metadata and AXI guidance.", [
      "packs",
      "pack",
      "resource",
      "relationship",
      "lifecycle",
      "action",
      "hook",
      "role",
      "policy",
      "seed",
    ]],
    ["pack", "Preview, apply, and inspect packs.", [
      "preview",
      "apply",
      "inspect",
    ]],
    ["migration", "Inspect, validate, and apply migration plans.", [
      "inspect",
      "validate",
      "apply",
    ]],
    ["changeset", "Stage and manage immutable changesets.", [
      "stage",
      "inspect",
      "commit",
      "cancel",
      "approvals",
      "approve",
      "reject",
    ]],
    ["action", "Stage or directly commit semantic actions.", [
      "stage",
      "commit",
    ]],
    ["seed", "Stage or directly commit seed reconciliation.", [
      "stage",
      "commit",
    ]],
    ["assignment", "Manage role assignments.", ["role"]],
    ["policy", "Manage policy assignments.", ["assignment"]],
    ["secret", "Manage encrypted secrets and Hook grants.", [
      "list",
      "create",
      "rotate",
      "disable",
      "grants",
      "grant",
      "replace-grant",
      "revoke-grant",
    ]],
    ["outbox", "Inspect and administer durable deliveries.", [
      "list",
      "inspect",
      "attempts",
      "retry",
      "cancel",
      "drain",
    ]],
    ["expression", "Inspect and validate expression syntax.", [
      "help",
      "validate",
    ]],
  ];

function cliCommand() {
  const root = new Command()
    .name("optctl")
    .description("Content-first Operant control client.")
    .option("--server <origin:string>", "Operant server origin.")
    .option(
      "--project <project:string>",
      "Explicit Project UUID or local selector.",
    )
    .option("--json", "Emit the canonical server JSON envelope.")
    .option("--verbose", "Include request context without credentials.");
  for (const [name, description, subcommands] of CLI_GROUPS) {
    const group = new Command().name(name).description(description);
    for (const subcommand of subcommands) {
      group.command(
        subcommand,
        new Command().description(`${subcommand} ${name} operation.`),
      );
    }
    root.command(name, group);
  }
  for (
    const [name, description] of [
      ["home", "Show live active-pack and Project guidance."],
      ["resources", "List active resources and their AXI purposes."],
      ["list", "List resource objects using metadata defaults."],
      ["search", "Search resource objects using metadata guidance."],
      ["create", "Stage or commit a resource create operation."],
      ["update", "Stage or commit a resource update operation."],
      ["transition", "Stage or commit a resource transition operation."],
      ["query", "Query committed resource or relationship facts."],
      ["view", "Read one committed object or relationship."],
      ["history", "Read immutable object or relationship history."],
    ] as const
  ) root.command(name, new Command().description(description));
  return root;
}

function helpText(args: string[]): string {
  const words = args.filter((arg) => arg !== "--help" && arg !== "-h");
  const group = CLI_GROUPS.find(([name]) => name === words[0]);
  if (!group) return cliCommand().getHelp();
  const [name, description, subcommands] = group;
  if (words[1] && subcommands.includes(words[1])) {
    return [
      `Usage: optctl ${name} ${words[1]} [options]`,
      "",
      `${words[1]} ${name} operation.`,
      "",
      "Options:",
      "  -h, --help  Show this help.",
      "",
    ].join("\n");
  }
  return [
    `Usage: optctl ${name} <command>`,
    "",
    description,
    "",
    "Commands:",
    ...subcommands.map((subcommand) => `  ${subcommand}`),
    "",
  ].join("\n");
}

export async function runOptctl(args: string[]): Promise<OptctlRunResult> {
  try {
    if (args.includes("--help") || args.includes("-h")) {
      return { stdout: helpText(args), stderr: "", code: 0 };
    }
    const parsed = parse(args);
    if (
      !args.some((arg) => arg === "--server" || arg.startsWith("--server="))
    ) {
      parsed.server = (await activeContextOrigin()) ?? parsed.server;
    }
    let [cmd, sub, value] = parsed.positional;
    if (!cmd) {
      cmd = "home";
      parsed.positional = ["home"];
    }
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
        await boundedFetch(`${parsed.server}/api/v1/auth/bootstrap`, {
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
      await ensureContext(parsed.server);
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
        await boundedFetch(`${parsed.server}/api/v1/auth/login`, {
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
        await boundedFetch(
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
          await boundedFetch(
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
          await boundedFetch(
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
          await boundedFetch(
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
        await boundedFetch(url, {
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
        await boundedFetch(`${parsed.server}/api/v1/auth/requests`, {
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
          await boundedFetch(
            `${parsed.server}/api/v1/auth/password-reset/requests`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": idempotencyKey,
              },
              body: JSON.stringify({
                username,
                redemption_nonce_hash: await tokenDigest(nonce),
              }),
            },
          ),
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
            await boundedFetch(
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
            await boundedFetch(
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
            await boundedFetch(
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
        await boundedFetch(`${parsed.server}/api/v1/auth/recovery/complete`, {
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
    } else if (cmd === "context" && sub === "list") {
      if (parsed.positional.length !== 2) {
        throw usageError("context list accepts no arguments");
      }
      result = { ok: true, data: await listContexts() };
    } else if (cmd === "context" && sub === "show") {
      if (parsed.positional.length > 3) {
        throw usageError("context show accepts at most one context name");
      }
      result = { ok: true, data: await showContext(value) };
    } else if (cmd === "context" && sub === "add" && value) {
      const contextArgs = parsed.positional.slice(3);
      const origin = option(contextArgs, "--server");
      const project = option(contextArgs, "--project");
      if (!origin) throw usageError("context add requires --server <origin>");
      const context = await addContext(value, origin);
      if (project) {
        const selected = await resolveProject(context.origin, project);
        await writeOrigin(context.origin, {
          projectId: String(selected.id),
          projectSlug: String(selected.slug),
        });
      }
      result = { ok: true, data: await showContext(value) };
    } else if (cmd === "context" && sub === "use" && value) {
      if (parsed.positional.length !== 3) {
        throw usageError("context use accepts exactly one context name");
      }
      result = { ok: true, data: await useContext(value) };
    } else if (cmd === "context" && sub === "remove" && value) {
      if (parsed.positional.length !== 3) {
        throw usageError("context remove accepts exactly one context name");
      }
      result = { ok: true, data: await removeContext(value) };
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
    } else if (cmd === "home" || cmd === "resources") {
      result = await getJson(
        `${parsed.server}/api/v1/metadata/home${await metadataQuery(
          parsed,
          [],
        )}`,
      );
    } else if ((cmd === "list" || cmd === "search") && sub) {
      const projectId = await resolveReadProject(parsed);
      const args = parsed.positional.slice(2);
      const metadata = await resourceMetadata(parsed.server, sub);
      const axi = metadata.axi as Record<string, unknown> | undefined;
      const list = axi?.list as Record<string, unknown> | undefined;
      const queryArgs = [...args];
      if (
        !args.some((arg) => arg === "--fields" || arg.startsWith("--fields="))
      ) {
        const defaultFields = list?.defaultFields;
        if (Array.isArray(defaultFields) && defaultFields.length) {
          queryArgs.push("--fields", defaultFields.join(","));
        }
      }
      if (cmd === "search") {
        const text = option(queryArgs, "--text");
        const textIndex = queryArgs.findIndex((arg) =>
          arg === "--text" || arg.startsWith("--text=")
        );
        if (!text || textIndex < 0) {
          throw usageError("search requires --text <value>");
        }
        queryArgs.splice(textIndex, queryArgs[textIndex] === "--text" ? 2 : 1);
        const search = axi?.search as Record<string, unknown> | undefined;
        const fields = search?.fields;
        if (!Array.isArray(fields) || !fields.length) {
          throw usageError(`${sub} does not declare AXI search fields`);
        }
        const literal = JSON.stringify(text);
        queryArgs.push(
          "--where",
          fields.map((field) => `${String(field)} == ${literal}`).join(" || "),
        );
      }
      result = await postJson(
        `${parsed.server}/api/v1/queries`,
        parseQueryPayload(projectId, "resource", sub, queryArgs),
      );
    } else if (cmd === "create" || cmd === "update" || cmd === "transition") {
      result = await stageResourceCommand(parsed, cmd);
    } else if (cmd === "pack" && sub === "preview" && value) {
      result = await postMultipart(
        `${parsed.server}/api/v1/packs/preview`,
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
        `${parsed.server}/api/v1/packs/preview`,
        value,
      ) as {
        data: { plan: { id: string; plan_digest: string; class: string } };
      };
      const plan = preview.data.plan;
      const validation = await postJson(
        `${parsed.server}/api/v1/migrations/${plan.id}/validate`,
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
          `${parsed.server}/api/v1/migrations/${plan.id}/apply`,
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
      cmd === "action" && (sub === "stage" || sub === "commit") && value
    ) {
      const project = { id: await resolveReadProject(parsed) };
      const [publisher, pack, name] = splitDefinitionIdentity(value);
      const actionArgs = parsed.positional.slice(3);
      const commit = sub === "commit" ? commitPayloadOptions(actionArgs) : null;
      const staged = await postJson(
        `${parsed.server}/api/v1/actions/${publisher}/${pack}/${name}/stage`,
        {
          project_id: project.id,
          input: await resolveActionInput(commit?.remaining ?? actionArgs),
        },
      );
      if (sub === "stage") result = staged;
      else {
        const stage = envelopeData(staged);
        result = stage.stage === null ? staged : await postJson(
          `${parsed.server}/api/v1/changesets/${String(stage.id)}/commit`,
          commit?.payload ?? {},
        );
      }
    } else if (
      cmd === "seed" && (sub === "stage" || sub === "commit") && value
    ) {
      const project = { id: await resolveReadProject(parsed) };
      const [publisher, pack] = splitPackIdentity(value);
      const seedArgs = parsed.positional.slice(3);
      const commit = sub === "commit" ? commitPayloadOptions(seedArgs) : null;
      const args = commit?.remaining ?? seedArgs;
      const all = args.includes("--all");
      const names = options(args, "--seed");
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--all" || arg.startsWith("--seed=")) continue;
        if (arg === "--seed" && args[index + 1]) {
          index++;
          continue;
        }
        throw usageError(`unknown seed ${sub} option ${arg}`);
      }
      const staged = await postJson(
        `${parsed.server}/api/v1/packs/${publisher}/${pack}/seeds/stage`,
        {
          project_id: project.id,
          all,
          ...(names.length ? { seed_names: names } : {}),
        },
      );
      if (sub === "stage") result = staged;
      else {
        const stage = envelopeData(staged).stage as
          | Record<string, unknown>
          | null;
        result = stage === null ? staged : await postJson(
          `${parsed.server}/api/v1/changesets/${String(stage.id)}/commit`,
          commit?.payload ?? {},
        );
      }
    } else if (cmd === "secret" && sub === "list") {
      result = await getJson(`${parsed.server}/api/v1/secrets`);
    } else if (cmd === "secret" && sub === "create" && value) {
      result = await postJson(`${parsed.server}/api/v1/secrets`, {
        name: value,
        ...await parseSecretValuePayload(parsed.positional.slice(3), true),
      });
    } else if (cmd === "secret" && sub === "rotate" && value) {
      const listed = await getJson(`${parsed.server}/api/v1/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) => item.name === value);
      if (!secret) throw usageError(`unknown secret ${value}`);
      result = await postJson(
        `${parsed.server}/api/v1/secrets/${secret.id}/rotate`,
        await parseSecretValuePayload(parsed.positional.slice(3), false),
      );
    } else if (cmd === "secret" && sub === "disable" && value) {
      const listed = await getJson(`${parsed.server}/api/v1/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) => item.name === value);
      if (!secret) throw usageError(`unknown secret ${value}`);
      result = await postJson(
        `${parsed.server}/api/v1/secrets/${secret.id}/disable`,
        {},
      );
    } else if (cmd === "secret" && sub === "grants") {
      result = await getJson(`${parsed.server}/api/v1/hook-secret-grants`);
    } else if (cmd === "secret" && sub === "grant" && value) {
      const options = parsed.positional.slice(3);
      let hookIdentity: string | undefined;
      let slot: string | undefined;
      for (let index = 0; index < options.length; index++) {
        if (options[index] === "--hook") hookIdentity = options[++index];
        else if (options[index] === "--slot") slot = options[++index];
        else throw usageError(`unknown grant option ${options[index]}`);
      }
      if (!hookIdentity || !slot) {
        throw usageError("grant requires --hook <hook> --slot <slot>");
      }
      const listed = await getJson(`${parsed.server}/api/v1/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) => item.name === value);
      if (!secret) throw usageError(`unknown secret ${value}`);
      const [publisher, pack, hookName] = splitDefinitionIdentity(hookIdentity);
      const metadata = await getJson(
        `${parsed.server}/api/v1/metadata/packs/${publisher}/${pack}/hooks/${hookName}?include_security=true`,
      ) as {
        data?: {
          hook_revision_id?: string;
          security_digest?: string;
          security?: { secret_slots?: Array<{ slot?: string }> };
        };
      };
      if (
        !metadata.data?.hook_revision_id || !metadata.data.security_digest ||
        !metadata.data.security?.secret_slots?.some((item) =>
          item.slot === slot
        )
      ) {
        throw usageError(`hook ${hookIdentity} does not declare slot ${slot}`);
      }
      result = await postJson(`${parsed.server}/api/v1/hook-secret-grants`, {
        hook_revision_id: metadata.data.hook_revision_id,
        expected_security_digest: metadata.data.security_digest,
        slot,
        secret_id: secret.id,
      });
    } else if (cmd === "secret" && sub === "replace-grant" && value) {
      const option = parsed.positional.slice(3);
      if (option.length !== 2 || option[0] !== "--secret") {
        throw usageError("replace-grant requires --secret <name>");
      }
      const listed = await getJson(`${parsed.server}/api/v1/secrets`) as {
        data?: { secrets?: Array<{ id: string; name: string }> };
      };
      const secret = listed.data?.secrets?.find((item) =>
        item.name === option[1]
      );
      if (!secret) throw usageError(`unknown secret ${option[1]}`);
      result = await postJson(
        `${parsed.server}/api/v1/hook-secret-grants/${value}/replace`,
        { expected_current_grant_id: value, secret_id: secret.id },
      );
    } else if (cmd === "secret" && sub === "revoke-grant" && value) {
      result = await postJson(
        `${parsed.server}/api/v1/hook-secret-grants/${value}/revoke`,
        {},
      );
    } else if (cmd === "outbox" && sub === "list") {
      const options = cliOptions(parsed.positional.slice(2), [
        "status",
        "hook",
        "event",
        "from",
        "to",
        "limit",
        "cursor",
      ]);
      const query = new URLSearchParams(options).toString();
      result = await getJson(
        `${parsed.server}/api/v1/outbox${query ? `?${query}` : ""}`,
      );
    } else if (cmd === "outbox" && sub === "inspect" && value) {
      if (parsed.positional.length !== 3) {
        throw usageError("outbox inspect accepts exactly one delivery ID");
      }
      result = await getJson(`${parsed.server}/api/v1/outbox/${value}`);
    } else if (cmd === "outbox" && sub === "attempts" && value) {
      const options = cliOptions(parsed.positional.slice(3), [
        "limit",
        "cursor",
      ]);
      const query = new URLSearchParams(options).toString();
      result = await getJson(
        `${parsed.server}/api/v1/outbox/${value}/attempts${
          query ? `?${query}` : ""
        }`,
      );
    } else if (cmd === "outbox" && sub === "drain") {
      const options = cliOptions(parsed.positional.slice(2), ["limit"]);
      result = await postJson(`${parsed.server}/api/v1/outbox/drain`, {
        ...(options.limit === undefined
          ? {}
          : { limit: Number(options.limit) }),
      });
    } else if (cmd === "outbox" && sub === "retry" && value) {
      const options = cliOptions(parsed.positional.slice(3), ["reason"]);
      result = await postJson(`${parsed.server}/api/v1/outbox/${value}/retry`, {
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
    } else if (cmd === "outbox" && sub === "cancel" && value) {
      const options = cliOptions(parsed.positional.slice(3), ["reason"]);
      result = await postJson(
        `${parsed.server}/api/v1/outbox/${value}/cancel`,
        {
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
      );
    } else if (cmd === "migration" && sub === "validate" && value) {
      result = await postJson(
        `${parsed.server}/api/v1/migrations/${value}/validate`,
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
      result = await postJson(
        `${parsed.server}/api/v1/migrations/${value}/apply`,
        {
          acknowledgement,
          confirmation_token: confirmationToken ?? null,
          ...lockTimeout ? { lock_timeout: lockTimeout } : {},
        },
      );
    } else if (cmd === "migration" && sub === "inspect" && value) {
      const projection = parsed.positional.includes("--sql")
        ? "sql"
        : parsed.positional.includes("--violations")
        ? "violations"
        : "";
      result = await getJson(
        `${parsed.server}/api/v1/migrations/${value}${
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
    } else if (cmd === "changeset" && sub === "commit") {
      const id = changesetId(value);
      result = await postJson(
        `${parsed.server}/api/v1/changesets/${id}/commit`,
        commitPayload(parsed.positional.slice(3)),
      );
    } else if (cmd === "changeset" && sub === "approvals") {
      result = await getJson(
        `${parsed.server}/api/v1/changesets/${changesetId(value)}/approvals`,
      );
    } else if (cmd === "changeset" && (sub === "approve" || sub === "reject")) {
      const id = changesetId(value);
      const requirementId = changesetId(parsed.positional[3]);
      const decisionArgs = parsed.positional.slice(4);
      const reason = option(decisionArgs, "--reason");
      if (sub === "reject" && !reason?.trim()) {
        throw usageError("changeset reject requires --reason");
      }
      result = await postJson(
        `${parsed.server}/api/v1/changesets/${id}/approvals/${requirementId}/decide`,
        { decision: sub, ...(reason !== undefined ? { reason } : {}) },
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
        `${parsed.server}/api/v1/metadata/packs${await metadataQuery(
          parsed,
          [],
        )}`,
      );
    } else if (cmd === "metadata" && sub === "packs") {
      result = await getJson(
        `${parsed.server}/api/v1/metadata/packs${await metadataQuery(
          parsed,
          parsed.positional.slice(2),
        )}`,
      );
    } else if (cmd === "metadata" && sub === "pack" && value) {
      const [publisher, pack] = splitPackIdentity(value);
      result = await getJson(
        `${parsed.server}/api/v1/metadata/packs/${publisher}/${pack}${await metadataQuery(
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
        `${parsed.server}/api/v1/metadata/packs/${publisher}/${pack}/${routeKind}/${name}${await metadataQuery(
          parsed,
          parsed.positional.slice(3),
        )}`,
      );
    } else {
      throw usageError(
        "unknown command; run optctl --help or optctl <group> --help",
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

function cliOptions(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw usageError(`unexpected argument ${argument}`);
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    if (!allowed.includes(name)) throw usageError(`unknown option --${name}`);
    if (Object.hasOwn(result, name)) {
      throw usageError(`duplicate option --${name}`);
    }
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw usageError(`--${name} requires a value`);
    }
    result[name] = value;
  }
  return result;
}
