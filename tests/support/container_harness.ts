const MAX_CAPTURE_BYTES = 1024 * 1024;

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ContainerCliResult = CommandResult & { argv: string[] };

export type ContainerCliLauncher = {
  readonly root: string;
  readonly kind: "human" | "request_only" | "agent";
  runOptctl(
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ): Promise<ContainerCliResult>;
  close(): Promise<void>;
};

export type ContainerHarness = {
  id: string;
  image: string;
  port: number;
  bootstrapToken: string;
  masterKey: string;
  volume: string;
  container: string;
  docker(args: string[], options?: RunOptions): Promise<CommandResult>;
  startAppManaged(extraArgs?: string[]): Promise<void>;
  recreateAppManaged(extraArgs?: string[]): Promise<void>;
  waitReady(timeoutMs?: number): Promise<Record<string, unknown>>;
  runOptctl(
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ): Promise<ContainerCliResult>;
  createProcessTreeLauncher(
    kind?: "human" | "request_only" | "agent",
  ): Promise<ContainerCliLauncher>;
  copyPack(hostPath: string): Promise<string>;
  logs(): Promise<string>;
  cleanup(): Promise<void>;
};

export type RunOptions = {
  timeoutMs?: number;
  stdin?: string;
  allowFailure?: boolean;
  env?: Record<string, string>;
};

