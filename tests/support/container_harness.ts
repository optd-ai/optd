const MAX_CAPTURE_BYTES = 1024 * 1024;

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
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
  waitReady(timeoutMs?: number): Promise<Record<string, unknown>>;
  logs(): Promise<string>;
  cleanup(): Promise<void>;
};

type RunOptions = {
  timeoutMs?: number;
  stdin?: string;
  allowFailure?: boolean;
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

  const docker = async (args: string[], options: RunOptions = {}) =>
    await runCommand("docker", args, options);
  const logs = async () => {
    const result = await docker(["logs", container], {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    return bounded(`${result.stdout}\n${result.stderr}`);
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
      cleanupArgs.push(["volume", "rm", "-f", volume]);
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
      cleanupArgs.unshift(["rm", "-f", "-v", container]);
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
    logs,
    async cleanup() {
      for (const args of cleanupArgs) {
        await docker(args, { timeoutMs: 20_000, allowFailure: true });
      }
      cleanupArgs.length = 0;
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
