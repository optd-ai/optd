// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { registerHostPublicFlowMatrix } from "../../support/public_flows/register.ts";
import "../../support/public_flows/equivalence.test.ts";

registerHostPublicFlowMatrix();

Deno.test("CRM public output source and selected trace leak barriers", async () => {
  const pack = join(Deno.cwd(), "prototypes", "crm-default-pack");
  const sources = await Promise.all([
    Deno.readTextFile(join(pack, "hooks", "notify_crm_change.ts")),
    Deno.readTextFile(join(pack, "hooks", "convert_lead.ts")),
  ]);
  for (const source of sources) {
    assertEquals(
      /Bearer |authorization:|OPTD_DATABASE_URL|postgres:\/\//i.test(source),
      false,
    );
  }
});
