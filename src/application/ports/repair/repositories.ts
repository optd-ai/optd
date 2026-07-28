import {
  type AuthorizationCutoff,
  canonicalTargetDigestInput,
  type TargetDigestInput,
} from "./targeted_action.ts";

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type RepositoryTransaction = Readonly<{
  /** Opaque application correlation only; adapters retain physical handles. */
  id: string;
}>;

export interface TransactionPort<TContext = RepositoryTransaction> {
  transaction<T>(work: (transaction: TContext) => Promise<T>): Promise<T>;
}

export type DefinitionDescriptor<TSchema extends JsonValue> = Readonly<{
  identity: string;
  versionId: string;
  version: number;
  schema: TSchema;
}>;

export interface DefinitionCatalog<TRequest, TDefinition> {
  definition(request: TRequest): Promise<TDefinition | null>;
}

export interface ObjectReaderPort<
  TReadArgs extends readonly unknown[],
  TObject,
  THistoryArgs extends readonly unknown[],
  THistory,
> {
  read(...args: TReadArgs): Promise<TObject | null>;
  history(...args: THistoryArgs): Promise<THistory | null>;
}

export interface AuthorizationReaderPort<TAuthorizationRequest, TResult> {
  authorize(request: TAuthorizationRequest): Promise<TResult>;
}

/**
 * Executes application orchestration inside one adapter-owned immutable read
 * session. The request and session capability are application types; physical
 * transaction handles never cross this boundary.
 */
export interface ReadSessionPort<TRequest, TSession> {
  execute<T>(
    request: TRequest,
    work: (session: TSession) => Promise<T>,
  ): Promise<T>;
}

export interface QueryObjectRepository<
  TQueryRequest,
  TQueryPage,
  TViewRequest,
  TObject,
  THistoryRequest,
  THistoryPage,
> {
  query(request: TQueryRequest): Promise<TQueryPage>;
  view(request: TViewRequest): Promise<TObject | null>;
  history(request: THistoryRequest): Promise<THistoryPage | null>;
}

/** Same-session physical policy/page primitive selected by application query orchestration. */
export interface QueryPolicyRepository<TRequest, TResult> extends
  Pick<
    QueryObjectRepository<TRequest, TResult, never, never, never, never>,
    "query"
  > {}

/** Persists staged changeset facts, evidence, approvals and cancellation atomically. */
export interface ChangesetFactRepository<
  TCreateArgs extends readonly unknown[],
  TInspectArgs extends readonly unknown[],
  TDecisionArgs extends readonly unknown[],
  TCancelArgs extends readonly unknown[],
  TResult,
> {
  create(...args: TCreateArgs): Promise<TResult>;
  inspect(...args: TInspectArgs): Promise<TResult>;
  approvals(...args: TInspectArgs): Promise<TResult>;
  decideApproval(...args: TDecisionArgs): Promise<TResult>;
  cancel(...args: TCancelArgs): Promise<TResult>;
}

export interface MetadataCatalog<
  TRequest,
  THome,
  TPack,
  TDefinition,
  TListItem,
> {
  home(request: TRequest): Promise<THome>;
  listPacks(request: TRequest): Promise<readonly TListItem[]>;
  pack(request: TRequest): Promise<TPack | null>;
  definition(request: TRequest): Promise<TDefinition | null>;
  hookScriptDigest(request: TRequest): Promise<string | null>;
}

export interface PackParser<TSource, TPack> {
  parse(source: TSource): Promise<TPack>;
}

export interface PackCatalog<
  TPlanArgs extends readonly unknown[],
  TPlanResult,
  TSummaryArgs extends readonly unknown[],
  TSummary,
> {
  plan(...args: TPlanArgs): Promise<TPlanResult>;
  summarize(...args: TSummaryArgs): TSummary;
}

export type MigrationApplyAttempt = Readonly<{
  planId: string;
  authContextId: string;
  attempt: number;
  outcome: string;
}>;

export interface MigrationRepository<
  TInspection,
  TViolations,
  TValidation,
  TApplyRequest,
  TAuthContext,
  TApplyResult,
