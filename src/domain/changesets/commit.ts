export type CommitChangesetDto = Readonly<{
  id: string;
  stage_id: string;
  committed_auth_context_id: string;
  authorization_cutoff_at: string;
  operation_graph_digest: string;
  committed_at: string;
}>;

export type CommitOptions = Readonly<{ lockTimeoutMs: number }>;

export const DEFAULT_COMMIT_LOCK_TIMEOUT_MS = 10_000;