export async function buildReleaseImage(): Promise<string> {
  const image = Deno.env.get("OPTD_CONTAINER_IMAGE") ??
    `optd:container-release-${sourceSuffix()}`;
  if (Deno.env.get("OPTD_CONTAINER_SKIP_BUILD") === "1") {
    const expectedId = Deno.env.get("OPTD_CONTAINER_IMAGE_ID");
    const expectedRevision = Deno.env.get("OPTD_CONTAINER_REVISION");
    const expectedVersion = Deno.env.get("OPTD_CONTAINER_VERSION");
    if (!Deno.env.get("OPTD_CONTAINER_IMAGE") || !expectedId) {
      throw new Error(
        "skip-build requires OPTD_CONTAINER_IMAGE and OPTD_CONTAINER_IMAGE_ID",
      );
    }
    const inspected = await runCommand("docker", [
      "image",
      "inspect",
      image,
      "--format",
      '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}',
    ]);
    const [actualId, actualRevision, actualVersion] = inspected.stdout.trim()
      .split(" ");
    if (
      actualId !== expectedId ||
      (expectedRevision && actualRevision !== expectedRevision) ||
      (expectedVersion && actualVersion !== expectedVersion)
    ) {
      throw new Error(
        `configured release image identity mismatch: expected ${expectedId} ${
          expectedRevision ?? "*"
        } ${expectedVersion ?? "*"}, got ${inspected.stdout.trim()}`,
      );
    }
    return expectedId;
  }
  const revision = (await runCommand("git", ["rev-parse", "HEAD"])).stdout
    .trim();
  await runCommand("docker", [
    "build",
    "--pull=false",
    "--no-cache",
    "--build-arg",
    `OPTD_REVISION=${revision}`,
    "--build-arg",
    "OPTD_VERSION=0.1.0-dev",
    "--tag",
    image,
    ".",
  ], { timeoutMs: 15 * 60_000 });
  return (await runCommand("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ])).stdout.trim();
}

export async function createContainerHarness(
  image: string,
): Promise<ContainerHarness> {
  const gateId = Deno.env.get("OPTD_RELEASE_GATE_ID");
  const expectedImageId = Deno.env.get("OPTD_CONTAINER_IMAGE_ID");
  if (gateId && (!expectedImageId || image !== expectedImageId)) {
    throw new Error(
      `gate harness requires its frozen image ID: expected ${expectedImageId}, got ${image}`,
    );
  }
  const id = `optd-cr-${gateId ? `${gateId.slice(0, 12)}-` : ""}${
    crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  }`;
  const port = await freePort();
  const volume = `${id}-data`;
  const container = `${id}-app`;
  const bootstrapToken = randomSecret();
  const masterKey = randomSecret();
  const cleanupArgs: string[][] = [];
  const gateLabel = gateId;
  const labelArgs = gateLabel
    ? ["--label", `dev.optd.release-gate=${gateLabel}`]
    : [];
  let volumeRegistered = false;
  let containerRegistered = false;
  let retainedExtraArgs: string[] = [];

  const docker = async (args: string[], options: RunOptions = {}) =>
    await runCommand("docker", args, options);
  const logs = async () => {
    const result = await docker(["logs", container], {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    return bounded(`${result.stdout}\n${result.stderr}`);
  };

  const runContainer = async (extraArgs: string[]) => {
    await docker([
      "run",
      "--detach",
      "--name",
      container,
      ...labelArgs,
      "--publish",
      `127.0.0.1:${port}:8789`,
      "--env",
      `OPTD_BOOTSTRAP_TOKEN=${bootstrapToken}`,
      "--env",
      `OPTD_SECRET_MASTER_KEY=${masterKey}`,
      "--volume",
      `${volume}:/data`,
      ...extraArgs,
      image,
    ]);
    if (!containerRegistered) {
      cleanupArgs.unshift(["rm", "-f", "-v", container]);
      containerRegistered = true;
    }
  };
  const cliRoot = `/data/.container-test-clients/default`;
  const runOptctl = async (
    args: string[],
    stdin?: string,
    commandEnv: Record<string, string> = {},
  ) => {
    const argv = ["--server", "http://127.0.0.1:8789", ...args];
    const result = await docker([
      "exec",
      ...stdin === undefined ? [] : ["--interactive"],
      ...Object.entries(commandEnv).flatMap((
        [name, value],
      ) => ["--env", `${name}=${value}`]),
      "--env",
      `HOME=${cliRoot}/home`,
      "--env",
      `XDG_CONFIG_HOME=${cliRoot}/config`,
      "--env",
      `XDG_STATE_HOME=${cliRoot}/state`,
      "--env",
      `OPTD_AUTH_TREE_STOP_PID=1`,
      container,
      "sh",
      "-c",
      `mkdir -p '${cliRoot}/home' '${cliRoot}/config' '${cliRoot}/state' && exec optctl "$@"`,
      "sh",
      ...argv,
    ], { stdin, allowFailure: true, timeoutMs: 60_000 });
    return { ...result, argv };
  };

  return {
    id,
    image,
    port,
    bootstrapToken,
    masterKey,
    volume,
    container,
    docker,
    async startAppManaged(extraArgs = []) {
      retainedExtraArgs = [...extraArgs];
      await docker([
        "volume",
        "create",
        ...gateLabel ? ["--label", `dev.optd.release-gate=${gateLabel}`] : [],
        volume,
      ]);
      if (!volumeRegistered) {
        cleanupArgs.push(["volume", "rm", "-f", volume]);
        volumeRegistered = true;
      }
      await runContainer(extraArgs);
    },
    async recreateAppManaged(extraArgs = retainedExtraArgs) {
      retainedExtraArgs = [...extraArgs];
      await docker(["rm", "-f", container], { allowFailure: true });
      await runContainer(retainedExtraArgs);
    },
    async waitReady(timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "no response";
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ready`, {
            signal: AbortSignal.timeout(2_000),
          });
          last = await response.text();
          if (response.ok) return JSON.parse(last);
        } catch (error) {
          last = String(error);
        }
        await sleep(250);
      }
      throw new Error(`container readiness timeout: ${last}\n${await logs()}`);
    },
    runOptctl,
    async createProcessTreeLauncher(kind = "human") {
      const root =
        `/data/.container-test-clients/${kind}-${crypto.randomUUID()}`;
      return await createDockerProcessTreeLauncher(container, root, kind);
    },
    async copyPack(hostPath) {
      const name = hostPath.replaceAll("\\", "/").split("/").filter(Boolean)
        .at(-1) ?? "pack";
      const destination =
        `/data/.container-test-packs/${crypto.randomUUID()}-${name}`;
      await docker([
        "exec",
        "--user",
        "0",
        container,
        "mkdir",
        "-p",
        destination,
      ]);
      await docker(["cp", `${hostPath}/.`, `${container}:${destination}`]);
      await docker([
        "exec",
        "--user",
        "0",
        container,
        "chown",
        "-R",
        "1993:1993",
        destination,
      ]);
      return destination;
    },
    logs,
    async cleanup() {
      for (const args of cleanupArgs) {
        await docker(args, { timeoutMs: 20_000, allowFailure: true });
      }
      cleanupArgs.length = 0;
    },
  };
}

// deno-lint-ignore require-await
async function createDockerProcessTreeLauncher(
  container: string,
  root: string,
  kind: "human" | "request_only" | "agent",
): Promise<ContainerCliLauncher> {
  const worker = `
    const root = Deno.args[0];
    await Promise.all(["home", "config", "state"].map((name) =>
      Deno.mkdir(root + "/" + name, { recursive: true, mode: 0o700 })));
    let buffered = "";
    for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      while (true) {
        const end = buffered.indexOf("\\n");
        if (end < 0) break;
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.close) Deno.exit(0);
        const child = new Deno.Command("/usr/local/bin/optctl", {
          args: message.argv,
          env: {
            ...Deno.env.toObject(), ...message.env, HOME: root + "/home",
            XDG_CONFIG_HOME: root + "/config", XDG_STATE_HOME: root + "/state",
            OPTD_AUTH_TREE_STOP_PID: String(Deno.pid),
          },
          stdin: message.stdin === undefined ? "null" : "piped",
          stdout: "piped", stderr: "piped",
        }).spawn();
        if (message.stdin !== undefined) {
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(message.stdin)); await writer.close();
        }
        const output = await child.output();
        console.log(JSON.stringify({ code: output.code,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr) }));
      }
    }
  `;
  const child = new Deno.Command("docker", {
    args: [
      "exec",
      "--interactive",
      container,
      "deno",
      "eval",
      worker,
      root,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = child.stdin.getWriter();
  const output = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errors = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let diagnostics = "";
  let queue = Promise.resolve();
  let closed = false;
  const errorPump = (async () => {
    while (true) {
      const next = await errors.read();
      if (next.done) return;
      diagnostics = bounded(diagnostics + next.value);
    }
  })();
  const readLine = async () => {
    while (true) {
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line;
      }
      const next = await output.read();
      if (next.done) {
        throw new Error(`container CLI launcher exited: ${diagnostics}`);
      }
      buffered += next.value;
    }
  };
  return {
    root,
    kind,
    async runOptctl(args, stdin, env) {
      if (closed) throw new Error("container CLI launcher is closed");
      const argv = ["--server", "http://127.0.0.1:8789", ...args];
      let resolveQueue!: () => void;
      const previous = queue;
      queue = new Promise((resolve) => resolveQueue = resolve);
      await previous;
      try {
        await input.write(
          new TextEncoder().encode(`${JSON.stringify({ argv, stdin, env })}\n`),
        );
        const result = JSON.parse(await readLine()) as CommandResult;
        return {
          ...result,
          stdout: result.stdout.trimEnd(),
          stderr: result.stderr.trimEnd(),
          argv,
        };
      } finally {
        resolveQueue();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      await input.write(new TextEncoder().encode('{"close":true}\n')).catch(
        () => undefined,
      );
      await input.close().catch(() => undefined);
      await child.status.catch(() => undefined);
      await output.cancel().catch(() => undefined);
      await errors.cancel().catch(() => undefined);
      await errorPump.catch(() => undefined);
    },
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const gateId = Deno.env.get("OPTD_RELEASE_GATE_ID");
  if (command === "docker" && gateId && args[0] === "run") {
    return await runRegisteredGateContainer(args.slice(1), options, gateId);
  }
  if (command === "docker" && gateId && args[0] === "compose") {
    return await runRegisteredGateCompose(args, options, gateId);
  }
  if (command === "docker" && gateId) {
    try {
      await verifyGateDockerRemoval(args, gateId);
    } catch (error) {
      if (!options.allowFailure) throw error;
      return { code: 125, stdout: "", stderr: String(error) };
    }
  }

  let effectiveArgs = args;
  let registration:
    | { kind: "containers" | "volumes" | "networks"; name: string }
    | undefined;
  if (command === "docker" && gateId) {
    const prepared = prepareGateDockerCreation(args, gateId);
    effectiveArgs = prepared.args;
    registration = prepared.registration;
    if (registration) {
      await appendGateRegistry(
        registration.kind,
        `pending:${registration.name}`,
        registration.name,
      );
    }
  }

  const result = await runCommandRaw(command, effectiveArgs, options);
  if (registration && result.code === 0) {
    let identity = result.stdout.trim().split("\n").at(-1) ?? "";
    if (registration.kind === "containers") {
      identity = (await runCommandRaw("docker", [
        "container",
        "inspect",
        identity || registration.name,
        "--format",
        "{{.Id}}",
      ])).stdout.trim();
      await registerContainerAndMounts(identity, registration.name);
    } else if (registration.kind === "volumes") {
      identity = (await runCommandRaw("docker", [
        "volume",
        "inspect",
        registration.name,
        "--format",
        "{{.Name}}",
      ])).stdout.trim();
      await appendGateRegistry("volumes", identity, registration.name);
    } else {
      identity = (await runCommandRaw("docker", [
        "network",
        "inspect",
        registration.name,
        "--format",
        "{{.Id}}",
      ])).stdout.trim();
      await appendGateRegistry("networks", identity, registration.name);
    }
  }
  return result;
}

async function verifyGateDockerRemoval(
  args: string[],
  gateId: string,
): Promise<void> {
  let kind: "container" | "volume" | "network" | undefined;
  let removalArgs: string[] = [];
  if (args[0] === "rm" || (args[0] === "container" && args[1] === "rm")) {
    kind = "container";
    removalArgs = args.slice(args[0] === "rm" ? 1 : 2);
  } else if (args[0] === "volume" && args[1] === "rm") {
    kind = "volume";
    removalArgs = args.slice(2);
  } else if (args[0] === "network" && args[1] === "rm") {
    kind = "network";
    removalArgs = args.slice(2);
  }
  if (!kind) return;

  const allowedFlags = kind === "container"
    ? new Set(["--force", "--link", "--volumes", "-f", "-l", "-v"])
    : new Set(["--force", "-f"]);
  const identities: string[] = [];
  let optionsEnded = false;
  for (const arg of removalArgs) {
    if (optionsEnded) {
      identities.push(arg);
    } else if (arg === "--") {
      optionsEnded = true;
    } else if (allowedFlags.has(arg)) {
      continue;
    } else if (arg.startsWith("-")) {
      throw new Error(
        `refusing to parse unsupported or ambiguous docker ${kind} rm option: ${arg}`,
      );
    } else {
      identities.push(arg);
    }
  }

  for (const identity of identities) {
    const format = kind === "container"
      ? '{{index .Config.Labels "dev.optd.release-gate"}}'
      : '{{index .Labels "dev.optd.release-gate"}}';
    const inspected = await runCommandRaw("docker", [
      kind,
      "inspect",
      identity,
      "--format",
      format,
    ], { allowFailure: true });
    if (inspected.code !== 0) {
      throw new Error(
        `refusing to remove ${kind} after gate-label inspection failed: ${identity}`,
      );
    }
    if (inspected.stdout.trim() !== gateId) {
      throw new Error(
        `refusing to remove ${kind} after gate-label mismatch: ${identity}`,
      );
    }
  }
}

async function runRegisteredGateContainer(
  runArgs: string[],
  options: RunOptions,
  gateId: string,
): Promise<CommandResult> {
  const createArgs: string[] = [];
  let detached = false;
  let remove = false;
  let interactive = options.stdin !== undefined;
  let name = "";
  for (let index = 0; index < runArgs.length; index++) {
    const arg = runArgs[index];
    if (arg === "--detach" || arg === "-d") {
      detached = true;
      continue;
    }
    if (arg === "--rm") {
      remove = true;
      continue;
    }
    if (arg === "--interactive" || arg === "-i") interactive = true;
    if (arg === "--name" && index + 1 < runArgs.length) {
      name = runArgs[index + 1];
    }
    createArgs.push(arg);
  }
  if (!name) {
    name = `optd-gate-${gateId.slice(0, 12)}-${
      crypto.randomUUID().replaceAll("-", "").slice(0, 12)
    }`;
    createArgs.unshift("--name", name);
  }
  createArgs.unshift("--label", `dev.optd.release-gate=${gateId}`);
  await appendGateRegistry("containers", `pending:${name}`, name);
  const created = await runCommandRaw("docker", [
    "container",
    "create",
    ...createArgs,
  ], {
    ...options,
    stdin: undefined,
    allowFailure: false,
  });
  const containerId = created.stdout.trim();
  await registerContainerAndMounts(containerId, name);

  let result: CommandResult;
  try {
    if (detached) {
      const started = await runCommandRaw("docker", [
        "container",
        "start",
        containerId,
      ], options);
      result = { ...started, stdout: `${containerId}\n` };
    } else {
      result = await runCommandRaw("docker", [
        "container",
        "start",
        "--attach",
        ...interactive ? ["--interactive"] : [],
        containerId,
      ], options);
    }
  } finally {
    if (remove) {
      await verifyGateDockerRemoval([
        "container",
        "rm",
        "--force",
        "--volumes",
        containerId,
      ], gateId);
      await runCommandRaw("docker", [
        "container",
        "rm",
        "--force",
        "--volumes",
        containerId,
      ], { allowFailure: true, timeoutMs: 20_000 });
    }
  }
  return result;
}

async function registerContainerAndMounts(
  containerId: string,
  name: string,
): Promise<void> {
  await appendGateRegistry("containers", containerId, name);
  const mounts = await runCommandRaw("docker", [
    "container",
    "inspect",
    containerId,
    "--format",
    '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
  ]);
  for (const volume of mounts.stdout.split("\n").filter(Boolean)) {
    await appendGateRegistry("volumes", volume, `${name}:mount`);
  }
}

function prepareGateDockerCreation(
  args: string[],
  gateId: string,
): {
  args: string[];
  registration?: {
    kind: "containers" | "volumes" | "networks";
    name: string;
  };
} {
  if (
    (args[0] === "create" ||
      (args[0] === "container" && args[1] === "create"))
  ) {
    const offset = args[0] === "create" ? 1 : 2;
    const effective = [...args];
    effective.splice(
      offset,
      0,
      "--label",
      `dev.optd.release-gate=${gateId}`,
    );
    const nameIndex = effective.indexOf("--name");
    const name = nameIndex >= 0
      ? effective[nameIndex + 1]
      : `optd-gate-${gateId.slice(0, 12)}-pending`;
    return { args: effective, registration: { kind: "containers", name } };
  }
  if (args[0] === "volume" && args[1] === "create") {
    const name = args.at(-1) ?? "";
    return {
      args: [
        "volume",
        "create",
        "--label",
        `dev.optd.release-gate=${gateId}`,
        ...args.slice(2),
      ],
      registration: { kind: "volumes", name },
    };
  }
  if (args[0] === "network" && args[1] === "create") {
    const name = args.at(-1) ?? "";
    return {
      args: [
        "network",
        "create",
        "--label",
        `dev.optd.release-gate=${gateId}`,
        ...args.slice(2),
      ],
      registration: { kind: "networks", name },
    };
  }
  return { args };
}

const composeResourceCommands = [
  ["containers", ["container", "ls", "--all", "--no-trunc", "--quiet"]],
  ["volumes", ["volume", "ls", "--quiet"]],
  ["networks", ["network", "ls", "--no-trunc", "--quiet"]],
] as const;

async function listExactComposeResources(
  command: readonly string[],
  project: string,
  gateId?: string,
): Promise<string[]> {
  const filters = [
    "--filter",
    `label=com.docker.compose.project=${project}`,
    ...gateId ? ["--filter", `label=dev.optd.release-gate=${gateId}`] : [],
  ];
  const listed = await runCommandRaw("docker", [...command, ...filters]);
  const identities = listed.stdout.split("\n").filter(Boolean);
  if (identities.some((identity) => /\s/.test(identity))) {
    throw new Error("ambiguous Docker identity in Compose ownership listing");
  }
  const exact = [...new Set(identities)].sort();
  if (exact.length !== identities.length) {
    throw new Error("duplicate Docker identity in Compose ownership listing");
  }
  return exact;
}

async function preflightComposeRemoval(
  project: string,
  gateId: string,
): Promise<void> {
  const inventories: Array<{
    kind: "containers" | "volumes" | "networks";
    identities: string[];
  }> = [];
  for (const [kind, command] of composeResourceCommands) {
    const projectResources = await listExactComposeResources(command, project);
    const ownedResources = await listExactComposeResources(
      command,
      project,
      gateId,
    );
    if (projectResources.join("\n") !== ownedResources.join("\n")) {
      throw new Error(
        `refusing Compose removal after exact project/run inventory mismatch: ${kind}`,
      );
    }
    inventories.push({ kind, identities: projectResources });
  }

  // Complete every ownership inspection before allowing the first destructive
  // Compose command. This keeps a late inspect error from following an earlier
  // resource removal.
  for (const { kind, identities } of inventories) {
    for (const identity of identities) {
      const format = kind === "containers"
        ? "{{json .Config.Labels}}"
        : "{{json .Labels}}";
      const inspected = await runCommandRaw("docker", [
        kind.slice(0, -1),
        "inspect",
        identity,
        "--format",
        format,
      ], { allowFailure: true });
      if (inspected.code !== 0) {
        throw new Error(
          `refusing Compose removal after ${kind} inspection failed: ${identity}`,
        );
      }
      let labels: Record<string, unknown>;
      try {
        labels = JSON.parse(inspected.stdout.trim());
      } catch {
        throw new Error(
          `refusing Compose removal after ambiguous ${kind} labels: ${identity}`,
        );
      }
      if (
        labels["com.docker.compose.project"] !== project ||
        labels["dev.optd.release-gate"] !== gateId
      ) {
        throw new Error(
          `refusing Compose removal after exact label mismatch: ${kind}/${identity}`,
        );
      }
      await appendGateRegistry(kind, identity, `compose:${project}`);
    }
  }
}

async function runRegisteredGateCompose(
  args: string[],
  options: RunOptions,
  gateId: string,
): Promise<CommandResult> {
  const project = options.env?.COMPOSE_PROJECT_NAME ??
    Deno.env.get("COMPOSE_PROJECT_NAME") ?? "unknown";
  const destructive = args.some((arg) => arg === "down" || arg === "rm");
  if (destructive) {
    await preflightComposeRemoval(project, gateId);
  } else {
    await appendGateRegistry(
      "containers",
      `pending:compose:${project}`,
      project,
    );
  }

  const result = await runCommandRaw("docker", args, {
    ...options,
    allowFailure: true,
  });
  for (const [kind, command] of composeResourceCommands) {
    const identities = await listExactComposeResources(
      command,
      project,
      gateId,
    );
    for (const identity of identities) {
      await appendGateRegistry(kind, identity, `compose:${project}`);
    }
  }
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `docker ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
    );
  }
  return result;
}

