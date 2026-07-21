import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";

Deno.test("production subprocess callsites remain explicitly classified", async () => {
  const callsites: Array<{ path: string; count: number; source: string }> = [];
  for await (
    const entry of walk("src", { includeDirs: false, exts: [".ts"] })
  ) {
    const source = await Deno.readTextFile(entry.path);
    const count = source.match(/new Deno\.Command\(/g)?.length ?? 0;
    if (count) {
      callsites.push({
        path: entry.path.replaceAll("\\", "/"),
        count,
        source,
      });
    }
  }
  assertEquals(
    callsites.map(({ path, count }) => ({ path, count })),
    [
      { path: "src/adapters/inbound/cli-cliffy/optctl.ts", count: 1 },
      { path: "src/adapters/outbound/deno-hooks/hook_runner.ts", count: 2 },
      { path: "src/adapters/outbound/postgres-process/lifecycle.ts", count: 3 },
      { path: "src/adapters/outbound/process-inspection/linux.ts", count: 1 },
      { path: "src/adapters/outbound/postgres/auth_repository.ts", count: 2 },
    ],
  );

  const cli = callsites.find((item) => item.path.endsWith("optctl.ts"))!.source;
  assertMatch(
    cli,
    /async function runIsolatedCommand[\s\S]*new Deno\.Command\(childArgs\[0\]/,
  );
  assertMatch(cli, /auth isolate requires -- before the child command/);
  assertEquals(
    (cli.match(
      /runIsolatedCommand\(\s*childArgs,\s*env,\s*parsed\.server,\s*parsed\.json,?\s*\)/g,
    ) ?? []).length,
    1,
  );
  assertEquals((cli.match(/childArgs\[0\]/g) ?? []).length, 2);

  const hooks =
    callsites.find((item) => item.path.endsWith("deno-hooks/hook_runner.ts"))!
      .source;
  assertMatch(
    hooks,
    /new Deno\.Command\(\s*this\.#options\.denoBin \?\? Deno\.execPath\(\)/,
  );
  assertMatch(hooks, /new Deno\.Command\(candidate/);
  assertMatch(hooks, /args: \["--version"\]/);
  assertMatch(hooks, /clearEnv: true/);

  const proc =
    callsites.find((item) => item.path.endsWith("process-inspection/linux.ts"))!
      .source;
  assertMatch(proc, /new Deno\.Command\("\/bin\/cat"/);
  assertMatch(proc, /args: \[path\]/);
  assertMatch(proc, /clearEnv: true/);
  assertMatch(proc, /env: \{\}/);
  assert(!proc.includes("Deno.env"));

  for (const item of callsites) {
    if (
      item.path.endsWith("optctl.ts") ||
      item.path.endsWith("process-inspection/linux.ts")
    ) continue;
    assert(!item.source.includes("childArgs"), item.path);
  }
});
