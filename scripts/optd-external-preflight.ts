import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const dnsServers = [
  "selah.ns.cloudflare.com",
  "quentin.ns.cloudflare.com",
  "1.1.1.1",
  "8.8.8.8",
] as const;
const name = "_optd-control.optd.dev.";
export const maxAgeMs = 120_000;
type Result = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[]) => Promise<Result>;
type Check = { id: string; ok: boolean; detail: unknown; observedAt?: string };

class ObservationRejected extends Error {}

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new ObservationRejected(code);
}

// Exact argument allowlists, not a shell or a generic Git/GitHub command gateway.
export function assertReadOnly(command: string, args: string[]): void {
  const fixed: Record<string, string[][]> = {
    git: [
      ["rev-parse", "HEAD"],
      ["merge-base", "--is-ancestor", "refs/heads/master", "HEAD"],
      ["rev-list", "--objects", "HEAD", "--missing=print"],
      ["rev-parse", "--is-shallow-repository"],
      ["rev-parse", "--git-common-dir"],
      ["for-each-ref", "--format=%(refname) %(objectname)"],
      [
        "config",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter)|core\\.alternaterefscommand)$",
      ],
      ["fsck", "--full", "--strict", "--no-reflogs"],
      ["rev-list", "--objects", "--all", "HEAD", "--missing=print"],
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ],
    dig: dnsServers.map((server) => [
      `@${server}`,
      name,
      "TXT",
      "+time=5",
      "+tries=1",
      "+dnssec",
      "+nocdflag",
      "+noall",
      "+comments",
      "+answer",
      server.endsWith("cloudflare.com") ? "+norecurse" : "+recurse",
    ]),
  };
  if (
    fixed[command]?.some((allowed) =>
      JSON.stringify(allowed) === JSON.stringify(args)
    )
  ) return;
  if (
    command === "gh" && args.length === 7 &&
    JSON.stringify(args.slice(0, 6)) ===
      JSON.stringify([
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
      ]) &&
    (/^\/user$|^\/orgs\/optd-ai$|^\/user\/memberships\/orgs\/optd-ai$|^\/repos\/optd-ai\/optd$/
      .test(args[6]) ||
      /^\/orgs\/optd-ai\/repos\?type=all&per_page=100&page=[1-9][0-9]{0,3}$/
        .test(args[6]))
  ) return;
  throw new Error("forbidden-command");
}

