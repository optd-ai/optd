// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const imageId = `sha256:${"a".repeat(64)}`;

Deno.test("release scripts reject dirty source and invalid explicit bases before Docker", async () => {
  const fixture = await createFixture();
  try {
    const invalid = await runGate(fixture, {
      OPERANT_RELEASE_BASE: "definitely-not-a-commit",
    });
    assert(invalid.code !== 0);
    assertStringIncludes(invalid.stderr, "full 40-character commit");
    assertEquals(await readLog(fixture, "docker.log"), "");

    const conflict = await runGate(fixture, {
      OPERANT_RELEASE_BASE: fixture.base,
      OPERANT_RELEASE_BASE_REV: fixture.revision,
    });
    assert(conflict.code !== 0);
    assertStringIncludes(conflict.stderr, "conflicting OPERANT_RELEASE_BASE");
    assertEquals(await readLog(fixture, "docker.log"), "");

    await Deno.writeTextFile(`${fixture.root}/untracked`, "dirty\n");
    const dirty = await runGate(fixture);
    assert(dirty.code !== 0);
    assertStringIncludes(dirty.stderr, "clean tracked and untracked");
    assertEquals(await readLog(fixture, "docker.log"), "");
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("every initial Docker inventory failure reaches exact cleanup", async () => {
  for (
    const command of [
      "image ls --no-trunc --quiet",
      "container ls --all --no-trunc --quiet",
      "volume ls --quiet",
      "network ls --no-trunc --quiet",
    ]
  ) {
    const fixture = await createFixture();
    try {
      const result = await runGate(fixture, {
        FAKE_DOCKER_FAIL_ONCE_MATCH: command,
      });
      assert(result.code !== 0, command);
      assertEquals(await resourceIds(fixture, "containers"), []);
      assertEquals(await resourceIds(fixture, "volumes"), []);
      assertEquals(await resourceIds(fixture, "networks"), []);
    } finally {
      await removeFixture(fixture);
    }
  }
});

Deno.test("partial snapshot and supplementary scan failures cannot become empty success", async () => {
  const partial = await createFixture();
  try {
    const result = await runGate(partial, {
      FAKE_DOCKER_FAIL_ONCE_MATCH: "container ls --all --no-trunc --quiet",
    });
    assert(result.code !== 0);
    const log = await readLog(partial, "docker.log");
    assertStringIncludes(log, "container ls --all --no-trunc --quiet");
    assertStringIncludes(log, "volume ls --quiet");
  } finally {
    await removeFixture(partial);
  }

  const scan = await createFixture();
  try {
    const result = await runGate(scan, {
      FAKE_DOCKER_FAIL_ALWAYS_MATCH:
        "volume ls --quiet --filter label=dev.operant.release-gate=",
    });
    assert(result.code !== 0);
  } finally {
    await removeFixture(scan);
  }
});

Deno.test("gate uses NUL paths, one build, one suite, and only the frozen image ID", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture);
    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertStringIncludes(
      result.stdout,
      "effective committed TypeScript coverage (3 files)",
    );
    assertStringIncludes(result.stdout, "$'tests/line\\nbreak - caller.ts'");
    assertEquals((await readLog(fixture, "build-count")).trim(), "1");
    assertEquals((await readLog(fixture, "suite-count")).trim(), "1");

    const args = await readNulLog(fixture, "deno.args");
    const weird = "tests/line\nbreak - caller.ts";
    assert(args.includes(weird), JSON.stringify(args));
    const docker = await readLog(fixture, "docker.log");
    assertStringIncludes(docker, `container create`);
    assertStringIncludes(docker, imageId);
    assert(!docker.includes("container create operant:"), docker);
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("unregistered prefix resources are preserved and make the gate fail", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "unrelated-prefix",
    });
    assert(result.code !== 0);
    assertEquals(await resourceIds(fixture, "containers"), [
      "unrelated-prefix",
    ]);
    assertStringIncludes(
      result.stderr,
      "exact Docker inventory delta (containers)",
    );
    const docker = await readLog(fixture, "docker.log");
    assert(!docker.includes("container rm --force --volumes unrelated-prefix"));
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("exact run labels clean registered and discovered owned resources", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, { FAKE_TEST_MODE: "owned-labels" });
    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertEquals(await resourceIds(fixture, "containers"), []);
    assertEquals(await resourceIds(fixture, "volumes"), []);
    assertEquals(await resourceIds(fixture, "networks"), []);
    const docker = await readLog(fixture, "docker.log");
    assertStringIncludes(
      docker,
      "container rm --force --volumes owned-container",
    );
    assertStringIncludes(docker, "volume rm --force owned-volume");
    assertStringIncludes(docker, "network rm owned-network");
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("missing baseline resources fail while preserving the primary status", async () => {
  const fixture = await createFixture();
  try {
    await seedResource(fixture, "containers", "baseline-container", "other");
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "missing-baseline",
    });
    assertEquals(result.code, 37, `${result.stdout}\n${result.stderr}`);
    assertStringIncludes(
      result.stderr,
      "exact Docker inventory delta (containers)",
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("source mutation after a host phase is rejected", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "source-mutation",
    });
    assert(result.code !== 0);
    assertStringIncludes(result.stderr, "tracked content changed");
    assertEquals((await readLog(fixture, "suite-count")).trim(), "1");
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("PID identity mismatch is never signaled", async () => {
  const fixture = await createFixture();
  let pid = 0;
  try {
    const result = await runGate(fixture, { FAKE_TEST_MODE: "pid-mismatch" });
    assert(result.code !== 0);
    assertStringIncludes(
      result.stderr,
      "refusing TERM after owned PID identity mismatch",
    );
    pid = Number((await readLog(fixture, "mismatch-pid")).trim());
    assert(pid > 1);
    assert(
      await processExists(pid),
      `injected unrelated PID ${pid} was signaled`,
    );
  } finally {
    if (pid > 1) await killProcess(pid);
    await removeFixture(fixture);
  }
});

Deno.test("artifact publication rolls back TERM and rejects symlink outputs", async () => {
  const fixture = await createFixture();
  try {
    await seedImage(fixture);
    const output = `${fixture.root}/artifacts`;
    await Deno.mkdir(output);
    await Deno.writeTextFile(`${output}/sentinel`, "original");
    const marker = `${fixture.state}/after-publish`;
    const child = new Deno.Command("bash", {
      args: ["scripts/release-artifacts.sh", imageId, output],
      cwd: fixture.root,
      env: fixtureEnv(fixture, {
        OPERANT_CONTAINER_IMAGE_ID: imageId,
        OPERANT_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE: marker,
      }),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await waitForPath(marker);
    await new Deno.Command("kill", {
      args: ["-TERM", String(child.pid)],
    }).output();
    const terminated = await child.output();
    assertEquals(terminated.code, 143);
    assertEquals(await Deno.readTextFile(`${output}/sentinel`), "original");
    assertEquals(
      (await directoryNames(fixture.root)).filter((name) =>
        name.includes(".artifacts.")
      ),
      [],
    );

    await Deno.remove(output, { recursive: true });
    await Deno.symlink(fixture.state, output);
    const symlink = await runArtifact(fixture, imageId, output);
    assert(symlink.code !== 0);
    assertStringIncludes(symlink.stderr, "symlink");
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("container harness freezes the ID before mutable tag drift", async () => {
  const fixture = await createFixture();
  try {
    await seedImage(fixture);
    const evalSource = `
      import { buildReleaseImage, createContainerHarness } from ${
      JSON.stringify(
        new URL("../../support/container_harness.ts", import.meta.url).href,
      )
    };
      const frozen = await buildReleaseImage();
      await Deno.writeTextFile(Deno.env.get("FAKE_STATE") + "/retag", "1");
      const harness = await createContainerHarness(frozen);
      await harness.docker([
        "run", "--rm", "--name", "frozen-after-retag", frozen, "true",
      ]);
      console.log(harness.image);
    `;
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["eval", evalSource],
      cwd: fixture.root,
      env: fixtureEnv(fixture, {
        OPERANT_CONTAINER_SKIP_BUILD: "1",
        OPERANT_CONTAINER_IMAGE: "operant:mutable",
        OPERANT_CONTAINER_IMAGE_ID: imageId,
        OPERANT_CONTAINER_REVISION: fixture.revision,
        OPERANT_CONTAINER_VERSION: `release-gate-${
          fixture.revision.slice(0, 12)
        }`,
        OPERANT_RELEASE_GATE_ID: "b".repeat(32),
        OPERANT_RELEASE_GATE_REGISTRY: fixture.registry,
      }),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      result.code,
      0,
      new TextDecoder().decode(result.stderr),
    );
    assertEquals(new TextDecoder().decode(result.stdout).trim(), imageId);
    const dockerLog = await readLog(fixture, "docker.log");
    assertStringIncludes(
      dockerLog,
      `container create --label dev.operant.release-gate=${
        "b".repeat(32)
      } --name frozen-after-retag ${imageId} true`,
    );
    assertStringIncludes(dockerLog, "container start --attach container-1");
    const registry = await Deno.readTextFile(`${fixture.registry}/containers`);
    assertStringIncludes(registry, "pending:frozen-after-retag");
  } finally {
    await removeFixture(fixture);
  }
});

type Fixture = {
  home: string;
  root: string;
  bin: string;
  state: string;
  registry: string;
  base: string;
  revision: string;
};

async function createFixture(): Promise<Fixture> {
  const home = await Deno.makeTempDir({ prefix: "release-script-contract-" });
  const root = `${home}/repo`;
  const bin = `${home}/bin`;
  const state = `${home}/state`;
  const registry = `${state}/registry`;
  await Deno.mkdir(root);
  await Deno.mkdir(bin);
  await Deno.mkdir(state);
  for (const kind of ["images", "containers", "volumes", "networks"]) {
    await Deno.mkdir(`${state}/${kind}`);
  }
  await Deno.mkdir(registry);
  await Deno.mkdir(`${registry}/pids`);
  for (const kind of ["images", "containers", "volumes", "networks"]) {
    await Deno.writeTextFile(`${registry}/${kind}`, "");
  }
  for (
    const file of [
      "docker.log",
      "deno.args",
      "build-count",
      "suite-count",
    ]
  ) {
    await Deno.writeTextFile(
      `${state}/${file}`,
      file.endsWith("count") ? "0\n" : "",
    );
  }

  await command(["git", "init", "--quiet"], root);
  await command(
    ["git", "config", "user.email", "release@example.invalid"],
    root,
  );
  await command(["git", "config", "user.name", "Release Contract"], root);
  await Deno.writeTextFile(`${root}/base.txt`, "base\n");
  await command(["git", "add", "--", "base.txt"], root);
  await command(["git", "commit", "--quiet", "-m", "chore: base"], root);
  const base = (await command(["git", "rev-parse", "HEAD"], root)).stdout
    .trim();

  for (const dir of ["scripts", "src", "tests", "docs", "k8s"]) {
    await Deno.mkdir(`${root}/${dir}`, { recursive: true });
  }
  await Deno.copyFile(
    "scripts/release-gate.sh",
    `${root}/scripts/release-gate.sh`,
  );
  await Deno.copyFile(
    "scripts/release-artifacts.sh",
    `${root}/scripts/release-artifacts.sh`,
  );
  await Deno.copyFile(
    "compose.external-postgres.yml",
    `${root}/compose.external-postgres.yml`,
  );
  await Deno.chmod(`${root}/scripts/release-gate.sh`, 0o755);
  await Deno.chmod(`${root}/scripts/release-artifacts.sh`, 0o755);
  await Deno.writeTextFile(`${root}/src/main_optctl.ts`, "export {};\n");
  await Deno.writeTextFile(
    `${root}/tests/ordinary.ts`,
    "export const ordinary = 1;\n",
  );
  await Deno.writeTextFile(
    `${root}/tests/line\nbreak - caller.ts`,
    "export const unusual = 1;\n",
  );
  await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${root}/.gitignore`, "artifacts\n");
  for (
    const file of [
      "Dockerfile",
      "docker-compose.yml",
      "docs/runtime.md",
    ]
  ) await Deno.writeTextFile(`${root}/${file}`, "release contract\n");
  await command(["git", "add", "--all"], root);
  await command(
    ["git", "commit", "--quiet", "-m", "test: release fixture"],
    root,
  );
  const revision = (await command(["git", "rev-parse", "HEAD"], root)).stdout
    .trim();

  await executable(`${bin}/deno`, fakeDeno());
  await executable(`${bin}/docker`, fakeDocker());
  return { home, root, bin, state, registry, base, revision };
}

function fakeDeno(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >>"$FAKE_STATE/deno.args"
if [[ "\${1:-}" == compile ]]; then
  while (($#)); do
    if [[ "$1" == --output ]]; then
      shift
      mkdir -p -- "$(dirname -- "$1")"
      printf '#!/usr/bin/env bash\\n' >"$1"
      chmod +x -- "$1"
      break
    fi
    shift
  done
  exit 0
fi
if [[ "$*" == "task test" ]]; then
  count=$(<"$FAKE_STATE/suite-count"); printf '%s\\n' "$((count+1))" >"$FAKE_STATE/suite-count"
  case "\${FAKE_TEST_MODE:-}" in
    unrelated-prefix)
      printf 'label=other\\nname=operant-cr-unrelated\\n' >"$FAKE_STATE/containers/unrelated-prefix"
      ;;
    owned-labels)
      printf 'label=%s\\nname=owned-container\\n' "$OPERANT_RELEASE_GATE_ID" >"$FAKE_STATE/containers/owned-container"
      printf 'label=%s\\nname=owned-volume\\n' "$OPERANT_RELEASE_GATE_ID" >"$FAKE_STATE/volumes/owned-volume"
      printf 'label=%s\\nname=owned-network\\n' "$OPERANT_RELEASE_GATE_ID" >"$FAKE_STATE/networks/owned-network"
      ;;
    missing-baseline)
      rm -f -- "$FAKE_STATE/containers/baseline-container"
      exit 37
      ;;
    source-mutation)
      printf '// mutated\\n' >>"$OPERANT_RELEASE_SOURCE_ROOT/tests/ordinary.ts"
      ;;
    pid-mismatch)
      setsid sleep 120 >/dev/null 2>&1 & pid=$!
      printf '%s\\n' "$pid" >"$FAKE_STATE/mismatch-pid"
      python3 - "$pid" "$OPERANT_RELEASE_GATE_REGISTRY/pids/$pid.json" "$OPERANT_RELEASE_GATE_ID" "$(dirname "$OPERANT_RELEASE_GATE_REGISTRY")" <<'PY'
import base64,json,os,pathlib,sys
pid=int(sys.argv[1]); proc=pathlib.Path('/proc')/str(pid)
raw=(proc/'stat').read_text(); fields=raw[raw.rfind(') ')+2:].split()
record={'pid':pid,'ppid':int(fields[1]),'start_ticks':str(int(fields[19])+1),
'exe':os.readlink(proc/'exe'),'cwd':os.readlink(proc/'cwd'),
'cmdline_b64':base64.b64encode((proc/'cmdline').read_bytes()).decode(),
'boot_id':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
'run_id':sys.argv[3],'data_dir':sys.argv[4],'ancestry':[]}
pathlib.Path(sys.argv[2]).write_text(json.dumps(record)+'\\n')
PY
      ;;
  esac
fi
`;
}

function fakeDocker(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_STATE/docker.log"
command_line="$*"
if [[ -n "\${FAKE_DOCKER_FAIL_ONCE_MATCH:-}" && "$command_line" == *"$FAKE_DOCKER_FAIL_ONCE_MATCH"* && ! -e "$FAKE_STATE/fail-once" ]]; then
  : >"$FAKE_STATE/fail-once"; exit 71
fi
if [[ -n "\${FAKE_DOCKER_FAIL_ALWAYS_MATCH:-}" && "$command_line" == *"$FAKE_DOCKER_FAIL_ALWAYS_MATCH"* ]]; then exit 72; fi
value() { sed -n "s/^$1=//p" "$2" | head -1; }
list_kind() {
  kind=$1; filter="\${2:-}"
  shopt -s nullglob
  for file in "$FAKE_STATE/$kind"/*; do
    if [[ -n "$filter" && "$(value label "$file")" != "$filter" ]]; then continue; fi
    basename -- "$file"
  done | LC_ALL=C sort
}
arg_after() { target=$1; shift; while (($#)); do [[ "$1" == "$target" ]] && { printf '%s' "$2"; return; }; shift; done; }
last_arg() { printf '%s' "\${!#}"; }
case "\${1:-} \${2:-}" in
  "image ls")
    filter=""; [[ "$*" != *"--filter label=dev.operant.release-gate="* ]] || filter="\${OPERANT_RELEASE_GATE_ID:-}"
    list_kind images "$filter" ;;
  "container ls")
    filter=""; [[ "$*" != *"--filter label=dev.operant.release-gate="* ]] || filter="\${OPERANT_RELEASE_GATE_ID:-}"
    list_kind containers "$filter" ;;
  "volume ls")
    filter=""; [[ "$*" != *"--filter label=dev.operant.release-gate="* ]] || filter="\${OPERANT_RELEASE_GATE_ID:-}"
    list_kind volumes "$filter" ;;
  "network ls")
    filter=""; [[ "$*" != *"--filter label=dev.operant.release-gate="* ]] || filter="\${OPERANT_RELEASE_GATE_ID:-}"
    list_kind networks "$filter" ;;
  "build --pull=false")
    count=$(<"$FAKE_STATE/build-count"); printf '%s\\n' "$((count+1))" >"$FAKE_STATE/build-count"
    tag=$(arg_after --tag "$@")
    printf 'label=%s\\nname=%s\\n' "$OPERANT_RELEASE_GATE_ID" "$tag" >"$FAKE_STATE/images/$FAKE_IMAGE_ID"
    printf '%s\\n' "$FAKE_IMAGE_ID" >"$FAKE_STATE/tag-image"
    ;;
  "image inspect")
    identity=$3; [[ "$identity" != operant:* ]] || identity=$(<"$FAKE_STATE/tag-image")
    if [[ -e "$FAKE_STATE/retag" && "$3" == operant:* ]]; then identity="sha256:$(printf 'b%.0s' {1..64})"; fi
    format=$(last_arg "$@")
    case "$format" in
      *'.Id}} {{index .Config.Labels'*) printf '%s %s release-gate-%s\\n' "$identity" "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
      *org.opencontainers.image.revision*) printf '%s\\n' "$FAKE_REVISION" ;;
      *org.opencontainers.image.version*) printf 'release-gate-%s\\n' "\${FAKE_REVISION:0:12}" ;;
      *dev.operant.release-gate*) value label "$FAKE_STATE/images/$FAKE_IMAGE_ID" ;;
      *json*.Config.Labels*) printf '{"org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"release-gate-%s"}\\n' "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
      *RepoDigests*) printf 'operant@example-digest\\n' ;;
      *'{{.Id}}'*) printf '%s\\n' "$identity" ;;
      *) printf '%s %s release-gate-%s\\n' "$identity" "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
    esac ;;
  "image rm")
    identity=$(last_arg "$@"); [[ "$identity" != operant:* ]] || identity=$(<"$FAKE_STATE/tag-image")
    rm -f -- "$FAKE_STATE/images/$identity" "$FAKE_STATE/tag-image" ;;
  "container create")
    name=$(arg_after --name "$@"); label=$(arg_after --label "$@"); entry=$(arg_after --entrypoint "$@")
    count=$(find "$FAKE_STATE/containers" -mindepth 1 -maxdepth 1 -type f | wc -l)
    id="container-$((count+1))"
    printf 'label=%s\\nname=%s\\nentry=%s\\n' "\${label#*=}" "$name" "$entry" >"$FAKE_STATE/containers/$id"
    printf '%s\\n' "$id" ;;
  "container inspect")
    identity=$3; file="$FAKE_STATE/containers/$identity"
    [[ -e "$file" ]] || { for candidate in "$FAKE_STATE/containers"/*; do [[ -e "$candidate" && "$(value name "$candidate")" == "$identity" ]] && { file=$candidate; identity=$(basename "$candidate"); break; }; done; }
    [[ -e "$file" ]] || exit 1
    format=$(last_arg "$@")
    case "$format" in
      *dev.operant.release-gate*) value label "$file" ;;
      *Mounts*) value mounts "$file" ;;
      *'{{.Id}}'*) printf '%s\\n' "$identity" ;;
      *) value name "$file" ;;
    esac ;;
  "container start")
    identity=$(last_arg "$@"); entry=$(value entry "$FAKE_STATE/containers/$identity")
    case "$entry" in
      deno) printf 'deno 2.9.4\\nv8 fake\\n' ;;
      *postgres) printf 'postgres (PostgreSQL) 18.4\\n' ;;
      *) printf '%s\\n' "$identity" ;;
    esac ;;
  "container rm")
    identity=$(last_arg "$@"); rm -f -- "$FAKE_STATE/containers/$identity" ;;
  "volume inspect")
    identity=$3; file="$FAKE_STATE/volumes/$identity"; [[ -e "$file" ]] || exit 1
    format=$(last_arg "$@"); [[ "$format" != *dev.operant.release-gate* ]] || { value label "$file"; exit; }; printf '%s\\n' "$identity" ;;
  "volume rm") identity=$(last_arg "$@"); rm -f -- "$FAKE_STATE/volumes/$identity" ;;
  "network inspect")
    identity=$3; file="$FAKE_STATE/networks/$identity"; [[ -e "$file" ]] || exit 1
    format=$(last_arg "$@"); [[ "$format" != *dev.operant.release-gate* ]] || { value label "$file"; exit; }; printf '%s\\n' "$identity" ;;
  "network rm") identity=$(last_arg "$@"); rm -f -- "$FAKE_STATE/networks/$identity" ;;
  "compose -f") exit 0 ;;
  *) printf 'unexpected fake docker: %s\\n' "$*" >&2; exit 2 ;;
esac
`;
}

async function runGate(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
) {
  return await run(
    fixture,
    ["bash", "scripts/release-gate.sh"],
    extraEnv,
  );
}

async function runArtifact(
  fixture: Fixture,
  image: string,
  output: string,
  extraEnv: Record<string, string> = {},
) {
  return await run(
    fixture,
    ["bash", "scripts/release-artifacts.sh", image, output],
    { OPERANT_CONTAINER_IMAGE_ID: image, ...extraEnv },
  );
}

async function run(
  fixture: Fixture,
  commandLine: string[],
  extraEnv: Record<string, string> = {},
) {
  const result = await new Deno.Command(commandLine[0], {
    args: commandLine.slice(1),
    cwd: fixture.root,
    env: fixtureEnv(fixture, extraEnv),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function fixtureEnv(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Deno.env.toObject(),
    PATH: `${fixture.bin}:${Deno.env.get("PATH")}`,
    FAKE_STATE: fixture.state,
    FAKE_REVISION: fixture.revision,
    FAKE_IMAGE_ID: imageId,
    OPERANT_RELEASE_BASE: fixture.base,
    ...extraEnv,
  };
}

async function seedImage(fixture: Fixture): Promise<void> {
  await seedResource(fixture, "images", imageId, "standalone");
  await Deno.writeTextFile(`${fixture.state}/tag-image`, `${imageId}\n`);
}

async function seedResource(
  fixture: Fixture,
  kind: "images" | "containers" | "volumes" | "networks",
  identity: string,
  label: string,
): Promise<void> {
  await Deno.writeTextFile(
    `${fixture.state}/${kind}/${identity}`,
    `label=${label}\nname=${identity}\n`,
  );
}

async function resourceIds(fixture: Fixture, kind: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const entry of Deno.readDir(`${fixture.state}/${kind}`)) {
    if (entry.isFile) ids.push(entry.name);
  }
  return ids.sort();
}

async function readLog(fixture: Fixture, name: string): Promise<string> {
  try {
    return await Deno.readTextFile(`${fixture.state}/${name}`);
  } catch {
    return "";
  }
}

async function readNulLog(fixture: Fixture, name: string): Promise<string[]> {
  const bytes = await Deno.readFile(`${fixture.state}/${name}`);
  return new TextDecoder().decode(bytes).split("\0").filter(Boolean);
}

async function executable(path: string, content: string): Promise<void> {
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755);
}

async function command(args: string[], cwd: string) {
  const output = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const result = {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
  assertEquals(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
  return result;
}

async function directoryNames(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names.sort();
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await Deno.lstat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function processExists(pid: number): Promise<boolean> {
  const result = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return result.code === 0;
}

async function killProcess(pid: number): Promise<void> {
  await new Deno.Command("kill", {
    args: ["-KILL", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await Deno.remove(fixture.home, { recursive: true }).catch(() => undefined);
}
