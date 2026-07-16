import { basename, dirname, join } from "jsr:@std/path";
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
    Deno.env.get("OPERANT_INSECURE_HTTP") !== "1"
  ) {
    throw new Error("remote HTTP requires OPERANT_INSECURE_HTTP=1");
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
    return join(Deno.env.get("LOCALAPPDATA") ?? ".", "Operant", "auth");
  }
  if (Deno.build.os === "darwin") {
    return join(
      Deno.env.get("HOME") ?? ".",
      "Library",
      "Application Support",
      "Operant",
      "auth",
    );
  }
  return join(
    Deno.env.get("XDG_DATA_HOME") ??
      join(Deno.env.get("HOME") ?? ".", ".local", "share"),
    "operant",
    "auth",
  );
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${Deno.pid}.${crypto.randomUUID()}.tmp`,
  );
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

async function exists(path: string): Promise<boolean> {
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
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await Deno.mkdir(lock, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await Deno.remove(lock).catch(() => undefined);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        const info = await Deno.lstat(lock);
        if (
          Date.now() - (info.mtime?.getTime() ?? Date.now()) > 30_000 &&
          info.isDirectory && !info.isSymlink
        ) {
          await Deno.remove(lock).catch(() => undefined);
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
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
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
        await Deno.remove(join(path, "bindings", `${existing.id}.json`)).catch(
          () => undefined,
        );
        await Deno.remove(join(path, "sessions", existing.session_id), {
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
          await Deno.remove(join(path, "bindings", `${binding.id}.json`));
          await Deno.remove(join(path, "sessions", binding.session_id), {
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
          await Deno.remove(join(path, "bindings", `${binding.id}.json`)).catch(
            () => undefined,
          );
          await Deno.remove(join(path, "sessions", binding.session_id), {
            recursive: true,
          }).catch(() => undefined);
          removed++;
        }
      });
    }
    return removed;
  }

  async doctor(fix = false): Promise<DoctorReport> {
    const findings: DoctorFinding[] = [];
    const fixes: DoctorReport["fixes"] = [];
    if (!(await exists(this.root))) {
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
    if (directory) {
      for await (const entry of Deno.readDir(path)) {
        if (entry.name === ".lock") continue;
        await this.inspectPath(join(path, entry.name), findings, fixes, fix);
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
