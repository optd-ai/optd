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

export interface TransactionPort {
  transaction<T>(
    work: (transaction: RepositoryTransaction) => Promise<T>,
  ): Promise<T>;
}

export type DefinitionDescriptor<TSchema extends JsonValue> = Readonly<{
  identity: string;
  versionId: string;
  version: number;
  schema: TSchema;
}>;

export interface DefinitionCatalog<TSchema extends JsonValue> {
  active(identity: string): Promise<DefinitionDescriptor<TSchema> | null>;
}

export interface ObjectReaderPort<
  TReadRequest,
  TObject,
  THistoryRequest,
  THistory,
> {
  read(request: TReadRequest): Promise<TObject | null>;
  history(request: THistoryRequest): Promise<THistory | null>;
}

export interface AuthorizationReaderPort<TAuthorizationRequest> {
  authorize(request: TAuthorizationRequest): Promise<boolean>;
}

export type ReadSessionAuthority<
  TReadRequest,
  TObject,
  THistoryRequest,
  THistory,
  TAuthorizationRequest,
> = Readonly<{
  reader: ObjectReaderPort<
    TReadRequest,
    TObject,
    THistoryRequest,
    THistory
  >;
  /** Reusable for every policy evaluation in this one immutable session. */
  authorization: AuthorizationReaderPort<TAuthorizationRequest>;
  /** Frozen into history/query cursors and compared at the next request. */
  authorizationRootId: string;
}>;

export interface ReadSessionPort<
  TReadRequest,
  TObject,
  THistoryRequest,
  THistory,
  TAuthorizationRequest,
  TAuthContext,
  TAddress,
