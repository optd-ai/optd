import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { Result } from "../../../domain/errors/result.ts";
import type {
  AgentAuthorization,
  AgentAuthorizationRequest,
  AuthContext,
  AuthorizationBoundary,
  BootstrapResult,
  CurrentIdentity,
  HumanSession,
  HumanUser,
  LoginResult,
  PasswordPolicy,
  PasswordReset,
} from "../../../domain/auth/model.ts";
import type { BootstrapStatus } from "../../../application/ports/authentication.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";
import { type AuthVariables, isJsonContentType } from "./auth_middleware.ts";
import { bootstrapStatusDataValidator } from "../../../schemas/auth/bootstrap.ts";
import {
  currentIdentityContract,
  type CurrentIdentityDto,
} from "../../../schemas/repair/current_identity.ts";

export type BootstrapHttpService = {
  status(): Promise<Result<BootstrapStatus>>;
  initialize(
    input: {
      bootstrapToken: string;
      username: unknown;
      displayName: unknown;
      password: unknown;
    },
  ): Promise<Result<BootstrapResult>>;
};
export type HumanAuthHttpService = {
  policy(): Result<PasswordPolicy>;
  login(
    input: {
      username: unknown;
      password: unknown;
      existingRequestSessionId?: unknown;
    },
  ): Promise<Result<LoginResult>>;
  current(auth: AuthContext): Promise<Result<CurrentIdentity>>;
  sessions(auth: AuthContext): Promise<Result<HumanSession[]>>;
  logout(auth: AuthContext): Promise<Result<{ revoked: true }>>;
  logoutAll(
    auth: AuthContext,
    password: unknown,
  ): Promise<Result<{ revoked: number }>>;
  changePassword(
    auth: AuthContext,
    currentPassword: unknown,
    newPassword: unknown,
  ): Promise<Result<LoginResult>>;
  users(auth: AuthContext): Promise<Result<HumanUser[]>>;
  createUser(
    auth: AuthContext,
    input: { username: unknown; displayName: unknown; password: unknown },
  ): Promise<Result<HumanUser>>;
  setUserStatus(
    auth: AuthContext,
    id: string,
    status: "active" | "disabled",
  ): Promise<Result<HumanUser>>;
  requestReset(
    input: { username: unknown; nonceHash: unknown; idempotencyKey: unknown },
  ): Promise<Result<{ requestId: string }>>;
  createResetWatchTicket(
    id: string,
    nonce: string,
  ): Promise<Result<{ ticket: string }>>;
  consumeResetWatchTicket(
    id: string,
    ticket: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  >;
  resetStatus(
    id: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  >;
  subscribeReset(id: string, listener: () => void): Promise<() => void>;
  inspectReset(auth: AuthContext, id: string): Promise<Result<PasswordReset>>;
  decideReset(
    auth: AuthContext,
    id: string,
    decision: "approved" | "denied",
  ): Promise<Result<PasswordReset>>;
  cancelReset(id: string, nonce: string): Promise<Result<PasswordReset>>;
  redeemReset(
    id: string,
    nonce: string,
  ): Promise<Result<{ capability: string }>>;
  completeReset(
    id: string,
    capability: string,
    password: unknown,
  ): Promise<Result<LoginResult>>;
  completeRecovery(
    input: { username: unknown; token: string; password: unknown },
  ): Promise<Result<LoginResult>>;
};

export type AgentAuthHttpService = {
  roles(
    auth: AuthContext,
    boundary: unknown,
  ): Promise<Result<{ roles: string[]; boundary: AuthorizationBoundary }>>;
  request(
    auth: AuthContext,
    input: Record<string, unknown>,
    idempotencyKey: unknown,
  ): Promise<Result<AgentAuthorizationRequest>>;
  inspect(
    auth: AuthContext,
    id: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  decide(
    auth: AuthContext,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Result<AgentAuthorizationRequest>>;
  cancel(
    auth: AuthContext,
    id: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  watchTicket(
    auth: AuthContext,
    id: string,
  ): Promise<Result<{ ticket: string }>>;
  consumeWatchTicket(
    id: string,
    ticket: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  status(id: string): Promise<Result<AgentAuthorizationRequest>>;
  subscribe(id: string, listener: () => void): Promise<() => void>;
  redeem(
    auth: AuthContext,
    id: string,
    nonce: string,
  ): Promise<Result<{ authorization: AgentAuthorization; token: string }>>;
  list(auth: AuthContext): Promise<Result<AgentAuthorization[]>>;
  revoke(auth: AuthContext, id: string): Promise<Result<{ revoked: true }>>;
};

export function registerAuthRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  bootstrap: BootstrapHttpService,
  human: HumanAuthHttpService,
  agent: AgentAuthHttpService,
) {
  const send = <T>(
    c: {
      json(data: unknown, status?: number): Response;
      header(name: string, value: string): void;
    },
    result: Result<T>,
    status = 200,
  ) => {
    if (
      !result.ok &&
      (result.error.code === "authentication_busy" ||
        result.error.code === "login_throttled" ||
        result.error.code === "password_reset_throttled")
    ) {
      const details = result.error.details as
        | { retry_after_seconds?: number }
        | undefined;
      c.header("Retry-After", String(details?.retry_after_seconds ?? 1));
    }
    return result.ok
      ? c.json(successEnvelope(result.value), status)
      : c.json(errorEnvelope(result.error), toHttpStatus(result.error));
  };
  const json = async (
    c: {
      req: {
        header(name: string): string | undefined;
        json(): Promise<unknown>;
      };
      json(data: unknown, status?: number): Response;
    },
  ) => {
    if (!isJsonContentType(c.req.header("content-type") ?? "")) {
      return {
        response: c.json(
          errorEnvelope({
            code: "unsupported_media_type",
            message: "JSON routes require Content-Type application/json",
            details: {},
          }),
          415,
        ),
      };
    }
    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        response: c.json(
          errorEnvelope({
            code: "invalid_json",
            message: "request body must be a JSON object",
            details: {},
          }),
          400,
        ),
      };
    }
    return { body: body as Record<string, unknown> };
  };
  const userData = (result: Result<LoginResult>): Result<unknown> =>
    result.ok ? { ok: true, value: loginData(result.value) } : result;

  app.get("/api/v1/auth/bootstrap/status", async (c) => {
    const result = await bootstrap.status();
    if (!result.ok) return send(c, result);
    const data = { state: result.value };
    bootstrapStatusDataValidator.assert(data);
    return c.json(successEnvelope(data));
  });
  app.post("/api/v1/auth/bootstrap", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const body = parsed.body!;
    if (
      !strictObject(body, ["username", "display_name", "password"], [
        "username",
        "password",
      ])
    ) {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "bootstrap request is invalid",
          details: {},
        }),
        422,
      );
    }
    const match = /^Optd-Bootstrap (.+)$/.exec(
      c.req.header("authorization") ?? "",
    );
    return send(
      c,
      userData(
        await bootstrap.initialize({
          bootstrapToken: match?.[1] ?? "",
          username: body.username,
          displayName: body.display_name ?? body.username,
          password: body.password,
        }),
      ),
      201,
    );
  });
  app.get("/api/v1/auth/password-policy", (c) => send(c, human.policy()));
  app.post("/api/v1/auth/login", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    if (
      !strictObject(parsed.body, [
        "username",
        "password",
        "existing_request_session_id",
      ], ["username", "password"])
    ) {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "login request is invalid",
          details: {},
        }),
        422,
      );
    }
    return send(
      c,
      userData(
        await human.login({
          username: parsed.body!.username,
          password: parsed.body!.password,
          existingRequestSessionId: parsed.body!.existing_request_session_id,
        }),
      ),
    );
  });
  app.get(
    "/api/v1/auth/me",
    async (c) =>
      send(c, mapResult(await human.current(c.get("auth")), identityDto)),
  );
  app.get(
    "/api/v1/auth/sessions",
    async (c) =>
      send(
        c,
        mapResult(await human.sessions(c.get("auth")), (sessions) =>
          sessions.map((session) => ({
            id: session.id,
            credential_kind: session.credentialKind,
            created_at: session.createdAt,
            current: session.current,
          }))),
      ),
  );
  app.post(
    "/api/v1/auth/logout",
    async (c) => send(c, await human.logout(c.get("auth"))),
  );
  app.post("/api/v1/auth/logout-all", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(c, await human.logoutAll(c.get("auth"), parsed.body!.password));
  });
  app.post("/api/v1/auth/password/change", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      userData(
        await human.changePassword(
          c.get("auth"),
          parsed.body!.current_password,
          parsed.body!.new_password,
        ),
      ),
    );
  });
  app.get(
    "/api/v1/auth/users",
    async (c) =>
      send(
        c,
        mapResult(await human.users(c.get("auth")), (users) =>
          users.map(userDto)),
      ),
  );
  app.post("/api/v1/auth/users", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const body = parsed.body!;
    return send(
      c,
      mapResult(
        await human.createUser(c.get("auth"), {
          username: body.username,
          displayName: body.display_name ?? body.username,
          password: body.password,
        }),
        userDto,
      ),
      201,
    );
  });
  app.patch("/api/v1/auth/users/:id", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const status = parsed.body!.status;
    if (status !== "active" && status !== "disabled") {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "status must be active or disabled",
          details: {},
        }),
        422,
      );
    }
    return send(
      c,
      mapResult(
        await human.setUserStatus(c.get("auth"), c.req.param("id"), status),
        userDto,
      ),
    );
  });

  app.post("/api/v1/auth/password-reset/requests", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const body = parsed.body!;
    const result = await human.requestReset({
      username: body.username,
      nonceHash: body.redemption_nonce_hash,
      idempotencyKey: c.req.header("idempotency-key"),
    });
    return result.ok
      ? c.json(successEnvelope({ request_id: result.value.requestId }), 202)
      : send(c, result);
  });
  app.post(
    "/api/v1/auth/password-reset/requests/:id/watch-ticket",
    async (c) => {
      const parsed = await json(c);
      if (parsed.response) return parsed.response;
      return send(
        c,
        await human.createResetWatchTicket(
          c.req.param("id"),
          String(parsed.body!.redemption_nonce ?? ""),
        ),
      );
    },
  );
  app.get(
    "/api/v1/auth/password-reset/requests/:id/watch",
    upgradeWebSocket((c) => {
      const id = c.req.param("id") ?? "";
      const ticket = c.req.query("ticket") ?? "";
      let unsubscribe: (() => void) | undefined;
      let lastVersion = -1;
      const sendState = async (
        ws: {
          send(data: string): void;
          close(code?: number, reason?: string): void;
        },
      ) => {
        const state = await human.resetStatus(id);
        if (!state.ok) {
          ws.close(1008, state.error.code);
          return;
        }
        if (state.value.version <= lastVersion) return;
        lastVersion = state.value.version;
        ws.send(
          JSON.stringify({
            type: "password_reset_status",
            request_id: state.value.requestId,
            version: state.value.version,
            status: state.value.status,
          }),
        );
        if (state.value.status !== "pending") {
          ws.close(1000, state.value.status);
        }
      };
      return {
        async onOpen(_event, ws) {
          const consumed = await human.consumeResetWatchTicket(id, ticket);
          if (!consumed.ok) {
            ws.close(1008, consumed.error.code);
            return;
          }
          unsubscribe = await human.subscribeReset(
            id,
            () => void sendState(ws),
          );
          await sendState(ws);
        },
        onClose() {
          unsubscribe?.();
        },
        onError() {
          unsubscribe?.();
        },
      };
    }),
  );
  app.get(
    "/api/v1/auth/password-reset/requests/:id",
    async (c) =>
      send(c, await human.inspectReset(c.get("auth"), c.req.param("id"))),
  );
  app.post("/api/v1/auth/password-reset/requests/:id/decision", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const decision = parsed.body!.decision;
    if (decision !== "approved" && decision !== "denied") {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "decision is invalid",
          details: {},
        }),
        422,
      );
    }
    return send(
      c,
      await human.decideReset(c.get("auth"), c.req.param("id"), decision),
    );
  });
  app.post("/api/v1/auth/password-reset/requests/:id/cancel", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      await human.cancelReset(
        c.req.param("id"),
        String(parsed.body!.redemption_nonce ?? ""),
      ),
    );
  });
  app.post("/api/v1/auth/password-reset/requests/:id/redeem", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      await human.redeemReset(
        c.req.param("id"),
        String(parsed.body!.redemption_nonce ?? ""),
      ),
    );
  });
  app.post("/api/v1/auth/password-reset/requests/:id/complete", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      userData(
        await human.completeReset(
          c.req.param("id"),
          String(parsed.body!.capability ?? ""),
          parsed.body!.password,
        ),
      ),
    );
  });
  app.get("/api/v1/auth/roles", async (c) => {
    const type = c.req.query("boundary_type");
    const boundary = type === "project"
      ? { type, project_id: c.req.query("project_id") }
      : { type };
    return send(
      c,
      mapResult(await agent.roles(c.get("auth"), boundary), (value) => ({
        roles: value.roles,
        boundary: boundaryDto(value.boundary),
      })),
    );
  });
  app.post("/api/v1/auth/requests", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      mapResult(
        await agent.request(
          c.get("auth"),
          parsed.body!,
          c.req.header("idempotency-key"),
        ),
        agentRequestDto,
      ),
      201,
    );
  });
  app.get(
    "/api/v1/auth/requests/:id",
    async (c) =>
      send(
        c,
        mapResult(
          await agent.inspect(c.get("auth"), c.req.param("id")),
          agentRequestDto,
        ),
      ),
  );
  app.post("/api/v1/auth/requests/:id/decision", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      mapResult(
        await agent.decide(c.get("auth"), c.req.param("id"), parsed.body!),
        agentRequestDto,
      ),
    );
  });
  app.post(
    "/api/v1/auth/requests/:id/cancel",
    async (c) =>
      send(
        c,
        mapResult(
          await agent.cancel(c.get("auth"), c.req.param("id")),
          agentRequestDto,
        ),
      ),
  );
  app.post(
    "/api/v1/auth/requests/:id/watch-ticket",
    async (c) =>
      send(c, await agent.watchTicket(c.get("auth"), c.req.param("id"))),
  );
  app.get(
    "/api/v1/auth/requests/:id/watch",
    upgradeWebSocket((c) => {
      const id = c.req.param("id") ?? "";
      const ticket = c.req.query("ticket") ?? "";
      let unsubscribe: (() => void) | undefined;
      let lastVersion = -1;
      const sendState = async (
        ws: {
          send(data: string): void;
          close(code?: number, reason?: string): void;
        },
      ) => {
        const state = await agent.status(id);
        if (!state.ok) return ws.close(1008, state.error.code);
        if (state.value.version <= lastVersion) return;
        lastVersion = state.value.version;
        ws.send(JSON.stringify({
          type: "auth_request_status",
          request_id: id,
          version: state.value.version,
          status: state.value.status,
          ...(state.value.denialReason
            ? { reason: state.value.denialReason }
            : {}),
        }));
        if (state.value.status !== "pending") {
          ws.close(1000, state.value.status);
        }
      };
      return {
        async onOpen(_event, ws) {
          const consumed = await agent.consumeWatchTicket(id, ticket);
          if (!consumed.ok) return ws.close(1008, consumed.error.code);
          unsubscribe = await agent.subscribe(
            id,
            () => void sendState(ws),
          );
          await sendState(ws);
        },
        onClose() {
          unsubscribe?.();
        },
        onError() {
          unsubscribe?.();
        },
      };
    }),
  );
  app.post("/api/v1/auth/requests/:id/redeem", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    return send(
      c,
      mapResult(
        await agent.redeem(
          c.get("auth"),
          c.req.param("id"),
          String(parsed.body!.redemption_nonce ?? ""),
        ),
        (value) => ({
          token: value.token,
          authorization: authorizationDto(value.authorization),
        }),
      ),
    );
  });
  app.get(
    "/api/v1/auth/authorizations",
    async (c) =>
      send(
        c,
        mapResult(await agent.list(c.get("auth")), (values) =>
          values.map(authorizationDto)),
      ),
  );
  app.post(
    "/api/v1/auth/authorizations/:id/revoke",
    async (c) => send(c, await agent.revoke(c.get("auth"), c.req.param("id"))),
  );

  app.post("/api/v1/auth/recovery/complete", async (c) => {
    const parsed = await json(c);
    if (parsed.response) return parsed.response;
    const match = /^Optd-Recovery (.+)$/.exec(
      c.req.header("authorization") ?? "",
    );
    return send(
      c,
      userData(
        await human.completeRecovery({
          username: parsed.body!.username,
          token: match?.[1] ?? "",
          password: parsed.body!.password,
        }),
      ),
    );
  });
}

