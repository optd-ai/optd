const MAX_CAPTURE_BYTES = 1024 * 1024;

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ContainerCliResult = CommandResult & { argv: string[] };

export type ContainerCliLauncher = {
  runOptctl(args: string[], stdin?: string): Promise<ContainerCliResult>;
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
  runOptctl(args: string[], stdin?: string): Promise<ContainerCliResult>;
  createProcessTreeLauncher(): Promise<ContainerCliLauncher>;
  copyPack(hostPath: string): Promise<string>;
  logs(): Promise<string>;
  cleanup(): Promise<void>;
};

type RunOptions = {
  timeoutMs?: number;
  stdin?: string;
  allowFailure?: boolean;
  env?: Record<string, string>;
};

export async function buildReleaseImage(): Promise<string> {
  const image = Deno.env.get("OPERANT_CONTAINER_IMAGE") ??
    `operant:container-release-${sourceSuffix()}`;
  if (Deno.env.get("OPERANT_CONTAINER_SKIP_BUILD") === "1") return image;
  const revision = (await runCommand("git", ["rev-parse", "HEAD"])).stdout
    .trim();
  await runCommand("docker", [
    "build",
    "--pull=false",
    "--no-cache",
    "--build-arg",
    `OPERANT_REVISION=${revision}`,
    "--build-arg",
    "OPERANT_VERSION=0.1.0-dev",
    "--tag",
    image,
    ".",
  ], { timeoutMs: 15 * 60_000 });
  return image;
}

export async function createContainerHarness(
  image: string,
): Promise<ContainerHarness> {
  const id = `operant-cr-${
    crypto.randomUUID().replaceAll("-", "").slice(0, 12)
  }`;
  const port = await freePort();
  const volume = `${id}-data`;
  const container = `${id}-app`;
  const bootstrapToken = randomSecret();
  const masterKey = randomSecret();
  const cleanupArgs: string[][] = [];
  let volumeRegistered = false;
  let containerRegistered = false;

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
      "--publish",
      `127.0.0.1:${port}:8789`,
      "--env",
      `OPERANT_BOOTSTRAP_TOKEN=${bootstrapToken}`,
      "--env",
      `OPERANT_SECRET_MASTER_KEY=${masterKey}`,
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
  const runOptctl = async (args: string[], stdin?: string) => {
    const argv = ["--server", "http://127.0.0.1:8789", ...args];
    const result = await docker([
      "exec",
      ...stdin === undefined ? [] : ["--interactive"],
      "--env",
      `HOME=${cliRoot}/home`,
      "--env",
      `XDG_CONFIG_HOME=${cliRoot}/config`,
      "--env",
      `XDG_STATE_HOME=${cliRoot}/state`,
      "--env",
      `OPERANT_AUTH_TREE_STOP_PID=1`,
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
      await docker(["volume", "create", volume]);
      if (!volumeRegistered) {
        cleanupArgs.push(["volume", "rm", "-f", volume]);
        volumeRegistered = true;
      }
      await runContainer(extraArgs);
    },
    async recreateAppManaged(extraArgs = []) {
      await docker(["rm", "-f", container], { allowFailure: true });
      await runContainer(extraArgs);
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
    async createProcessTreeLauncher() {
      const root = `/data/.container-test-clients/${crypto.randomUUID()}`;
      return await createDockerProcessTreeLauncher(container, root);
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
            ...Deno.env.toObject(), HOME: root + "/home",
            XDG_CONFIG_HOME: root + "/config", XDG_STATE_HOME: root + "/state",
            OPERANT_AUTH_TREE_STOP_PID: String(Deno.pid),
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
    async runOptctl(args, stdin) {
      if (closed) throw new Error("container CLI launcher is closed");
      const argv = ["--server", "http://127.0.0.1:8789", ...args];
      let resolveQueue!: () => void;
      const previous = queue;
      queue = new Promise((resolve) => resolveQueue = resolve);
      await previous;
      try {
        await input.write(
          new TextEncoder().encode(`${JSON.stringify({ argv, stdin })}\n`),
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
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("command timeout")),
        options.timeoutMs ?? 60_000,
      );
    });
    const output = await Promise.race([child.output(), timeout]);
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
    try {
      new Deno.Command("kill", { args: ["-TERM", `-${child.pid}`] })
        .outputSync();
      await sleep(500);
      new Deno.Command("kill", { args: ["-KILL", `-${child.pid}`] })
        .outputSync();
    } catch {
      // Process group already exited.
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
