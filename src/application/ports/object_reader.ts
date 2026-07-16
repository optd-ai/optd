import type { DefinitionIdentity } from "../../domain/objects/read.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import type { AuthorizationRepository } from "./authorization.ts";
import type {
  HistoryEntry,
  ObjectDto,
  RelationshipDto,
} from "../../schemas/api/objects.ts";

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

export interface ObjectReadBoundary {
  execute<T>(
    auth: AuthContext,
    address: ReadAddress,
    work: (
      reader: ObjectReader,
      authorization: AuthorizationRepository,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface ObjectReader {
  read(address: ReadAddress): Promise<ObjectDto | RelationshipDto | null>;
  history(
    address: ReadAddress,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<HistoryPage | null>;
}
