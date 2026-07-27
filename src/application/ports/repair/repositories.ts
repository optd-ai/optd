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

export interface MigrationRepository<
  TPlanRequest,
  TPlan,
  TInspection,
  TValidation,
  TApplyResult,
> {
  plan(request: TPlanRequest): Promise<TPlan>;
  inspect(id: string): Promise<TInspection>;
  validate(id: string): Promise<TValidation>;
  apply(
    id: string,
    transaction: RepositoryTransaction,
  ): Promise<TApplyResult>;
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

export interface OutboxRepository<TDelivery, TEvidence> {
  lease(batchSize: number, now: string): Promise<readonly TDelivery[]>;
  markDelivered(id: string, evidence: TEvidence): Promise<void>;
  markRetry(id: string, retryAt: string, evidence: TEvidence): Promise<void>;
  markFailed(id: string, evidence: TEvidence): Promise<void>;
}

export interface ActionCatalog<TActionDefinition> {
  definition(identity: string): Promise<TActionDefinition | null>;
}
