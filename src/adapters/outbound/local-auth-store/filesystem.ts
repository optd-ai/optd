import { basename, dirname, isAbsolute, join, resolve } from "jsr:@std/path";
import type {
  DoctorFinding,
  DoctorReport,
  LocalBinding,
  LocalCredential,
  LocalCredentialKind,
} from "../../../application/ports/local_auth.ts";
import {
  type ProcessIdentity,
  type ProcessInspector,
  sameProcess,
} from "../../../application/ports/process_inspection.ts";

const encoder = new TextEncoder();
const SCHEMA_VERSION = 1;

type ServerRecord = {
  schema_version: 1;
  record_type: "server";
  origin: string;
  created_at: string;
  updated_at: string;
  state: Record<string, unknown>;
};
type SessionRecord = {
  schema_version: 1;
  record_type: "session";
  origin: string;
  id: string;
  credential_type: LocalCredentialKind;
  authorization_id?: string;
  created_at: string;
  updated_at: string;
};

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash
  ) {
    throw new Error(
      "server origin must not contain credentials, path, query, or fragment",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("server origin scheme must be http or https");
  }
  const loopback = url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" || url.hostname === "::1";
  if (
    url.protocol === "http:" && !loopback &&
    Deno.env.get("OPTD_INSECURE_HTTP") !== "1"
  ) {
    throw new Error("remote HTTP requires OPTD_INSECURE_HTTP=1");
  }
  return url.origin.toLowerCase();
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function authDataRoot(): string {
  if (Deno.build.os === "windows") {
    return join(Deno.env.get("LOCALAPPDATA") ?? ".", "optd", "auth");
  }
  if (Deno.build.os === "darwin") {
    return join(
      Deno.env.get("HOME") ?? ".",
      "Library",
      "Application Support",
      "optd",
      "auth",
    );
  }
  return join(
    Deno.env.get("XDG_DATA_HOME") ??
      join(Deno.env.get("HOME") ?? ".", ".local", "share"),
    "optd",
    "auth",
  );
}

async function firstSymlinkComponent(
  path: string,
  allowMissing = false,
): Promise<string | null> {
  if (Deno.build.os === "windows") return null;
  const absolute = isAbsolute(path) ? path : resolve(path);
  let current = "/";
  for (const component of absolute.split("/").filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await Deno.lstat(current)).isSymlink) return current;
    } catch (error) {
      if (allowMissing && error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }
  return null;
}

