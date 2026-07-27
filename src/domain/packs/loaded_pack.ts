export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export type UploadedPackFile = {
  path: string;
  text: string;
  kind?: "config" | "script";
};

export type PackDefinitionKind =
  | "Pack"
  | "Resource"
  | "Relationship"
  | "Lifecycle"
  | "Action"
  | "Hook"
  | "Role"
  | "Policy"
  | "Seed";

export type NormalizedDefinition = {
  kind: PackDefinitionKind;
  path: string;
  name: string;
  publisher: string;
  pack: string;
  identity: string;
  document: Record<string, JsonValue>;
  spec: Record<string, JsonValue>;
};

export type LoadedPack = {
  publisher: string;
  name: string;
  version: string;
  revision: string;
  sourceDigest: string;
  manifest: Record<string, JsonValue>;
  normalized: Record<string, JsonValue>;
  sourceFiles: Array<
    { path: string; kind: "config" | "script"; digest: string; content: string }
  >;
  resources: Record<string, NormalizedDefinition>;
  relationships: Record<string, NormalizedDefinition>;
  lifecycles: Record<string, NormalizedDefinition>;
  actions: Record<string, NormalizedDefinition>;
  hooks: Record<
    string,
    NormalizedDefinition & {
      script: string;
      scriptDigest: string;
      securityDigest: string;
    }
  >;
  roles: Record<string, NormalizedDefinition>;
  policies: Record<string, NormalizedDefinition>;
  seeds: Record<string, NormalizedDefinition>;
  scripts: Record<string, { path: string; digest: string; content: string }>;
};
