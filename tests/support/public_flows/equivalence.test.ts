// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals } from "jsr:@std/assert";
import {
  COMPLETE_PUBLIC_FLOW_DRIVERS,
  visitCompletePublicFlowDrivers,
} from "./matrix.ts";
import { runCompleteCrmPublicFlow } from "./crm_driver.ts";
import { runCompleteProjectsPublicFlow } from "./projects_driver.ts";

Deno.test("shared public-flow matrix has the immutable two-driver identity", () => {
  assertEquals(COMPLETE_PUBLIC_FLOW_DRIVERS, [
    runCompleteCrmPublicFlow,
    runCompleteProjectsPublicFlow,
  ]);
  assert(Object.isFrozen(COMPLETE_PUBLIC_FLOW_DRIVERS));
});

Deno.test("runtime matrix visits the exact two driver identities in order", async () => {
  const visited: unknown[] = [];
  await visitCompletePublicFlowDrivers((driver) => {
    visited.push(driver);
    return Promise.resolve();
  });
  assertEquals(visited, [
    runCompleteCrmPublicFlow,
    runCompleteProjectsPublicFlow,
  ]);
});

Deno.test("shared public-flow drivers are backend neutral and registrations share one matrix", async () => {
  for (const file of ["crm_driver.ts", "projects_driver.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(
      /(?:from\s+["'][^"']*(?:live_harness|container_harness|postgres)|docker|\.server\.sql|\.backend\s*[=!])/i
        .test(source),
      false,
      file,
    );
    assertEquals(/from\s+["'][^"']*src\//.test(source), false, file);
  }
  const registration = await Deno.readTextFile(
    new URL("register.ts", import.meta.url),
  );
  assertEquals(
    (registration.match(/runCompletePublicFlowMatrix/g) ?? []).length,
    3,
  );
  const container = await Deno.readTextFile(
    new URL(
      "../../e2e/container_release/container_release.test.ts",
      import.meta.url,
    ),
  );
  assertEquals(
    container.includes(
      "in-image CLI exercises CRM and Projects production packs",
    ),
    false,
  );
});
