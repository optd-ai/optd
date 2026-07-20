import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract, strictObject } from "../api/contracts.ts";

const Pointer = Type.String({
  pattern: "^/(?:[^~]|~[01])*(?:/(?:[^~]|~[01])*)*$",
});
const Add = strictObject({
  op: Type.Literal("add"),
  path: Pointer,
  value: Type.Unknown(),
});
const Remove = strictObject({ op: Type.Literal("remove"), path: Pointer });
const Replace = strictObject({
  op: Type.Literal("replace"),
  path: Pointer,
  value: Type.Unknown(),
});
const Test = strictObject({
  op: Type.Literal("test"),
  path: Pointer,
  value: Type.Unknown(),
});
export const JsonPatchSchema = Type.Union([Add, Remove, Replace, Test]);
const ValidationMessage = strictObject({
  path: Type.String(),
  code: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export const PatchOutputSchema = strictObject({
  patches: Type.Array(JsonPatchSchema),
  warnings: Type.Optional(Type.Array(ValidationMessage)),
});
export const patchOutputContract = compileContract<PatchOutput>(
  PatchOutputSchema,
);
export type JsonPatch = Static<typeof JsonPatchSchema>;
export type PatchOutput = Static<typeof PatchOutputSchema>;
