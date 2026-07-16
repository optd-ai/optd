import { isUuidV7 } from "../ids/uuid_v7.ts";

export type DefinitionKind = "resource" | "relationship";
export type DefinitionIdentity = Readonly<{
  kind: DefinitionKind;
  publisher: string;
  pack: string;
  name: string;
}>;

const PUBLISHER = /^[a-z][a-z0-9-]{0,62}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

export function assertReadAddress(input: {
  projectId: string;
  objectId: string;
  publisher: string;
  pack: string;
  name: string;
}): void {
  if (!isUuidV7(input.projectId) || !isUuidV7(input.objectId)) {
    throw new TypeError(
      "project_id and object id must be lowercase UUIDv7 values",
    );
  }
  if (
    !PUBLISHER.test(input.publisher) || !NAME.test(input.pack) ||
    !NAME.test(input.name)
  ) {
    throw new TypeError(
      "definition identity must be canonical lowercase publisher/pack:name",
    );
  }
}

export function qualifiedIdentity(identity: DefinitionIdentity): string {
  return `${identity.publisher}/${identity.pack}:${identity.name}`;
}