> {
  execute<T>(
    auth: TAuthContext,
    address: TAddress,
    work: (
      authority: ReadSessionAuthority<
        TReadRequest,
        TObject,
        THistoryRequest,
        THistory,
        TAuthorizationRequest
      >,
    ) => Promise<T>,
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

/** Supplies every frozen policy fact needed by query and target cutoffs. */
export interface QueryPolicyRepository<
  TAuthorityRequest,
  TDefinitionRequest,
  TDefinition,
  TRoleRequest,
  TRoleFacts,
  TPolicyRequest,
  TPolicyFacts,
  TRelationshipRequest,
  TRelationshipFacts,
> {
  lockReadAuthority(
    request: TAuthorityRequest,
    transaction: RepositoryTransaction,
  ): Promise<void>;
  definition(request: TDefinitionRequest): Promise<TDefinition | null>;
  roleFacts(request: TRoleRequest): Promise<TRoleFacts>;
  policyFacts(request: TPolicyRequest): Promise<TPolicyFacts>;
  relationshipFacts(request: TRelationshipRequest): Promise<TRelationshipFacts>;
}

/** Persists changeset requests, immutable object/version facts and evidence. */
export interface ChangesetFactRepository<
  TPreviewRequest,
  TPreviewResult,
  TCommitRequest,
  TCommitResult,
  TViewRequest,
  TViewResult,
  THistoryRequest,
  THistoryResult,
> {
  persistPreview(request: TPreviewRequest): Promise<TPreviewResult>;
  commitFacts(
    request: TCommitRequest,
    transaction: RepositoryTransaction,
  ): Promise<TCommitResult>;
  view(request: TViewRequest): Promise<TViewResult | null>;
  history(request: THistoryRequest): Promise<THistoryResult>;
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

export interface PackCatalog<TPackRequest, TPackRevision, TCandidate> {
  list(request: TPackRequest): Promise<readonly TPackRevision[]>;
  active(request: TPackRequest): Promise<TPackRevision | null>;
  revision(id: string): Promise<TPackRevision | null>;
  revisionCount(transaction?: RepositoryTransaction): Promise<number>;
  storeOrReuseCandidate(
    candidate: TCandidate,
    transaction: RepositoryTransaction,
  ): Promise<TPackRevision>;
}

export type MigrationApplyAttempt = Readonly<{
  planId: string;
  authContextId: string;
  attempt: number;
  outcome: string;
}>;

export interface MigrationRepository<
  TPlanRequest,
  TPlan,
  TInspection,
  TValidation,
  TApplyRequest,
  TApplyResult,
> {
  plan(request: TPlanRequest): Promise<TPlan>;
  inspect(id: string): Promise<TInspection | null>;
  validate(id: string): Promise<TValidation | null>;
  generatedSql(id: string): Promise<readonly string[] | null>;
  apply(
    request: TApplyRequest,
    transaction: RepositoryTransaction,
  ): Promise<TApplyResult | null>;
  /** Records denied, transient/retried and terminal failed apply attempts. */
  recordApplyAttempt(
    request: MigrationApplyAttempt,
    transaction: RepositoryTransaction,
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
  Readonly<{
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
  }>;

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

/** Curated action reads include immutable object-version evidence. */
export interface ActionCuratedReadRepository<TReadRequest, TReadResult> {
  read(request: TReadRequest): Promise<TReadResult | null>;
}

/** Resolves ordered action-stage attachments and only action-stage programs. */
export interface ActionStageHookCatalog<TRequest> {
  stageHooks(
    request: TRequest,
  ): Promise<readonly PinnedHookProgram<"action.stage">[]>;
}

const ACTION_STAGE_AUTHORITY_CUTOFF: unique symbol = Symbol(
  "ActionStageAuthorityCutoff",
);

/**
 * Opaque validated authority cutoff. All target digest input is derived from
 * `authorization`; no caller-supplied duplicate actor/root/target facts exist.
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
    !(ACTION_STAGE_AUTHORITY_CUTOFF in value) ||
    (value as Record<PropertyKey, unknown>)[ACTION_STAGE_AUTHORITY_CUTOFF] !==
      true ||
    !Object.isFrozen(value)
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
  return Object.freeze({
    authorization,
    canonicalTargetDigest: computed,
    authorityFactsDigest: input.authorityFactsDigest,
    [ACTION_STAGE_AUTHORITY_CUTOFF]: true as const,
  });
}

/**
 * Locks and evaluates exact action authority in one transaction, then persists
 * that same immutable root/target/digest tuple after hooks complete outside it.
 */
export interface ActionStageAuthorityPort<
  TAuthorityRequest,
  TStageRequest,
  TStageResult,
> {
  lockAndEvaluate(
    request: TAuthorityRequest,
  ): Promise<ActionStageAuthorityCutoff>;
  persistAfterHooks(
    request: TStageRequest,
    cutoff: ActionStageAuthorityCutoff,
  ): Promise<TStageResult>;
}

/** Resolves the exact action-stage hook pinned by the action definition. */
export interface PinnedActionHookCatalog<THookRequest> {
  pinned(
    request: THookRequest,
  ): Promise<PinnedHookProgram<"action.stage"> | null>;
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
export interface ActionTargetReader<TTargetRequest, TObject> {
  current(request: TTargetRequest): Promise<ActionTarget<TObject> | null>;
}

/** Evaluates and asserts semantic-action authority for the reviewed target. */
export interface ActionPolicyAuthorizer<TAuthorizationRequest, TDecision> {
  assertAllowed(request: TAuthorizationRequest): Promise<TDecision>;
}

export type ActionHookExecutionEvidence<TOutput, TError> = Readonly<{
  hookIdentity: string;
  revisionId: string;
  sourceDigest: string;
  scriptDigest: string;
  securityDigest: string;
  attachmentId: string | null;
  attachmentDigest: string | null;
  configurationDigest: string;
  outputSchema: string;
  actorId: string;
  phase: HookPhase;
  status: "succeeded" | "failed" | "timed_out" | "invalid_output";
  durationMs: number;
  exitCode: number | null;
  logs: string;
  logsTruncated: boolean;
  secretsRedacted: boolean;
  grants: readonly HookSecretGrantEvidence[];
  output: TOutput | null;
  error: TError | null;
}>;

/** Persists one immutable success/failure record for the pinned hook execution. */
export interface HookExecutionEvidenceRepository<
  TOutput,
  TError,
  TEvidenceId,
> {
  record(
    evidence: ActionHookExecutionEvidence<TOutput, TError>,
  ): Promise<TEvidenceId>;
}
