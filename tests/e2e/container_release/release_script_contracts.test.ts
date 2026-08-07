// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const revision = "a6715631d48f2c6bf0c03326c909896ba9058164";
const imageId = `sha256:${"a".repeat(64)}`;

Deno.test("release scripts reject dirty source before Docker", async () => {
  const fixture = await createFixture();
  try {
    await Deno.writeTextFile(`${fixture.state}/dirty`, "1");
    const result = await run(fixture, ["bash", "scripts/release-gate.sh"]);
    assert(result.code !== 0);
    assertStringIncludes(result.stderr, "clean tracked and untracked source");
    assertEquals(await readLog(fixture, "docker.log"), "");

    const artifact = await run(fixture, [
      "bash",
      "scripts/release-artifacts.sh",
      "operant:test",
      "artifacts",
    ]);
    assert(artifact.code !== 0);
    assertStringIncludes(artifact.stderr, "clean tracked and untracked source");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("release gate selects committed callers and builds one exact image", async () => {
  const fixture = await createFixture();
  try {
    const result = await run(fixture, ["bash", "scripts/release-gate.sh"]);
    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertStringIncludes(result.stdout, "committed.ts");
    assertStringIncludes(result.stdout, "caller.ts");
    const deno = await readLog(fixture, "deno.log");
    assertStringIncludes(deno, "lint -- caller.ts committed.ts");
    assertStringIncludes(deno, "check caller.ts committed.ts");
    assertEquals(deno.match(/^task test$/gm)?.length, 1);
    assertEquals((await readLog(fixture, "build-count")).trim(), "1");
    const testEnv = await readLog(fixture, "test-env");
    assertStringIncludes(testEnv, "SKIP=1");
    assertStringIncludes(testEnv, `ID=${imageId}`);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("release gate failure trap removes owned anonymous volume and network deltas", async () => {
  const fixture = await createFixture();
  try {
    const result = await run(fixture, ["bash", "scripts/release-gate.sh"], {
      FAKE_TEST_FAIL: "1",
    });
    assert(result.code !== 0);
    assertEquals((await readLog(fixture, "containers")).trim(), "");
    assertEquals(
      (await readLog(fixture, "volumes")).trim(),
      "",
      `${result.stdout}\n${result.stderr}\n${await readLog(
        fixture,
        "docker.log",
      )}`,
    );
    assertEquals((await readLog(fixture, "networks")).trim(), "");
    const docker = await readLog(fixture, "docker.log");
    assertStringIncludes(docker, "rm -f -v container-delta");
    assertStringIncludes(docker, "volume rm -f anonymous-volume-full-id");
    assertStringIncludes(docker, "network rm network-full-id");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("release artifacts reject revision mismatch and preserve output atomically", async () => {
  const fixture = await createFixture();
  try {
    await Deno.mkdir(`${fixture.root}/artifacts`);
    await Deno.writeTextFile(`${fixture.root}/artifacts/sentinel`, "original");
    const mismatch = await run(fixture, [
      "bash",
      "scripts/release-artifacts.sh",
      "operant:test",
      "artifacts",
    ], { FAKE_IMAGE_REVISION: "wrong-revision" });
    assert(mismatch.code !== 0);
    assertStringIncludes(mismatch.stderr, "image/source revision mismatch");
    assertEquals(
      await Deno.readTextFile(`${fixture.root}/artifacts/sentinel`),
      "original",
    );

    const compileFailure = await run(fixture, [
      "bash",
      "scripts/release-artifacts.sh",
      "operant:test",
      "artifacts",
    ], { FAKE_COMPILE_FAIL: "1" });
    assert(compileFailure.code !== 0);
    assertEquals(
      await Deno.readTextFile(`${fixture.root}/artifacts/sentinel`),
      "original",
    );
    const entries = [];
    for await (const entry of Deno.readDir(fixture.root)) {
      entries.push(entry.name);
    }
    assert(!entries.some((name) => name.includes(".artifacts.staging.")));
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

type Fixture = { root: string; bin: string; state: string };

async function createFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "release-script-contract-" });
  const bin = `${root}/bin`;
  const state = `${root}/state`;
  await Deno.mkdir(bin);
  await Deno.mkdir(state);
  for (
    const file of [
      "docker.log",
      "deno.log",
      "containers",
      "volumes",
      "networks",
    ]
  ) {
    await Deno.writeTextFile(`${state}/${file}`, "");
  }
  await Deno.writeTextFile(`${state}/build-count`, "0\n");
  await Deno.mkdir(`${root}/scripts`);
  await Deno.copyFile(
    "scripts/release-gate.sh",
    `${root}/scripts/release-gate.sh`,
  );
  await Deno.copyFile(
    "scripts/release-artifacts.sh",
    `${root}/scripts/release-artifacts.sh`,
  );
  for (const dir of ["src", "tests", "docs", "k8s"]) {
    await Deno.mkdir(`${root}/${dir}`);
  }
  await Deno.writeTextFile(`${root}/src/main_optctl.ts`, "export {};\n");
  await Deno.writeTextFile(
    `${root}/committed.ts`,
    "export const committed = 1;\n",
  );
  await Deno.writeTextFile(`${root}/caller.ts`, "import './committed.ts';\n");
  await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
  for (
    const file of [
      "Dockerfile",
      "docker-compose.yml",
      "compose.external-postgres.yml",
      "docs/runtime.md",
    ]
  ) await Deno.writeTextFile(`${root}/${file}`, "release contract\n");

  await executable(
    `${bin}/git`,
    `#!/usr/bin/env bash
set -eu
state="$FAKE_STATE"
case "$1 $2" in
  "rev-parse --show-toplevel") pwd ;;
  "rev-parse --verify") echo "$FAKE_REVISION" ;;
  "status --porcelain=v1") [[ ! -e "$state/dirty" ]] || echo "?? dirty.ts" ;;
  "status --short") echo "?? dirty.ts" ;;
  "cat-file -e") exit 0 ;;
  "merge-base --is-ancestor") exit 0 ;;
  "diff --name-only") printf '%s\\n' committed.ts caller.ts ;;
  "diff --check") exit 0 ;;
  *) echo "unexpected fake git: $*" >&2; exit 2 ;;
esac
`,
  );
  await executable(
    `${bin}/deno`,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$FAKE_STATE/deno.log"
if [[ "$1" == compile ]]; then
  [[ "\${FAKE_COMPILE_FAIL:-0}" != 1 ]] || exit 19
  while (($#)); do
    if [[ "$1" == --output ]]; then shift; mkdir -p "$(dirname "$1")"; printf '#!/bin/sh\\n' >"$1"; chmod +x "$1"; break; fi
    shift
  done
fi
if [[ "$*" == "task test" ]]; then
  printf 'SKIP=%s ID=%s IMAGE=%s\\n' "\${OPERANT_CONTAINER_SKIP_BUILD:-}" "\${OPERANT_CONTAINER_IMAGE_ID:-}" "\${OPERANT_CONTAINER_IMAGE:-}" >"$FAKE_STATE/test-env"
  if [[ "\${FAKE_TEST_FAIL:-0}" == 1 ]]; then
    echo container-delta >"$FAKE_STATE/containers"
    echo anonymous-volume-full-id >"$FAKE_STATE/volumes"
    echo network-full-id >"$FAKE_STATE/networks"
    exit 23
  fi
fi
`,
  );
  await executable(
    `${bin}/docker`,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >>"$FAKE_STATE/docker.log"
read_state() { [[ -e "$FAKE_STATE/$1" ]] && cat "$FAKE_STATE/$1"; }
remove_line() { grep -Fvx "$2" "$FAKE_STATE/$1" >"$FAKE_STATE/$1.tmp" || true; mv "$FAKE_STATE/$1.tmp" "$FAKE_STATE/$1"; }
case "$1 $2" in
  "ps -aq") read_state containers ;;
  "volume ls") read_state volumes ;;
  "network ls") read_state networks ;;
  "build --pull=false") count=$(cat "$FAKE_STATE/build-count"); echo $((count+1)) >"$FAKE_STATE/build-count" ;;
  "image inspect")
    format="\${*: -1}"
    case "$format" in
      *org.opencontainers.image.revision*) echo "\${FAKE_IMAGE_REVISION:-$FAKE_REVISION}" ;;
      *org.opencontainers.image.version*) echo "release-gate-\${FAKE_REVISION:0:12}" ;;
      *json*.Config.Labels*) printf '{"org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"release-gate-%s"}\\n' "\${FAKE_IMAGE_REVISION:-$FAKE_REVISION}" "\${FAKE_REVISION:0:12}" ;;
      *RepoDigests*) echo "operant@test-digest" ;;
      *) echo "$FAKE_IMAGE_ID" ;;
    esac ;;
  "compose -f") exit 0 ;;
  "create --entrypoint") echo artifact-container ;;
  "run --rm")
    if [[ "$*" == *"postgres"* ]]; then echo 'postgres (PostgreSQL) 18.4'; else printf 'deno 2.9.4\\nv8 fake\\n'; fi ;;
  "rm -f")
    if [[ "\${*: -1}" == container-delta ]]; then remove_line containers container-delta; fi ;;
  "volume rm") remove_line volumes "\${*: -1}" ;;
  "network rm") remove_line networks "\${*: -1}" ;;
  "network inspect") echo operant-cr-net-contract ;;
  "inspect container-delta")
    format="\${*: -1}"
    case "$format" in
      *Mounts*) echo anonymous-volume-full-id ;;
      *NetworkID*) echo network-full-id ;;
      *dev.operant.release-gate*) echo "$FAKE_REVISION" ;;
      *'.Name'*) echo /operant-cr-contract ;;
    esac ;;
  "image rm") exit 0 ;;
  *) echo "unexpected fake docker: $*" >&2; exit 2 ;;
esac
`,
  );
  await executable(
    `${bin}/jq`,
    `#!/usr/bin/env bash
exec /usr/bin/jq "$@"
`,
  );
  return { root, bin, state };
}

async function executable(path: string, content: string): Promise<void> {
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755);
}

async function run(
  fixture: Fixture,
  command: string[],
  extraEnv: Record<string, string> = {},
) {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: fixture.root,
    env: {
      ...Deno.env.toObject(),
      PATH: `${fixture.bin}:${Deno.env.get("PATH")}`,
      FAKE_STATE: fixture.state,
      FAKE_REVISION: revision,
      FAKE_IMAGE_ID: imageId,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function readLog(fixture: Fixture, name: string): Promise<string> {
  try {
    return await Deno.readTextFile(`${fixture.state}/${name}`);
  } catch {
    return "";
  }
}
