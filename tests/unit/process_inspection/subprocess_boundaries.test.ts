// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";

type CommandSite = Readonly<{
  path: string;
  command: string;
  source: string;
}>;

Deno.test("production subprocess callsites remain explicitly classified", async () => {
  const sites: CommandSite[] = [];
  for await (
    const entry of walk("src", { includeDirs: false, exts: [".ts"] })
  ) {
    const source = await Deno.readTextFile(entry.path);
    for (const call of commandCalls(source)) {
      sites.push({
        path: entry.path.replaceAll("\\", "/"),
        command: call.command,
        source: call.source,
      });
    }
  }
  assertEquals(
    [...Map.groupBy(sites, (site) => site.path).entries()].map(
      ([path, entries]) => ({ path, count: entries.length }),
    ).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "src/adapters/inbound/cli-cliffy/optctl.ts", count: 1 },
      { path: "src/adapters/outbound/deno-hooks/hook_runner.ts", count: 2 },
      {
        path: "src/adapters/outbound/postgres-process/lifecycle.ts",
        count: 6,
      },
      {
        path: "src/adapters/outbound/process-inspection/linux.ts",
        count: 1,
      },
      {
        path: "src/adapters/outbound/postgres/auth_repository.ts",
        count: 2,
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );

  const cli = only(sites, "optctl.ts");
  assertEquals(cli.command, "childArgs[0]");
  assertMatch(cli.source, /args:\s*childArgs\.slice\(1\)/);
  assertMatch(cli.source, /clearEnv:\s*true/);
  assert(!cli.source.includes("/bin/sh"));
  const cliFile = await Deno.readTextFile(cli.path);
  assertMatch(cliFile, /auth isolate requires -- before the child command/);
  assertEquals((cliFile.match(/runIsolatedCommand\(/g) ?? []).length, 2);

  const hooks = sites.filter((site) => site.path.endsWith("hook_runner.ts"));
  assertEquals(hooks.map((site) => site.command), [
    "this.#options.denoBin ?? Deno.execPath()",
    "candidate",
  ]);
  assertMatch(hooks[0].source, /args,\s*clearEnv:\s*true/);
  assertMatch(hooks[0].source, /stdin:\s*"piped"/);
  assertMatch(hooks[1].source, /args:\s*\["--version"\]/);
  assertMatch(hooks[1].source, /clearEnv:\s*true/);
  assert(!hooks.some((site) => site.source.includes("/bin/sh")));
  const hookFile = await Deno.readTextFile(hooks[0].path);
  assertMatch(
    hookFile,
    /hook\.timeoutMs\s*>\s*\(this\.#options\.maximumTimeoutMs/,
  );
  assertMatch(hookFile, /setTimeout\([\s\S]*hook\.timeoutMs/);
  assertMatch(hookFile, /readBounded\([\s\S]*DEFAULT_STDOUT_LIMIT/);

  const passwordWorkers = sites.filter((site) =>
    site.path.endsWith("auth_repository.ts")
  );
  assertEquals(
    passwordWorkers.map((site) => site.command),
    ["Deno.execPath()", "Deno.execPath()"],
  );
  for (const site of passwordWorkers) {
    assertMatch(site.source, /new URL\("\.\/auth_password_worker\.ts"/);
    assertMatch(site.source, /stdin:\s*"piped"/);
    assert(!site.source.includes("/bin/sh"));
    assert(!site.source.includes("${"));
  }

  const proc = only(sites, "process-inspection/linux.ts");
  assertEquals(proc.command, '"/bin/cat"');
  assertMatch(proc.source, /args:\s*\[path\]/);
  assertMatch(proc.source, /clearEnv:\s*true/);
  assertMatch(proc.source, /env:\s*\{\}/);
  assert(!proc.source.includes("/bin/sh"));
  const procFile = await Deno.readTextFile(proc.path);
  assert(!procFile.includes("Deno.env"));

  assertPostgresLifecycleSites(
    sites.filter((site) => site.path.endsWith("postgres-process/lifecycle.ts")),
  );
});

function assertPostgresLifecycleSites(sites: readonly CommandSite[]): void {
  assertEquals(sites.map((site) => site.command), [
    "bins.postgres",
    "psqlBin",
    "command",
    '"/bin/sh"',
    '"/bin/sh"',
    '"/bin/sh"',
  ]);

  const [postgres, readiness, checked, cmdline, cwd, existence] = sites;
  assertMatch(postgres.source, /args:\s*\[\s*"-D",\s*dataDir/);
  assertMatch(postgres.source, /"listen_addresses=127\.0\.0\.1"/);
  assert(!postgres.source.includes("/bin/sh"));

  assertMatch(readiness.source, /"-Atc",\s*"select 1"/);
  assert(!readiness.source.includes("/bin/sh"));
  assertMatch(checked.source, /args,\s*stdout:\s*"piped"/);
  assert(!checked.source.includes("/bin/sh"));

  assertProcFallback(cmdline, {
    operation: "exec /bin/cat",
    procSuffix: "/cmdline",
    selfExit: 2,
  });
  assertProcFallback(cwd, {
    operation: "exec /bin/readlink -e",
    procSuffix: "/cwd",
    selfExit: 2,
  });
  assertProcFallback(existence, {
    operation: "test -d",
    procSuffix: "",
    selfExit: 1,
  });
  assertMatch(existence.source, /stdout:\s*"null"/);

  const file = Deno.readTextFileSync(sites[0].path);
  assertEquals(
    (file.match(/const fixedPid = fixedNumericPid\(pid\);/g) ?? []).length,
    3,
  );
  assertMatch(
    file,
    /function fixedNumericPid[\s\S]*Number\.isSafeInteger\(pid\)[\s\S]*pid <= 0[\s\S]*return String\(pid\)/,
  );
  assertMatch(file, /const PROC_CMDLINE_MAX_BYTES = 4 \* 1024 \* 1024/);
  assertMatch(file, /output\.stdout\.length > PROC_CMDLINE_MAX_BYTES/);
  assertMatch(file, /const PROC_CWD_MAX_BYTES = 8192/);
  assertMatch(file, /output\.stdout\.length > PROC_CWD_MAX_BYTES/);
  assertMatch(
    file,
    /while \(Date\.now\(\) - started < POSTGRES_STARTUP_TIMEOUT_MS\)/,
  );
  assertEquals((file.match(/\/proc\/\$\{pid\}/g) ?? []).length, 0);
}

function assertProcFallback(
  site: CommandSite,
  expected: Readonly<{
    operation: string;
    procSuffix: string;
    selfExit: number;
  }>,
): void {
  assertEquals(site.command, '"/bin/sh"');
  assertMatch(site.source, /args:\s*\[\s*"-c",/);
  assert(
    site.source.includes(
      `if [ "$$" -eq \${fixedPid} ]; then exit ${expected.selfExit}; fi;`,
    ),
  );
  assert(
    site.source.includes(
      `${expected.operation} /proc/\${fixedPid}${expected.procSuffix}`,
    ),
  );
  assertEquals((site.source.match(/\$\{fixedPid\}/g) ?? []).length, 2);
  assertEquals((site.source.match(/\$\{pid\}/g) ?? []).length, 0);
}

function only(sites: readonly CommandSite[], suffix: string): CommandSite {
  const found = sites.filter((site) => site.path.endsWith(suffix));
  assertEquals(found.length, 1, suffix);
  return found[0];
}

function commandCalls(
  source: string,
): Array<{ command: string; source: string }> {
  const marker = "new Deno.Command(";
  const calls: Array<{ command: string; source: string }> = [];
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const start = cursor;
    let index = cursor + marker.length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (; index < source.length && depth > 0; index++) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") depth++;
      else if (character === ")") depth--;
    }
    assertEquals(depth, 0, "unterminated Deno.Command call");
    const call = source.slice(start, index);
    calls.push({ command: firstArgument(call), source: call });
    cursor = index;
  }
  return calls;
}

function firstArgument(call: string): string {
  const body = call.slice("new Deno.Command(".length, -1);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth--;
    else if (character === "," && depth === 0) {
      return body.slice(0, index).trim();
    }
  }
  throw new Error("Deno.Command has no options argument");
}