export async function runReadOnly(
  command: string,
  args: string[],
): Promise<Result> {
  assertReadOnly(command, args);
  // Disable lazy object fetching and optional index writes even for read commands.
  const child = new Deno.Command(command, {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    env: {
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
    },
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* Already exited. */ }
  }, command === "git" ? 120_000 : 30_000);
  try {
    const result = await child.output();
    requireValue(!timedOut, "observation-timeout");
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function expectedChallenge(model: unknown): string {
  const records: Record<string, unknown>[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && "body" in value) {
      records.push(value as Record<string, unknown>);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(model);
  const values = ["DEC-optd-api-namespace", "EV-optd-domain-control-txt"].map(
    (id) => {
      const matches = records.filter((record) => record.id === id);
      requireValue(matches.length === 1, "ambiguous-model-challenge");
      const challenges = String(matches[0].body).match(
        /pi-dag-workflow=[a-f0-9]{32}\b/g,
      );
      requireValue(challenges?.length === 1, "missing-model-challenge");
      return challenges[0];
    },
  );
  requireValue(values[0] === values[1], "inconsistent-model-challenge");
  return values[0];
}

export function validateDns(
  text: string,
  expected: string,
  authoritative: boolean,
): void {
  const headers = [...text.matchAll(/status: ([A-Z]+),/g)];
  requireValue(
    headers.length === 1 && headers[0][1] === "NOERROR",
    "dns-status",
  );
  const flags = [...text.matchAll(/;; flags: ([^;]*);/g)];
  requireValue(flags.length === 1, "dns-flags");
  const words = flags[0][1].split(/\s+/);
  requireValue(
    words.includes("qr") && !words.includes("tc") && !words.includes("cd"),
    "dns-invalid-flags",
  );
  requireValue(words.includes(authoritative ? "aa" : "ra"), "dns-server-role");
  // An unsigned zone need not set AD. CD must remain off at validating resolvers.
  const answers = text.split("\n").map((line) => line.trim()).filter((line) =>
    line && !line.startsWith(";")
  );
  const signatures = answers.filter((line) => /\sIN\s+RRSIG\s/.test(line));
  for (const signature of signatures) {
    const record = signature.match(
      /^(\S+)\s+([1-9]\d*)\s+IN\s+RRSIG\s+TXT\s+\d+\s+\d+\s+\d+\s+\d{14}\s+\d{14}\s+\d+\s+optd\.dev\.\s+[A-Za-z0-9+/= ]+$/,
    );
    requireValue(
      record && record[1].toLowerCase() === name,
      "dns-invalid-signature-record",
    );
  }
  // RRSIGs accompany the TXT, not additional challenge values. Recursive
  // resolvers must authenticate signed answers rather than merely return them.
  requireValue(
    authoritative || signatures.length === 0 || words.includes("ad"),
    "dns-not-authenticated",
  );
  const txt = answers.filter((line) => !signatures.includes(line));
  requireValue(txt.length === 1, "dns-ambiguous-answer");
  const answer = txt[0].match(/^(\S+)\s+(\d+)\s+IN\s+TXT\s+"([^"\\]*)"$/);
  requireValue(
    answer && answer[1].toLowerCase() === name && Number(answer[2]) > 0 &&
      answer[3] === expected,
    "dns-challenge-mismatch",
  );
}

export function assertFresh(
  startedAt: number,
  observedAt: number,
  now: number,
): void {
  requireValue(
    Number.isFinite(startedAt) && Number.isFinite(observedAt) &&
      Number.isFinite(now) &&
      startedAt <= observedAt && observedAt <= now &&
      now - startedAt <= maxAgeMs,
    "stale-observation",
  );
}

export function inventoryRefs(text: string) {
  const refs = text.trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^(refs\/\S+) ([a-f0-9]{40}|[a-f0-9]{64})$/);
    requireValue(match, "invalid-ref-inventory");
    return { ref: match[1], oid: match[2] };
  });
  requireValue(
    new Set(refs.map((ref) => ref.ref)).size === refs.length,
    "duplicate-ref",
  );
  requireValue(
    !refs.some(({ ref }) => ref.startsWith("refs/replace/")),
    "replacement-history",
  );
  const privateRef = (ref: string) =>
    /^refs\/(heads\/dag\/|pi-dag(?:-v2)?\/)/.test(ref);
  return {
    privateDag: refs.filter(({ ref }) => privateRef(ref)),
    other: refs.filter(({ ref }) => !privateRef(ref)),
  };
}

export function parseApi(
  result: Result,
): { status: number; body: unknown; scopes: string[] } {
  const match = result.stdout.match(
    /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/,
  );
  requireValue(match, "github-response-unavailable");
  const status = Number(match[1]);
  requireValue(
    (status === 200 && result.code === 0) ||
      (status === 404 && result.code !== 0),
    "github-access-failure",
  );
  return {
    status,
    body: JSON.parse(match[2]),
    scopes: (result.stdout.match(/^x-oauth-scopes:\s*([^\r\n]*)/im)?.[1] ?? "")
      .split(",").map((s) => s.trim()),
  };
}

async function api(runner: Runner, endpoint: string) {
  return parseApi(
    await runner("gh", [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      endpoint,
    ]),
  );
}