> {
  inspect(id: string): Promise<TInspection | null>;
  violations(id: string): Promise<TViolations | null>;
  validate(id: string, authContextId: string): Promise<TValidation | null>;
  generatedSql(id: string): Promise<readonly string[] | null>;
  applyOnce(
    id: string,
    request: TApplyRequest,
    auth: TAuthContext,
    attempt: number,
  ): Promise<TApplyResult | null>;
  /** Records denied, transient/retried and terminal failed apply attempts. */
  recordFailedAttempt(
    id: string,
    authContextId: string,
    outcome: string,
  ): Promise<void>;
}

export type CuratedHookInput = Readonly<{ [key: string]: JsonValue }>;

/** The four frozen attachment phases. Commit never executes hooks. */
export type HookPhase =
  | "action.stage"
  | "changeset.before_stage"
  | "changeset.validate"
  | "event.after_commit";

export type HookSecretDeclaration = Readonly<{
  slot: string;
  env: string;
}>;

/** Immutable hook program, attachment and capability declaration. */
type HookOutputSchemaFor<TPhase extends HookPhase> = TPhase extends
  "action.stage" ? "changeset.operations.v1"
  : TPhase extends "changeset.before_stage" ? "patch.v1"
  : TPhase extends "changeset.validate" ? "validation.v1"
  : TPhase extends "event.after_commit" ? "delivery.v1"
  : never;

type PinnedHookProgramFields = Readonly<{
  hookIdentity: string;
  revisionId: string;
  source: string;
  sourceDigest: string;
  scriptDigest: string;
  securityDigest: string;
  attachmentId: string | null;
  attachmentDigest: string | null;
  configurationDigest: string;
  declarationDigest: string | null;
  declaration: JsonValue;
  ordinal: number;
  timeoutMs: number;
  permissions: Readonly<{
    net: readonly string[];
    env: readonly string[];
  }>;
  secretDeclarations: readonly HookSecretDeclaration[];
  enabled: boolean;
}>;

/** A pinned program's phase determines its one allowed output schema. */
export type PinnedHookProgram<TPhase extends HookPhase = HookPhase> =
  TPhase extends HookPhase ?
      & PinnedHookProgramFields
      & Readonly<{
        phase: TPhase;
        outputSchema: HookOutputSchemaFor<TPhase>;
      }>
    : never;

export type HookSecretGrantEvidence = Readonly<{
  grantId: string;
  secretId: string;
  secretVersion: number;
  hookRevisionId: string;
  securityDigest: string;
  slot: string;
  env: string;
}>;

export type ResolvedHookSecrets = Readonly<{
  values: Readonly<Record<string, string>>;
  grants: readonly HookSecretGrantEvidence[];
}>;

export type HookIssue = Readonly<{
  path: string;
  code: string;
  message: string;
  details?: JsonValue;
}>;

/** Each phase has exactly one strict output family. */
export type HookOutput =
  | Readonly<{
    phase: "action.stage";
    schema: "changeset.operations.v1";
    operations: readonly JsonValue[];
    warnings?: readonly HookIssue[];
    errors?: readonly HookIssue[];
  }>
  | Readonly<{
    phase: "changeset.before_stage";
    schema: "patch.v1";
    patches: readonly JsonValue[];
    warnings?: readonly HookIssue[];
  }>
  | Readonly<{
    phase: "changeset.validate";
    schema: "validation.v1";
    allow: true;
    errors: readonly [];
    warnings: readonly HookIssue[];
    required_approvals: readonly JsonValue[];
  }>
  | Readonly<{
    phase: "changeset.validate";
    schema: "validation.v1";
    allow: false;
    errors: readonly [HookIssue, ...HookIssue[]];
    warnings: readonly HookIssue[];
    required_approvals: readonly JsonValue[];
  }>
  | Readonly<{
    phase: "event.after_commit";
    schema: "delivery.v1";
    outcome: "succeeded";
    summary: string;
    external_id?: string;
  }>
  | Readonly<{
    phase: "event.after_commit";
    schema: "delivery.v1";
    outcome: "retry";
    code: string;
    message: string;
    retry_after?: string;
  }>
  | Readonly<{
    phase: "event.after_commit";
    schema: "delivery.v1";
    outcome: "dead_letter";
    code: string;
    message: string;
  }>;

export type HookOutputFor<TPhase extends HookPhase> = Extract<
  HookOutput,
  { phase: TPhase }
>;

