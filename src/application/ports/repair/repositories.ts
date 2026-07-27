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

export interface ReadSessionPort<
  TReadRequest,
  TObject,
  THistoryRequest,
  THistory,
  TAuthorizationRequest,
> {
  execute<T>(
    work: (
      reader: ObjectReaderPort<
        TReadRequest,
        TObject,
        THistoryRequest,
        THistory
      >,
      authorization: AuthorizationReaderPort<TAuthorizationRequest>,
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
export type HookPhase =
  | "before_validate"
  | "validate"
  | "before_apply"
  | "after_apply"
  | "action.stage"
  | "action.preview"
  | "action.commit"
  | "delivery";

export type HookSecretDeclaration = Readonly<{
  slot: string;
  env: string;
}>;

/** Immutable hook program, attachment and capability declaration. */
export type PinnedHookProgram = Readonly<{
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
  phase: HookPhase;
  timeoutMs: number;
  outputSchema: string;
  permissions: Readonly<{
    net: readonly string[];
    env: readonly string[];
  }>;
  secretDeclarations: readonly HookSecretDeclaration[];
  enabled: boolean;
}>;

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

export type HookOutput =
  | Readonly<{ kind: "patch"; patch: JsonValue }>
  | Readonly<{
    kind: "validation";
    valid: boolean;
    code?: string;
    message?: string;
    details?: JsonValue;
  }>
  | Readonly<{
    kind: "action";
    operations: readonly JsonValue[];
    attachments: readonly JsonValue[];
  }>
  | Readonly<{
    kind: "delivery";
    outcome: "delivered" | "retry" | "failed";
    providerEvidence: JsonValue;
  }>;

export type HookExecutionResult = Readonly<{
  status: "succeeded" | "failed" | "timed_out" | "invalid_output";
  output: HookOutput | null;
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

export type HookInvocation = Readonly<{
  program: PinnedHookProgram;
  input: CuratedHookInput;
  capabilities: Readonly<{
    net: readonly string[];
    env: Readonly<Record<string, string>>;
    secrets: ResolvedHookSecrets;
  }>;
}>;

export interface HookExecutor {
  execute(invocation: HookInvocation): Promise<HookExecutionResult>;
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

/** Resolves ordered action-stage attachments and their pinned programs. */
export interface ActionStageHookCatalog<TRequest> {
  stageHooks(request: TRequest): Promise<readonly PinnedHookProgram[]>;
}

/** Resolves the exact hook revision and source pinned by the action definition. */
export interface PinnedActionHookCatalog<THookRequest, TPinnedHook> {
  pinned(request: THookRequest): Promise<TPinnedHook | null>;
}

/** Resolves and verifies the enabled delivery hook pinned by an outbox row. */
export interface PinnedDeliveryHookCatalog<TRequest> {
  deliveryHook(request: TRequest): Promise<PinnedHookProgram | null>;
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
  phase: "action.preview" | "action.commit";
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
