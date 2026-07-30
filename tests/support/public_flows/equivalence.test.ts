// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals } from "jsr:@std/assert";
import {
  COMPLETE_PUBLIC_FLOW_DRIVERS,
  visitCompletePublicFlowDrivers,
} from "./matrix.ts";
import {
  type HookQuiescenceEvidence,
  QUIESCENT_HOOK_EVIDENCE,
  waitForHookQuiescence,
} from "./backend.ts";
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

Deno.test("hook quiescence barrier blocks retry_wait until it is terminalized or cancelled", async () => {
  let evidence: HookQuiescenceEvidence = {
    ...QUIESCENT_HOOK_EVIDENCE,
    retryWait: 1,
  };
  let settled = false;
  const barrier = waitForHookQuiescence(() => Promise.resolve(evidence), {
    timeoutMs: 500,
    pollMs: 1,
  }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(settled, false, "retry_wait caused a false quiescent return");
  evidence = QUIESCENT_HOOK_EVIDENCE;
  assertEquals(await barrier, QUIESCENT_HOOK_EVIDENCE);
});

Deno.test("hook quiescence barrier checks every nonterminal, cache, and child count", async () => {
  const observations: HookQuiescenceEvidence[] = [
    { ...QUIESCENT_HOOK_EVIDENCE, pending: 1 },
    { ...QUIESCENT_HOOK_EVIDENCE, running: 1 },
    { ...QUIESCENT_HOOK_EVIDENCE, retryWait: 1 },
    { ...QUIESCENT_HOOK_EVIDENCE, cacheEntries: 1 },
    { ...QUIESCENT_HOOK_EVIDENCE, children: 1 },
    QUIESCENT_HOOK_EVIDENCE,
  ];
  let calls = 0;
  const result = await waitForHookQuiescence(
    () => Promise.resolve(observations[calls++] ?? QUIESCENT_HOOK_EVIDENCE),
    { timeoutMs: 500, pollMs: 1 },
  );
  assertEquals(calls, observations.length);
  assertEquals(result, QUIESCENT_HOOK_EVIDENCE);
});

Deno.test("shared public-flow semantic modules are backend neutral", async () => {
  for (
    const file of ["crm_driver.ts", "crm_migration.ts", "projects_driver.ts"]
  ) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(
      /(?:from\s+["'][^"']*(?:live_harness|container_harness|postgres)|\.server\.sql|\.backend\s*[=!])/i
        .test(source),
      false,
      file,
    );
    assertEquals(/from\s+["'][^"']*src\//.test(source), false, file);
    assertEquals(/\b(?:docker|psql)\b/i.test(source), false, file);
  }
});

Deno.test("public-flow entrypoints contain no copied semantic command programs", async () => {
  for (
    const path of [
      "../../e2e/full_crm/compiled_cli.test.ts",
      "../../e2e/full_projects/compiled_cli.test.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    for (
      const copiedCommand of [
        /["']bootstrap["']\s*,\s*["']init["']/,
        /["']changeset["']\s*,\s*["'](?:stage|commit)["']/,
        /["']migration["']\s*,\s*["'](?:validate|apply)["']/,
        /["']outbox["']\s*,\s*["'](?:list|inspect|attempts)["']/,
        /["']action["']\s*,\s*["']stage["']/,
      ]
    ) assertEquals(copiedCommand.test(source), false, path);
    assertEquals(
      /(?:live_harness|container_harness|host_adapter|container_adapter)/.test(
        source,
      ),
      false,
      path,
    );
  }
});

Deno.test("public-flow adapters cannot create public facts outside named fault barriers", async () => {
  for (const file of ["host_adapter.ts", "container_adapter.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(
      /\b(?:insert\s+into|update\s+[a-z_\"]+\s+set|delete\s+from|create\s+table)\b/i
        .test(source),
      false,
      file,
    );
    const ddl = source.match(/\b(?:create|drop)\s+(?:function|trigger)\b/gi) ??
      [];
    assertEquals(ddl.length, 4, file);
    assertEquals(
      (source.match(/test_fail_migration_application/g) ?? []).length,
      5,
      file,
    );
    assert(source.includes("holdMigrationTableLock"), file);
  }
});

Deno.test("public-flow registrations share one matrix", async () => {
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
