import { strict as assert } from "node:assert";
import {
  assertFresh,
  assertReadOnly,
  dnsServers,
  expectedChallenge,
  inventoryRefs,
  maxAgeMs,
  observeGithub,
  observeHistory,
  observeLocalIntegration,
  parseApi,
  type Runner,
  validateDns,
  validateGitEnvironment,
} from "../../scripts/optd-external-preflight.ts";

const safetyConfig = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "hook.pre-push.enabled",
  GIT_CONFIG_VALUE_2: "false",
};

Deno.test("Git environment admits only exact indexed safety disables", () => {
  validateGitEnvironment({});
  validateGitEnvironment({ GIT_CONFIG_COUNT: "0" });
  validateGitEnvironment(safetyConfig);
  const patches: Record<string, string>[] = [
    ...[
      "",
      "-1",
      "03",
      "+3",
      "3.0",
      "3\n",
      "1e0",
      "9007199254740992",
      "2",
      "4",
    ].map(
      (GIT_CONFIG_COUNT) => ({ GIT_CONFIG_COUNT }),
    ),
    { GIT_CONFIG_KEY_3: "core.hooksPath", GIT_CONFIG_VALUE_3: "/dev/null" },
    { GIT_CONFIG_KEY_01: "core.fsmonitor" },
    { GIT_CONFIG_VALUE_bad: "false" },
    { GIT_CONFIG_KEY_2: "core.fsmonitor" },
    { GIT_CONFIG_KEY_2: "hook..enabled" },
    { GIT_CONFIG_KEY_2: "hook.pre-push.command" },
    { GIT_CONFIG_KEY_2: "hook.pre-push.enabled\ninclude.path" },
    { GIT_CONFIG_KEY_2: "include.path", GIT_CONFIG_VALUE_2: "/tmp/unsafe" },
    { GIT_CONFIG_KEY_2: "core.alternateRefsCommand" },
    { GIT_CONFIG_KEY_2: "remote.origin.promisor" },
    { GIT_CONFIG_KEY_2: "core.repositoryFormatVersion" },
    { GIT_CONFIG_KEY_2: "Core.fsmonitor" },
    { GIT_CONFIG_VALUE_0: "/tmp/hooks" },
    { GIT_CONFIG_VALUE_1: "true" },
    { GIT_CONFIG_VALUE_2: "0" },
    { GIT_CONFIG_VALUE_2: "False" },
  ];
  for (const patch of patches) {
    assert.throws(
      () => validateGitEnvironment({ ...safetyConfig, ...patch }),
      /git-environment-override/,
    );
  }
  for (const key of Object.keys(safetyConfig)) {
    const missing: Record<string, string> = { ...safetyConfig };
    delete missing[key];
    assert.throws(
      () => validateGitEnvironment(missing),
      /git-environment-override/,
    );
  }
  for (
    const key of [
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_SHALLOW_FILE",
      "GIT_INDEX_FILE",
      "GIT_REPLACE_REF_BASE",
      "GIT_GRAFT_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]
  ) {
    for (const value of ["", "/tmp/override"]) {
      assert.throws(
        () => validateGitEnvironment({ ...safetyConfig, [key]: value }),
        /git-environment-override/,
      );
    }
  }
});

const challenge = "pi-dag-workflow=b1c0895ca2a37f9b592044e84c7e75ad";
const dns = (flags = "qr aa", value = challenge) =>
  `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 123\n;; flags: ${flags}; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0\n_optd-control.optd.dev. 60 IN TXT "${value}"\n`;

Deno.test("DNS requires the exact single live TXT and correct server role", () => {
  validateDns(dns(), challenge, true);
  validateDns(dns("qr rd ra"), challenge, false);
  for (
    const text of [
      dns("qr"),
      dns("qr aa tc"),
      dns("qr aa cd"),
      dns("qr aa", "pi-dag-workflow=obsolete"),
      dns().replace("NOERROR", "SERVFAIL"),
      dns().replace("NOERROR", "NXDOMAIN"),
      dns().replace(" 60 ", " 0 "),
      dns().replace("_optd-control.optd.dev.", "attacker.example."),
      dns().replace('"\n', '" "other"\n'),
      dns() + '_optd-control.optd.dev. 60 IN TXT "other"\n',
      dns() + "_optd-control.optd.dev. 60 IN CNAME attacker.example.\n",
      dns() + dns(),
      "",
      '"' + challenge + '"',
    ]
  ) assert.throws(() => validateDns(text, challenge, true));
  assert.throws(() => validateDns(dns(), challenge, false));
  assert.throws(() => validateDns(dns("qr rd ra"), challenge, true));
});

Deno.test("signed TXT permits only its RRSIG and requires validating resolver AD", () => {
  const signature =
    "_optd-control.optd.dev. 300 IN RRSIG TXT 13 3 300 20261003143202 20261001123202 34505 optd.dev. YWJj ZA==\n";
  validateDns(dns() + signature, challenge, true);
  validateDns(dns("qr rd ra ad") + signature, challenge, false);
  assert.throws(() =>
    validateDns(dns("qr rd ra") + signature, challenge, false)
  );
  assert.throws(() =>
    validateDns(
      dns() + signature.replace("RRSIG TXT", "RRSIG CNAME"),
      challenge,
      true,
    )
  );
  assert.throws(() =>
    validateDns(
      dns() + signature.replace("_optd-control.optd.dev.", "other.optd.dev."),
      challenge,
      true,
    )
  );
});

Deno.test("freshness rejects stale, future, nonfinite and replayed observations", () => {
  assertFresh(100, 200, 300);
  for (
    const times of [
      [100, 200, maxAgeMs + 101],
      [200, 100, 300],
      [100, 400, 300],
      [NaN, 200, 300],
      [100, Infinity, 300],
      [100, 200, Infinity],
    ]
  ) assert.throws(() => assertFresh(times[0], times[1], times[2]));
});

Deno.test("challenge is read from unambiguous current model, never historical receipt", () => {
  const records = ["DEC-optd-api-namespace", "EV-optd-domain-control-txt"].map((
    id,
  ) => ({ id, body: challenge }));
  assert.equal(expectedChallenge({ records }), challenge);
  for (
    const model of [
      {},
      { records: records.slice(1) },
      { records: [...records, records[0]] },
      {
        records: [records[0], {
          ...records[1],
          body: "pi-dag-workflow=00000000000000000000000000000000",
        }],
      },
      {
        records: [records[0], {
          ...records[1],
          body: challenge + " " + challenge,
        }],
      },
    ]
  ) assert.throws(() => expectedChallenge(model));
});

Deno.test("command boundary denies mutation, credentials, arbitrary services and argument injection", () => {
  for (
    const args of [
      ["push"],
      ["fetch"],
      ["tag", "v1"],
      ["remote", "add", "origin", "https://example.org"],
      ["config", "credential.helper", "x"],
      ["fsck", "--lost-found"],
      ["-c", "alias.x=!touch pwned", "x"],
      ["rev-parse", "HEAD", ";", "touch", "pwned"],
    ]
  ) assert.throws(() => assertReadOnly("git", args));
  for (
    const args of [
      ["repo", "create", "optd-ai/optd"],
      ["auth", "login"],
      ["auth", "token"],
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "--include",
        "/orgs/optd-ai/repos",
      ],
      [
        "api",
        "--hostname",
        "evil.example",
        "--method",
        "GET",
        "--include",
        "/orgs/optd-ai",
      ],
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        "/user/emails",
      ],
    ]
  ) assert.throws(() => assertReadOnly("gh", args));
  for (const command of ["bash", "curl", "docker", "nsupdate", "sudo"]) {
    assert.throws(() => assertReadOnly(command, []));
  }
  assertReadOnly("git", ["fsck", "--full", "--strict", "--no-reflogs"]);
  assertReadOnly("gh", [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "--include",
    "/orgs/optd-ai",
  ]);
  for (const server of dnsServers) {
    assertReadOnly("dig", [
      `@${server}`,
      "_optd-control.optd.dev.",
      "TXT",
      "+time=5",
      "+tries=1",
      "+dnssec",
      "+nocdflag",
      "+noall",
      "+comments",
      "+answer",
      server.endsWith("cloudflare.com") ? "+norecurse" : "+recurse",
    ]);
  }
});

