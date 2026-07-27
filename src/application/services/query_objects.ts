import type { AuthContext } from "../../domain/auth/model.ts";
import {
  err,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type { DefinitionIdentity } from "../../domain/objects/read.ts";
import {
  type QueryRequest,
  queryRequestContract,
  type QueryResponse,
} from "../../schemas/queries/query.ts";
import type { QueryObjectRepository } from "../ports/repair/repositories.ts";

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
export type QueryCall = Readonly<{ input: QueryRequest; auth: AuthContext }>;

type QueryObjectsPort = Pick<
  QueryObjectRepository<
    QueryCall,
    Result<QueryResponse>,
    never,
    never,
    never,
    never
  >,
  "query"
>;

/** Application-owned use case over the frozen query repository port. */
export function makeQueryObjectsService(port: QueryObjectsPort) {
  return Object.freeze({
    query(input: unknown, auth?: AuthContext): Promise<Result<QueryResponse>> {
      if (!auth) {
        return Promise.resolve(err({
          ...validationError(
            "authentication_required",
            "authentication is required",
          ),
          severity: "authentication",
        }));
      }
      const issues = queryRequestContract.issues(input);
      if (issues.length) {
        return Promise.resolve(err(validationError(
          "bad_request",
          "query request is invalid",
          { issues },
        )));
      }
      return port.query({ input: input as QueryRequest, auth });
    },
  });
}
