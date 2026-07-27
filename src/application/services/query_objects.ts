import type { DefinitionIdentity } from "../../domain/objects/read.ts";
import type {
  QueryRequest,
  QueryResponse,
} from "../../schemas/queries/query.ts";

export type QueryObjectsRequest = QueryRequest;
export type QueryObjectsDto = QueryResponse;
export type ObjectPolicyEvaluation = Readonly<{
  allowed: boolean;
  policyDigest: string;
}>;
export type TargetedActionPolicyTarget = Readonly<{
  definition: DefinitionIdentity;
  objectId?: string;
}>;