Deno.test("private DAG refs are inventoried separately, never declared publishable", () => {
  const oid = "a".repeat(40);
  const refs = inventoryRefs(
    `refs/heads/master ${oid}\nrefs/heads/dag/old/work ${oid}\nrefs/pi-dag-v2/run/node/candidate ${oid}\nrefs/pi-dag/candidates/id ${oid}\n`,
  );
  assert.equal(refs.other.length, 1);
  assert.equal(refs.privateDag.length, 3);
  for (
    const text of [
      `refs/replace/${oid} ${oid}`,
      `refs/heads/master nope`,
      `refs/heads/master ${oid}\nrefs/heads/master ${oid}`,
    ]
  ) assert.throws(() => inventoryRefs(text));
});

const response = (body: unknown, status = 200) => ({
  code: status === 200 ? 0 : 1,
  stdout:
    `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\nX-OAuth-Scopes: repo, read:org\r\n\r\n${
      JSON.stringify(body)
    }`,
  stderr: "",
});
function github(
  overrides: Record<string, ReturnType<typeof response>> = {},
): Runner {
  return (command, args) => {
    assertReadOnly(command, args);
    const endpoint = args[6];
    const responses = {
      "/user": response({ login: "fixture", id: 1, type: "User" }),
      "/orgs/optd-ai": response({
        login: "optd-ai",
        public_repos: 0,
        total_private_repos: 0,
      }),
      "/user/memberships/orgs/optd-ai": response({
        state: "active",
        role: "admin",
        organization: { login: "optd-ai" },
        user: { login: "fixture", id: 1 },
      }),
      "/orgs/optd-ai/repos?type=all&per_page=100&page=1": response([]),
      "/repos/optd-ai/optd": response({ message: "Not Found" }, 404),
      ...overrides,
    };
    assert.ok(endpoint in responses, `unexpected endpoint ${endpoint}`);
    return Promise.resolve(responses[endpoint as keyof typeof responses]);
  };
}

