// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { runOptctl } from "../../../src/adapters/inbound/cli-cliffy/optctl.ts";

Deno.test("context add, list, show, use, and remove are local and deterministic", async () => {
  const prior = Deno.env.get("XDG_DATA_HOME");
  const root = await Deno.makeTempDir();
  Deno.env.set("XDG_DATA_HOME", root);
  try {
    const run = async (args: string[]) => {
      const result = await runOptctl(["--json", ...args]);
      assertEquals(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).data;
    };
    assertEquals(
      (await run([
        "context",
        "add",
        "local",
        "--server",
        "http://127.0.0.1:8789",
      ])).name,
      "local",
    );
    assertEquals((await run(["context", "list"])).active, "local");
    assertEquals(
      (await run(["context", "show", "local"])).origin,
      "http://127.0.0.1:8789",
    );
    assertEquals((await run(["context", "use", "local"])).name, "local");
    assertEquals((await run(["context", "remove", "local"])).name, "local");
    assertEquals((await run(["context", "list"])).contexts, []);
  } finally {
    if (prior === undefined) Deno.env.delete("XDG_DATA_HOME");
    else Deno.env.set("XDG_DATA_HOME", prior);
    await Deno.remove(root, { recursive: true });
  }
});
