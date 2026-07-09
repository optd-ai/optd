import { decodeToon, encodeToon } from "./toon-package-spike.ts";

Deno.test("@toon-format/toon works from Deno npm imports", () => {
  const value = {
    ok: true,
    system: { active_pack: "default.crm@0.1.0" },
    resources: ["default.lead", "default.opportunity"],
    items: [{ id: "lead_1", status: "new" }],
  };
  const text = encodeToon(value);
  if (!text.includes("active_pack")) throw new Error(text);
  if (!text.includes("resources")) throw new Error(text);
  const decoded = decodeToon(text) as any;
  if (decoded.system.active_pack !== "default.crm@0.1.0") {
    throw new Error(JSON.stringify(decoded));
  }
  if (decoded.items[0].id !== "lead_1") {
    throw new Error(JSON.stringify(decoded));
  }
});
