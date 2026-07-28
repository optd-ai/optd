import type { DefinitionIdentity } from "../../domain/objects/read.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import type { AuthorizationRepository } from "./authorization.ts";
import type {
  HistoryEntry,
  ObjectDto,
  RelationshipDto,
} from "../../schemas/api/objects.ts";
import type { ObjectReaderPort } from "./repair/repositories.ts";

export type ReadAddress = Readonly<{
  projectId: string;
  objectId: string;
  definition: DefinitionIdentity;
}>;
export type HistoryPage = Readonly<{
  items: HistoryEntry[];
  hasMore: boolean;
  nextPosition: { createdAt: string; id: string } | null;
}>;

export type ReadAuthorityAnchor = Readonly<{
  authorizationRootId: string;
}>;

export class ObjectReadAuthorityInvalidError extends Error {
  constructor() {
    super("object read authority is no longer valid");
  }
}

export interface ObjectPolicyReader {
  evaluate(
    input: Readonly<{
      projectId: string;
      objectId: string;
      definition: DefinitionIdentity;
      actions: readonly string[];
    }>,
    auth: AuthContext,
  ): Promise<Readonly<{ allowed: boolean; policyDigest: string }>>;
}

export interface ObjectReadBoundary {
  execute<T>(
    auth: AuthContext,
    address: ReadAddress,
    work: (
      reader: ObjectReader,
      authorization: AuthorizationRepository,
      anchor: ReadAuthorityAnchor,
      policy: ObjectPolicyReader,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface ObjectReader extends
  ObjectReaderPort<
    readonly [address: ReadAddress],
    ObjectDto | RelationshipDto,
    readonly [
      address: ReadAddress,
      limit: number,
      before?: { createdAt: string; id: string },
    ],
    HistoryPage
  > {}