export async function observeGithub(runner: Runner) {
  const user = await api(runner, "/user");
  const identity = user.body as { login?: string; id?: number; type?: string };
  requireValue(
    user.status === 200 && identity.type === "User" &&
      typeof identity.login === "string" && identity.login.length > 0 &&
      Number.isSafeInteger(identity.id) && Number(identity.id) > 0,
    "github-user-mismatch",
  );
  // Fine-grained/repository-limited credentials cannot prove org-wide absence.
  requireValue(
    user.scopes.includes("repo") &&
      ["read:org", "write:org", "admin:org"].some((scope) =>
        user.scopes.includes(scope)
      ),
    "github-token-visibility-unverified",
  );
  const org = await api(runner, "/orgs/optd-ai");
  requireValue(
    org.status === 200 && (org.body as { login?: string }).login === "optd-ai",
    "github-org-mismatch",
  );
  const membership = await api(runner, "/user/memberships/orgs/optd-ai");
  const member = membership.body as {
    state?: string;
    role?: string;
    organization?: { login?: string };
    user?: { login?: string; id?: number };
  };
  requireValue(
    membership.status === 200 && member.state === "active" &&
      member.role === "admin" && member.organization?.login === "optd-ai" &&
      member.user?.login === identity.login && member.user?.id === identity.id,
    "github-admin-required",
  );
  // A standalone 404 cannot establish absence: enumerate all repositories with
  // the same authenticated administrative identity, including private ones.
  let complete = false;
  const seen = new Set<string>();
  let privateCount = 0;
  for (let page = 1; page <= 9999; page++) {
    const response = await api(
      runner,
      `/orgs/optd-ai/repos?type=all&per_page=100&page=${page}`,
    );
    requireValue(
      response.status === 200 && Array.isArray(response.body),
      "github-incomplete-inventory",
    );
    const repos = response.body as {
      full_name?: string;
      private?: boolean;
      visibility?: string;
      owner?: { login?: string };
    }[];
    requireValue(repos.length <= 100, "github-invalid-page");
    for (const repo of repos) {
      requireValue(
        typeof repo.full_name === "string" &&
          repo.full_name.toLowerCase().startsWith("optd-ai/") &&
          repo.owner?.login === "optd-ai" &&
          typeof repo.private === "boolean" &&
          repo.visibility === (repo.private ? "private" : "public"),
        "github-invalid-repository",
      );
      const fullName = repo.full_name.toLowerCase();
      requireValue(!seen.has(fullName), "github-unstable-inventory");
      requireValue(fullName !== "optd-ai/optd", "github-destination-exists");
      seen.add(fullName);
      if (repo.private) privateCount++;
    }
    if (repos.length < 100) {
      complete = true;
      break;
    }
  }
  requireValue(complete, "github-incomplete-inventory");
  const metadata = org.body as Record<string, unknown>;
  requireValue(
    Number.isSafeInteger(metadata.total_private_repos) &&
      metadata.total_private_repos === privateCount &&
      Number.isSafeInteger(metadata.public_repos) &&
      metadata.public_repos === seen.size - privateCount,
    "github-inventory-visibility-gap",
  );
  const destination = await api(runner, "/repos/optd-ai/optd");
  requireValue(
    destination.status === 404 &&
      (destination.body as { message?: string }).message === "Not Found",
    "github-destination-not-absent",
  );
  return {
    activeAdmin: true,
    credentialVisibility: "classic repo and org read scopes",
    inventorySha256: Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify({
            userId: identity.id,
            repositories: [...seen].sort(),
          })),
        ),
      ),
    ).map((b) => b.toString(16).padStart(2, "0")).join(""),
    repositoryCount: seen.size,
    privateRepositoryCount: privateCount,
    destination: "ABSENT",
    creationPolicy: Object.fromEntries([
      "members_can_create_repositories",
      "members_can_create_public_repositories",
      "members_can_create_private_repositories",
    ].map((
      key,
    ) => [
      key,
      typeof metadata[key] === "boolean" ? metadata[key] : "UNKNOWN",
    ])),
    postcreation: {
      hooks: "UNVERIFIED",
      actions: "UNVERIFIED",
      rules: "UNVERIFIED",
      ghcr: "UNVERIFIED",
      writeCapabilities: "UNVERIFIED",
    },
    publicationAuthorized: false,
  };
}

async function exists(path: string) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export function validateGitEnvironment(env: Record<string, string>): void {
  const deny = () => {
    throw new Error("git-environment-override");
  };
  for (
    const key of [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_OBJECT_DIRECTORY",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_SHALLOW_FILE",
      "GIT_INDEX_FILE",
      "GIT_REPLACE_REF_BASE",
      "GIT_GRAFT_FILE",
      "GIT_CONFIG",
      "GIT_CONFIG_PARAMETERS",
    ]
  ) {
    if (Object.hasOwn(env, key)) deny();
  }
  const indexed = Object.keys(env).filter((key) =>
    key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")
  );
  if (!Object.hasOwn(env, "GIT_CONFIG_COUNT")) {
    if (indexed.length) deny();
    return;
  }
  const count = Number(env.GIT_CONFIG_COUNT);
  if (
    !/^(0|[1-9][0-9]*)$/.test(env.GIT_CONFIG_COUNT) ||
    !Number.isSafeInteger(count) || String(count) !== env.GIT_CONFIG_COUNT ||
    indexed.length !== count * 2
  ) deny();
  const expected = new Set<string>();
  const settings = new Set<string>();
  for (let i = 0; i < count; i++) {
    expected.add(`GIT_CONFIG_KEY_${i}`);
    expected.add(`GIT_CONFIG_VALUE_${i}`);
    const key = env[`GIT_CONFIG_KEY_${i}`];
    const value = env[`GIT_CONFIG_VALUE_${i}`];
    // Only disables are admitted. Leave them inherited by every child Git;
    // never sanitize an unknown override into an apparently safe observation.
    if (
      typeof key !== "string" || settings.has(key) ||
      !(key === "core.hooksPath" && value === "/dev/null" ||
        key === "core.fsmonitor" && value === "false" ||
        /^hook\.\P{Cc}+\.enabled$/u.test(key) && value === "false")
    ) deny();
    settings.add(key);
  }
  if (indexed.some((key) => !expected.has(key))) deny();
}

