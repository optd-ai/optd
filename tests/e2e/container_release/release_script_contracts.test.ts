// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";

const imageId = `sha256:${"a".repeat(64)}`;

Deno.test("release scripts reject dirty source and invalid explicit bases before Docker", async () => {
  const fixture = await createFixture();
  try {
    const invalid = await runGate(fixture, {
      OPTD_RELEASE_BASE: "definitely-not-a-commit",
    });
    assert(invalid.code !== 0);
    assertStringIncludes(invalid.stderr, "full 40-character commit");
    assertEquals(await readLog(fixture, "docker.log"), "");

    const conflict = await runGate(fixture, {
      OPTD_RELEASE_BASE: fixture.base,
      OPTD_RELEASE_BASE_REV: fixture.revision,
    });
    assert(conflict.code !== 0);
    assertStringIncludes(conflict.stderr, "conflicting OPTD_RELEASE_BASE");
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
      "image ls --all --no-trunc --quiet",
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
        "volume ls --quiet --filter label=dev.optd.release-gate=",
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
    assert(!docker.includes("container create optd:"), docker);
    assertStringIncludes(docker, `image rm --no-prune -- ${imageId}`);
    assert(!docker.includes("image rm -- optd:"), docker);
    assert(!docker.includes("image prune"), docker);
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("legacy builder registers and removes a 17-intermediate chain with exact all-image equality", async () => {
  const fixture = await createFixture();
  try {
    const before = await resourceIds(fixture, "images");
    const result = await runGate(fixture);
    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertEquals(await resourceIds(fixture, "images"), before);
    const docker = await readLog(fixture, "docker.log");
    assertEquals(
      docker.split("\n").filter((line) =>
        line.startsWith("image rm --no-prune -- sha256:")
      ).length,
      18,
    );
    assert(!docker.includes("image prune"), docker);
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("failed legacy build cleans every emitted intermediate and preserves status", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, { FAKE_TEST_MODE: "build-failure" });
    assertEquals(result.code, 37, `${result.stdout}\n${result.stderr}`);
    assertEquals(await resourceIds(fixture, "images"), []);
    const docker = await readLog(fixture, "docker.log");
    assertEquals(
      docker.split("\n").filter((line) =>
        line.startsWith("image rm --no-prune -- sha256:")
      ).length,
      17,
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("failed build with a final incomplete Step cleans prior completed images and preserves status", async () => {
  const fixture = await createFixture();
  const baseline = `sha256:${"b".repeat(64)}`;
  try {
    await seedImageMetadata(fixture, baseline);
    await Deno.writeTextFile(`${fixture.state}/base-image`, `${baseline}\n`);
    const before = await resourceIds(fixture, "images");
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "build-failure-incomplete",
    });
    assertEquals(result.code, 37, `${result.stdout}\n${result.stderr}`);
    assertEquals(await resourceIds(fixture, "images"), before);
    const docker = await readLog(fixture, "docker.log");
    assertEquals(
      docker.split("\n").filter((line) =>
        line.startsWith("image rm --no-prune -- sha256:")
      ).length,
      1,
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("signaled build with a final incomplete Step cleans prior completed images and preserves 143", async () => {
  const fixture = await createFixture();
  const baseline = `sha256:${"b".repeat(64)}`;
  try {
    await seedImageMetadata(fixture, baseline);
    await Deno.writeTextFile(`${fixture.state}/base-image`, `${baseline}\n`);
    const before = await resourceIds(fixture, "images");
    const child = new Deno.Command("bash", {
      args: ["scripts/release-gate.sh"],
      cwd: fixture.root,
      env: fixtureEnv(fixture, {
        FAKE_TEST_MODE: "build-signal-incomplete",
      }),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    await waitForPath(`${fixture.state}/build-signal-ready`);
    await new Deno.Command("kill", {
      args: ["-TERM", String(child.pid)],
    }).output();
    const result = await child.output();
    assertEquals(
      result.code,
      143,
      new TextDecoder().decode(result.stderr),
    );
    assertEquals(await resourceIds(fixture, "images"), before);
    const docker = await readLog(fixture, "docker.log");
    assertEquals(
      docker.split("\n").filter((line) =>
        line.startsWith("image rm --no-prune -- sha256:")
      ).length,
      1,
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("successful status with an incomplete Step is rejected without image authority", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "build-success-incomplete",
    });
    assert(result.code !== 0, `${result.stdout}\n${result.stderr}`);
    assertEquals((await resourceIds(fixture, "images")).length, 1);
    assertStringIncludes(
      result.stderr,
      "builder image authority is ambiguous",
    );
    assert(
      !(await readLog(fixture, "docker.log")).includes(
        "image rm --no-prune -- sha256:",
      ),
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("a result after an incomplete Step is rejected as spoofed protocol", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "incomplete-then-spoof-result",
    });
    assert(result.code !== 0, `${result.stdout}\n${result.stderr}`);
    assertEquals((await resourceIds(fixture, "images")).length, 1);
    assertStringIncludes(
      result.stderr,
      "builder image authority is ambiguous",
    );
    assert(
      !(await readLog(fixture, "docker.log")).includes(
        "image rm --no-prune -- sha256:",
      ),
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("multiple or non-final incomplete Steps are rejected", async () => {
  for (
    const mode of [
      "multiple-incomplete",
      "nonfinal-incomplete",
    ]
  ) {
    const fixture = await createFixture();
    try {
      const result = await runGate(fixture, { FAKE_TEST_MODE: mode });
      assert(
        result.code !== 0,
        `${mode}\n${result.stdout}\n${result.stderr}`,
      );
      assertStringIncludes(
        result.stderr,
        "builder image authority is ambiguous",
      );
      assert(
        !(await readLog(fixture, "docker.log")).includes(
          "image rm --no-prune -- sha256:",
        ),
        mode,
      );
    } finally {
      await removeFixture(fixture);
    }
  }
});

Deno.test("an unreported image from an incomplete Step blocks cleanup authority", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "incomplete-unknown-delta",
    });
    assert(result.code !== 0, `${result.stdout}\n${result.stderr}`);
    assertEquals((await resourceIds(fixture, "images")).length, 2);
    assertStringIncludes(
      result.stderr,
      "post-build delta has IDs not owned by completed Steps",
    );
    assertStringIncludes(
      result.stderr,
      "builder image authority is ambiguous",
    );
    assert(
      !(await readLog(fixture, "docker.log")).includes(
        "image rm --no-prune -- sha256:",
      ),
    );
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("a signaled build preserves 143 and cleans only completed Steps even when Docker exits zero", async () => {
  for (const mode of ["build-signal", "build-signal-child-zero"]) {
    const fixture = await createFixture();
    try {
      const child = new Deno.Command("bash", {
        args: ["scripts/release-gate.sh"],
        cwd: fixture.root,
        env: fixtureEnv(fixture, { FAKE_TEST_MODE: mode }),
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await waitForPath(`${fixture.state}/build-signal-ready`);
      await new Deno.Command("kill", {
        args: ["-TERM", String(child.pid)],
      }).output();
      const result = await child.output();
      assertEquals(
        result.code,
        143,
        `${mode}: ${new TextDecoder().decode(result.stderr)}`,
      );
      assertEquals(await resourceIds(fixture, "images"), []);
      const docker = await readLog(fixture, "docker.log");
      assertEquals(
        docker.split("\n").filter((line) =>
          line.startsWith("image rm --no-prune -- sha256:")
        ).length,
        5,
      );
    } finally {
      await removeFixture(fixture);
    }
  }
});

Deno.test("unknown deltas and spoofed or ambiguous transcript IDs fail closed without image deletion", async () => {
  for (
    const mode of [
      "unknown-delta",
      "transcript-spoof",
      "ambiguous-short",
      "concurrent-result-spoof",
      "step-line-spoof",
      "success-line-spoof",
    ]
  ) {
    const fixture = await createFixture();
    try {
      const result = await runGate(fixture, { FAKE_TEST_MODE: mode });
      assert(result.code !== 0, `${mode}\n${result.stdout}\n${result.stderr}`);
      assert((await resourceIds(fixture, "images")).length > 0, mode);
      const docker = await readLog(fixture, "docker.log");
      assert(
        !docker.includes("image rm --no-prune -- sha256:"),
        `${mode}\n${docker}`,
      );
      assertStringIncludes(
        result.stderr,
        "builder image authority is ambiguous",
      );
    } finally {
      await removeFixture(fixture);
    }
  }
});

Deno.test("a baseline ancestor emitted by the builder is retained", async () => {
  const fixture = await createFixture();
  const baseline = `sha256:${"b".repeat(64)}`;
  try {
    await seedImageMetadata(fixture, baseline);
    await Deno.writeTextFile(`${fixture.state}/base-image`, `${baseline}\n`);
    const result = await runGate(fixture);
    assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assertEquals(await resourceIds(fixture, "images"), [baseline]);
    const docker = await readLog(fixture, "docker.log");
    assert(!docker.includes(`image rm --no-prune -- ${baseline}`), docker);
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("unexpected image tags, digests, children, and references block all image removal", async () => {
  for (
    const mode of [
      "unexpected-tag",
      "unexpected-digest",
      "unexpected-child",
      "unexpected-ref",
    ]
  ) {
    const fixture = await createFixture();
    try {
      if (mode === "unexpected-child") {
        const child = `sha256:${"c".repeat(64)}`;
        await seedImageMetadata(fixture, child);
        await Deno.writeTextFile(`${fixture.state}/base-child`, `${child}\n`);
      }
      const result = await runGate(fixture, { FAKE_TEST_MODE: mode });
      assert(result.code !== 0, `${mode}\n${result.stdout}\n${result.stderr}`);
      const docker = await readLog(fixture, "docker.log");
      assert(
        !docker.includes("image rm --no-prune -- sha256:"),
        `${mode}\n${docker}`,
      );
      assertStringIncludes(result.stderr, "image ownership preflight failed");
    } finally {
      await removeFixture(fixture);
    }
  }
});

Deno.test("unsafe authority paths and post-preflight Docker races block before image removal", async () => {
  for (
    const mode of [
      "authority-symlink-0666",
      "action-tag-race",
      "action-parent-race",
      "action-ref-race",
      "action-disappearance-race",
    ]
  ) {
    const fixture = await createFixture();
    try {
      const result = await runGate(fixture, { FAKE_TEST_MODE: mode });
      assert(result.code !== 0, `${mode}\n${result.stdout}\n${result.stderr}`);
      const docker = await readLog(fixture, "docker.log");
      assert(
        !docker.includes("image rm --no-prune -- sha256:"),
        `${mode} reached destructive image action:\n${docker}`,
      );
      assertStringIncludes(result.stderr, "image ownership preflight failed");
    } finally {
      await removeFixture(fixture);
    }
  }

  const source = await Deno.readTextFile("scripts/release-gate.sh");
  assert(!source.includes("cleanup-images.ids"));
  assert(!source.includes("preflight \\"));
});

Deno.test("an exact-ID removal failure blocks and leaves unrelated resources intact", async () => {
  const fixture = await createFixture();
  const unrelated = `sha256:${"d".repeat(64)}`;
  try {
    await seedImageMetadata(fixture, unrelated);
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "removal-failure",
    });
    assert(result.code !== 0, `${result.stdout}\n${result.stderr}`);
    assert((await resourceIds(fixture, "images")).includes(unrelated));
    const docker = await readLog(fixture, "docker.log");
    assert(!docker.includes(`image rm --no-prune -- ${unrelated}`), docker);
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

Deno.test("Docker ownership inspect failure blocks removal before destruction", async () => {
  const fixture = await createFixture();
  try {
    const gateId = "c".repeat(32);
    await seedResource(fixture, "containers", "victim", gateId);
    const source = `
      import { runCommand } from ${
      JSON.stringify(
        new URL("../../support/container_harness.ts", import.meta.url).href,
      )
    };
      try {
        await runCommand("docker", ["container", "rm", "--force", "victim"]);
        Deno.exit(91);
      } catch (error) {
        console.error(String(error));
      }
    `;
    const result = await runHarnessEval(fixture, source, {
      OPTD_RELEASE_GATE_ID: gateId,
      FAKE_DOCKER_FAIL_ALWAYS_MATCH: "container inspect victim",
    });
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "inspection failed");
    const docker = await readLog(fixture, "docker.log");
    assertStringIncludes(docker, "container inspect victim");
    assert(!docker.includes("container rm --force victim"), docker);
  } finally {
    await removeFixture(fixture);
  }
});

for (
  const contract of [
    {
      kind: "container",
      registryKind: "containers",
      command: ["container", "rm"],
      flags: ["--force"],
      combined: "-fv",
    },
    {
      kind: "volume",
      registryKind: "volumes",
      command: ["volume", "rm"],
      flags: ["--force"],
      combined: "-ff",
    },
    {
      kind: "network",
      registryKind: "networks",
      command: ["network", "rm"],
      flags: ["--force"],
      combined: "-ff",
    },
  ] as const
) {
  Deno.test(
    `Docker ${contract.kind} rm parses exact candidates and rejects ambiguous options`,
    async () => {
      const fixture = await createFixture();
      try {
        const gateId = "e".repeat(32);
        for (
          const identity of [
            "123",
            "456",
            "-leading",
            "unknown-victim",
            "combined-victim",
            "missing-value-victim",
            "multi-one",
            "multi-two",
            "multi-live",
          ]
        ) {
          await seedResource(
            fixture,
            contract.registryKind,
            identity,
            gateId,
          );
        }
        const source = `
          import { runCommand } from ${
          JSON.stringify(
            new URL("../../support/container_harness.ts", import.meta.url).href,
          )
        };
          const prefix = ${
          JSON.stringify([...contract.command, ...contract.flags])
        };
          async function blocked(args) {
            try {
              await runCommand("docker", args);
            } catch {
              return;
            }
            throw new Error("unsafe removal command was accepted: " + args.join(" "));
          }
          await runCommand("docker", [...prefix, "123"]);
          await runCommand("docker", [...prefix, "--", "456"]);
          await runCommand("docker", [...prefix, "--", "-leading"]);
          await blocked([...prefix, "--definitely-unknown", "unknown-victim"]);
          await blocked([...prefix, ${
          JSON.stringify(contract.combined)
        }, "combined-victim"]);
          await blocked([...prefix, "--force=", "missing-value-victim"]);
          await runCommand("docker", [...prefix, "multi-one", "multi-two"]);
          await blocked([...prefix, "multi-live", "multi-absent"]);
        `;
        const result = await runHarnessEval(fixture, source, {
          OPTD_RELEASE_GATE_ID: gateId,
        });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const docker = await readLog(fixture, "docker.log");
        for (
          const identity of [
            "123",
            "456",
            "-leading",
            "multi-one",
            "multi-two",
            "multi-live",
            "multi-absent",
          ]
        ) {
          assertStringIncludes(
            docker,
            `${contract.kind} inspect ${identity} --format`,
          );
        }
        assertStringIncludes(
          docker,
          `${contract.command.join(" ")} ${contract.flags.join(" ")} 123`,
        );
        assertStringIncludes(
          docker,
          `${contract.command.join(" ")} ${contract.flags.join(" ")} -- 456`,
        );
        assertStringIncludes(
          docker,
          `${contract.command.join(" ")} ${
            contract.flags.join(" ")
          } -- -leading`,
        );
        assertStringIncludes(
          docker,
          `${contract.command.join(" ")} ${
            contract.flags.join(" ")
          } multi-one multi-two`,
        );
        for (
          const rejected of [
            "--definitely-unknown unknown-victim",
            `${contract.combined} combined-victim`,
            "--force= missing-value-victim",
            "multi-live multi-absent",
          ]
        ) {
          assert(
            !docker.includes(
              `${contract.command.join(" ")} ${
                contract.flags.join(" ")
              } ${rejected}`,
            ),
            docker,
          );
        }
      } finally {
        await removeFixture(fixture);
      }
    },
  );
}

Deno.test("Compose down preflights exact resources and never runs after inspect failure", async () => {
  const fixture = await createFixture();
  try {
    const gateId = "d".repeat(32);
    await Deno.writeTextFile(
      `${fixture.state}/containers/compose-container`,
      `label=${gateId}\nproject=exact-project\nname=compose-container\n`,
    );
    const source = `
      import { runCommand } from ${
      JSON.stringify(
        new URL("../../support/container_harness.ts", import.meta.url).href,
      )
    };
      try {
        await runCommand("docker", ["compose", "-f", "compose.external-postgres.yml", "down", "--volumes", "--remove-orphans"], {
          env: { COMPOSE_PROJECT_NAME: "exact-project" },
        });
        Deno.exit(91);
      } catch (error) {
        console.error(String(error));
      }
    `;
    const result = await runHarnessEval(fixture, source, {
      OPTD_RELEASE_GATE_ID: gateId,
      FAKE_DOCKER_FAIL_ALWAYS_MATCH: "container inspect compose-container",
    });
    assertEquals(result.code, 0, result.stderr);
    assertStringIncludes(result.stderr, "inspection failed");
    const docker = await readLog(fixture, "docker.log");
    assertStringIncludes(
      docker,
      "container ls --all --no-trunc --quiet --filter label=com.docker.compose.project=exact-project",
    );
    assertStringIncludes(docker, "container inspect compose-container");
    assert(
      !docker.includes(
        "compose -f compose.external-postgres.yml down --volumes --remove-orphans",
      ),
      docker,
    );
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

Deno.test("staged mutation with unchanged HEAD fails immutable tree verification", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      FAKE_TEST_MODE: "staged-source-mutation",
    });
    assert(result.code !== 0);
    assertStringIncludes(
      result.stderr,
      "source index differs from immutable commit",
    );
    assertEquals((await readLog(fixture, "suite-count")).trim(), "1");
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("pre-registration failure cannot launch or numerically kill a workload", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, {
      OPTD_RELEASE_TEST_PRE_REGISTRATION_FAILURE: "1",
    });
    assert(result.code !== 0);
    assertStringIncludes(result.stderr, "registration failed before launch");
    assertEquals(await readLog(fixture, "deno.args"), "");
  } finally {
    await removeFixture(fixture);
  }
});

for (const signalName of ["CONT", "TERM", "KILL"] as const) {
  for (const mode of ["mismatch", "reuse", "inspect-failure"] as const) {
    Deno.test(
      `pidfd ${signalName} blocks deterministic ${mode} without signaling`,
      async () => {
        const result = await runPidfdAdversary(signalName, mode);
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "blocked-without-signal");
      },
    );
  }
}

Deno.test("pidfd rejects untrusted manifest paths and metadata without signaling", async () => {
  const result = await runPidfdManifestAdversaries();
  assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
  for (
    const adversary of [
      "mode-0666",
      "mode-0640",
      "symlink-final",
      "symlink-parent",
      "symlink-state-root",
      "hardlink",
      "outside-registry",
      "directory",
      "fifo",
      "unsafe-state-mode",
      "unsafe-registry-mode",
      "unsafe-pids-mode",
      "rename-replacement",
      "wrong-owner",
    ]
  ) {
    assertStringIncludes(result.stdout, adversary);
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
      "refusing TERM after owned PID identity inspection failed",
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
        OPTD_CONTAINER_IMAGE_ID: imageId,
        OPTD_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE: marker,
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

Deno.test("quarantine failure retains the old backup at its top-level recovery path", async () => {
  const fixture = await createFixture();
  try {
    await seedImage(fixture);
    const output = `${fixture.root}/artifacts`;
    await Deno.mkdir(output);
    await Deno.writeTextFile(`${output}/sentinel`, "original");
    await executable(
      `${fixture.bin}/mv`,
      `#!/usr/bin/env bash\nset -euo pipefail\nfor arg in "$@"; do [[ "$arg" != *'.failed.'* ]] || exit 74; done\nexec /usr/bin/mv "$@"\n`,
    );
    const marker = `${fixture.state}/after-publish-quarantine-failure`;
    const child = new Deno.Command("bash", {
      args: ["scripts/release-artifacts.sh", imageId, output],
      cwd: fixture.root,
      env: fixtureEnv(fixture, {
        OPTD_CONTAINER_IMAGE_ID: imageId,
        OPTD_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE: marker,
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
    const stderr = new TextDecoder().decode(terminated.stderr);
    assertStringIncludes(stderr, "could not quarantine failed publication");
    assertStringIncludes(stderr, "retained prior-output backup");

    const backups = (await directoryNames(fixture.root)).filter((name) =>
      name.startsWith(".artifacts.backup.")
    );
    assertEquals(backups.length, 1, JSON.stringify(backups));
    assertEquals(
      await Deno.readTextFile(`${fixture.root}/${backups[0]}/sentinel`),
      "original",
    );
    assert(await pathExists(`${output}/optctl`));
    assert(!(await pathExists(`${output}/sentinel`)));
    assertEquals(
      (await directoryNames(output)).filter((name) =>
        name.includes(".artifacts.backup.")
      ),
      [],
    );
    assertStringIncludes(stderr, `${fixture.root}/${backups[0]}`);
  } finally {
    await removeFixture(fixture);
  }
});

Deno.test("image cleanup never dereferences a drifted mutable tag", async () => {
  const fixture = await createFixture();
  try {
    const result = await runGate(fixture, { FAKE_TEST_MODE: "image-retag" });
    assert(result.code !== 0);
    assertStringIncludes(
      result.stderr,
      "mutable convenience tag drifted from the frozen image ID",
    );
    const docker = await readLog(fixture, "docker.log");
    assert(!docker.includes("image rm -- optd:"), docker);
    assert(!docker.includes("image rm --force -- optd:"), docker);
    assert(!docker.includes(`image rm --no-prune -- ${imageId}`), docker);
    assertEquals((await resourceIds(fixture, "images")).length, 18);
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
        OPTD_CONTAINER_SKIP_BUILD: "1",
        OPTD_CONTAINER_IMAGE: "optd:mutable",
        OPTD_CONTAINER_IMAGE_ID: imageId,
        OPTD_CONTAINER_REVISION: fixture.revision,
        OPTD_CONTAINER_VERSION: `release-gate-${fixture.revision.slice(0, 12)}`,
        OPTD_RELEASE_GATE_ID: "b".repeat(32),
        OPTD_RELEASE_GATE_REGISTRY: fixture.registry,
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
      `container create --label dev.optd.release-gate=${
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
  retainedEvidence: string[];
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
  // Retain historical transcript/parser adversaries without offering a legacy
  // production switch. BuildKit authority is exercised independently by the
  // exact-image tests; this fixture's fake daemon emits legacy Step frames.
  const gate = await Deno.readTextFile("scripts/release-gate.sh");
  await Deno.writeTextFile(
    `${root}/scripts/release-gate.sh`,
    gate.replace(
      /# The approved existing Docker driver[\s\S]*?(?=printf 'COMMAND: docker buildx)/,
      "",
    ).replace(
      /docker buildx build --builder default --load --pull=false --no-cache \\\n {2}--iidfile[^\n]*\\\n/,
      "docker build --pull=false --no-cache \\\n",
    ),
  );
  await Deno.copyFile(
    "scripts/release-artifacts.sh",
    `${root}/scripts/release-artifacts.sh`,
  );
  await Deno.copyFile(
    "scripts/release-owned-supervisor.py",
    `${root}/scripts/release-owned-supervisor.py`,
  );
  await Deno.copyFile(
    "scripts/release-pidfd-signal.py",
    `${root}/scripts/release-pidfd-signal.py`,
  );
  await Deno.copyFile(
    "scripts/release-image-accounting.py",
    `${root}/scripts/release-image-accounting.py`,
  );
  await Deno.copyFile(
    "compose.external-postgres.yml",
    `${root}/compose.external-postgres.yml`,
  );
  await Deno.chmod(`${root}/scripts/release-gate.sh`, 0o755);
  await Deno.chmod(`${root}/scripts/release-artifacts.sh`, 0o755);
  await Deno.chmod(`${root}/scripts/release-owned-supervisor.py`, 0o755);
  await Deno.chmod(`${root}/scripts/release-pidfd-signal.py`, 0o755);
  await Deno.chmod(`${root}/scripts/release-image-accounting.py`, 0o755);
  for (const file of ["LICENSE", "NOTICE"]) {
    await Deno.copyFile(file, `${root}/${file}`);
  }
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
  await Deno.writeTextFile(
    `${root}/Dockerfile`,
    Array.from({ length: 17 }, (_, index) => `RUN fixture-${index + 1}\n`).join(
      "",
    ),
  );
  for (const file of ["docker-compose.yml", "docs/runtime.md"]) {
    await Deno.writeTextFile(`${root}/${file}`, "release contract\n");
  }
  await command(["git", "add", "--all"], root);
  await command(
    ["git", "commit", "--quiet", "-m", "test: release fixture"],
    root,
  );
  const revision = (await command(["git", "rev-parse", "HEAD"], root)).stdout
    .trim();

  await executable(`${bin}/deno`, fakeDeno());
  await executable(`${bin}/docker`, fakeDocker());
  return {
    home,
    root,
    bin,
    state,
    registry,
    base,
    revision,
    retainedEvidence: [],
  };
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
      printf 'label=other\\nname=optd-cr-unrelated\\n' >"$FAKE_STATE/containers/unrelated-prefix"
      ;;
    owned-labels)
      printf 'label=%s\\nname=owned-container\\n' "$OPTD_RELEASE_GATE_ID" >"$FAKE_STATE/containers/owned-container"
      printf 'label=%s\\nname=owned-volume\\n' "$OPTD_RELEASE_GATE_ID" >"$FAKE_STATE/volumes/owned-volume"
      printf 'label=%s\\nname=owned-network\\n' "$OPTD_RELEASE_GATE_ID" >"$FAKE_STATE/networks/owned-network"
      ;;
    missing-baseline)
      rm -f -- "$FAKE_STATE/containers/baseline-container"
      exit 37
      ;;
    source-mutation)
      printf '// mutated\\n' >>"$OPTD_RELEASE_SOURCE_ROOT/tests/ordinary.ts"
      ;;
    staged-source-mutation)
      printf '// staged mutation\\n' >>"$OPTD_RELEASE_SOURCE_ROOT/tests/ordinary.ts"
      printf 'staged extra\\n' >"$OPTD_RELEASE_SOURCE_ROOT/tests/staged-extra.ts"
      git -C "$OPTD_RELEASE_SOURCE_ROOT" add -- tests/ordinary.ts tests/staged-extra.ts
      ;;
    image-retag)
      : >"$FAKE_STATE/retag"
      ;;
    unexpected-tag)
      intermediate="sha256:$(printf '%012x' 1)$(printf '0%.0s' {1..52})"
      sed -i 's/^tags=.*/tags=unexpected:latest/' "$FAKE_STATE/images/$intermediate"
      ;;
    unexpected-digest)
      intermediate="sha256:$(printf '%012x' 1)$(printf '0%.0s' {1..52})"
      sed -i 's/^digests=.*/digests=unexpected@example/' "$FAKE_STATE/images/$intermediate"
      ;;
    unexpected-child)
      child=$(<"$FAKE_STATE/base-child")
      sed -i "s|^parent=.*|parent=$FAKE_IMAGE_ID|" "$FAKE_STATE/images/$child"
      ;;
    unexpected-ref)
      printf 'label=other\\nname=unexpected-ref\\nimage=%s\\n' "$FAKE_IMAGE_ID" >"$FAKE_STATE/containers/unexpected-ref"
      ;;
    authority-symlink-0666)
      mv -- "$OPTD_RELEASE_GATE_REGISTRY/image-authority.json" "$FAKE_STATE/outside-authority.json"
      chmod 0666 -- "$FAKE_STATE/outside-authority.json"
      ln -s -- "$FAKE_STATE/outside-authority.json" "$OPTD_RELEASE_GATE_REGISTRY/image-authority.json"
      ;;
    pid-mismatch)
      setsid sleep 120 >/dev/null 2>&1 & pid=$!
      printf '%s\\n' "$pid" >"$FAKE_STATE/mismatch-pid"
      python3 - "$pid" "$OPTD_RELEASE_GATE_REGISTRY/pids/$pid.json" "$OPTD_RELEASE_GATE_ID" "$(dirname "$OPTD_RELEASE_GATE_REGISTRY")" <<'PY'
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
  kind=$1; filter="\${2:-}"; project="\${3:-}"
  shopt -s nullglob
  for file in "$FAKE_STATE/$kind"/*; do
    if [[ -n "$filter" && "$(value label "$file")" != "$filter" ]]; then continue; fi
    if [[ -n "$project" && "$(value project "$file")" != "$project" ]]; then continue; fi
    basename -- "$file"
  done | LC_ALL=C sort
}
filter_value() {
  key=$1; shift
  for arg in "$@"; do
    [[ "$arg" != "label=$key="* ]] || { printf '%s' "\${arg#label=$key=}"; return; }
    [[ "$arg" != "$key="* ]] || { printf '%s' "\${arg#$key=}"; return; }
  done
}
arg_after() { target=$1; shift; while (($#)); do [[ "$1" == "$target" ]] && { printf '%s' "$2"; return; }; shift; done; }
last_arg() { printf '%s' "\${!#}"; }
case "\${1:-} \${2:-}" in
  "image ls")
    filter=$(filter_value dev.optd.release-gate "$@"); project=$(filter_value com.docker.compose.project "$@")
    list_kind images "$filter" "$project" ;;
  "container ls")
    filter=$(filter_value dev.optd.release-gate "$@"); project=$(filter_value com.docker.compose.project "$@")
    ancestor=$(filter_value ancestor "$@")
    if [[ -n "$ancestor" ]]; then
      shopt -s nullglob
      for file in "$FAKE_STATE/containers"/*; do [[ "$(value image "$file")" != "$ancestor" ]] || basename -- "$file"; done | LC_ALL=C sort
      case "\${FAKE_TEST_MODE:-}" in
        action-tag-race|action-parent-race|action-ref-race|action-disappearance-race)
          count=0; [[ ! -e "$FAKE_STATE/cleanup-ref-count" ]] || count=$(<"$FAKE_STATE/cleanup-ref-count")
          count=$((count+1)); printf '%s\\n' "$count" >"$FAKE_STATE/cleanup-ref-count"
          if [[ "$count" == 1 ]]; then
            victim="sha256:$(printf '%012x' 1)$(printf '0%.0s' {1..52})"
            case "$FAKE_TEST_MODE" in
              action-tag-race) sed -i 's/^tags=.*/tags=concurrent:latest/' "$FAKE_STATE/images/$victim" ;;
              action-parent-race) sed -i 's/^parent=.*/parent=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/' "$FAKE_STATE/images/$victim" ;;
              action-ref-race) printf 'label=other\\nname=race-ref\\nimage=%s\\n' "$victim" >"$FAKE_STATE/containers/race-ref" ;;
              action-disappearance-race) rm -f -- "$FAKE_STATE/images/$victim" ;;
            esac
          fi
          ;;
      esac
    else
      list_kind containers "$filter" "$project"
    fi ;;
  "volume ls")
    filter=$(filter_value dev.optd.release-gate "$@"); project=$(filter_value com.docker.compose.project "$@")
    list_kind volumes "$filter" "$project" ;;
  "network ls")
    filter=$(filter_value dev.optd.release-gate "$@"); project=$(filter_value com.docker.compose.project "$@")
    list_kind networks "$filter" "$project" ;;
  "build --pull=false")
    count=$(<"$FAKE_STATE/build-count"); printf '%s\\n' "$((count+1))" >"$FAKE_STATE/build-count"
    if [[ "\${FAKE_TEST_MODE:-}" == build-signal-child-zero ]]; then trap 'exit 0' TERM; fi
    tag=$(arg_after --tag "$@")
    parent=""
    if [[ -s "$FAKE_STATE/base-image" ]]; then
      parent=$(<"$FAKE_STATE/base-image")
    fi
    for number in $(seq 1 17); do
      identity="sha256:$(printf '%012x' "$number")$(printf '0%.0s' {1..52})"
      created=$(date --iso-8601=ns)
      printf 'Step %s/18 : RUN fixture-%s\\n' "$number" "$number"
      case "\${FAKE_TEST_MODE:-}" in
        build-failure-incomplete)
          [[ "$number" != 2 ]] || exit 37
          ;;
        build-signal-incomplete)
          if [[ "$number" == 2 ]]; then
            : >"$FAKE_STATE/build-signal-ready"
            sleep 120
          fi
          ;;
        build-success-incomplete)
          [[ "$number" != 2 ]] || exit 0
          ;;
        incomplete-then-spoof-result)
          if [[ "$number" == 2 ]]; then
            printf 'Step 3/18 : RUN fixture-3\\n'
            printf ' ---> dddddddddddd\\n'
            exit 37
          fi
          ;;
        multiple-incomplete)
          if [[ "$number" == 1 ]]; then
            printf 'Step 2/18 : RUN fixture-2\\n'
            exit 37
          fi
          ;;
        nonfinal-incomplete)
          if [[ "$number" == 1 ]]; then
            printf 'Step 2/18 : RUN fixture-2\\n'
            printf ' ---> dddddddddddd\\n'
            exit 37
          fi
          ;;
        incomplete-unknown-delta)
          if [[ "$number" == 2 ]]; then
            printf 'label=\\nname=%s\\nparent=%s\\ncreated=%s\\ncreated_by=/bin/sh -c fixture-%s\\ntags=\\ndigests=\\n' "$identity" "$parent" "$created" "$number" >"$FAKE_STATE/images/$identity"
            exit 37
          fi
          ;;
      esac
      printf 'label=\\nname=%s\\nparent=%s\\ncreated=%s\\ncreated_by=/bin/sh -c fixture-%s\\ntags=\\ndigests=\\n' "$identity" "$parent" "$created" "$number" >"$FAKE_STATE/images/$identity"
      printf ' ---> %s\\n' "\${identity:7:12}"
      parent=$identity
      if [[ "\${FAKE_TEST_MODE:-}" == build-signal* && "$number" == 5 ]]; then
        : >"$FAKE_STATE/build-signal-ready"
        sleep 120
      fi
    done
    if [[ "\${FAKE_TEST_MODE:-}" == build-failure ]]; then exit 37; fi
    created=$(date --iso-8601=ns)
    printf 'Step 18/18 : LABEL dev.optd.release-gate=%s\\n' "$OPTD_RELEASE_GATE_ID"
    printf 'label=%s\\nname=%s\\nparent=%s\\ncreated=%s\\ncreated_by=/bin/sh -c #(nop) LABEL dev.optd.release-gate=%s\\ntags=%s\\ndigests=\\n' "$OPTD_RELEASE_GATE_ID" "$tag" "$parent" "$created" "$OPTD_RELEASE_GATE_ID" "$tag" >"$FAKE_STATE/images/$FAKE_IMAGE_ID"
    if [[ "\${FAKE_TEST_MODE:-}" == concurrent-result-spoof ]]; then
      concurrent="sha256:$(printf 'd%.0s' {1..64})"
      printf 'label=other\\nname=concurrent\\nparent=\\ncreated=%s\\ncreated_by=/bin/sh -c unrelated\\ntags=\\ndigests=\\n' "$(date --iso-8601=ns)" >"$FAKE_STATE/images/$concurrent"
      printf ' ---> %s\\n' "\${concurrent:7:12}"
    elif [[ "\${FAKE_TEST_MODE:-}" == step-line-spoof ]]; then
      printf 'Step 18/18 : LABEL dev.optd.release-gate=%s\\n' "$OPTD_RELEASE_GATE_ID"
    elif [[ "\${FAKE_TEST_MODE:-}" == success-line-spoof ]]; then
      printf 'Successfully built dddddddddddd\\n'
    fi
    printf ' ---> %s\\nSuccessfully built %s\\nSuccessfully tagged %s\\n' "\${FAKE_IMAGE_ID:7:12}" "\${FAKE_IMAGE_ID:7:12}" "$tag"
    printf '%s\\n' "$FAKE_IMAGE_ID" >"$FAKE_STATE/tag-image"
    if [[ "\${FAKE_TEST_MODE:-}" == unknown-delta ]]; then
      unknown="sha256:$(printf 'e%.0s' {1..64})"
      printf 'label=other\\nname=unknown\\nparent=\\ncreated=%s\\ntags=\\ndigests=\\n' "$(date --iso-8601=ns)" >"$FAKE_STATE/images/$unknown"
    elif [[ "\${FAKE_TEST_MODE:-}" == ambiguous-short ]]; then
      one="sha256:deadbeefcafe$(printf '1%.0s' {1..52})"
      two="sha256:deadbeefcafe$(printf '2%.0s' {1..52})"
      for identity in "$one" "$two"; do
        printf 'label=other\\nname=spoof\\nparent=\\ncreated=%s\\ntags=\\ndigests=\\n' "$(date --iso-8601=ns)" >"$FAKE_STATE/images/$identity"
      done
      printf ' ---> deadbeefcafe\\n'
    elif [[ "\${FAKE_TEST_MODE:-}" == transcript-spoof ]]; then
      printf ' ---> ffffffffffff\\n'
    fi
    ;;
  "image inspect")
    identity=$3; [[ "$identity" != optd:* ]] || identity=$(<"$FAKE_STATE/tag-image")
    if [[ -e "$FAKE_STATE/retag" && "$3" == optd:* ]]; then identity="sha256:$(printf 'b%.0s' {1..64})"; fi
    file="$FAKE_STATE/images/$identity"
    [[ -e "$file" ]] || exit 1
    if [[ "$*" != *" --format "* ]]; then
      python3 - "$identity" "$file" <<'PY'
import json, pathlib, sys
identity, path = sys.argv[1:]
values = {}
for line in pathlib.Path(path).read_text().splitlines():
    key, _, value = line.partition('=')
    values[key] = value
labels = {'dev.optd.release-gate': values['label']} if values.get('label') else None
print(json.dumps([{
    'Id': identity,
    'Parent': values.get('parent', ''),
    'Created': values.get('created', ''),
    'RepoTags': [values['tags']] if values.get('tags') else None,
    'RepoDigests': [values['digests']] if values.get('digests') else None,
    'Config': {'Labels': labels},
}]))
PY
      exit
    fi
    format=$(last_arg "$@")
    case "$format" in
      *'.Id}} {{index .Config.Labels'*) printf '%s %s release-gate-%s\\n' "$identity" "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
      *org.opencontainers.image.revision*) printf '%s\\n' "$FAKE_REVISION" ;;
      *org.opencontainers.image.version*) printf 'release-gate-%s\\n' "\${FAKE_REVISION:0:12}" ;;
      *org.opencontainers.image.licenses*) printf 'Apache-2.0\\n' ;;
      *org.opencontainers.image.source*) printf 'https://github.com/optd-ai/optd\\n' ;;
      *dev.optd.release-gate*) value label "$file" ;;
      *json*.Config.Labels*) printf '{"org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"release-gate-%s"}\\n' "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
      *RepoDigests*) printf 'optd@example-digest\\n' ;;
      *'{{.Id}}'*) printf '%s\\n' "$identity" ;;
      *) printf '%s %s release-gate-%s\\n' "$identity" "$FAKE_REVISION" "\${FAKE_REVISION:0:12}" ;;
    esac ;;
  "image history")
    identity=$(last_arg "$@")
    if [[ "$*" == *"--format"* ]]; then
      python3 - "$identity" "$FAKE_STATE/images/$identity" <<'PY'
import json, pathlib, sys
identity, path = sys.argv[1:]
values = {}
for line in pathlib.Path(path).read_text().splitlines():
    key, _, value = line.partition('=')
    values[key] = value
print(json.dumps({'ID': identity, 'CreatedBy': values.get('created_by', '')}))
PY
    else
      while [[ -n "$identity" ]]; do
        printf '%s\\n' "$identity"
        identity=$(value parent "$FAKE_STATE/images/$identity")
      done
    fi ;;
  "image rm")
    identity=$(last_arg "$@"); [[ "$identity" != optd:* ]] || identity=$(<"$FAKE_STATE/tag-image")
    if [[ "\${FAKE_TEST_MODE:-}" == removal-failure && ! -e "$FAKE_STATE/removal-failed" ]]; then : >"$FAKE_STATE/removal-failed"; exit 73; fi
    rm -f -- "$FAKE_STATE/images/$identity"
    [[ ! -e "$FAKE_STATE/tag-image" || "$(<"$FAKE_STATE/tag-image")" != "$identity" ]] || rm -f -- "$FAKE_STATE/tag-image" ;;
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
      *'{{json .Config.Labels}}'*) printf '{"dev.optd.release-gate":"%s","com.docker.compose.project":"%s"}\\n' "$(value label "$file")" "$(value project "$file")" ;;
      *dev.optd.release-gate*) value label "$file" ;;
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
    format=$(last_arg "$@"); [[ "$format" != *'{{json .Labels}}'* ]] || { printf '{"dev.optd.release-gate":"%s","com.docker.compose.project":"%s"}\\n' "$(value label "$file")" "$(value project "$file")"; exit; }; [[ "$format" != *dev.optd.release-gate* ]] || { value label "$file"; exit; }; printf '%s\\n' "$identity" ;;
  "volume rm") identity=$(last_arg "$@"); rm -f -- "$FAKE_STATE/volumes/$identity" ;;
  "network inspect")
    identity=$3; file="$FAKE_STATE/networks/$identity"; [[ -e "$file" ]] || exit 1
    format=$(last_arg "$@"); [[ "$format" != *'{{json .Labels}}'* ]] || { printf '{"dev.optd.release-gate":"%s","com.docker.compose.project":"%s"}\\n' "$(value label "$file")" "$(value project "$file")"; exit; }; [[ "$format" != *dev.optd.release-gate* ]] || { value label "$file"; exit; }; printf '%s\\n' "$identity" ;;
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
  const result = await run(
    fixture,
    ["bash", "scripts/release-gate.sh"],
    extraEnv,
  );
  for (
    const match of result.stderr.matchAll(
      /retained release-gate evidence after cleanup failure: (\/tmp\/optd-release-gate-[^\s]+)/g,
    )
  ) {
    fixture.retainedEvidence.push(match[1]);
  }
  return result;
}

async function runPidfdAdversary(
  signalName: "CONT" | "TERM" | "KILL",
  mode: "mismatch" | "reuse" | "inspect-failure",
) {
  const helper = new URL(
    "../../../scripts/release-pidfd-signal.py",
    import.meta.url,
  ).pathname;
  const source = String.raw`
import importlib.util, json, os, pathlib, signal, sys, tempfile
sys.dont_write_bytecode = True
helper, signal_name, mode = sys.argv[1:]
spec = importlib.util.spec_from_file_location("release_pidfd_signal", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = pathlib.Path(tempfile.mkdtemp(prefix="pidfd-contract-"))
state = root / "state"
registry = state / "registry"
pids = registry / "pids"
pids.mkdir(parents=True)
for directory in (state, registry, pids):
    directory.chmod(0o700)
proc = root / "proc"
(proc / "sys/kernel/random").mkdir(parents=True)
(proc / "sys/kernel/random/boot_id").write_text("boot-contract\n")

def write_process(pid, ppid, ticks, run=False):
    directory = proc / str(pid)
    directory.mkdir(exist_ok=True)
    fields = ["S", str(ppid)] + ["0"] * 17 + [str(ticks)] + ["0"] * 5
    (directory / "stat").write_text(f"{pid} (contract) " + " ".join(fields) + "\n")
    uid = str(os.geteuid())
    (directory / "status").write_text(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
    (directory / "cmdline").write_bytes(b"worker\0" + (b"r" * 32 if run else b""))
    os.symlink("/bin/worker", directory / "exe")
    os.symlink(state, directory / "cwd")

write_process(1, 0, 100)
write_process(42, 1, 200, True)
identity = module.process_identity(proc, 42)
record = {
    **identity,
    "boot_id": "boot-contract",
    "run_id": "r" * 32,
    "data_dir": str(state),
}
if mode == "mismatch":
    record["start_ticks"] = "199"
record_path = pids / "42.json"
record_path.write_text(json.dumps(record) + "\n")
record_path.chmod(0o600)
sent = []

def fake_open(pid, flags):
    assert pid == 42 and flags == 0
    return os.open("/dev/null", os.O_RDONLY)

def mutate_after_open():
    if mode == "reuse":
        fields = ["S", "1"] + ["0"] * 17 + ["999"] + ["0"] * 5
        (proc / "42/stat").write_text("42 (reused) " + " ".join(fields) + "\n")
    elif mode == "inspect-failure":
        (proc / "42/status").unlink()

def fake_send(pidfd, number):
    sent.append((pidfd, number))

try:
    module.signal_registered_process(
        record_path,
        state,
        registry,
        "r" * 32,
        getattr(signal, "SIG" + signal_name),
        proc_root=proc,
        pidfd_open=fake_open,
        pidfd_send_signal=fake_send,
        before_revalidate=mutate_after_open,
    )
except module.IdentityError:
    pass
else:
    raise SystemExit("unsafe signal was accepted")
if sent:
    raise SystemExit(f"unsafe signal callback: {sent!r}")
print("blocked-without-signal")
`;
  const output = await new Deno.Command("python3", {
    args: ["-c", source, helper, signalName, mode],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function runPidfdManifestAdversaries() {
  const helper = new URL(
    "../../../scripts/release-pidfd-signal.py",
    import.meta.url,
  ).pathname;
  const source = String.raw`
import importlib.util, json, os, pathlib, signal, sys, tempfile
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release_pidfd_signal", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
run_id = "r" * 32
completed = []

def fixture():
    root = pathlib.Path(tempfile.mkdtemp(prefix="pidfd-manifest-contract-"))
    state = root / "state"
    registry = state / "registry"
    pids = registry / "pids"
    pids.mkdir(parents=True)
    for directory in (state, registry, pids):
        directory.chmod(0o700)
    proc = root / "proc"
    (proc / "sys/kernel/random").mkdir(parents=True)
    (proc / "sys/kernel/random/boot_id").write_text("boot-contract\n")
    for pid, ppid, ticks, has_run in ((1, 0, 100, False), (42, 1, 200, True)):
        directory = proc / str(pid)
        directory.mkdir()
        fields = ["S", str(ppid)] + ["0"] * 17 + [str(ticks)] + ["0"] * 5
        (directory / "stat").write_text(f"{pid} (contract) " + " ".join(fields) + "\n")
        uid = str(os.geteuid())
        (directory / "status").write_text(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
        (directory / "cmdline").write_bytes(b"worker\0" + (run_id.encode() if has_run else b""))
        os.symlink("/bin/worker", directory / "exe")
        os.symlink(state, directory / "cwd")
    record = {
        **module.process_identity(proc, 42),
        "boot_id": "boot-contract",
        "run_id": run_id,
        "data_dir": str(state),
    }
    record_path = pids / "42.json"
    record_path.write_text(json.dumps(record) + "\n")
    record_path.chmod(0o600)
    return root, state, registry, pids, proc, record, record_path

def reject(name, mutate, replace_after_open=False):
    root, state, registry, pids, proc, record, record_path = fixture()
    record_path, state, registry = mutate(
        root, state, registry, pids, record, record_path
    )
    sent = []
    opened = []
    def fake_open(pid, flags):
        opened.append(pid)
        return os.open("/dev/null", os.O_RDONLY)
    def fake_send(pidfd, number):
        sent.append((pidfd, number))
    def replace():
        old = record_path.with_suffix(".old")
        record_path.rename(old)
        record_path.write_text(json.dumps(record) + "\n")
        record_path.chmod(0o600)
    try:
        module.signal_registered_process(
            record_path,
            state,
            registry,
            run_id,
            signal.SIGTERM,
            proc_root=proc,
            pidfd_open=fake_open,
            pidfd_send_signal=fake_send,
            before_revalidate=replace if replace_after_open else None,
        )
    except module.IdentityError:
        pass
    else:
        raise SystemExit(f"{name}: unsafe manifest was accepted")
    if sent:
        raise SystemExit(f"{name}: unsafe signal callback reached: {sent!r}")
    if replace_after_open and opened != [42]:
        raise SystemExit(f"{name}: replacement adversary did not run after pidfd_open")
    if not replace_after_open and opened:
        raise SystemExit(f"{name}: pidfd_open ran before manifest validation")
    completed.append(name)

def unchanged(root, state, registry, pids, record, record_path):
    return record_path, state, registry

def mode(value):
    def mutate(root, state, registry, pids, record, record_path):
        record_path.chmod(value)
        return record_path, state, registry
    return mutate

reject("mode-0666", mode(0o666))
reject("mode-0640", mode(0o640))

def final_symlink(root, state, registry, pids, record, record_path):
    target = root / "outside.json"
    target.write_text(json.dumps(record) + "\n")
    target.chmod(0o600)
    record_path.unlink()
    record_path.symlink_to(target)
    return record_path, state, registry
reject("symlink-final", final_symlink)

def parent_symlink(root, state, registry, pids, record, record_path):
    real = state / "real-registry"
    registry.rename(real)
    registry.symlink_to(real, target_is_directory=True)
    return registry / "pids" / "42.json", state, registry
reject("symlink-parent", parent_symlink)

def state_symlink(root, state, registry, pids, record, record_path):
    alias = root / "state-alias"
    alias.symlink_to(state, target_is_directory=True)
    return alias / "registry" / "pids" / "42.json", alias, alias / "registry"
reject("symlink-state-root", state_symlink)

def hardlink(root, state, registry, pids, record, record_path):
    os.link(record_path, pids / "second-link.json")
    return record_path, state, registry
reject("hardlink", hardlink)

def outside(root, state, registry, pids, record, record_path):
    path = root / "42.json"
    path.write_text(json.dumps(record) + "\n")
    path.chmod(0o600)
    return path, state, registry
reject("outside-registry", outside)

def directory(root, state, registry, pids, record, record_path):
    record_path.unlink()
    record_path.mkdir(mode=0o700)
    return record_path, state, registry
reject("directory", directory)

def fifo(root, state, registry, pids, record, record_path):
    record_path.unlink()
    os.mkfifo(record_path, 0o600)
    record_path.chmod(0o600)
    return record_path, state, registry
reject("fifo", fifo)

def state_mode(root, state, registry, pids, record, record_path):
    state.chmod(0o755)
    return record_path, state, registry
reject("unsafe-state-mode", state_mode)

def registry_mode(root, state, registry, pids, record, record_path):
    registry.chmod(0o755)
    return record_path, state, registry
reject("unsafe-registry-mode", registry_mode)

def pids_mode(root, state, registry, pids, record, record_path):
    pids.chmod(0o755)
    return record_path, state, registry
reject("unsafe-pids-mode", pids_mode)
reject("rename-replacement", unchanged, replace_after_open=True)
if os.geteuid() == 0:
    def wrong_owner(root, state, registry, pids, record, record_path):
        os.chown(record_path, 1, -1)
        return record_path, state, registry
    reject("wrong-owner", wrong_owner)
else:
    completed.append("wrong-owner-skipped-unprivileged")
print("blocked-manifest-adversaries=" + ",".join(completed))
`;
  const output = await new Deno.Command("python3", {
    args: ["-c", source, helper],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function runHarnessEval(
  fixture: Fixture,
  source: string,
  extraEnv: Record<string, string> = {},
) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["eval", source],
    cwd: fixture.root,
    env: fixtureEnv(fixture, extraEnv),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
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
    { OPTD_CONTAINER_IMAGE_ID: image, ...extraEnv },
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
    OPTD_RELEASE_BASE: fixture.base,
    // Controlled fixtures are subprocesses, not recursive executions of the
    // parent gate. Never let its ownership or immutable-source context bleed
    // into their isolated fake registries and repositories.
    OPTD_RELEASE_GATE_ACTIVE: "0",
    OPTD_RELEASE_GATE_ID: "",
    OPTD_RELEASE_GATE_REGISTRY: "",
    OPTD_RELEASE_SOURCE_REVISION: "",
    OPTD_RELEASE_SOURCE_ROOT: "",
    OPTD_CONTAINER_IMAGE: "",
    OPTD_CONTAINER_IMAGE_TAG: "",
    OPTD_CONTAINER_IMAGE_ID: "",
    OPTD_CONTAINER_REVISION: "",
    OPTD_CONTAINER_VERSION: "",
    OPTD_CONTAINER_SKIP_BUILD: "",
    ...extraEnv,
  };
}

async function seedImage(fixture: Fixture): Promise<void> {
  await seedResource(fixture, "images", imageId, "standalone");
  await Deno.writeTextFile(`${fixture.state}/tag-image`, `${imageId}\n`);
}

async function seedImageMetadata(
  fixture: Fixture,
  identity: string,
): Promise<void> {
  await Deno.writeTextFile(
    `${fixture.state}/images/${identity}`,
    `label=other\nname=${identity}\nparent=\ncreated=2020-01-01T00:00:00Z\ntags=\ndigests=\n`,
  );
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
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
  for (const path of fixture.retainedEvidence) {
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
  }
  await Deno.remove(fixture.home, { recursive: true }).catch(() => undefined);
}
