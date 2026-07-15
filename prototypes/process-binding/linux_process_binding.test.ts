import {
  ancestry,
  inspectLinuxProcess,
  parseProcStat,
  parseProcUid,
  type ProcessBinding,
  type ProcessIdentity,
  sameProcess,
  selectClosestBinding,
} from "./linux_process_binding.ts";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

function identity(
  pid: number,
  parentPid: number,
  startTicks = 100n,
): ProcessIdentity {
  return { pid, parentPid, startTicks, uid: 1000, bootId: "boot-a" };
}

Deno.test("parses stat with spaces and closing parentheses in command name", () => {
  const prefix = "42 (odd command) name) S 7";
  const fields = Array.from({ length: 18 }, (_, index) => String(index + 10));
  fields[17] = "987654"; // overall field 22 after state + ppid
  const parsed = parseProcStat(`${prefix} ${fields.join(" ")}`);
  assertEquals(parsed, { pid: 42, parentPid: 7, startTicks: 987654n });
});

Deno.test("parses real uid instead of effective/saved uid", () => {
  assertEquals(parseProcUid("Name:\tx\nUid:\t1000\t1001\t1001\t1001\n"), 1000);
});

Deno.test("process identity rejects pid reuse, user changes, and reboot", () => {
  const original = identity(42, 1, 100n);
  assert(sameProcess(original, { ...original }));
  assert(!sameProcess(original, { ...original, startTicks: 101n }));
  assert(!sameProcess(original, { ...original, uid: 1001 }));
  assert(!sameProcess(original, { ...original, bootId: "boot-b" }));
});

Deno.test("closest matching ancestor wins", () => {
  const child = identity(30, 20);
  const agent = identity(20, 10);
  const human = identity(10, 1);
  const bindings: ProcessBinding[] = [
    { id: "human", anchor: human },
    { id: "agent", anchor: agent },
  ];
  assertEquals(
    selectClosestBinding([child, agent, human], bindings)?.id,
    "agent",
  );
});

Deno.test("real Linux ancestry includes current parent and honors a valid stop", async () => {
  if (Deno.build.os !== "linux") return;
  const parent = await inspectLinuxProcess(Deno.ppid);
  const chain = await ancestry(Deno.ppid, parent.pid);
  assertEquals(chain.length, 1);
  assertEquals(chain[0], parent);
});

Deno.test("tree stop must be a real ancestor", async () => {
  if (Deno.build.os !== "linux") return;
  await assertRejects(
    () => ancestry(Deno.ppid, 2_147_483_647),
    Error,
    "is not in caller ancestry",
  );
});
