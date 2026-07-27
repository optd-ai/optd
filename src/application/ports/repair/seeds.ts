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
  archivedAt: string | null;
  valuesDigest: string;
}>;

export type SeedReconciliationDecision =
  | Readonly<{ kind: "unchanged"; objectId: string; objectVersion: number }>
  | Readonly<{ kind: "update"; objectId: string; objectVersion: number }>
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
  return match.valuesDigest === desiredValuesDigest
    ? Object.freeze({
      kind: "unchanged" as const,
      objectId: match.objectId,
      objectVersion: match.objectVersion,
    })
    : Object.freeze({
      kind: "update" as const,
      objectId: match.objectId,
      objectVersion: match.objectVersion,
    });
}

export interface SeedCatalog {
  definitions(seedIdentities: readonly string[]): Promise<SeedDefinition[]>;
}

export interface SeedReconciliationRepository {
  findByActiveBusinessKey(seed: SeedDefinition): Promise<SeedMatch | null>;
  verifyActiveUniqueness(constraint: ActiveUniqueConstraint): Promise<boolean>;
}
