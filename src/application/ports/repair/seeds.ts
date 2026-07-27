export type ActiveUniqueConstraint = Readonly<{
  name: string;
  projectScoped: true;
  fields: readonly string[];
  predicate: "active()";
}>;

export type SeedDefinition = Readonly<{
  seedIdentity: string;
  resource: string;
  keyField: string;
  keyValue: string | number | boolean;
  activeUniqueness: ActiveUniqueConstraint;
  values: Readonly<Record<string, unknown>>;
}>;

export type SeedMatch = Readonly<{
  objectId: string;
  objectVersion: number;
  /** Exact immutable object_versions.id dependency. */
  objectVersionId: string;
  archivedAt: string | null;
  valuesDigest: string;
}>;

export type SeedActivePresence =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
    kind: "present";
    objectId: string;
    currentObjectVersionId: string;
  }>;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Freezes the exact active-only presence dependency staged for commit. */
export function freezeSeedActivePresence(
  match: SeedMatch | null,
): SeedActivePresence {
  if (!match || match.archivedAt !== null) {
    return Object.freeze({ kind: "absent" as const });
  }
  if (!UUID_V7.test(match.objectVersionId)) {
    throw new Error("seed current_object_version_id must be UUIDv7");
  }
  return Object.freeze({
    kind: "present" as const,
    objectId: match.objectId,
    currentObjectVersionId: match.objectVersionId,
  });
}

export function seedActivePresenceMatches(
  frozen: SeedActivePresence,
  current: SeedMatch | null,
): boolean {
  const observed = freezeSeedActivePresence(current);
  return frozen.kind === "absent"
    ? observed.kind === "absent"
    : observed.kind === "present" &&
      observed.objectId === frozen.objectId &&
      observed.currentObjectVersionId === frozen.currentObjectVersionId;
}

export type SeedReconciliationDecision =
  | Readonly<{
    kind: "unchanged";
    objectId: string;
    objectVersion: number;
    objectVersionId: string;
  }>
  | Readonly<{
    kind: "update";
    objectId: string;
    objectVersion: number;
    objectVersionId: string;
  }>
  | Readonly<{ kind: "create"; objectId: string }>;

export interface IdAllocator {
  nextUuidV7(): string;
}

/** Archived rows are historical evidence and never candidates for restore/update. */
export function decideSeedReconciliation(
  matches: readonly SeedMatch[],
  desiredValuesDigest: string,
  ids: IdAllocator,
): SeedReconciliationDecision {
  const active = matches.filter((match) => match.archivedAt === null);
  if (active.length > 1) {
    throw new Error("active-only seed uniqueness is violated");
  }
  if (active.length === 0) {
    const objectId = ids.nextUuidV7();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(objectId)
    ) {
      throw new Error("seed replacement ID must be UUIDv7");
    }
    return Object.freeze({ kind: "create" as const, objectId });
  }
  const match = active[0];
  freezeSeedActivePresence(match);
  return match.valuesDigest === desiredValuesDigest
    ? Object.freeze({
      kind: "unchanged" as const,
      objectId: match.objectId,
      objectVersion: match.objectVersion,
      objectVersionId: match.objectVersionId,
    })
    : Object.freeze({
      kind: "update" as const,
      objectId: match.objectId,
      objectVersion: match.objectVersion,
      objectVersionId: match.objectVersionId,
    });
}

export interface SeedCatalog {
  definitions(seedIdentities: readonly string[]): Promise<SeedDefinition[]>;
}

export const ACTIVE_SEED_KEY_CONFLICT = "active_seed_key_conflict" as const;

export type SeedReplacementCommitAttempt =
  | Readonly<{ kind: "inserted"; objectId: string }>
  | Readonly<{ kind: "unique_conflict"; constraint: string }>;

export type SeedReplacementCommitResult =
  | Readonly<{ kind: "created"; objectId: string }>
  | Readonly<{
    kind: "conflict";
    code: typeof ACTIVE_SEED_KEY_CONFLICT;
    constraint: string;
  }>;

/** Normalizes an ordinary active-only uniqueness loser to one stable conflict. */
export function seedReplacementCommitResult(
  attempt: SeedReplacementCommitAttempt,
  constraint: ActiveUniqueConstraint,
): SeedReplacementCommitResult {
  if (attempt.kind === "inserted") {
    return Object.freeze({
      kind: "created" as const,
      objectId: attempt.objectId,
    });
  }
  if (attempt.constraint !== constraint.name) {
    throw new Error("unexpected seed replacement uniqueness conflict");
  }
  return Object.freeze({
    kind: "conflict" as const,
    code: ACTIVE_SEED_KEY_CONFLICT,
    constraint: attempt.constraint,
  });
}

export interface SeedReconciliationRepository {
  findByActiveBusinessKey(seed: SeedDefinition): Promise<SeedMatch | null>;
  freezeActivePresence(seed: SeedDefinition): Promise<SeedActivePresence>;
  revalidateActivePresence(
    seed: SeedDefinition,
    frozen: SeedActivePresence,
  ): Promise<boolean>;
  verifyActiveUniqueness(constraint: ActiveUniqueConstraint): Promise<boolean>;
  createActiveReplacement(
    seed: SeedDefinition,
    objectId: string,
  ): Promise<SeedReplacementCommitResult>;
}
