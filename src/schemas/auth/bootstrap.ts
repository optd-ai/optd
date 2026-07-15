import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract, type ContractValidator } from "../api/contracts.ts";

export const BootstrapStateSchema = Type.Union([
  Type.Literal("bootstrap_required"),
  Type.Literal("bootstrap_in_progress"),
  Type.Literal("active"),
]);

export const BootstrapStatusDataSchema = Type.Object({
  state: BootstrapStateSchema,
}, { additionalProperties: false });

export type BootstrapStatusData = Static<typeof BootstrapStatusDataSchema>;
export const bootstrapStatusDataValidator: ContractValidator<
  BootstrapStatusData
> = compileContract<BootstrapStatusData>(BootstrapStatusDataSchema);
