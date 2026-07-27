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

export interface MetadataCatalog<TRequest, TMetadata> {
  inspect(request: TRequest): Promise<TMetadata>;
}

export interface PackParser<TSource, TPack> {
  parse(source: TSource): Promise<TPack>;
}

export interface PackCatalog<TPackRevision> {
  activePack(): Promise<TPackRevision | null>;
  revision(id: string): Promise<TPackRevision | null>;
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
export type HookResult<TOperation, TAttachment> = Readonly<{
  operations: readonly TOperation[];
  attachments: readonly TAttachment[];
}>;

export interface HookExecutor<TOperation, TAttachment> {
  execute(
    hookIdentity: string,
    input: CuratedHookInput,
    capabilities: Readonly<{
      net: readonly string[];
      env: Readonly<Record<string, string>>;
      secrets: Readonly<Record<string, string>>;
    }>,
  ): Promise<HookResult<TOperation, TAttachment>>;
}

export interface HookSecretResolver {
  resolve(
    revisionId: string,
    hookIdentity: string,
    slots: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
}

export interface SecretCipher {
  encrypt(
    input: Readonly<{
      plaintext: Uint8Array;
      rowId: string;
      version: number;
    }>,
  ): Promise<Uint8Array>;
  decrypt(
    input: Readonly<{
      ciphertext: Uint8Array;
      rowId: string;
      version: number;
    }>,
  ): Promise<Uint8Array>;
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

export interface ActionCatalog<TActionRequest, TActionDefinition> {
  definition(request: TActionRequest): Promise<TActionDefinition | null>;
}

/** Resolves the exact hook revision and source pinned by the action definition. */
export interface PinnedActionHookCatalog<THookRequest, TPinnedHook> {
  pinned(request: THookRequest): Promise<TPinnedHook | null>;
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
  scriptDigest: string;
  actorId: string;
  phase: "action.preview" | "action.commit";
  status: "succeeded" | "failed";
  durationMs: number;
  exitCode: number | null;
  logs: string;
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
