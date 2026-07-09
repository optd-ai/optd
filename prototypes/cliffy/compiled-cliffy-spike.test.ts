import { assertStringIncludes } from "jsr:@std/assert";
import { runCli } from "./compiled-cliffy-spike.ts";

Deno.test("Cliffy command renders TOON and JSON", async () => {
  const toon = await runCli(["home"]);
  assertStringIncludes(toon, "active_pack");
  const json = await runCli(["home", "--json"]);
  assertStringIncludes(json, "default.crm@0.1.0");
});

Deno.test("Deno compile works for Cliffy + npm TOON imports", async () => {
  const dir = await Deno.makeTempDir({ prefix: "optctl-spike-" });
  const outputPath = `${dir}/optctl-spike`;
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "compile",
        "--quiet",
        "--output",
        outputPath,
        new URL("./compiled-cliffy-spike.ts", import.meta.url).pathname,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
