import type { AuthContext } from "../../domain/auth/model.ts";
import type { DeliveryOutcome } from "../../domain/outbox/delivery.ts";
import type {
  OutboxOperatorMutationStatus,
  OutboxRepository,
} from "./repair/repositories.ts";

export type OutboxClaim = Readonly<{
  id: string;
  attempt_id: string;
  retry_generation: number;
  attempt_number: number;
  total_attempt_number: number;
  lease_expires_at: string;
  hook_revision_id: string;
  attachment_id: string;
  candidate_revision_id: string;
  hook_identity: string;
  script_digest: string;
  security_digest: string;
  attachment_digest: string;
  config_digest: string;
  output_schema: string;
  envelope_json: unknown;
  attachment_spec_json: unknown;
  hook_config_json: unknown;
  capabilities_json: unknown;
  pinned_grants_json: unknown;
  timeout_ms: number;
  max_attempts: number;
}>;

export type OutboxExecutionEvidence = Readonly<{
  duration_ms: number;
  exit_code: number | null;
  logs: string;
  logs_truncated: boolean;
  secrets_redacted: boolean;
  grants: unknown[];
}>;

export type OutboxClaimRequest = Readonly<{
  workerId: string;
  limit: number;
  leaseMarginMs: number;
  now: Date;
}>;

export type OutboxCompletionRequest = Readonly<{
  claim: OutboxClaim;
  outcome: DeliveryOutcome;
  evidence: OutboxExecutionEvidence;
  delayMs: number;
  now: Date;
}>;

export type OutboxListRequest = Readonly<{
  filters: Record<string, unknown>;
  limit: number;
  cursor?: { created_at: string; id: string };
}>;

export type OutboxAttemptRequest = Readonly<{
  deliveryId: string;
  limit: number;
  after: number;
}>;

type FrozenOutboxLifecycle = OutboxRepository<
  OutboxClaimRequest,
  OutboxClaim,
  OutboxCompletionRequest,
  string,
  OutboxListRequest,
  Record<string, unknown>,
  OutboxAttemptRequest,
  Record<string, unknown>
>;

export type OutboxMutationRequest = Readonly<{
  deliveryId: string;
  reason?: string;
  authContextId: string;
  /** The concrete repository revalidates this immutable context after locking. */
  auth: AuthContext;
}>;

export type OutboxLifecyclePort =
  & Omit<FrozenOutboxLifecycle, "retry" | "cancel">
  & {
    retry(
      request: OutboxMutationRequest,
    ): Promise<OutboxOperatorMutationStatus>;
    cancel(
      request: OutboxMutationRequest,
    ): Promise<OutboxOperatorMutationStatus>;
  };

export type PinnedDeliveryProgram = Readonly<{
  source: string;
  config: Record<string, unknown>;
}>;

export interface PinnedDeliveryHookCatalog {
  load(claim: OutboxClaim): Promise<PinnedDeliveryProgram>;
}

export type ResolvedDeliverySecrets = Readonly<{
  values: Readonly<Record<string, string>>;
  evidence: readonly unknown[];
}>;

export interface DeliverySecretResolver {
  resolve(claim: OutboxClaim): Promise<ResolvedDeliverySecrets>;
}

export type DeliveryHookRunResult = Readonly<{
  ok: boolean;
  output: unknown;
  durationMs: number;
  exitCode: number | null;
  logs: string;
  logsTruncated?: boolean;
  secretsRedacted?: boolean;
  error?: { code: string; message: string };
}>;

export interface DeliveryHookExecutor {
  run(
    request: Readonly<{
      claim: OutboxClaim;
      program: PinnedDeliveryProgram;
      secretValues: Readonly<Record<string, string>>;
      envelope: Record<string, unknown>;
    }>,
  ): Promise<DeliveryHookRunResult>;
}

export interface OutboxCursorPort {
  decode(
    cursor: string,
    filters: Record<string, unknown>,
  ): Promise<{ created_at: string; id: string }>;
  encode(
    value: { created_at: string; id: string },
    filters: Record<string, unknown>,
  ): Promise<string>;
  decodeAttempt(cursor: string, deliveryId: string): Promise<number>;
  encodeAttempt(deliveryId: string, attempt: number): Promise<string>;
}

export interface OutboxAuthorizationPort {
  authorize(
    request: Readonly<{
      auth: AuthContext;
      boundary: { type: "system" };
      action: string;
      resource: "system:outbox";
    }>,
  ): Promise<import("../../domain/errors/result.ts").Result<unknown>>;
}