async function assertNoSymlinkComponents(
  path: string,
  allowMissing = false,
): Promise<void> {
  const symlink = await firstSymlinkComponent(path, allowMissing);
  if (symlink) throw new Error(`unsafe auth store symlink: ${symlink}`);
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await assertNoSymlinkComponents(dirname(path));
  if (await exists(path)) await assertNoSymlinkComponents(path);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${Deno.pid}.${crypto.randomUUID()}.tmp`,
  );
  await assertNoSymlinkComponents(temporary, true);
  const file = await Deno.open(temporary, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    await file.write(encoder.encode(data));
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.rename(temporary, path);
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
}

async function readPrivateText(path: string): Promise<string> {
  await assertNoSymlinkComponents(path);
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`unsafe auth store path: ${path}`);
  }
  assertOwnerAndMode(path, info, false);
  return await Deno.readTextFile(path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readPrivateText(path)) as T;
}

function currentUid(): number | null {
  if (Deno.build.os === "windows") return null;
  return Deno.uid();
}

function assertOwnerAndMode(
  path: string,
  info: Deno.FileInfo,
  directory: boolean,
): void {
  if (Deno.build.os === "windows") return;
  const uid = currentUid();
  if (info.uid !== null && info.uid !== uid) {
    throw new Error(`auth_store_permissions_unsafe: ${path}`);
  }
  const expected = directory ? 0o700 : 0o600;
  if (((info.mode ?? 0) & 0o777) !== expected) {
    throw new Error(`auth_store_permissions_unsafe: ${path}`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await assertNoSymlinkComponents(path, true);
  try {
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error(`unsafe auth store path: ${path}`);
    }
    assertOwnerAndMode(path, info, true);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    if (Deno.build.os !== "windows") await Deno.chmod(path, 0o700);
  }
}

async function safeRemove(
  path: string,
  options?: Deno.RemoveOptions,
): Promise<void> {
  await assertNoSymlinkComponents(path);
  await Deno.remove(path, options);
}

async function exists(path: string): Promise<boolean> {
  await assertNoSymlinkComponents(path, true);
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export class FilesystemLocalAuthStore {
  constructor(
    readonly root: string,
    private readonly inspector: ProcessInspector,
  ) {}

  static create(inspector: ProcessInspector): FilesystemLocalAuthStore {
    return new FilesystemLocalAuthStore(authDataRoot(), inspector);
  }

  private async instance(
    originValue: string,
  ): Promise<{ origin: string; path: string }> {
    const origin = normalizeOrigin(originValue);
    return { origin, path: join(this.root, "instances", await digest(origin)) };
  }

  private async initialize(
    instancePath: string,
    origin: string,
  ): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(join(instancePath, "sessions"));
    await ensurePrivateDirectory(join(instancePath, "bindings"));
    await ensurePrivateDirectory(join(instancePath, "requests"));
    await ensurePrivateDirectory(join(instancePath, "authorizations"));
    const identityPath = join(this.root, "identity.json");
    if (!(await exists(identityPath))) {
      await atomicWrite(
        identityPath,
        JSON.stringify({
          schema_version: SCHEMA_VERSION,
          record_type: "local_identity",
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
        }),
      );
    }
    const serverPath = join(instancePath, "server.json");
    if (!(await exists(serverPath))) {
      const now = new Date().toISOString();
      await atomicWrite(
        serverPath,
        JSON.stringify(
          {
            schema_version: SCHEMA_VERSION,
            record_type: "server",
            origin,
            created_at: now,
            updated_at: now,
            state: {},
          } satisfies ServerRecord,
        ),
      );
    }
  }

  private async withLock<T>(
    instancePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await ensurePrivateDirectory(instancePath);
    const lock = join(instancePath, ".lock");
    await assertNoSymlinkComponents(lock, true);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await Deno.mkdir(lock, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await safeRemove(lock).catch(() => undefined);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        await assertNoSymlinkComponents(lock);
        const info = await Deno.lstat(lock);
        if (
          Date.now() - (info.mtime?.getTime() ?? Date.now()) > 30_000 &&
          info.isDirectory && !info.isSymlink
        ) {
          await safeRemove(lock).catch(() => undefined);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("local auth store is locked");
  }

  async readState(originValue: string): Promise<Record<string, unknown>> {
    const { origin, path } = await this.instance(originValue);
    if (!(await exists(join(path, "server.json")))) return {};
    const server = await readJson<ServerRecord>(join(path, "server.json"));
    if (
      server.schema_version !== 1 || server.record_type !== "server" ||
      server.origin !== origin
    ) {
      throw new Error("invalid local server record");
    }
    return server.state ?? {};
  }

  async updateState(
    originValue: string,
    update: Record<string, unknown>,
    anchor?: ProcessIdentity,
  ): Promise<void> {
    const { origin, path } = await this.instance(originValue);
    await this.initialize(path, origin);
    await this.withLock(path, async () => {
      const serverPath = join(path, "server.json");
      const server = await readJson<ServerRecord>(serverPath);
      const state = { ...server.state };
      for (const [key, value] of Object.entries(update)) {
        if (key === "token" || key === "requestToken") continue;
        if (value === undefined) delete state[key];
        else state[key] = value;
      }
      await atomicWrite(
        serverPath,
        JSON.stringify({
          ...server,
          state,
          updated_at: new Date().toISOString(),
        }),
      );
      if (Object.hasOwn(update, "requestToken")) {
        await this.replaceRequestCredential(
          path,
          origin,
          update.requestToken,
          update,
        );
      }
      if (Object.hasOwn(update, "token")) {
        if (!anchor) {
          throw new Error("full credentials require a verified process anchor");
        }
        await this.replaceBoundCredential(
          path,
          origin,
          update.token,
          update,
          anchor,
        );
      }
    });
  }

  private async replaceRequestCredential(
    path: string,
    origin: string,
    token: unknown,
    update: Record<string, unknown>,
  ): Promise<void> {
    const id = "authorization-request";
    const directory = join(path, "sessions", id);
    if (token === undefined) {
      await safeRemove(directory, { recursive: true }).catch(() => undefined);
      return;
    }
    await ensurePrivateDirectory(directory);
    const now = new Date().toISOString();
    await atomicWrite(
      join(directory, "metadata.json"),
      JSON.stringify({
        schema_version: 1,
        record_type: "session",
        origin,
        id,
        credential_type: "authorization_request",
        created_at: now,
        updated_at: now,
        server_session_id: update.requestSessionId,
      }),
    );
    await atomicWrite(join(directory, "token"), String(token));
  }

  private async replaceBoundCredential(
    path: string,
    origin: string,
    token: unknown,
    update: Record<string, unknown>,
    anchor: ProcessIdentity,
  ): Promise<void> {
    const bindings = await this.bindings(path);
    const existing = bindings.find((binding) =>
      sameProcess(binding.anchor, anchor)
    );
    if (token === undefined) {
      if (existing) {
        await safeRemove(join(path, "bindings", `${existing.id}.json`)).catch(
          () => undefined,
        );
        await safeRemove(join(path, "sessions", existing.session_id), {
          recursive: true,
        }).catch(() => undefined);
      }
      return;
    }
    const bindingId = existing?.id ?? crypto.randomUUID();
    const sessionId = existing?.session_id ?? crypto.randomUUID();
    const directory = join(path, "sessions", sessionId);
    await ensurePrivateDirectory(directory);
    const now = new Date().toISOString();
    const metadata: SessionRecord = {
      schema_version: 1,
      record_type: "session",
      origin,
      id: sessionId,
      credential_type: typeof update.authorizationId === "string"
        ? "agent"
        : "human",
      ...(typeof update.authorizationId === "string"
        ? { authorization_id: update.authorizationId }
        : {}),
      created_at: now,
      updated_at: now,
    };
    await atomicWrite(
      join(directory, "metadata.json"),
      JSON.stringify(metadata),
    );
    await atomicWrite(join(directory, "token"), String(token));
    await atomicWrite(
      join(path, "bindings", `${bindingId}.json`),
      JSON.stringify(
        {
          schema_version: 1,
          record_type: "process_binding",
          id: bindingId,
          origin,
          session_id: sessionId,
          anchor,
          created_at: now,
        } satisfies LocalBinding,
      ),
    );
  }

  private async bindings(path: string): Promise<LocalBinding[]> {
    const directory = join(path, "bindings");
    if (!(await exists(directory))) return [];
    const result: LocalBinding[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isSymlink) {
        throw new Error(
          `unsafe auth store symlink: ${join(directory, entry.name)}`,
        );
      }
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const binding = await readJson<LocalBinding>(
          join(directory, entry.name),
        );
        if (
          binding.schema_version === 1 &&
          binding.record_type === "process_binding"
        ) result.push(binding);
      } catch { /* corrupt records are never selected */ }
    }
    return result;
  }

  async select(
    originValue: string,
    parentPid: number,
    stopPid?: number,
  ): Promise<LocalCredential | null> {
    const { origin, path } = await this.instance(originValue);
    if (!(await exists(path))) return null;
    const chain = await this.inspector.ancestry(parentPid, stopPid);
    const bindings = await this.bindings(path);
    for (const process of chain) {
      const binding = bindings.find((candidate) =>
        candidate.origin === origin && sameProcess(candidate.anchor, process)
      );
      if (!binding) continue;
      try {
        const directory = join(path, "sessions", binding.session_id);
        const metadata = await readJson<SessionRecord>(
          join(directory, "metadata.json"),
        );
        const token = await readPrivateText(join(directory, "token"));
        return {
          sessionId: metadata.id,
          token,
          kind: metadata.credential_type,
          authorizationId: metadata.authorization_id,
          anchor: binding.anchor,
        };
      } catch (error) {
        if (
          error instanceof SyntaxError || error instanceof Deno.errors.NotFound
        ) return null;
        throw error;
      }
    }
    return null;
  }

  async requestCredential(
    originValue: string,
  ): Promise<LocalCredential | null> {
    const { origin, path } = await this.instance(originValue);
    const directory = join(path, "sessions", "authorization-request");
    if (!(await exists(directory))) return null;
    try {
      const metadata = await readJson<SessionRecord>(
        join(directory, "metadata.json"),
      );
      if (
        metadata.origin !== origin ||
        metadata.credential_type !== "authorization_request"
      ) return null;
      return {
        sessionId: metadata.id,
        token: await readPrivateText(join(directory, "token")),
        kind: metadata.credential_type,
      };
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound || error instanceof SyntaxError
      ) return null;
      throw error;
    }
  }

  async removeAuthorization(
    originValue: string,
    authorizationId: string,
  ): Promise<void> {
    const { path } = await this.instance(originValue);
    if (!(await exists(path))) return;
    await this.withLock(path, async () => {
      for (const binding of await this.bindings(path)) {
        try {
          const metadata = await readJson<SessionRecord>(
            join(path, "sessions", binding.session_id, "metadata.json"),
          );
          if (metadata.authorization_id !== authorizationId) continue;
          await safeRemove(join(path, "bindings", `${binding.id}.json`));
          await safeRemove(join(path, "sessions", binding.session_id), {
            recursive: true,
          });
        } catch { /* cleanup remains best effort */ }
      }
    });
  }

  async cleanup(originValue?: string): Promise<number> {
    const instances = join(this.root, "instances");
    if (!(await exists(instances))) return 0;
    const wanted = originValue
      ? (await this.instance(originValue)).path
      : undefined;
    let removed = 0;
    for await (const instance of Deno.readDir(instances)) {
      const path = join(instances, instance.name);
      if (!instance.isDirectory || (wanted && path !== wanted)) continue;
      await this.withLock(path, async () => {
        for (const binding of await this.bindings(path)) {
          try {
            const live = await this.inspector.inspect(binding.anchor.pid);
            if (sameProcess(live, binding.anchor)) continue;
          } catch { /* stale */ }
          await safeRemove(join(path, "bindings", `${binding.id}.json`)).catch(
            () => undefined,
          );
          await safeRemove(join(path, "sessions", binding.session_id), {
            recursive: true,
          }).catch(() => undefined);
          removed++;
        }
        removed += await this.cleanupTemporaryArtifacts(path);
      });
    }
    return removed;
  }

  private async cleanupTemporaryArtifacts(path: string): Promise<number> {
    let removed = 0;
    for await (const entry of Deno.readDir(path)) {
      if (entry.name === ".lock") continue;
      const child = join(path, entry.name);
      const info = await Deno.lstat(child);
      if (info.isSymlink) continue;
      if (entry.isDirectory) {
        removed += await this.cleanupTemporaryArtifacts(child);
      } else if (entry.isFile && entry.name.endsWith(".tmp")) {
        assertOwnerAndMode(child, info, false);
        await safeRemove(child);
        removed++;
      }
    }
    return removed;
  }

  async doctor(fix = false): Promise<DoctorReport> {
    const findings: DoctorFinding[] = [];
    const fixes: DoctorReport["fixes"] = [];
    const symlink = await firstSymlinkComponent(this.root, true);
    if (symlink) {
      findings.push({
        severity: "unsafe",
        code: "auth_store_symlink",
        path: symlink,
        repairable: false,
      });
      return { healthy: false, findings, fixes };
    }
    let rootExists = true;
    try {
      await Deno.lstat(this.root);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) rootExists = false;
      else throw error;
    }
    if (!rootExists) {
      findings.push({
        severity: "warning",
        code: "auth_root_missing",
        path: this.root,
        repairable: true,
        planned_action: "create_0700",
      });
      if (fix) {
        await ensurePrivateDirectory(this.root);
        fixes.push({
          code: "auth_root_missing",
          path: this.root,
          action: "create_0700",
        });
      }
    } else {
      await this.inspectPath(this.root, findings, fixes, fix);
      await this.inspectIntegrity(findings, fixes, fix);
    }
    const remaining = fix ? (await this.doctor(false)).findings : findings;
    return {
      healthy: !remaining.some((finding) =>
        finding.severity === "error" || finding.severity === "unsafe"
      ),
      findings,
      fixes,
    };
  }

  private async inspectIntegrity(
    findings: DoctorFinding[],
    fixes: DoctorReport["fixes"],
    fix: boolean,
  ): Promise<void> {
    try {
      const identity = await readJson<Record<string, unknown>>(
        join(this.root, "identity.json"),
      );
      if (
        identity.schema_version !== 1 ||
        identity.record_type !== "local_identity" ||
        typeof identity.id !== "string" ||
        typeof identity.created_at !== "string"
      ) throw new Error("invalid identity");
    } catch {
      findings.push({
        severity: "error",
        code: "local_identity_invalid",
        path: join(this.root, "identity.json"),
        repairable: false,
      });
    }
    const instances = join(this.root, "instances");
    if (!(await exists(instances))) return;
    for await (const entry of Deno.readDir(instances)) {
      const instancePath = join(instances, entry.name);
      if (!entry.isDirectory || !/^[0-9a-f]{64}$/.test(entry.name)) {
        findings.push({
          severity: "error",
          code: "origin_partition_invalid",
          path: instancePath,
          repairable: false,
        });
        continue;
      }
      let server: ServerRecord;
      try {
        server = await readJson<ServerRecord>(
          join(instancePath, "server.json"),
        );
        const normalized = normalizeOrigin(server.origin);
        if (
          server.schema_version !== 1 || server.record_type !== "server" ||
          normalized !== server.origin ||
          await digest(normalized) !== entry.name ||
          !server.state || typeof server.state !== "object" ||
          Array.isArray(server.state) ||
          (server.state.projectId !== undefined &&
            typeof server.state.projectId !== "string") ||
          (server.state.projectSlug !== undefined &&
            typeof server.state.projectSlug !== "string") ||
          (server.state.username !== undefined &&
            typeof server.state.username !== "string")
        ) throw new Error("invalid server record");
      } catch {
        findings.push({
          severity: "error",
          code: "server_record_invalid",
          path: join(instancePath, "server.json"),
          repairable: false,
        });
        continue;
      }

      const sessionsPath = join(instancePath, "sessions");
      const sessions = new Map<
        string,
        { path: string; metadata?: SessionRecord; token: boolean }
      >();
      if (await exists(sessionsPath)) {
        for await (const sessionEntry of Deno.readDir(sessionsPath)) {
          const sessionPath = join(sessionsPath, sessionEntry.name);
          if (!sessionEntry.isDirectory) continue;
          let metadata: SessionRecord | undefined;
          let token = false;
          try {
            metadata = await readJson<SessionRecord>(
              join(sessionPath, "metadata.json"),
            );
            if (
              metadata.schema_version !== 1 ||
              metadata.record_type !== "session" ||
              metadata.id !== sessionEntry.name ||
              metadata.origin !== server.origin ||
              !["human", "agent", "authorization_request"].includes(
                metadata.credential_type,
              )
            ) throw new Error("invalid session metadata");
          } catch {
            findings.push({
              severity: "error",
              code: "session_metadata_invalid",
              path: join(sessionPath, "metadata.json"),
              repairable: false,
            });
            metadata = undefined;
          }
          try {
            await readPrivateText(join(sessionPath, "token"));
            token = true;
          } catch {
            findings.push({
              severity: "error",
              code: "session_token_missing_or_invalid",
              path: join(sessionPath, "token"),
              repairable: false,
            });
          }
          sessions.set(sessionEntry.name, {
            path: sessionPath,
            metadata,
            token,
          });
        }
      }

      const references = new Map<string, number>();
      const bindingsPath = join(instancePath, "bindings");
      if (await exists(bindingsPath)) {
        for await (const bindingEntry of Deno.readDir(bindingsPath)) {
          if (!bindingEntry.isFile || !bindingEntry.name.endsWith(".json")) {
            continue;
          }
          const bindingPath = join(bindingsPath, bindingEntry.name);
          let binding: LocalBinding;
          try {
            binding = await readJson<LocalBinding>(bindingPath);
            if (
              binding.schema_version !== 1 ||
              binding.record_type !== "process_binding" ||
              `${binding.id}.json` !== bindingEntry.name ||
              binding.origin !== server.origin ||
              !binding.anchor || !Number.isSafeInteger(binding.anchor.pid) ||
              typeof binding.anchor.startTicks !== "string" ||
              !Number.isSafeInteger(binding.anchor.uid) ||
              !binding.anchor.bootId
            ) throw new Error("invalid binding");
          } catch {
            findings.push({
              severity: "error",
              code: "binding_record_invalid",
              path: bindingPath,
              repairable: false,
            });
            continue;
          }
          references.set(
            binding.session_id,
            (references.get(binding.session_id) ?? 0) + 1,
          );
          const session = sessions.get(binding.session_id);
          if (
            !session?.metadata || !session.token ||
            session.metadata.credential_type === "authorization_request"
          ) {
            findings.push({
              severity: "error",
              code: "binding_session_reference_broken",
              path: bindingPath,
              repairable: false,
            });
            continue;
          }
          let live = false;
          try {
            live = sameProcess(
              await this.inspector.inspect(binding.anchor.pid),
              binding.anchor,
            );
          } catch { /* gone or denied is stale for local selection */ }
          if (!live) {
            findings.push({
              severity: "error",
              code: "process_binding_stale",
              path: bindingPath,
              repairable: true,
              planned_action: "remove_stale_binding",
            });
            if (fix) {
              await safeRemove(bindingPath);
              if ((references.get(binding.session_id) ?? 0) === 1) {
                await safeRemove(session.path, { recursive: true });
                sessions.delete(binding.session_id);
              }
              fixes.push({
                code: "process_binding_stale",
                path: bindingPath,
                action: "remove_stale_binding",
              });
            }
          }
        }
      }
      for (const [sessionId, count] of references) {
        if (count > 1) {
          findings.push({
            severity: "error",
            code: "session_binding_duplicate",
            path: sessions.get(sessionId)?.path ?? sessionsPath,
            repairable: false,
          });
        }
      }
      for (const [sessionId, session] of sessions) {
        if (
          sessionId === "authorization-request" || references.has(sessionId)
        ) continue;
        findings.push({
          severity: "warning",
          code: "orphan_session",
          path: session.path,
          repairable: true,
          planned_action: "remove_orphan_session",
        });
        if (fix) {
          await safeRemove(session.path, { recursive: true });
          fixes.push({
            code: "orphan_session",
            path: session.path,
            action: "remove_orphan_session",
          });
        }
      }
    }
  }

  private async inspectPath(
    path: string,
    findings: DoctorFinding[],
    fixes: DoctorReport["fixes"],
    fix: boolean,
  ): Promise<void> {
    const info = await Deno.lstat(path);
    if (info.isSymlink) {
      findings.push({
        severity: "unsafe",
        code: "auth_store_symlink",
        path,
        repairable: false,
      });
      return;
    }
    const directory = info.isDirectory;
    if (!directory && !info.isFile) {
      findings.push({
        severity: "unsafe",
        code: "auth_store_type_unsafe",
        path,
        repairable: false,
      });
      return;
    }
    if (Deno.build.os !== "windows") {
      if (info.uid !== null && info.uid !== currentUid()) {
        findings.push({
          severity: "unsafe",
          code: "auth_store_owner_unsafe",
          path,
          repairable: false,
        });
        return;
      }
      const expected = directory ? 0o700 : 0o600;
      if (((info.mode ?? 0) & 0o777) !== expected) {
        const action = directory ? "chmod_0700" : "chmod_0600";
        findings.push({
          severity: "error",
          code: directory
            ? "directory_permissions_unsafe"
            : "token_permissions_unsafe",
          path,
          repairable: true,
          planned_action: action,
        });
        if (fix) {
          await Deno.chmod(path, expected);
          fixes.push({ code: "permissions_repaired", path, action });
        }
      }
    }
    if (basename(path).endsWith(".tmp") && info.isFile) {
      findings.push({
        severity: "warning",
        code: "stale_auth_temporary",
        path,
        repairable: true,
        planned_action: "remove_stale_temporary",
      });
      if (fix) {
        await safeRemove(path);
        fixes.push({
          code: "stale_auth_temporary",
          path,
          action: "remove_stale_temporary",
        });
      }
      return;
    }
    if (directory) {
      for await (const entry of Deno.readDir(path)) {
        const child = join(path, entry.name);
        if (entry.name === ".lock") {
          const lock = await Deno.lstat(child);
          if (lock.isSymlink) {
            findings.push({
              severity: "unsafe",
              code: "auth_store_symlink",
              path: child,
              repairable: false,
            });
          } else if (
            Date.now() - (lock.mtime?.getTime() ?? Date.now()) > 30_000
          ) {
            findings.push({
              severity: "warning",
              code: "stale_auth_lock",
              path: child,
              repairable: true,
              planned_action: "remove_stale_lock",
            });
            if (fix) {
              await safeRemove(child, { recursive: true });
              fixes.push({
                code: "stale_auth_lock",
                path: child,
                action: "remove_stale_lock",
              });
            }
          }
          continue;
        }
        await this.inspectPath(child, findings, fixes, fix);
      }
    } else if (path.endsWith(".json")) {
      try {
        const record = JSON.parse(await Deno.readTextFile(path));
        if (
          record.schema_version !== 1 || typeof record.record_type !== "string"
        ) throw new Error();
      } catch {
        findings.push({
          severity: "error",
          code: "auth_record_malformed",
          path,
          repairable: false,
        });
      }
    }
  }
}
