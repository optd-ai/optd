import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname!, "../..");
const overrides = [
  "OPTD_CONTAINER_SKIP_BUILD",
  "OPTD_CONTAINER_IMAGE",
  "OPTD_CONTAINER_IMAGE_ID",
  "OPTD_CONTAINER_IMAGE_TAG",
  "OPTD_CONTAINER_REVISION",
  "OPTD_CONTAINER_VERSION",
  "OPTD_RELEASE_GATE_ACTIVE",
  "OPTD_RELEASE_BASE",
  "OPTD_RELEASE_BASE_REV",
];

Deno.test("exact-image wrapper rejects skip, stale image and alternate revision inputs", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-exact-image-" });
  try {
    await Deno.mkdir(join(fixture, "scripts"));
    await Deno.copyFile(
      join(root, "scripts/optd-release-verify.sh"),
      join(fixture, "scripts/optd-release-verify.sh"),
    );
    // Failure-only sentinel: validates dispatch, never claims image acceptance.
    await Deno.writeTextFile(
      join(fixture, "scripts/release-gate.sh"),
      `#!/usr/bin/env bash
set -eu
[[ "$OPTD_RELEASE_BASE" == 0b44cc6a07b5328e63a77bb888031b5b6ab311cc ]]
[[ "\${DOCKER_BUILDKIT:-}" != 0 ]]
echo reached-mandatory-gate >&2
exit 43
`,
    );
    const run = (env: Record<string, string> = {}, args: string[] = []) =>
      new Deno.Command("bash", {
        args: [join(fixture, "scripts/optd-release-verify.sh"), ...args],
        cwd: "/",
        env: {
          ...Object.fromEntries(overrides.map((key) => [key, ""])),
          ...env,
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
    await Deno.writeTextFile(join(fixture, "receipt.json"), '{"passed":true}');
    const baseline = await run();
    assert.equal(baseline.code, 43);
    assert.match(
      new TextDecoder().decode(baseline.stderr),
      /reached-mandatory/,
    );
    for (const name of overrides) {
      const result = await run({ [name]: "stale-or-skip" });
      assert.equal(result.code, 2, name);
      assert.match(new TextDecoder().decode(result.stderr), /rejects caller/);
    }
    assert.equal((await run({}, ["--skip-image"])).code, 2);
    await Deno.remove(join(fixture, "scripts/release-gate.sh"));
    assert.notEqual((await run()).code, 0);
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

Deno.test("exact-source implementation keeps one archive/build and full image suite", async () => {
  const gate = await Deno.readTextFile(join(root, "scripts/release-gate.sh"));
  assert.equal((gate.match(/^git archive /gm) ?? []).length, 1);
  assert.equal((gate.match(/^ {2}docker buildx build /gm) ?? []).length, 1);
  assert.match(gate, /--builder default --load --pull=false --no-cache/);
  assert.match(gate, /--iidfile/);
  assert.match(gate, /--metadata-file/);
  assert.match(gate, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(gate, /git merge-base --is-ancestor/);
  assert.match(gate, /export OPTD_CONTAINER_IMAGE="\$release_image_id"/);
  assert.match(gate, /run_owned complete-suite deno task test/);
  assert.match(gate, /image_revision.*!=.*release_revision/);
  assert.match(gate, /verify_source_archive/);
});

Deno.test("BuildKit authority rejects mismatched, incomplete and foreign ownership before cleanup", async () => {
  const result = await new Deno.Command("python3", {
    args: [
      "-B",
      join(root, "tests/unit/optd_buildkit_accounting.py"),
      join(root, "scripts/release-image-accounting.py"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  assert.equal(
    new TextDecoder().decode(result.stdout).trim().split("\n").length,
    20,
  );
});

Deno.test("real gate rejects dirty composed trees and unavailable release base before build", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-image-source-" });
  const command = async (cmd: string, args: string[]) => {
    const result = await new Deno.Command(cmd, {
      args,
      cwd: fixture,
      env: Object.fromEntries(overrides.map((key) => [key, ""])),
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
  const git = async (...args: string[]) => {
    const result = await command("git", args);
    assert.equal(result.code, 0, result.stderr);
  };
  try {
    await Deno.mkdir(join(fixture, "scripts"));
    for (const name of ["optd-release-verify.sh", "release-gate.sh"]) {
      await Deno.copyFile(
        join(root, "scripts", name),
        join(fixture, "scripts", name),
      );
    }
    await Deno.writeTextFile(join(fixture, ".gitignore"), "cache/\n");
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const run = () => command("bash", ["scripts/optd-release-verify.sh"]);
    const clean = await run();
    assert.notEqual(clean.code, 0);
    assert.match(clean.stderr, /release base is unavailable/);
    await Deno.mkdir(join(fixture, "cache"));
    await Deno.writeTextFile(join(fixture, "cache", "receipt"), "passed");
    assert.match((await run()).stderr, /release base is unavailable/);
    await Deno.writeTextFile(join(fixture, "untracked"), "not committed");
    assert.match((await run()).stderr, /requires a clean/);
    await git("add", "untracked");
    assert.match((await run()).stderr, /requires a clean/);
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
