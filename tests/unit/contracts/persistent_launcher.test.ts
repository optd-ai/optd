import { assertEquals, assertRejects } from "jsr:@std/assert";
import { makeProcessTreeLauncher } from "../../support/live_harness.ts";

Deno.test("persistent launchers repeatedly run and close without stream leaks", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "optd-launcher-leak-",
  });
  const executable = `${directory}/fake-optctl`;
  await Deno.writeTextFile(
    executable,
    "#!/bin/sh\necho fake-diagnostic >&2\nprintf 'fake-output'\n",
    { mode: 0o700 },
  );
  try {
    for (let index = 0; index < 8; index++) {
      const launcher = await makeProcessTreeLauncher(
        "agent",
        executable,
        Deno.env.toObject(),
        () => "http://127.0.0.1:1",
      );
      const result = await launcher.runOptctl(["status", "live"]);
      assertEquals(result.code, 0);
      assertEquals(result.stdout, "fake-output");
      assertEquals(result.stderr, "fake-diagnostic");
      await launcher.close();
      await launcher.close();
      await assertRejects(
        () => launcher.runOptctl(["status", "live"]),
        Error,
        "process-tree launcher is closed",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("persistent launcher failure drains both streams and terminates once", async () => {
  const launcher = await makeProcessTreeLauncher(
    "human",
    `/missing-optctl-${crypto.randomUUID()}`,
    Deno.env.toObject(),
    () => "http://127.0.0.1:1",
  );
  await assertRejects(
    () => launcher.runOptctl(["home"]),
    Error,
    "process-tree launcher exited",
  );
  await launcher.close();
  await launcher.close();
});