export async function observeHistory(runner: Runner, repositoryRoot = root) {
  validateGitEnvironment(Deno.env.toObject());
  const git = async (args: string[]) => {
    const result = await runner("git", args);
    requireValue(result.code === 0, "git-observation-failed");
    return result.stdout.trim();
  };
  requireValue(
    await git(["rev-parse", "--is-shallow-repository"]) === "false",
    "shallow-history",
  );
  const config = await runner("git", [
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter)|core\\.alternaterefscommand)$",
  ]);
  requireValue(
    config.code === 1 && config.stdout === "",
    "partial-history-config",
  );
  const common = resolve(
    repositoryRoot,
    await git(["rev-parse", "--git-common-dir"]),
  );
  for (
    const path of [
      "shallow",
      "info/grafts",
      "objects/info/alternates",
      "objects/info/http-alternates",
    ]
  ) {
    requireValue(
      !await exists(join(common, path)),
      "non-self-contained-history",
    );
  }
  for await (const entry of Deno.readDir(join(common, "objects/pack"))) {
    requireValue(!entry.name.endsWith(".promisor"), "promisor-history");
  }
  const head = await git(["rev-parse", "HEAD"]);
  const before = await git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
  const refs = inventoryRefs(before);
  const master = refs.other.find(({ ref }) => ref === "refs/heads/master");
  requireValue(master, "publication-master-missing");
  await git(["merge-base", "--is-ancestor", "refs/heads/master", "HEAD"]);
  const publicationObjects = await git([
    "rev-list",
    "--objects",
    "HEAD",
    "--missing=print",
  ]);
  requireValue(
    publicationObjects.length > 0 &&
      !publicationObjects.split("\n").some((line) => line.startsWith("?")),
    "missing-publication-objects",
  );
  await git(["fsck", "--full", "--strict", "--no-reflogs"]);
  const objects = await git([
    "rev-list",
    "--objects",
    "--all",
    "HEAD",
    "--missing=print",
  ]);
  requireValue(
    !objects.split("\n").some((line) => line.startsWith("?")),
    "missing-history-objects",
  );
  requireValue(
    await git(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "dirty-source",
  );
  requireValue(
    head === await git(["rev-parse", "HEAD"]) &&
      before ===
        await git(["for-each-ref", "--format=%(refname) %(objectname)"]),
    "history-changed",
  );
  return {
    head,
    refs,
    reachableObjects: objects.split("\n").length,
    publication: {
      ref: "refs/heads/master",
      acceptedMaster: master.oid,
      prospectiveTip: head,
      ancestry: "ALL reachable ancestry and objects; no squash",
      reachableObjects: publicationObjects.split("\n").length,
      excludedRefs: [
        ...refs.privateDag,
        ...refs.other.filter(({ ref }) => ref !== "refs/heads/master"),
      ],
    },
  };
}

export async function observeLocalIntegration(repositoryRoot = root) {
  const paths = [
    "scripts/optd-release-verify.sh",
    "scripts/optd-integration-verify.sh",
    "Dockerfile",
  ];
  const files = [];
  for (const path of paths) {
    const bytes = await Deno.readFile(join(repositoryRoot, path));
    const text = new TextDecoder().decode(bytes);
    requireValue(text.length > 0, "empty-integration-file");
    if (path === "Dockerfile") {
      requireValue(
        text.includes("ARG OPTD_SOURCE=https://github.com/optd-ai/optd") &&
          text.includes('org.opencontainers.image.title="optd"') &&
          text.includes('org.opencontainers.image.licenses="Apache-2.0"'),
        "oci-identity-mismatch",
      );
    }
    files.push({
      path,
      sha256: Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ).map((b) => b.toString(16).padStart(2, "0")).join(""),
    });
  }
  const workflows: string[] = [];
  const directory = join(repositoryRoot, ".github/workflows");
  if (await exists(directory)) {
    for await (const entry of Deno.readDir(directory)) {
      requireValue(
        entry.isFile && !entry.isSymlink,
        "ambiguous-workflow-inventory",
      );
      workflows.push(entry.name);
    }
  }
  return {
    files,
    workflows: workflows.sort(),
    workflowsState: workflows.length ? "PRESENT" : "ABSENT",
    executionVerified: false,
    publicationAuthorized: false,
  };
}

