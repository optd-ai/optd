import type {
  CompletePublicFlowHarness,
  PublicFlowLauncher,
} from "../public_flow_contract.ts";

export type PublicFlowAsset =
  | "crm"
  | "projects"
  | "crm_migration_v1"
  | "crm_migration_transitional"
  | "crm_migration_final"
  | "projects_auxiliary";

export type PersistenceCounts = Readonly<{
  stages: string;
  versions: string;
}>;

export type RelationshipTupleEvidence = Readonly<{
  fromObjectId: string;
  toObjectId: string;
}>;

export type MigrationEvidence = Readonly<{
  activeRevisionId: string;
  activation: string;
  applications: string;
  catalog: string;
  sourceFields: string;
  physicalColumns: string;
  physicalRows: string;
}>;

export type MigrationSideEffects = Readonly<{
  validations: string;
  tokens: string;
  attempts: string;
  audits: string;
  latestOutcome: string | null;
  latestDecision: string | null;
  latestDetails: string | null;
}>;

export type ProviderBehavior =
  | Readonly<{ kind: "success"; status?: number; body?: unknown }>
  | Readonly<{
    kind: "retry";
    status?: number;
    retryAfterSeconds: number;
    body?: unknown;
  }>
  | Readonly<{
    kind: "retry_then_success";
    status?: number;
    retryAfterSeconds: number;
    successHoldToken: string;
    body?: unknown;
  }>
  | Readonly<{ kind: "hold"; token: string; status?: number; body?: unknown }>;

export type ProviderAttemptEvidence = Readonly<{
  id: number;
  idempotencyKey: string | null;
  duplicate: boolean;
  body: string;
}>;

export type HookQuiescenceEvidence = Readonly<{
  pending: number;
  running: number;
  retryWait: number;
  cacheEntries: number;
  children: number;
}>;

export const QUIESCENT_HOOK_EVIDENCE: HookQuiescenceEvidence = Object.freeze({
  pending: 0,
  running: 0,
  retryWait: 0,
  cacheEntries: 0,
  children: 0,
});

/** Test-only semantic evidence and fault controls. Public facts are never made here. */
export interface CompletePublicFlowEvidence {
  assetPath(asset: PublicFlowAsset): Promise<string>;
  materializeInput(name: string, value: unknown): Promise<string>;
  loginProcess(
    username: string,
    password: string,
  ): Promise<
    Readonly<{
      launcher: PublicFlowLauncher;
      result: {
        code: number;
        stdout: string;
        stderr: string;
      };
    }>
  >;

  observeCrmApprovalPolicy(): Promise<readonly Record<string, string>[]>;
  observeCrmRelationshipPolicy(): Promise<readonly Record<string, string>[]>;
  observePersistenceCounts(): Promise<PersistenceCounts>;
  observeAuthContextPrincipal(authContextId: string): Promise<string>;
  observeCrmLostReasonId(projectId: string): Promise<string>;
  observeProjectsTodoStageId(projectId: string): Promise<string>;
  observeProjectsTaskCount(projectId: string, state: string): Promise<number>;
  observeProjectsTimesheets(
    projectId: string,
    principalId: string,
  ): Promise<
    readonly Readonly<{
      principalId: string;
      hours: string;
    }>[]
  >;
  observeCrmRelationshipAuthority(
    input: Readonly<{
      principalId: string;
      projectId: string;
    }>,
  ): Promise<number>;
  observeRelationshipTuple(
    input: Readonly<{
      pack: "crm" | "projects_auxiliary";
      relationship: string;
      projectId: string;
      fromObjectId: string;
    }>,
  ): Promise<RelationshipTupleEvidence | null>;
  ciphertextContainsAny(values: readonly string[]): Promise<boolean>;

  configureProvider(behaviors: readonly ProviderBehavior[]): Promise<string>;
  enqueueProviderBehaviors(
    behaviors: readonly ProviderBehavior[],
  ): Promise<void>;
  providerAttempts(): Promise<readonly ProviderAttemptEvidence[]>;
  providerEffects(): Promise<readonly ProviderAttemptEvidence[]>;

  installMigrationFailureBarrier(): Promise<void>;
  removeMigrationFailureBarrier(): Promise<void>;
  holdMigrationTableLock(): Promise<void>;
  releaseMigrationTableLock(): Promise<void>;
  observeMigration(
    projectId: string,
    leadId: string,
  ): Promise<MigrationEvidence>;
  observeMigrationSideEffects(planId: string): Promise<MigrationSideEffects>;

  observeHookQuiescence(): Promise<HookQuiescenceEvidence>;
  /** Waits until all nonterminal deliveries and hook children have exited and cleaned up. */
  awaitHookQuiescence(): Promise<HookQuiescenceEvidence>;
  /** Proves cleanup joined all backend-owned processes and removed runtime state. */
  assertQuiescent(): Promise<void>;
}

export async function waitForHookQuiescence(
  observe: () => Promise<HookQuiescenceEvidence>,
  options: Readonly<{ timeoutMs?: number; pollMs?: number }> = {},
): Promise<HookQuiescenceEvidence> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let last: HookQuiescenceEvidence | undefined;
  while (Date.now() < deadline) {
    last = await observe();
    if (isHookQuiescent(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 20));
  }
  throw new Error(
    `hook runtime did not become quiescent: ${JSON.stringify(last)}`,
  );
}

function isHookQuiescent(evidence: HookQuiescenceEvidence): boolean {
  return evidence.pending === 0 && evidence.running === 0 &&
    evidence.retryWait === 0 && evidence.cacheEntries === 0 &&
    evidence.children === 0;
}

export type CompletePublicFlowBackend =
  & CompletePublicFlowHarness
  & CompletePublicFlowEvidence;