async function appendGateRegistry(
  kind: "containers" | "volumes" | "networks",
  identity: string,
  name: string,
): Promise<void> {
  const root = Deno.env.get("OPTD_RELEASE_GATE_REGISTRY");
  if (!root) {
    throw new Error(
      "release gate Docker creation requires its durable registry",
    );
  }
  if (/\r|\n|\t/.test(identity) || /\r|\n|\t/.test(name)) {
    throw new Error("release gate registry identity contains a delimiter");
  }
  const file = await Deno.open(`${root}/${kind}`, {
    append: true,
    write: true,
  });
  try {
    file.writeSync(new TextEncoder().encode(`${identity}\t${name}\n`));
    file.syncSync();
  } finally {
    file.close();
  }
}

async function runCommandRaw(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const child = new Deno.Command("setsid", {
    args: [command, ...args],
    env: options.env,
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outputPromise = child.output();
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("command timeout")),
        options.timeoutMs ?? 60_000,
      );
    });
    const output = await Promise.race([outputPromise, timeout]);
    const result = {
      code: output.code,
      stdout: bounded(new TextDecoder().decode(output.stdout)),
      stderr: bounded(new TextDecoder().decode(output.stderr)),
    };
    if (result.code !== 0 && !options.allowFailure) {
      throw new Error(
        `${command} ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
      );
    }
    return result;
  } catch (error) {
    // This Deno.ChildProcess is the authoritative launch handle. Never signal
    // a separately re-inspected numeric PID or a potentially reused group ID.
    try {
      child.kill("SIGTERM");
      await Promise.race([outputPromise, sleep(500)]);
      child.kill("SIGKILL");
      await outputPromise.catch(() => undefined);
    } catch {
      // The authoritative child handle already observed process exit.
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

function sourceSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function bounded(value: string): string {
  return value.length <= MAX_CAPTURE_BYTES
    ? value
    : value.slice(value.length - MAX_CAPTURE_BYTES);
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
