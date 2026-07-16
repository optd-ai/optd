import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { sameProcess } from "../../../src/application/ports/process_inspection.ts";
import {
  LinuxProcessInspector,
  parseProcStat,
  parseProcUid,
} from "../../../src/adapters/outbound/process-inspection/linux.ts";

Deno.test("Linux proc parser handles command names containing closing parentheses", () => {
  const fields = Array.from({ length: 20 }, (_, index) => String(index + 10));
  fields[19] = "987654";
  assertEquals(
    parseProcStat(`42 (odd) name) S 7 ${fields.slice(2).join(" ")}`),
    {
      pid: 42,
      parentPid: 7,
      startTicks: "987654",
    },
  );
  assertEquals(parseProcUid("Name:\tx\nUid:\t1000\t1001\t1001\t1001\n"), 1000);
});

Deno.test("full process identity rejects PID reuse, UID changes, and reboot", () => {
  const original = {
    pid: 42,
    parentPid: 1,
    startTicks: "100",
    uid: 1000,
    bootId: "a",
  };
  assert(sameProcess(original, { ...original }));
  assert(!sameProcess(original, { ...original, startTicks: "101" }));
  assert(!sameProcess(original, { ...original, uid: 1001 }));
  assert(!sameProcess(original, { ...original, bootId: "b" }));
});

Deno.test("Linux inspector walks real ancestry and rejects unrelated stop PID", async () => {
  if (Deno.build.os !== "linux") return;
  const inspector = new LinuxProcessInspector();
  const parent = await inspector.inspect(Deno.ppid);
  assertEquals((await inspector.ancestry(Deno.ppid, parent.pid))[0], parent);
  await assertRejects(
    () => inspector.ancestry(Deno.ppid, 2_147_483_647),
    Error,
    "not in caller ancestry",
  );
});