export type HookExecutionResult<TPhase extends HookPhase = HookPhase> =
  TPhase extends HookPhase ? Readonly<{
      /** Retained even for failures whose output is null. */
      phase: TPhase;
      outputSchema: HookOutputSchemaFor<TPhase>;
      status: "succeeded" | "failed" | "timed_out" | "invalid_output";
      output: HookOutputFor<TPhase> | null;
      logs: string;
      logsTruncated: boolean;
      secretsRedacted: boolean;
      durationMs: number;
      exitCode: number | null;
      error:
        | Readonly<{
          code: string;
          message: string;
          details?: JsonValue;
        }>
        | null;
    }>
    : never;

export type HookInvocation<TPhase extends HookPhase = HookPhase> = Readonly<{
  program: PinnedHookProgram<TPhase>;
  input: CuratedHookInput;
  capabilities: Readonly<{
    net: readonly string[];
    env: Readonly<Record<string, string>>;
    secrets: ResolvedHookSecrets;
  }>;
}>;

export interface HookExecutor {
  execute<TPhase extends HookPhase>(
    invocation: HookInvocation<TPhase>,
  ): Promise<HookExecutionResult<TPhase>>;
}

export interface HookSecretResolver {
  resolve(
    request: Readonly<{
      revisionId: string;
      hookIdentity: string;
      securityDigest: string;
      declarations: readonly HookSecretDeclaration[];
    }>,
  ): Promise<ResolvedHookSecrets>;
}

export type SecretValueAad = Readonly<{
  rowId: string;
  version: number;
}>;

export interface SecretCipher {
  hasKey(): boolean;
  validateKey(): void;
  keyId(): Promise<string>;
  encrypt(plaintext: string, aad: SecretValueAad): Promise<SecretCiphertext>;
  decrypt(encrypted: SecretCiphertext, aad: SecretValueAad): Promise<string>;
}

export type SecretCiphertext = Readonly<{
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  algorithm: "AES-256-GCM";
  keyId: string;
  valueVersion: number;
}>;

/** Complete persistence lifecycle; plaintext remains outside this port. */
export interface SecretRepository<TMetadata, TLockedSecret, TAudit> {
  list(): Promise<readonly TMetadata[]>;
  /** Preserves the legacy name-keyed set operation and its audit atomically. */
  upsertByName(
    secret: Readonly<{
      name: string;
      description: string | null;
      encrypted: SecretCiphertext;
      authContextId: string;
      audit: TAudit;
    }>,
    transaction: RepositoryTransaction,
  ): Promise<TMetadata>;
  /** Preserves hard delete-by-name and its deleted/not-found audit atomically. */
  hardDeleteByName(
    request: Readonly<{
      name: string;
      authContextId: string;
      audit: TAudit;
    }>,
    transaction: RepositoryTransaction,
  ): Promise<boolean>;
  resolveActiveByName(name: string): Promise<TLockedSecret | null>;
  create(
    secret: Readonly<{
      id: string;
      name: string;
      description: string | null;
      encrypted: SecretCiphertext;
      authContextId: string;
    }>,
    transaction: RepositoryTransaction,
  ): Promise<TMetadata>;
  lockForUpdate(
    id: string,
    transaction: RepositoryTransaction,
  ): Promise<TLockedSecret | null>;
  rotate(
    id: string,
    encrypted: SecretCiphertext,
    authContextId: string,
    transaction: RepositoryTransaction,
  ): Promise<TMetadata>;
  disable(
    id: string,
    authContextId: string,
    transaction: RepositoryTransaction,
  ): Promise<TMetadata | null>;
  resolveActive(id: string): Promise<TLockedSecret | null>;
  appendAudit(
    audit: TAudit,
    transaction: RepositoryTransaction,
  ): Promise<void>;
  assertReady(): Promise<void>;
}

export interface HookSecretGrantRepository<
  TGrant,
  THookSlot,
  TSecret,
  TAudit,
  TAuthorizationRequest,
