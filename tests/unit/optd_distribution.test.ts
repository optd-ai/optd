import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname!, "../..");
const image = `sha256:${"a".repeat(64)}`;
const source = "https://github.com/optd-ai/optd";
const read = (path: string) => Deno.readTextFile(join(root, path));
const digest = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("distribution carries canonical Apache text and image legal identity", async () => {
  assert.equal(
    await digest(await Deno.readFile(join(root, "LICENSE"))),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
  assert.match(await read("NOTICE"), /optd contributors/);
  const dockerfile = await read("Dockerfile");
  assert.match(
    dockerfile,
    /COPY deno.json deno.lock LICENSE NOTICE \/opt\/optd\//,
  );
  assert.match(dockerfile, /org.opencontainers.image.licenses="Apache-2.0"/);
  assert.ok(dockerfile.includes(`ARG OPTD_SOURCE=${source}`));
  assert.match(
    dockerfile,
    /org.opencontainers.image.revision="\$\{OPTD_REVISION\}"/,
  );
  assert.match(dockerfile, /USER 1993:1993/);
  for (const path of ["docker-compose.yml", "compose.external-postgres.yml"]) {
    const text = await read(path);
    assert.ok(text.includes(source), path);
    assert.ok(!/OPERANT_|operant:|from-nibly/.test(text), path);
  }
});

Deno.test("local release automation contains no external publication or global cleanup", async () => {
  const forbidden = [
    /\bgit\s+(?:push|remote|tag)\b/,
    /\bgh\s+(?:repo\s+(?:create|rename|transfer)|release\s+create)\b/,
    /\bdocker\s+(?:login|push)\b/,
    /\bdocker\s+\S+\s+prune\b/,
    /\b(?:cosign|syft)\b/,
    /--push\b/,
  ];
  for await (const entry of Deno.readDir(join(root, "scripts"))) {
    if (!entry.isFile || !/\.(sh|py)$/.test(entry.name)) continue;
    const text = await read(`scripts/${entry.name}`);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(text), `${entry.name}: ${pattern}`);
    }
  }
  const gate = await read("scripts/release-gate.sh");
  assert.match(gate, /git archive/);
  assert.match(gate, /--no-cache/);
  assert.match(await read("scripts/release-image-accounting.py"), /--no-prune/);
  assert.match(gate, /dev\.optd\.release-gate/);
  const guide = await read("docs/release.md");
  assert.match(guide, /new public `optd-ai\/optd` repository/);
  assert.match(guide, /each require explicit later authorization/);
});

// Docker is an explicitly narrow metadata/process double, not image acceptance.
// Compilation, execution, Git binding, transactional output and hashes are real.
Deno.test("artifact transaction binds real compiled bytes and legal files to exact source", async () => {
  const evidence = join(root, ".ai/distribution-evidence");
  await Deno.mkdir(evidence, { recursive: true });
  const fixture = await Deno.makeTempDir({ dir: evidence, prefix: "oracle-" });
  const repo = join(fixture, "repo");
  const bin = join(fixture, "bin");
  let passed = false;
  const run = async (
    cmd: string,
    args: string[],
    env: Record<string, string> = {},
  ) => {
    const output = await new Deno.Command(cmd, {
      args,
      cwd: repo,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr);
    await Deno.writeTextFile(
      join(fixture, "commands.log"),
      `${cmd} ${args.join(" ")}\n${text}\nexit=${output.code}\n`,
      { append: true },
    );
    return { ...output, text };
  };
  const ok = async (cmd: string, args: string[]) => {
    const result = await run(cmd, args);
    assert.equal(result.code, 0, result.text);
    return result.text.trim();
  };
  try {
    for (const dir of [repo, bin, join(repo, "scripts"), join(repo, "src")]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    for (const path of ["LICENSE", "NOTICE", "scripts/release-artifacts.sh"]) {
      await Deno.copyFile(join(root, path), join(repo, path));
    }
    await Deno.writeTextFile(
      join(repo, "src/main_optctl.ts"),
      'console.log("optd artifact oracle");\n',
    );
    await Deno.writeTextFile(join(repo, "deno.json"), "{}\n");
    await Deno.writeTextFile(
      join(repo, "deno.lock"),
      '{"version":"5","specifiers":{}}\n',
    );
    await Deno.writeTextFile(join(repo, ".gitignore"), "/dist/\n");
    await ok("git", ["init", "--quiet"]);
    await ok("git", ["add", "."]);
    await ok("git", [
      "-c",
      "user.name=Distribution Oracle",
      "-c",
      "user.email=oracle@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: exact artifact source",
    ]);
    const revision = await ok("git", ["rev-parse", "HEAD"]);
    const docker = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == 'image inspect' ]]; then
  [[ "$3" == '${image}' ]] || exit 90
  case "$5" in
    '{{.Id}}') echo '${image}' ;;
    *image.revision*) echo "\${TEST_REVISION}" ;;
    *image.version*) echo 'oracle' ;;
    *image.licenses*) echo "\${TEST_LICENSE}" ;;
    *image.source*) echo "\${TEST_SOURCE}" ;;
    *json*.Config.Labels*) printf '{"org.opencontainers.image.revision":"%s","org.opencontainers.image.licenses":"%s","org.opencontainers.image.source":"%s"}\\n' "$TEST_REVISION" "$TEST_LICENSE" "$TEST_SOURCE" ;;
    *RepoDigests*) echo '' ;;
    *) exit 91 ;;
  esac
