import { decode, encode } from "npm:@toon-format/toon";

export function encodeToon(value: unknown): string {
  return encode(value);
}

export function decodeToon(text: string): unknown {
  return decode(text);
}

if (import.meta.main) {
  const sample = {
    ok: true,
    system: { active_pack: "default.crm@0.1.0" },
    resources: ["default.lead", "default.opportunity"],
    help: ["optctl metadata resource default.lead"],
  };
  console.log(encodeToon(sample));
}