> {
  list(): Promise<readonly TGrant[]>;
  authorizeInTransaction(
    request: TAuthorizationRequest,
    transaction: RepositoryTransaction,
  ): Promise<void>;
  lockAndValidateActiveHookSlot(
    request: Readonly<{
      revisionId: string;
      securityDigest: string;
      slot: string;
    }>,
    transaction: RepositoryTransaction,
  ): Promise<THookSlot | null>;
  lockActiveSecret(
    secretId: string,
    transaction: RepositoryTransaction,
  ): Promise<TSecret | null>;
  lockCurrentGrant(
    grantId: string,
    transaction: RepositoryTransaction,
  ): Promise<TGrant | null>;
  lockEffectiveGrant(
    revisionId: string,
    slot: string,
    transaction: RepositoryTransaction,
  ): Promise<TGrant | null>;
  create(
    grant: TGrant,
    transaction: RepositoryTransaction,
  ): Promise<void>;
  replace(
    expectedGrantId: string,
    replacement: TGrant,
    transaction: RepositoryTransaction,
  ): Promise<boolean>;
  revoke(
    grantId: string,
    reason: string | null,
    authContextId: string,
    transaction: RepositoryTransaction,
  ): Promise<boolean>;
  appendAudit(
    audit: TAudit,
    transaction: RepositoryTransaction,
  ): Promise<void>;
}

export type OutboxMutationAuthority = Readonly<{
  authContextId: string;
  /** Called after the delivery row is locked, in the mutation transaction. */
  revalidate(transaction: RepositoryTransaction): Promise<boolean>;
}>;

export type OutboxOperatorMutation = Readonly<{
  deliveryId: string;
  reason?: string;
  authority: OutboxMutationAuthority;
}>;

export type OutboxDrainAudit = Readonly<{
  authContextId: string;
  limit: number;
}>;

export type OutboxOperatorMutationStatus =
  | "pending"
  | "cancelled"
  | "authorization_changed"
  | "delivery_not_found"
  | "delivery_not_retryable"
  | "delivery_in_progress";

/** Atomic delivery lifecycle, inspection, operator control and drain audit. */
export interface OutboxRepository<
  TClaimRequest,
  TClaimedDelivery,
  TCompletionRequest,
  TCompletionStatus,
  TListRequest,
  TDelivery,
  TAttemptRequest,
  TAttempt,
> {
  claim(request: TClaimRequest): Promise<readonly TClaimedDelivery[]>;
  complete(request: TCompletionRequest): Promise<TCompletionStatus>;
  list(request: TListRequest): Promise<readonly TDelivery[]>;
  inspect(id: string): Promise<TDelivery | null>;
  attempts(request: TAttemptRequest): Promise<readonly TAttempt[]>;
  retry(request: OutboxOperatorMutation): Promise<OutboxOperatorMutationStatus>;
  cancel(
    request: OutboxOperatorMutation,
  ): Promise<OutboxOperatorMutationStatus>;
  auditDrain(audit: OutboxDrainAudit): Promise<void>;
}

export interface ActionCatalog<
  TActionRequest,
  TActionDefinition,
  TAvailability = TActionDefinition,
> {
  definition(request: TActionRequest): Promise<TActionDefinition | null>;
  availability(request: TActionRequest): Promise<TAvailability | null>;
}

declare const ACTION_STAGE_AUTHORITY_CUTOFF: unique symbol;
const validatedActionStageAuthorityCutoffs = new WeakSet<object>();

/**
 * Opaque validated authority cutoff. All target digest input is derived from
 * `authorization`; no caller-supplied duplicate actor/root/target facts exist.
 * Runtime authenticity is object identity registered by the private factory.
 */
export type ActionStageAuthorityCutoff = Readonly<{
  authorization: AuthorizationCutoff;
  canonicalTargetDigest: string;
  authorityFactsDigest: string;
  readonly [ACTION_STAGE_AUTHORITY_CUTOFF]: true;
}>;

export type CanonicalTargetDigester = (
  input: TargetDigestInput,
) => string | Promise<string>;

export class InvalidActionStageAuthorityCutoffError extends Error {
  constructor(
    message = "canonical target digest does not match authorization cutoff",
  ) {
    super(message);
    this.name = "InvalidActionStageAuthorityCutoffError";
  }
}

/** Runtime trust-boundary guard for untyped adapter/caller values. */
export function assertActionStageAuthorityCutoff(
  value: unknown,
): asserts value is ActionStageAuthorityCutoff {
  if (
    typeof value !== "object" || value === null ||
    !validatedActionStageAuthorityCutoffs.has(value)
  ) {
    throw new InvalidActionStageAuthorityCutoffError(
      "action stage authority cutoff was not created by the validated factory",
    );
  }
}

