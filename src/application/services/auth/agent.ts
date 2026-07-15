import type { AuthRepository } from "../../ports/authentication.ts";
import type {
  AuthContext,
  AuthorizationBoundary,
} from "../../../domain/auth/model.ts";
import { validationError } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

const rolePattern =
  /^(?:system:[a-z][a-z0-9_]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9_]*)$/;

function boundary(value: unknown): AuthorizationBoundary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.type === "system" && Object.keys(input).length === 1) {
    return { type: "system" };
  }
  if (input.type === "all_projects" && Object.keys(input).length === 1) {
    return { type: "all_projects" };
  }
  if (
    input.type === "project" && Object.keys(input).length === 2 &&
    typeof input.project_id === "string" && isUuidV7(input.project_id)
  ) {
    return { type: "project", projectId: input.project_id };
  }
}

export function makeAgentAuthService(repository: AuthRepository) {
  return {
    roles: (auth: AuthContext, input: unknown) => {
      const parsed = boundary(input);
      return parsed ? repository.discoverRoles(auth, parsed) : Promise.resolve({
        ok: false as const,
        error: validationError(
          "validation_failed",
          "authorization boundary is invalid",
        ),
      });
    },
    request: (
      auth: AuthContext,
      input: Record<string, unknown>,
      idempotencyKey: unknown,
    ) => {
      const allowedKeys = [
        "roles",
        "boundary",
        "reason",
        "redemption_nonce_hash",
        "agent",
      ];
      const roles = Array.isArray(input.roles)
        ? [
          ...new Set(input.roles.filter((role): role is string =>
            typeof role === "string"
          )),
        ].sort()
        : [];
      const parsedBoundary = boundary(input.boundary);
      if (
        Object.keys(input).some((key) => !allowedKeys.includes(key)) ||
        roles.length === 0 || roles.length > 32 ||
        roles.some((role) => !rolePattern.test(role)) ||
        !parsedBoundary || typeof input.reason !== "string" ||
        input.reason.length > 2000 ||
        typeof input.redemption_nonce_hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.redemption_nonce_hash) ||
        typeof idempotencyKey !== "string" || idempotencyKey.length < 16
      ) {
        return Promise.resolve({
          ok: false as const,
          error: validationError(
            "validation_failed",
            "authorization request is invalid",
          ),
        });
      }
      const agent = input.agent;
      if (
        agent !== undefined &&
        (!agent || typeof agent !== "object" || Array.isArray(agent) ||
          Object.keys(agent).some((key) =>
            ![
              "name",
              "harness",
              "external_session_id",
              "provider",
              "model",
              "reasoning_effort",
            ].includes(key)
          ) || Object.values(agent).some((value) => typeof value !== "string"))
      ) {
        return Promise.resolve({
          ok: false as const,
          error: validationError(
            "validation_failed",
            "agent metadata is invalid",
          ),
        });
      }
      return repository.createAuthorizationRequest(auth, {
        roles,
        boundary: parsedBoundary,
        reason: input.reason,
        nonceHash: input.redemption_nonce_hash,
        idempotencyKey,
        agentName: (agent as Record<string, string> | undefined)?.name,
      });
    },
    inspect: (auth: AuthContext, id: string) =>
      repository.inspectAuthorizationRequest(auth, id),
    decide: (auth: AuthContext, id: string, input: Record<string, unknown>) => {
      if (
        Object.keys(input).some((key) =>
          !["decision", "reason", "agent_name", "capability_summary_digest"]
            .includes(key)
        ) ||
        (input.decision !== "approved" && input.decision !== "denied") ||
        (input.decision === "denied" &&
          (typeof input.reason !== "string" || !input.reason.trim()))
      ) {
        return Promise.resolve({
          ok: false as const,
          error: validationError(
            "validation_failed",
            "authorization decision is invalid",
          ),
        });
      }
      return repository.decideAuthorizationRequest(auth, id, {
        decision: input.decision,
        reason: typeof input.reason === "string" ? input.reason : undefined,
        agentName: typeof input.agent_name === "string"
          ? input.agent_name
          : undefined,
        capabilitySummaryDigest:
          typeof input.capability_summary_digest === "string"
            ? input.capability_summary_digest
            : undefined,
      });
    },
    cancel: (auth: AuthContext, id: string) =>
      repository.cancelAuthorizationRequest(auth, id),
    watchTicket: (auth: AuthContext, id: string) =>
      repository.createAuthorizationWatchTicket(auth, id),
    consumeWatchTicket: (id: string, ticket: string) =>
      repository.consumeAuthorizationWatchTicket(id, ticket),
    status: (id: string) => repository.authorizationRequestStatus(id),
    subscribe: (id: string, listener: () => void) =>
      repository.subscribeAuthorizationRequest(id, listener),
    redeem: (auth: AuthContext, id: string, nonce: string) =>
      repository.redeemAuthorizationRequest(auth, id, nonce),
    list: (auth: AuthContext) => repository.listAuthorizations(auth),
    revoke: (auth: AuthContext, id: string) =>
      repository.revokeAuthorization(auth, id),
  };
}
