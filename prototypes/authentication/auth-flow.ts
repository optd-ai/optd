import { hash, verify } from "npm:@node-rs/argon2";
import { Hono } from "npm:hono";

type Boundary =
  | { type: "project"; project_id: string }
  | { type: "all_projects" }
  | { type: "system" };
type BoundedRole = { role: string; boundary: Boundary };
type User = {
  id: string;
  username: string;
  passwordHash: string;
  active: boolean;
};
type SessionKind =
  | "human_session"
  | "authorization_request"
  | "agent_authorization";
type Session = {
  id: string;
  kind: SessionKind;
  tokenHash: string;
  humanUserId: string;
  agentUserId?: string;
  authorizationId?: string;
  active: boolean;
};
type Authorization = {
  id: string;
  humanUserId: string;
  agentUserId: string;
  roles: BoundedRole[];
  parentAuthorizationId?: string;
  rootAuthorizationId: string;
  active: boolean;
};
type AuthRequest = {
  id: string;
  version: number;
  humanUserId: string;
  requestingAuthorizationId?: string;
  approvedByAuthorizationId?: string;
  roles: string[];
  boundary: Boundary;
  reason: string;
  agent: Record<string, string>;
  idempotencyKey: string;
  redemptionNonceHash: string;
  status: "pending" | "approved" | "denied" | "redeemed" | "invalidated";
  denialReason?: string;
  approvedBy?: string;
  authorizationId?: string;
};
type Recovery = {
  id: string;
  humanUserId: string;
  tokenHash: string;
  enableUser: boolean;
  restoreSuperAdmin: boolean;
  expiresAt: number;
  active: boolean;
};
type AuthContext = {
  id: string;
  principalType: "human_user" | "agent_user";
  principalId: string;
  humanUserId: string;
  agentUserId?: string;
  credentialKind: SessionKind;
  boundedRoles: BoundedRole[];
};

type State = {
  bootstrapped: boolean;
  bootstrapTokenHash: string;
  users: Map<string, User>;
  usersByName: Map<string, string>;
  sessions: Map<string, Session>;
  authorizations: Map<string, Authorization>;
  requests: Map<string, AuthRequest>;
  idempotency: Map<string, string>;
  recoveries: Map<string, Recovery>;
  contexts: AuthContext[];
  audit: Array<Record<string, unknown>>;
};

const argonOptions = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
const encoder = new TextEncoder();

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
function opaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}
function fail(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  return Response.json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }, { status });
}
function sameBoundary(a: Boundary, b: Boundary): boolean {
  return a.type === b.type &&
    (a.type !== "project" ||
      (b.type === "project" && a.project_id === b.project_id));
}
function roleKey(value: BoundedRole): string {
  return `${value.role}|${value.boundary.type}|${
    value.boundary.type === "project" ? value.boundary.project_id : ""
  }`;
}