function mapResult<T, U>(
  result: Result<T>,
  transform: (value: T) => U,
): Result<U> {
  return result.ok ? { ok: true, value: transform(result.value) } : result;
}
function boundaryDto(boundary: AuthorizationBoundary) {
  return boundary.type === "project"
    ? { type: boundary.type, project_id: boundary.projectId }
    : { type: boundary.type };
}
function agentRequestDto(request: AgentAuthorizationRequest) {
  return {
    id: request.id,
    status: request.status,
    version: request.version,
    roles: request.roles,
    boundary: boundaryDto(request.boundary),
    reason: request.reason,
    ...(request.denialReason ? { denial_reason: request.denialReason } : {}),
    ...(request.agentName ? { agent_name: request.agentName } : {}),
    created_at: request.createdAt,
    ...(request.alreadyAuthorized ? { already_authorized: true } : {}),
    ...(request.authorizationId
      ? { authorization_id: request.authorizationId }
      : {}),
  };
}
function authorizationDto(authorization: AgentAuthorization) {
  return {
    id: authorization.id,
    agent_user_id: authorization.agentUserId,
    human_user_id: authorization.humanUserId,
    ...(authorization.parentAuthorizationId
      ? { parent_authorization_id: authorization.parentAuthorizationId }
      : {}),
    root_authorization_id: authorization.rootAuthorizationId,
    role_assignments: authorization.roleAssignments.map((assignment) => ({
      role: assignment.role,
      boundary: boundaryDto(assignment.boundary),
    })),
    active: authorization.active,
    created_at: authorization.createdAt,
  };
}
function identityDto(identity: CurrentIdentity): CurrentIdentityDto {
  const dto = {
    credential_kind: identity.credentialKind,
    principal: {
      id: identity.principalId,
      type: identity.principalType,
    },
    human_user: userDto(identity.humanUser),
    ...(identity.agent
      ? {
        agent: {
          id: identity.agent.id,
          principal_id: identity.agent.principalId,
          name: identity.agent.name,
          authorization_id: identity.agent.authorizationId,
          ...(identity.agent.parentAuthorizationId
            ? {
              parent_authorization_id: identity.agent.parentAuthorizationId,
            }
            : {}),
          root_authorization_id: identity.agent.rootAuthorizationId,
          authorization_ancestry_ids: identity.agent.authorizationAncestryIds,
        },
      }
      : {}),
    role_assignments: identity.roleAssignments.map((assignment) => ({
      role: assignment.role,
      boundary: boundaryDto(assignment.boundary),
    })),
    session_id: identity.sessionId,
    auth_context_id: identity.authContextId,
  };
  currentIdentityContract.assert(dto);
  return dto;
}
function userDto(user: HumanUser) {
  return {
    id: user.id,
    principal_id: user.principalId,
    username: user.username,
    display_name: user.displayName,
    status: user.status,
  };
}
function loginData(result: LoginResult) {
  return {
    user: {
      id: result.user.id,
      principal_id: result.user.principalId,
      username: result.user.username,
      display_name: result.user.displayName,
      status: result.user.status,
    },
    credentials: {
      token: result.credentials.token,
      session_id: result.credentials.fullSessionId,
      authorization_request_session_id: result.credentials.requestSessionId,
      authorization_request_retained: result.credentials.requestRetained,
      ...(result.credentials.requestToken === undefined
        ? {}
        : { authorization_request_token: result.credentials.requestToken }),
    },
  };
}
export function strictObject(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}