Deno.test("GitHub requires active administration, full inventory and explicit absence", async () => {
  await observeGithub(github());
  const rejected: Record<string, ReturnType<typeof response>>[] = [
    { "/orgs/optd-ai": response({ login: "other" }) },
    { "/orgs/optd-ai": response({ message: "Not Found" }, 404) },
    {
      "/user/memberships/orgs/optd-ai": response({
        state: "pending",
        role: "admin",
        organization: { login: "optd-ai" },
        user: { login: "fixture", id: 1 },
      }),
    },
    {
      "/user/memberships/orgs/optd-ai": response({
        state: "active",
        role: "member",
        organization: { login: "optd-ai" },
        user: { login: "fixture", id: 1 },
      }),
    },
    {
      "/orgs/optd-ai/repos?type=all&per_page=100&page=1": response({
        message: "Forbidden",
      }, 403),
    },
    {
      "/orgs/optd-ai/repos?type=all&per_page=100&page=1": response([{
        full_name: "optd-ai/OPTD",
      }]),
    },
    {
      "/orgs/optd-ai/repos?type=all&per_page=100&page=1": response([{
        full_name: "another/repo",
      }]),
    },
    { "/repos/optd-ai/optd": response({ full_name: "optd-ai/optd" }) },
    { "/repos/optd-ai/optd": response({ message: "rate limited" }, 429) },
  ];
  for (const overrides of rejected) {
    await assert.rejects(() => observeGithub(github(overrides)));
  }
});

Deno.test("GitHub follows pages and rejects hidden destination or duplicate inventory", async () => {
  const first = Array.from(
    { length: 100 },
    (_, i) => ({
      full_name: `optd-ai/repo-${i}`,
      private: false,
      visibility: "public",
      owner: { login: "optd-ai" },
    }),
  );
  const page1 = "/orgs/optd-ai/repos?type=all&per_page=100&page=1";
  const page2 = "/orgs/optd-ai/repos?type=all&per_page=100&page=2";
  await observeGithub(
    github({
      "/orgs/optd-ai": response({
        login: "optd-ai",
        public_repos: 100,
        total_private_repos: 0,
      }),
      [page1]: response(first),
      [page2]: response([]),
    }),
  );
  for (const second of [[{ full_name: "optd-ai/optd" }], [first[0]]]) {
    await assert.rejects(() =>
      observeGithub(
        github({ [page1]: response(first), [page2]: response(second) }),
      )
    );
  }
});