elif [[ "$1 $2" == 'container create' ]]; then
  echo oracle-container
elif [[ "$1 $2" == 'container start' ]]; then
  echo 'oracle runtime version'
elif [[ "$1 $2" == 'container rm' ]]; then
  [[ "$3 $4 $5" == '--force --volumes oracle-container' ]] || exit 92
else
  exit 93
fi
`;
    await Deno.writeTextFile(join(bin, "docker"), docker);
    await Deno.chmod(join(bin, "docker"), 0o755);
    const env = {
      PATH: `${bin}:${Deno.env.get("PATH")}`,
      OPTD_RELEASE_GATE_ID: "",
      OPTD_RELEASE_GATE_REGISTRY: "",
      OPTD_RELEASE_SOURCE_REVISION: revision,
      OPTD_CONTAINER_IMAGE_ID: image,
      OPTD_CONTAINER_VERSION: "oracle",
      OPTD_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE: "",
      TEST_REVISION: revision,
      TEST_LICENSE: "Apache-2.0",
      TEST_SOURCE: source,
    };
    const artifact = (overrides: Record<string, string> = {}, id = image) =>
      run("bash", ["scripts/release-artifacts.sh", id, "dist"], {
        ...env,
        ...overrides,
      });
    const result = await artifact();
    assert.equal(result.code, 0, result.text);
    assert.equal(
      await ok(join(repo, "dist/optctl"), []),
      "optd artifact oracle",
    );
    const metadata = JSON.parse(
      await Deno.readTextFile(join(repo, "dist/image-metadata.json")),
    );
    assert.equal(metadata.source_revision, revision);
    assert.equal(metadata.source_dirty, false);
    assert.equal(metadata.image_id, image);
    assert.equal(metadata.source, source);
    assert.equal(metadata.license, "Apache-2.0");
    assert.equal(
      metadata.optctl_sha256,
      await digest(await Deno.readFile(join(repo, "dist/optctl"))),
    );
    for (const file of ["LICENSE", "NOTICE"]) {
      assert.equal(
        await Deno.readTextFile(join(repo, `dist/${file}`)),
        await read(file),
      );
    }
    const sums = await Deno.readTextFile(join(repo, "dist/SHA256SUMS"));
    const names = [];
    for (const line of sums.trim().split("\n")) {
      const [hash, file] = line.split("  ");
      names.push(file);
      assert.equal(
        hash,
        await digest(await Deno.readFile(join(repo, `dist/${file}`))),
      );
    }
    assert.deepEqual(names.sort(), [
      "LICENSE",
      "NOTICE",
      "image-metadata.json",
      "optctl",
    ]);
    for (
      const [overrides, message] of [
        [{ TEST_LICENSE: "MIT" }, /image license/],
        [{ TEST_SOURCE: "https://example.invalid" }, /image source/],
        [{ TEST_REVISION: "b".repeat(40) }, /revision mismatch/],
      ] as const
    ) {
      const rejected = await artifact(overrides);
      assert.notEqual(rejected.code, 0, rejected.text);
      assert.match(rejected.text, message);
      assert.equal(
        await Deno.readTextFile(join(repo, "dist/SHA256SUMS")),
        sums,
      );
    }
    const mutable = await artifact({}, "optd:latest");
    assert.notEqual(mutable.code, 0);
    assert.match(mutable.text, /immutable full image ID/);
    await Deno.writeTextFile(join(repo, "unexpected-source"), "dirty\n");
    const dirty = await artifact();
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.text, /clean tracked and untracked source tree/);
    assert.equal(await Deno.readTextFile(join(repo, "dist/SHA256SUMS")), sums);
    passed = true;
  } finally {
    if (passed) await Deno.remove(fixture, { recursive: true });
    else console.error(`Retained distribution failure evidence: ${fixture}`);
  }
});
