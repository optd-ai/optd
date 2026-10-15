import { assertEquals, assertRejects } from "@std/assert";
import {
  isSessionBoundary,
  resolveProcessAnchor,
} from "../../src/adapters/inbound/cli-cliffy/auth_anchor.ts";
import type { ProcessIdentity } from "../../src/application/ports/process_inspection.ts";

const identity = (pid: number, parentPid: number): ProcessIdentity => ({
  pid,
  parentPid,
  startTicks: `${pid}00`,
  uid: 1000,
  bootId: "test-boot",
});
const chain = [
  identity(40, 30),
  identity(30, 20),
  identity(20, 10),
  identity(10, 1),
];
const commands = new Map<number, string[]>([
  [40, ["bash", "-c", "pipeline"]],
  [30, ["timeout", "60", "bash"]],
  [20, ["pi"]],
  [10, ["zsh"]],
]);
function inspector(rows = chain, names = commands) {
  return {
    inspect: (pid: number) => Promise.resolve(rows.find((p) => p.pid === pid)!),
    ancestry: (_pid: number, stop?: number) =>
      Promise.resolve(
        stop ? rows.slice(0, rows.findIndex((p) => p.pid === stop) + 1) : rows,
      ),
    command: (pid: number) => Promise.resolve(names.get(pid) ?? ["unknown"]),
  };
}
Deno.test("anchor traverses tool wrappers but stops at the nearest harness", async () => {
  assertEquals((await resolveProcessAnchor(inspector(), 40)).pid, 20);
  assertEquals(
    (await resolveProcessAnchor(inspector(), 40, { explicitPid: 10 })).pid,
    20,
  );
  assertEquals(
    (await resolveProcessAnchor(inspector(), 40, {
      nearestBinding: chain[3],
      explicitPid: 10,
    })).pid,
    20,
  );
  assertEquals(
    (await resolveProcessAnchor(inspector(), 40, { nearestBinding: chain[1] }))
      .pid,
    30,
  );
  assertEquals(
    (await resolveProcessAnchor(inspector(), 40, { stopPid: 30 })).pid,
    30,
  );
});
Deno.test("anchor recognizes interactive shells and script-based harnesses", () => {
  for (
    const argv of [["zsh"], ["-bash"], ["nu"], ["codex"], ["claude"], [
      "node",
      "/opt/pi-coding-agent/dist/cli.js",
    ]]
  ) assertEquals(isSessionBoundary(argv), true);
  for (
    const argv of [
      ["bash", "-lc", "optctl"],
      ["bash", "script.sh"],
      ["sh", "-s"],
      ["nu", "--commands", "optctl"],
      ["node", "unrelated.js"],
    ]
  ) assertEquals(isSessionBoundary(argv), false);
});
Deno.test("unknown launchers, unrelated explicit PIDs and changed identities fail closed", async () => {
  await assertRejects(
    () => resolveProcessAnchor(inspector(), 40, { explicitPid: 999 }),
    Error,
    "outside",
  );
  await assertRejects(
    () =>
      resolveProcessAnchor(
        inspector(chain, new Map([[40, ["unknown-agent"]]])),
        40,
      ),
    Error,
    "unrecognized",
  );
  const base = inspector();
  let calls = 0;
  await assertRejects(
    () =>
      resolveProcessAnchor({
        ...base,
        ancestry: () =>
          Promise.resolve(
            ++calls === 1
              ? chain
              : chain.map((p) => ({ ...p, startTicks: "reused" })),
          ),
      }, 40),
    Error,
    "changed",
  );
  await assertRejects(
    () =>
      resolveProcessAnchor(
        inspector(chain.map((p) => p.pid === 20 ? { ...p, uid: 2000 } : p)),
        40,
      ),
    Error,
    "no persistent",
  );
});
Deno.test("nested harnesses stay separate and explicit targets cannot cross isolate", async () => {
  const nested = new Map(commands);
  nested.set(30, ["claude"]);
  assertEquals(
    (await resolveProcessAnchor(inspector(chain, nested), 40)).pid,
    30,
  );
  await assertRejects(
    () =>
      resolveProcessAnchor(inspector(), 40, { stopPid: 30, explicitPid: 20 }),
    Error,
    "outside",
  );
});