Deno.test("missing API capability and malformed/error responses fail closed", () => {
  for (
    const result of [
      { code: 127, stdout: "", stderr: "secret credential diagnostic" },
      { ...response({}), code: 1 },
      response({}, 401),
      response({}, 500),
      { code: 0, stdout: '{"ready":true}', stderr: "" },
    ]
  ) assert.throws(() => parseApi(result));
});

Deno.test("real Git rejects shallow, partial, alternate and missing object history", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "optd-preflight-history-",
  });
  const command = async (args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: directory,
      stdout: "piped",
      stderr: "piped",
      env: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
  const setup = async (args: string[]) => {
    const result = await command(args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const runner: Runner = (cmd, args) => {
    assertReadOnly(cmd, args);
    assert.equal(cmd, "git");
    return command(args);
  };
  try {
    await setup(["init", "--quiet", "--initial-branch=master"]);
    await Deno.writeTextFile(`${directory}/file`, "fixture blob");
    await setup(["add", "file"]);
    await setup([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const head = await setup(["rev-parse", "HEAD"]);
    for (let i = 0; i < Number(Deno.env.get("GIT_CONFIG_COUNT") ?? "0"); i++) {
      const key = Deno.env.get(`GIT_CONFIG_KEY_${i}`)!;
      assert.equal(
        await setup(["config", "--get", key]),
        Deno.env.get(`GIT_CONFIG_VALUE_${i}`),
        "child Git must retain inherited safety disables",
      );
    }
    assert.equal((await observeHistory(runner, directory)).head, head);
    await Deno.writeTextFile(`${directory}/untracked`, "not checked source");
    await assert.rejects(
      () => observeHistory(runner, directory),
      /dirty-source/,
    );
    await Deno.remove(`${directory}/untracked`);
    let refReads = 0;
    const changingRefs: Runner = async (cmd, args) => {
      const result = await runner(cmd, args);
      if (args[0] === "for-each-ref" && ++refReads === 2) {
        result.stdout += `refs/heads/raced ${head}\n`;
      }
      return result;
    };
    await assert.rejects(
      () => observeHistory(changingRefs, directory),
      /history-changed/,
    );
    await setup(["update-ref", `refs/replace/${head}`, head]);
    await assert.rejects(
      () => observeHistory(runner, directory),
      /replacement-history/,
    );
    await setup(["update-ref", "-d", `refs/replace/${head}`]);
    await setup(["checkout", "--quiet", "--detach"]);
    await setup([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "candidate",
    ]);
    await setup(["update-ref", "refs/pi-dag-v2/private", head]);
    const candidate = await observeHistory(runner, directory);
    assert.notEqual(candidate.head, head);
    assert.equal(candidate.publication.acceptedMaster, head);
    assert.equal(candidate.publication.prospectiveTip, candidate.head);
    assert.equal(candidate.publication.ref, "refs/heads/master");
    assert.equal(candidate.refs.privateDag.length, 1);
    await setup(["update-ref", "refs/heads/master", candidate.head]);
    await setup(["checkout", "--quiet", "--detach", head]);
    await assert.rejects(
      () => observeHistory(runner, directory),
      /git-observation-failed/,
    );
    await setup(["update-ref", "refs/heads/master", head]);
    await Deno.writeTextFile(`${directory}/.git/shallow`, head + "\n");
    await assert.rejects(
      () => observeHistory(runner, directory),
      /shallow-history/,
    );
    await Deno.remove(`${directory}/.git/shallow`);
    await setup(["config", "remote.origin.promisor", "true"]);
    await assert.rejects(
      () => observeHistory(runner, directory),
      /partial-history-config/,
    );
    await setup(["config", "--unset", "remote.origin.promisor"]);
    await Deno.writeTextFile(
      `${directory}/.git/objects/info/alternates`,
      "/nonexistent\n",
    );
    await assert.rejects(
      () => observeHistory(runner, directory),
      /non-self-contained-history/,
    );
    await Deno.remove(`${directory}/.git/objects/info/alternates`);
    await Deno.writeTextFile(
      `${directory}/.git/objects/pack/fixture.promisor`,
      "",
    );
    await assert.rejects(
      () => observeHistory(runner, directory),
      /promisor-history/,
    );
    await Deno.remove(`${directory}/.git/objects/pack/fixture.promisor`);
    const blob = await setup(["rev-parse", "HEAD:file"]);
    await Deno.remove(
      `${directory}/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`,
    );
    await assert.rejects(
      () => observeHistory(runner, directory),
      /git-observation-failed|missing-publication-objects/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("precreation inventory distinguishes observations from unknown policies and future permission", async () => {
  const inventory = await observeGithub(github());
  assert.equal(inventory.publicationAuthorized, false);
  assert.equal(inventory.destination, "ABSENT");
  assert.ok(
    Object.values(inventory.creationPolicy).every((value) =>
      value === "UNKNOWN"
    ),
  );
  assert.ok(
    Object.values(inventory.postcreation).every((value) =>
      value === "UNVERIFIED"
    ),
  );
  const policy = await observeGithub(
    github({
      "/orgs/optd-ai": response({
        login: "optd-ai",
        public_repos: 0,
        total_private_repos: 0,
        members_can_create_repositories: false,
      }),
    }),
  );
  assert.equal(policy.creationPolicy.members_can_create_repositories, false);
  assert.equal(policy.publicationAuthorized, false);
  for (
    const overrides of [
      { "/user": response({ login: "fixture", id: 2, type: "User" }) },
      {
        "/user": {
          ...response({ login: "fixture", id: 1, type: "User" }),
          stdout: response({ login: "fixture", id: 1, type: "User" }).stdout
            .replace("repo, read:org", "read:org"),
        },
      },
      { "/orgs/optd-ai": response({ login: "optd-ai", public_repos: 0 }) },
      {
        "/orgs/optd-ai": response({
          login: "optd-ai",
          public_repos: 0,
          total_private_repos: 1,
        }),
      },
      {
        "/orgs/optd-ai/repos?type=all&per_page=100&page=1": response([{
          full_name: "optd-ai/hidden",
          private: true,
          visibility: "public",
          owner: { login: "optd-ai" },
        }]),
      },
    ] as Record<string, ReturnType<typeof response>>[]
  ) await assert.rejects(() => observeGithub(github(overrides)));
  assert.ok(!JSON.stringify(inventory).includes("fixture"));
});

Deno.test("local integration inventory reads actual source without claiming execution or future capability", async () => {
  const result = await observeLocalIntegration();
  assert.equal(result.files.length, 3);
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.executionVerified, false);
  const directory = await Deno.makeTempDir();
  try {
    await assert.rejects(() => observeLocalIntegration(directory));
    await Deno.mkdir(`${directory}/scripts`);
    await Deno.writeTextFile(
      `${directory}/scripts/optd-release-verify.sh`,
      "fixture",
    );
    await Deno.writeTextFile(
      `${directory}/scripts/optd-integration-verify.sh`,
      "fixture",
    );
    await Deno.writeTextFile(`${directory}/Dockerfile`, "FROM wrong");
    await assert.rejects(
      () => observeLocalIntegration(directory),
      /oci-identity-mismatch/,
    );
    await Deno.writeTextFile(
      `${directory}/Dockerfile`,
      'ARG OPTD_SOURCE=https://github.com/optd-ai/optd\nLABEL org.opencontainers.image.title="optd" org.opencontainers.image.licenses="Apache-2.0"',
    );
    assert.equal(
      (await observeLocalIntegration(directory)).workflowsState,
      "ABSENT",
    );
    await Deno.mkdir(`${directory}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${directory}/.github/workflows/test.yml`,
      "fixture",
    );
    assert.deepEqual((await observeLocalIntegration(directory)).workflows, [
      "test.yml",
    ]);
    await Deno.symlink(
      "test.yml",
      `${directory}/.github/workflows/ambiguous.yml`,
    );
    await assert.rejects(
      () => observeLocalIntegration(directory),
      /ambiguous-workflow-inventory/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