function immutableAuthorizationCutoff(
  authorization: AuthorizationCutoff,
): AuthorizationCutoff {
  return Object.freeze({
    actor: Object.freeze({ ...authorization.actor }),
    authorizationRootId: authorization.authorizationRootId,
    authorizationLineageIds: Object.freeze([
      ...authorization.authorizationLineageIds,
    ]),
    targets: Object.freeze(
      authorization.targets.map((evidence) =>
        Object.freeze({
          target: Object.freeze({
            ...evidence.target,
            ...(evidence.target.object
              ? { object: Object.freeze({ ...evidence.target.object }) }
              : {}),
          }),
          policyDigest: evidence.policyDigest,
          matchedRules: Object.freeze(
            evidence.matchedRules.map((rule) => Object.freeze({ ...rule })),
          ),
          roleAssignmentIds: Object.freeze([...evidence.roleAssignmentIds]),
          relationshipIds: Object.freeze([...evidence.relationshipIds]),
        })
      ),
    ),
  });
}

/** Creates the only valid cutoff, verifying any persisted digest first. */
export async function createActionStageAuthorityCutoff(
  input: Readonly<{
    authorization: AuthorizationCutoff;
    authorityFactsDigest: string;
    canonicalTargetDigest?: string;
  }>,
  digest: CanonicalTargetDigester,
): Promise<ActionStageAuthorityCutoff> {
  const authorization = immutableAuthorizationCutoff(input.authorization);
  const computed = await digest(canonicalTargetDigestInput(authorization));
  if (
    input.canonicalTargetDigest !== undefined &&
    input.canonicalTargetDigest !== computed
  ) {
    throw new InvalidActionStageAuthorityCutoffError();
  }
  const cutoff = Object.freeze({
    authorization,
    canonicalTargetDigest: computed,
    authorityFactsDigest: input.authorityFactsDigest,
  }) as ActionStageAuthorityCutoff;
  validatedActionStageAuthorityCutoffs.add(cutoff);
  return cutoff;
}

/**
 * Locks and evaluates exact action authority in one transaction, then persists
 * that same immutable root/target/digest tuple after hooks complete outside it.
 */
export interface ActionStageAuthorityPort<TAuthorityRequest, TCutoff> {
  lockAndEvaluate(request: TAuthorityRequest): Promise<TCutoff>;
}

/** Resolves the exact ordered action-stage hooks pinned by the definition. */
export interface PinnedActionHookCatalog<
  THookRequest,
  THookResult = PinnedHookProgram<"action.stage">,
> {
  pinned(request: THookRequest): Promise<readonly THookResult[]>;
}

/** Resolves and verifies only an after-commit delivery hook. */
export interface PinnedDeliveryHookCatalog<TRequest> {
  deliveryHook(
    request: TRequest,
  ): Promise<PinnedHookProgram<"event.after_commit"> | null>;
}

export type ActionTarget<TObject> = Readonly<{
  resource: string;
  name: string;
  objectId: string;
  objectVersionId: string;
  object: TObject;
}>;

/** Reads the active target object, including its immutable version evidence. */
export interface ActionTargetReader<TTargetRequest, TResult> {
  current(request: TTargetRequest): Promise<TResult | null>;
}

/** Evaluates and asserts semantic-action authority for the reviewed target. */
export interface ActionPolicyAuthorizer<TAuthorizationRequest, TDecision> {
  assertAllowed(request: TAuthorizationRequest): Promise<TDecision>;
}

export type ActionHookExecutionEvidence<
  TPhase extends HookPhase = "action.stage",
> = TPhase extends HookPhase ? Readonly<{
    /** Program is the single source for phase, schema and immutable pin facts. */
    program: PinnedHookProgram<TPhase>;
    actorId: string;
    grants: readonly HookSecretGrantEvidence[];
    /** Result output is constrained to the same phase family as the program. */
    result: HookExecutionResult<TPhase>;
  }>
  : never;

/** Persists immutable action-stage evidence; no commit hook path exists. */
export interface HookExecutionEvidenceRepository<TEvidence, TResult> {
  /** Atomically persists the post-hook staged facts and immutable evidence. */
  record(evidence: TEvidence): Promise<TResult>;
}