export async function createAuthPrototype(bootstrapToken = "bootstrap-secret") {
  const state: State = {
    bootstrapped: false,
    bootstrapTokenHash: await digest(bootstrapToken),
    users: new Map(),
    usersByName: new Map(),
    sessions: new Map(),
    authorizations: new Map(),
    requests: new Map(),
    idempotency: new Map(),
    recoveries: new Map(),
    contexts: [],
    audit: [],
  };
  const app = new Hono();

  async function issueSession(
    kind: SessionKind,
    humanUserId: string,
    extra: Partial<Session> = {},
  ) {
    const token = opaqueToken();
    const session: Session = {
      id: id("sess"),
      kind,
      tokenHash: await digest(token),
      humanUserId,
      active: true,
      ...extra,
    };
    state.sessions.set(session.id, session);
    return { session, token };
  }

  function authorizationChainActive(
    authorization: Authorization | undefined,
  ): boolean {
    if (!authorization?.active) return false;
    if (!authorization.parentAuthorizationId) return true;
    return authorizationChainActive(
      state.authorizations.get(authorization.parentAuthorizationId),
    );
  }

  async function authenticate(
    request: Request,
  ): Promise<
    {
      session: Session;
      user: User;
      authorization?: Authorization;
      context: AuthContext;
    } | Response
  > {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return fail("authentication_required", "bearer credential required", 401);
    }
    const tokenHash = await digest(header.slice(7));
    const session = [...state.sessions.values()].find((candidate) =>
      candidate.active && candidate.tokenHash === tokenHash
    );
    if (!session) {
      return fail(
        "credential_invalid",
        "credential is invalid or revoked",
        401,
      );
    }
    const user = state.users.get(session.humanUserId);
    if (!user?.active) {
      return fail("user_disabled", "anchoring human user is disabled", 401);
    }
    const authorization = session.authorizationId
      ? state.authorizations.get(session.authorizationId)
      : undefined;
    if (
      session.kind === "agent_authorization" &&
      !authorizationChainActive(authorization)
    ) {
      return fail(
        "authorization_ancestor_invalid",
        "agent authorization is invalid",
        401,
      );
    }
    const context: AuthContext = {
      id: id("ctx"),
      principalType: session.agentUserId ? "agent_user" : "human_user",
      principalId: session.agentUserId ?? user.id,
      humanUserId: user.id,
      agentUserId: session.agentUserId,
      credentialKind: session.kind,
      boundedRoles: authorization?.roles ??
        (session.kind === "human_session"
          ? [{ role: "system:super_admin", boundary: { type: "system" } }]
          : []),
    };
    state.contexts.push(context);
    return { session, user, authorization, context };
  }

  function hasSuperAdmin(
    auth: { session: Session; authorization?: Authorization },
  ): boolean {
    if (auth.session.kind === "human_session") return true;
    return auth.authorization?.roles.some((item) =>
      item.role === "system:super_admin"
    ) ?? false;
  }

  function canDecide(
    auth: { session: Session; authorization?: Authorization },
  ): boolean {
    return hasSuperAdmin(auth) ||
      (auth.authorization?.roles.some((item) =>
        item.role === "optd/crm:sales_manager"
      ) ?? false);
  }

  function holdsRequestedRoles(
    auth: { authorization?: Authorization },
    request: AuthRequest,
  ): boolean {
    return request.roles.every((role) =>
      auth.authorization?.roles.some((item) =>
        item.role === role && sameBoundary(item.boundary, request.boundary)
      )
    );
  }

  app.get(
    "/api/v1/auth/bootstrap/status",
    () => ok({ state: state.bootstrapped ? "active" : "bootstrap_required" }),
  );
  app.post("/api/v1/auth/bootstrap", async (c) => {
    if (state.bootstrapped) {
      return fail(
        "bootstrap_already_completed",
        "bootstrap is already complete",
        409,
      );
    }
    const auth = c.req.header("authorization") ?? "";
    if (
      !auth.startsWith("Operant-Bootstrap ") ||
      await digest(auth.slice(18)) !== state.bootstrapTokenHash
    ) {
      return fail(
        "bootstrap_credential_invalid",
        "bootstrap credential is invalid",
        401,
      );
    }
    const body = await c.req.json<{ username: string; password: string }>();
    if (!body.username || body.password.length < 8) {
      return fail(
        "validation_failed",
        "username and 8+ character password required",
        400,
      );
    }
    const user: User = {
      id: id("human"),
      username: body.username,
      passwordHash: await hash(body.password, argonOptions),
      active: true,
    };
    state.users.set(user.id, user);
    state.usersByName.set(user.username, user.id);
    state.bootstrapped = true;
    const human = await issueSession("human_session", user.id);
    const requestCredential = await issueSession(
      "authorization_request",
      user.id,
    );
    state.audit.push({
      event: "auth.bootstrap.completed",
      humanUserId: user.id,
    });
    return ok({
      human_user: { id: user.id, username: user.username },
      human_session: { id: human.session.id, token: human.token },
      request_credential: {
        id: requestCredential.session.id,
        token: requestCredential.token,
      },
    }, 201);
  });

  app.post("/api/v1/auth/login", async (c) => {
    const body = await c.req.json<
      {
        username: string;
        password: string;
        existing_request_session_id?: string;
      }
    >();
    const user = state.users.get(state.usersByName.get(body.username) ?? "");
    if (
      !user || !user.active || !await verify(user.passwordHash, body.password)
    ) return fail("login_invalid", "username or password is invalid", 401);
    const human = await issueSession("human_session", user.id);
    let requestResult: Record<string, unknown>;
    const existing = body.existing_request_session_id
      ? state.sessions.get(body.existing_request_session_id)
      : undefined;
    if (
      existing?.active && existing.kind === "authorization_request" &&
      existing.humanUserId === user.id
    ) requestResult = { status: "retained", id: existing.id };
    else {
      const issued = await issueSession("authorization_request", user.id);
      requestResult = {
        status: "issued",
        id: issued.session.id,
        token: issued.token,
      };
    }
    state.audit.push({ event: "auth.login", humanUserId: user.id });
    return ok({
      human_session: { id: human.session.id, token: human.token },
      request_credential: requestResult,
    });
  });

  app.get("/api/v1/auth/me", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    return ok({
      principal_id: auth.context.principalId,
      human_user_id: auth.user.id,
      agent_user_id: auth.context.agentUserId,
      credential_kind: auth.session.kind,
      roles: auth.context.boundedRoles,
    });
  });

  app.post("/api/v1/auth/requests", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    if (
      !new Set<SessionKind>(["authorization_request", "agent_authorization"])
        .has(auth.session.kind)
    ) {
      return fail(
        "credential_kind_invalid",
        "request or agent credential required",
        403,
      );
    }
    const key = c.req.header("idempotency-key");
    if (!key) {
      return fail(
        "idempotency_key_required",
        "Idempotency-Key is required",
        400,
      );
    }
    const dedupe = `${auth.session.id}:${key}`;
    const existingId = state.idempotency.get(dedupe);
    if (existingId) return ok(state.requests.get(existingId));
    const body = await c.req.json<
      {
        roles: string[];
        boundary: Boundary;
        reason: string;
        redemption_nonce_hash: string;
        agent?: Record<string, string>;
      }
    >();
    if (!body.roles?.length || !body.reason || !body.redemption_nonce_hash) {
      return fail(
        "validation_failed",
        "roles, reason, and redemption nonce hash required",
        400,
      );
    }
    const request: AuthRequest = {
      id: id("req"),
      version: 1,
      humanUserId: auth.user.id,
      requestingAuthorizationId: auth.authorization?.id,
      roles: [...new Set(body.roles)].sort(),
      boundary: body.boundary,
      reason: body.reason,
      agent: body.agent ?? {},
      idempotencyKey: key,
      redemptionNonceHash: body.redemption_nonce_hash,
      status: "pending",
    };
    state.requests.set(request.id, request);
    state.idempotency.set(dedupe, request.id);
    state.audit.push({
      event: "auth.request.created",
      requestId: request.id,
      humanUserId: request.humanUserId,
    });
    return ok(request, 201);
  });

  app.get("/api/v1/auth/requests/:id", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const request = state.requests.get(c.req.param("id"));
    if (!request || request.humanUserId !== auth.user.id) {
      return fail("not_found", "request not found", 404);
    }
    return ok(request);
  });

  app.post("/api/v1/auth/requests/:id/decision", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const request = state.requests.get(c.req.param("id"));
    if (!request || request.humanUserId !== auth.user.id) {
      return fail("not_found", "request not found", 404);
    }
    if (request.status !== "pending") {
      return fail("request_not_pending", "request is not pending", 409);
    }
    if (!canDecide(auth)) {
      return fail(
        "authorization_insufficient",
        "auth.request.decide is required",
        403,
      );
    }
    if (!hasSuperAdmin(auth) && !holdsRequestedRoles(auth, request)) {
      return fail(
        "authorization_insufficient",
        "approver does not hold every requested role in the boundary",
        403,
      );
    }
    const body = await c.req.json<
      { decision: "approved" | "denied"; reason?: string; agent_name?: string }
    >();
    request.version++;
    if (body.decision === "denied") {
      request.status = "denied";
      request.denialReason = body.reason ?? "denied";
      state.audit.push({ event: "auth.request.denied", requestId: request.id });
      return ok(request);
    }
    request.status = "approved";
    request.approvedBy = auth.context.principalId;
    request.approvedByAuthorizationId = auth.authorization?.id;
    if (body.agent_name) request.agent.name = body.agent_name;
    state.audit.push({ event: "auth.request.approved", requestId: request.id });
    return ok(request);
  });

  app.post("/api/v1/auth/requests/:id/redeem", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const request = state.requests.get(c.req.param("id"));
    if (!request || request.humanUserId !== auth.user.id) {
      return fail("not_found", "request not found", 404);
    }
    if (request.status === "denied") {
      return fail("request_denied", "authorization request was denied", 403, {
        reason: request.denialReason,
      });
    }
    if (request.status !== "approved") {
      return fail(
        "request_not_approved",
        "authorization request is not approved",
        409,
      );
    }
    const body = await c.req.json<{ redemption_nonce: string }>();
    if (await digest(body.redemption_nonce) !== request.redemptionNonceHash) {
      return fail("redemption_invalid", "redemption nonce is invalid", 401);
    }
    const replacement = request.requestingAuthorizationId
      ? state.authorizations.get(request.requestingAuthorizationId)
      : undefined;
    const parent = replacement ??
      (request.approvedByAuthorizationId
        ? state.authorizations.get(request.approvedByAuthorizationId)
        : undefined);
    const merged = new Map<string, BoundedRole>();
    for (const role of replacement?.roles ?? []) {
      if (replacement?.active) merged.set(roleKey(role), role);
    }
    for (const role of request.roles) {
      const assignment = { role, boundary: request.boundary };
      merged.set(roleKey(assignment), assignment);
    }
    const authorizationId = id("authz");
    const authorization: Authorization = {
      id: authorizationId,
      humanUserId: auth.user.id,
      agentUserId: replacement?.agentUserId ?? id("agent"),
      roles: [...merged.values()],
      parentAuthorizationId: replacement
        ? replacement.parentAuthorizationId
        : parent?.id,
      rootAuthorizationId: parent?.rootAuthorizationId ?? authorizationId,
      active: true,
    };
    state.authorizations.set(authorization.id, authorization);
    const issued = await issueSession("agent_authorization", auth.user.id, {
      agentUserId: authorization.agentUserId,
      authorizationId: authorization.id,
    });
    if (replacement) replacement.active = false;
    request.status = "redeemed";
    request.authorizationId = authorization.id;
    request.version++;
    state.audit.push({
      event: "auth.request.redeemed",
      requestId: request.id,
      authorizationId: authorization.id,
    });
    return ok({
      authorization,
      session: { id: issued.session.id, token: issued.token },
      supersedes: replacement?.id,
    });
  });

  app.post("/api/v1/auth/authorizations/:id/revoke", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const target = state.authorizations.get(c.req.param("id"));
    if (!target || target.humanUserId !== auth.user.id) {
      return fail("not_found", "authorization not found", 404);
    }
    const self = auth.authorization?.id === target.id;
    if (!self) {
      const body = await c.req.json<{ password: string; confirm: boolean }>();
      if (
        !body.confirm || !await verify(auth.user.passwordHash, body.password)
      ) {
        return fail(
          "password_confirmation_required",
          "valid password confirmation required",
          403,
        );
      }
    }
    target.active = false;
    for (const session of state.sessions.values()) {
      if (session.authorizationId === target.id) session.active = false;
    }
    state.audit.push({
      event: "auth.authorization.revoked",
      authorizationId: target.id,
      by: auth.context.principalId,
    });
    return ok({ revoked: target.id });
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    auth.session.active = false;
    state.audit.push({ event: "auth.logout", sessionId: auth.session.id });
    return ok({ revoked: auth.session.id });
  });

  app.post("/api/v1/auth/logout-all", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const body = await c.req.json<{ password: string; confirm: boolean }>();
    if (!body.confirm || !await verify(auth.user.passwordHash, body.password)) {
      return fail(
        "password_confirmation_required",
        "valid password confirmation required",
        403,
      );
    }
    for (const session of state.sessions.values()) {
      if (session.humanUserId === auth.user.id) session.active = false;
    }
    for (const authorization of state.authorizations.values()) {
      if (authorization.humanUserId === auth.user.id) {
        authorization.active = false;
      }
    }
    for (const request of state.requests.values()) {
      if (
        request.humanUserId === auth.user.id && request.status === "pending"
      ) request.status = "invalidated";
    }
    state.audit.push({ event: "auth.logout_all", humanUserId: auth.user.id });
    return ok({ revoked_all: true });
  });

  app.post("/api/v1/test/work", async (c) => {
    const auth = await authenticate(c.req.raw);
    if (auth instanceof Response) return auth;
    const body = await c.req.json<{ project: string; required_role: string }>();
    const allowed = hasSuperAdmin(auth) ||
      auth.context.boundedRoles.some((item) =>
        item.role === body.required_role &&
        (item.boundary.type === "all_projects" ||
          (item.boundary.type === "project" &&
            item.boundary.project_id === body.project))
      );
    if (!allowed) {
      return fail(
        "authorization_insufficient",
        "current authorization does not permit operation",
        403,
        {
          principal_id: auth.context.principalId,
          effective_roles: auth.context.boundedRoles,
          boundary: { type: "project", project_id: body.project },
          failed_capability: { action: "test.work" },
        },
      );
    }
    return ok({
      worked: true,
      project: body.project,
      principal_id: auth.context.principalId,
    });
  });

  async function beginRecovery(
    input: {
      username: string;
      token: string;
      enableUser?: boolean;
      restoreSuperAdmin?: boolean;
      now?: number;
    },
  ) {
    const user = state.users.get(state.usersByName.get(input.username) ?? "");
    if (!user) throw new Error("user not found");
    for (const recovery of state.recoveries.values()) {
      if (recovery.humanUserId === user.id) recovery.active = false;
    }
    for (const session of state.sessions.values()) {
      if (session.humanUserId === user.id) session.active = false;
    }
    for (const authorization of state.authorizations.values()) {
      if (authorization.humanUserId === user.id) authorization.active = false;
    }
    for (const request of state.requests.values()) {
      if (request.humanUserId === user.id && request.status === "pending") {
        request.status = "invalidated";
      }
    }
    const recovery: Recovery = {
      id: id("recovery"),
      humanUserId: user.id,
      tokenHash: await digest(input.token),
      enableUser: input.enableUser ?? false,
      restoreSuperAdmin: input.restoreSuperAdmin ?? false,
      expiresAt: (input.now ?? Date.now()) + 15 * 60_000,
      active: true,
    };
    state.recoveries.set(recovery.id, recovery);
    state.audit.push({
      event: "auth.recovery.initiated",
      recoveryId: recovery.id,
      humanUserId: user.id,
    });
    return recovery;
  }

  app.post("/api/v1/auth/recovery/complete", async (c) => {
    const header = c.req.header("authorization") ?? "";
    if (!header.startsWith("Operant-Recovery ")) {
      return fail("recovery_invalid", "recovery credential required", 401);
    }
    const body = await c.req.json<{ username: string; password: string }>();
    const user = state.users.get(state.usersByName.get(body.username) ?? "");
    const tokenHash = await digest(header.slice(17));
    const recovery = [...state.recoveries.values()].find((item) =>
      item.active && item.humanUserId === user?.id &&
      item.tokenHash === tokenHash
    );
    if (!user || !recovery) {
      return fail("recovery_invalid", "recovery challenge is invalid", 401);
    }
    if (Date.now() >= recovery.expiresAt) {
      recovery.active = false;
      return fail("recovery_expired", "recovery challenge expired", 410);
    }
    if (body.password.length < 8) {
      return fail("validation_failed", "8+ character password required", 400);
    }
    user.passwordHash = await hash(body.password, argonOptions);
    if (recovery.enableUser) user.active = true;
    recovery.active = false;
    const human = await issueSession("human_session", user.id);
    const requestCredential = await issueSession(
      "authorization_request",
      user.id,
    );
    state.audit.push({
      event: "auth.recovery.completed",
      recoveryId: recovery.id,
      restoreSuperAdmin: recovery.restoreSuperAdmin,
    });
    return ok({
      human_session: { id: human.session.id, token: human.token },
      request_credential: {
        id: requestCredential.session.id,
        token: requestCredential.token,
      },
    });
  });

  return {
    app,
    state,
    beginRecovery,
    password: { hash: (value: string) => hash(value, argonOptions), verify },
  };
}