async function evidenceDirectory() {
  // Never reuse receipts or follow a preexisting symlink into unowned storage.
  let parent = root;
  for (const component of [".ai", "optd-external-preflight"]) {
    parent = join(parent, component);
    try {
      await Deno.mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const info = await Deno.lstat(parent);
    requireValue(
      info.isDirectory && !info.isSymlink,
      "unsafe-evidence-directory",
    );
  }
  return await Deno.makeTempDir({ dir: parent, prefix: "observation-" });
}

export async function verify() {
  const startedAt = Date.now();
  const directory = await evidenceDirectory();
  const checks: Check[] = [];
  async function check(id: string, observe: () => Promise<unknown>) {
    try {
      const detail = await observe();
      assertFresh(startedAt, Date.now(), Date.now());
      checks.push({
        id,
        ok: true,
        detail: detail ?? "observed",
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Do not persist API bodies, account names, command stderr or credentials.
      checks.push({
        id,
        ok: false,
        detail: error instanceof ObservationRejected
          ? error.message
          : "observation unavailable or rejected",
        observedAt: new Date().toISOString(),
      });
    }
  }
  let history: Awaited<ReturnType<typeof observeHistory>> | undefined;
  await check(
    "local-history",
    async () => history = await observeHistory(runReadOnly),
  );
  await check(
    "integration-metadata-capabilities",
    () => observeLocalIntegration(),
  );
  let github: Awaited<ReturnType<typeof observeGithub>> | undefined;
  await check(
    "github-administration-and-absence",
    async () => github = await observeGithub(runReadOnly),
  );
  let expected: string | undefined;
  await check("governing-challenge", async () => {
    expected = expectedChallenge(
      JSON.parse(
        await Deno.readTextFile(join(root, "project-model/model.json")),
      ),
    );
    return expected;
  });
  for (const server of dnsServers) {
    await check(`dns:${server}`, async () => {
      requireValue(expected, "missing-model-challenge");
      const authoritative = server.endsWith("cloudflare.com");
      const result = await runReadOnly("dig", [
        `@${server}`,
        name,
        "TXT",
        "+time=5",
        "+tries=1",
        "+dnssec",
        "+nocdflag",
        "+noall",
        "+comments",
        "+answer",
        authoritative ? "+norecurse" : "+recurse",
      ]);
      requireValue(result.code === 0, "dns-command-failed");
      validateDns(result.stdout, expected, authoritative);
      return {
        server,
        challenge: expected,
        observedAt: new Date().toISOString(),
      };
    });
  }
  await check("observation-window", () => {
    assertFresh(startedAt, Date.now(), Date.now());
    return Promise.resolve();
  });
  await check("github-consistency", async () => {
    requireValue(github, "missing-initial-github-observation");
    const current = await observeGithub(runReadOnly);
    requireValue(
      JSON.stringify(github) === JSON.stringify(current),
      "github-observation-changed",
    );
    return current;
  });
  await check("intended-publication-refs", async () => {
    requireValue(history, "missing-initial-history");
    const final = await observeHistory(runReadOnly);
    requireValue(
      JSON.stringify(history) === JSON.stringify(final),
      "source-changed-during-observation",
    );
    return final.publication;
  });
  await check(
    "final-freshness",
    () => Promise.resolve(assertFresh(startedAt, Date.now(), Date.now())),
  );
  const evidence = {
    schema: 2,
    scope: "LOCAL/PRECREATION",
    publicationAuthorized: false,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    precreationReady: checks.every((check) => check.ok),
    checks,
    exactImage:
      "mandatory independent source and composed-proposal gates; not established by this observation",
    externalEffectsAuthorized: false,
  };
  await Deno.writeTextFile(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
    { createNew: true, mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      scope: evidence.scope,
      precreationReady: evidence.precreationReady,
      publicationAuthorized: false,
      evidence: join(directory, "evidence.json"),
      failedChecks: checks.filter((check) => !check.ok).map((check) =>
        check.id
      ),
    }),
  );
  return evidence.precreationReady;
}

if (import.meta.main) {
  if (Deno.args.length !== 1 || Deno.args[0] !== "verify") {
    console.error(
      "usage: deno run -A scripts/optd-external-preflight.ts verify",
    );
    Deno.exit(2);
  }
  try {
    Deno.exit(await verify() ? 0 : 1);
  } catch {
    console.error(
      "preflight failed; evidence storage or required capability unavailable",
    );
    Deno.exit(1);
  }
}
