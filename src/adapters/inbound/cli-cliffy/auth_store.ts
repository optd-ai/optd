import { FilesystemLocalAuthStore } from "../../outbound/local-auth-store/filesystem.ts";
import { platformProcessInspector } from "../../outbound/process-inspection/linux.ts";
import type { LocalCredential } from "../../../application/ports/local_auth.ts";
import type { ProcessIdentity } from "../../../application/ports/process_inspection.ts";

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
      username: state.username ?? null,
      project_id: state.projectId ?? null,
      request_credential_available: request !== null,
      selection: selected
        ? "nearest verified process binding"
        : "no matching process binding",
    },
  };
}
