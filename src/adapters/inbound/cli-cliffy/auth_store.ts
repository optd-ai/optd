import {
  authDataRoot,
  FilesystemLocalAuthStore,
  normalizeOrigin,
} from "../../outbound/local-auth-store/filesystem.ts";
import { dirname, join } from "jsr:@std/path";
import { platformProcessInspector } from "../../outbound/process-inspection/linux.ts";
import type { LocalCredential } from "../../../application/ports/local_auth.ts";
import type { ProcessIdentity } from "../../../application/ports/process_inspection.ts";

export type LocalContext = {
  name: string;
  origin: string;
  projectId?: string;
  projectSlug?: string;
};
type ContextFile = {
  schema_version: 1;
  record_type: "contexts";
  active: string | null;
  contexts: LocalContext[];
};

export type OriginState = {
  token?: string;
  requestToken?: string;
  requestSessionId?: string;
  projectId?: string;
  projectSlug?: string;
  username?: string;
  authorizationId?: string;
  resetNonces?: Record<string, string>;
  resetCapabilities?: Record<string, string>;
  authorizationNonces?: Record<string, string>;
};

const contextPath = () => join(authDataRoot(), "contexts.json");

async function readContexts(): Promise<ContextFile> {
  try {
    const value = JSON.parse(await Deno.readTextFile(contextPath()));
    if (
      value?.schema_version !== 1 ||
      value.record_type !== "contexts" ||
      (value.active !== null && typeof value.active !== "string") ||
      !Array.isArray(value.contexts)
    ) throw new Error("invalid local context store");
    return value as ContextFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        schema_version: 1,
        record_type: "contexts",
        active: null,
        contexts: [],
      };
    }
    throw error;
  }
}

async function writeContexts(value: ContextFile): Promise<void> {
  const path = contextPath();
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temporary, JSON.stringify(value), {
    createNew: true,
    mode: 0o600,
  });
  await Deno.rename(temporary, path);
  await Deno.chmod(path, 0o600);
}

function contextName(value: string): string {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error("context name must be lowercase letters, digits, _ or -");
  }
  return value;
}

export async function activeContextOrigin(): Promise<string | undefined> {
  const value = await readContexts();
  return value.contexts.find((item) => item.name === value.active)?.origin;
}

export async function listContexts(): Promise<{
  active: string | null;
  contexts: LocalContext[];
}> {
  const value = await readContexts();
  return {
    active: value.active,
    contexts: value.contexts.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function showContext(name?: string): Promise<LocalContext> {
  const value = await readContexts();
  const selected = name ?? value.active;
  const context = value.contexts.find((item) => item.name === selected);
  if (!context) throw new Error(`unknown context ${selected ?? "(none)"}`);
  const state = await store().readState(context.origin) as OriginState;
  return {
    ...context,
    ...(state.projectId ? { projectId: state.projectId } : {}),
    ...(state.projectSlug ? { projectSlug: state.projectSlug } : {}),
  };
}

export async function addContext(
  nameValue: string,
  originValue: string,
  activate = false,
): Promise<LocalContext> {
  const name = contextName(nameValue);
  const origin = normalizeOrigin(originValue);
  const value = await readContexts();
  if (value.contexts.some((item) => item.name === name)) {
    throw new Error(`context ${name} already exists`);
  }
  const context = { name, origin };
  value.contexts.push(context);
  if (activate || value.active === null) value.active = name;
  await writeContexts(value);
  return context;
}

export async function ensureContext(originValue: string): Promise<void> {
  const origin = normalizeOrigin(originValue);
  const value = await readContexts();
  const existing = value.contexts.find((item) => item.origin === origin);
  if (existing) value.active = existing.name;
  else {
    let name = new URL(origin).hostname.replace(/[^a-z0-9_-]/g, "-");
    if (!/^[a-z]/.test(name)) name = `server-${name}`;
    let candidate = name;
    for (
      let suffix = 2;
      value.contexts.some((item) => item.name === candidate);
      suffix++
    ) {
      candidate = `${name}-${suffix}`;
    }
    value.contexts.push({ name: candidate, origin });
    value.active = candidate;
  }
  await writeContexts(value);
}

export async function useContext(nameValue: string): Promise<LocalContext> {
  const name = contextName(nameValue);
  const value = await readContexts();
  const context = value.contexts.find((item) => item.name === name);
  if (!context) throw new Error(`unknown context ${name}`);
  value.active = name;
  await writeContexts(value);
  return context;
}

export async function removeContext(nameValue: string): Promise<LocalContext> {
  const name = contextName(nameValue);
  const value = await readContexts();
  const index = value.contexts.findIndex((item) => item.name === name);
  if (index < 0) throw new Error(`unknown context ${name}`);
  const [removed] = value.contexts.splice(index, 1);
  if (value.active === name) value.active = value.contexts[0]?.name ?? null;
  await writeContexts(value);
  return removed;
}

function store(): FilesystemLocalAuthStore {
  return FilesystemLocalAuthStore.create(platformProcessInspector());
}

function stopPid(): number | undefined {
  const raw = Deno.env.get("OPERANT_AUTH_TREE_STOP_PID");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid OPERANT_AUTH_TREE_STOP_PID");
  }
  return value;
}

async function parentIdentity(): Promise<ProcessIdentity> {
  return await platformProcessInspector().inspect(Deno.ppid);
}

export async function selectedCredential(
  origin: string,
): Promise<LocalCredential | null> {
  return await store().select(origin, Deno.ppid, stopPid());
}

export async function readOrigin(origin: string): Promise<OriginState> {
  const localStore = store();
  const state = await localStore.readState(origin) as OriginState;
  const selected = await localStore.select(origin, Deno.ppid, stopPid());
  const request = await localStore.requestCredential(origin);
  return {
    ...state,
    token: selected?.token,
    authorizationId: selected?.authorizationId,
    requestToken: request?.token,
  };
}

export async function writeOrigin(
  origin: string,
  update: OriginState,
): Promise<void> {
  const needsAnchor = Object.hasOwn(update, "token");
  await store().updateState(
    origin,
    update as Record<string, unknown>,
    needsAnchor ? await parentIdentity() : undefined,
  );
}

export async function removeLocalAuthorization(
  origin: string,
  id: string,
): Promise<void> {
  await store().removeAuthorization(origin, id);
}

export async function cleanupLocalAuth(origin?: string): Promise<number> {
  return await store().cleanup(origin);
}

export async function doctorLocalAuth(fix = false) {
  return await store().doctor(fix);
}

export async function localAuthStatus(origin: string) {
  const localStore = store();
  const state = await localStore.readState(origin) as OriginState;
  const selected = await localStore.select(origin, Deno.ppid, stopPid());
  const request = await localStore.requestCredential(origin);
  return {
    ok: true,
    data: {
      server_origin: new URL(origin).origin,
      authenticated: selected !== null,
      credential_type: selected?.kind ?? null,
      session_id: selected?.sessionId ?? null,
      authorization_id: selected?.authorizationId ?? null,
      anchor_pid: selected?.anchor?.pid ?? null,
      anchor_start_ticks: selected?.anchor?.startTicks ?? null,
      anchor_uid: selected?.anchor?.uid ?? null,
      anchor_boot_id: selected?.anchor?.bootId ?? null,
      username: state.username ?? null,
      project_id: state.projectId ?? null,
      request_credential_available: request !== null,
      selection: selected
        ? "nearest verified process binding"
        : "no matching process binding",
    },
  };
}
