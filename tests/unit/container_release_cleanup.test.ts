// deno-lint-ignore-file no-import-prefix no-unversioned-import
import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "jsr:@std/assert";
import {
  AuxiliaryContainerCleanupError,
  runAuxiliaryContainerCases,
} from "../support/auxiliary_container_cleanup.ts";

const cases = [
  { name: "smoke-missing" },
  { name: "smoke-wrong" },
  { name: "smoke-malformed" },
];

Deno.test("auxiliary container cases clean up every command and assertion failure", async () => {
  for (const [failureIndex, definition] of cases.entries()) {
    for (const phase of ["command", "assertion"] as const) {
      const primary = new Error(`${definition.name} ${phase} failure`);
      const cleaned: string[] = [];
      let caught: unknown;

      try {
        await runAuxiliaryContainerCases(
          cases,
          async (candidate) => {
            if (candidate.name !== definition.name) return;
            if (phase === "command") throw primary;
            await Promise.resolve();
            throw primary;
          },
          (name) => {
            cleaned.push(name);
            return Promise.resolve();
          },
        );
      } catch (error) {
        caught = error;
      }

      assertStrictEquals(caught, primary);
      assertEquals(
        cleaned,
        cases.slice(0, failureIndex + 1).map((candidate) => candidate.name),
      );
    }
  }
});

Deno.test("auxiliary container cleanup retries partial setup and preserves the primary error", async () => {
  const primary = new Error("injected command failure");
  const cleanupFailure = new Error("injected cleanup failure");
  const cleaned: string[] = [];
  let caught: unknown;

  try {
    await runAuxiliaryContainerCases(
      [cases[0]],
      () => Promise.reject(primary),
      (name) => {
        cleaned.push(name);
        if (cleaned.length === 1) return Promise.reject(cleanupFailure);
        return Promise.resolve();
      },
    );
  } catch (error) {
    caught = error;
  }

  assertInstanceOf(caught, AggregateError);
  assertStrictEquals(caught.cause, primary);
  assertStrictEquals(caught.errors[0], primary);
  assertInstanceOf(caught.errors[1], AuxiliaryContainerCleanupError);
  assertEquals(caught.errors[1].containerName, cases[0].name);
  assertStrictEquals(caught.errors[1].cause, cleanupFailure);
  assertEquals(cleaned, [cases[0].name, cases[0].name]);
});

Deno.test("auxiliary container cleanup aggregates every fallback failure", async () => {
  const primary = new Error("injected assertion failure");
  const cleanupFailures = [
    new Error("injected case cleanup failure"),
    new Error("injected fallback cleanup failure"),
  ];
  let cleanupAttempt = 0;
  let caught: unknown;

  try {
    await runAuxiliaryContainerCases(
      [cases[2]],
      () => Promise.reject(primary),
      () => Promise.reject(cleanupFailures[cleanupAttempt++]),
    );
  } catch (error) {
    caught = error;
  }

  assertInstanceOf(caught, AggregateError);
  assertStrictEquals(caught.errors[0], primary);
  assertEquals(caught.errors.length, 3);
  for (const [index, failure] of cleanupFailures.entries()) {
    const wrapped: unknown = caught.errors[index + 1];
    assertInstanceOf(wrapped, AuxiliaryContainerCleanupError);
    assertEquals(wrapped.containerName, cases[2].name);
    assertStrictEquals(wrapped.cause, failure);
  }
});

Deno.test("pre-build image cleanup reports its own result inside a failing EXIT trap", async () => {
  const gate = await Deno.readTextFile(
    new URL("../../scripts/release-gate.sh", import.meta.url),
  );
  const start = gate.indexOf("cleanup_registered_images() {");
  const end = gate.indexOf("\ninspect_label() {", start);
  if (start < 0 || end < 0) throw new Error("image cleanup function missing");
  const fixture = await Deno.makeTempDir({ prefix: "optd-prebuild-cleanup-" });
  try {
    await Deno.mkdir(`${fixture}/before/docker`, { recursive: true });
    await Deno.writeTextFile(`${fixture}/before/docker/images`, "baseline\n");
    for (
      const [inventory, expected] of [["baseline", 0], ["changed", 1]] as const
    ) {
      const result = await new Deno.Command("bash", {
        args: [
          "-c",
          `
set -eu
state_root=$1
build_accounting_started=false
${gate.slice(start, end)}
# Substitute only inventory acquisition; execute the real cleanup and EXIT trap.
atomic_sorted_command() { printf '%s\\n' "$INVENTORY" > "$1"; }
trap 'set +e; cleanup_registered_images; result=$?; echo "cleanup=$result"; exit 37' EXIT
exit 37
`,
          "fixture",
          fixture,
        ],
        env: { INVENTORY: inventory },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(result.code, 37);
      assertEquals(
        new TextDecoder().decode(result.stdout),
        `cleanup=${expected}\n`,
      );
    }
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
