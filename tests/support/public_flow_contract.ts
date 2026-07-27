export type PublicFlowCommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type PublicFlowCliOptions = Readonly<{
  stdin?: string;
  env?: Readonly<Record<string, string>>;
}>;

export type PublicFlowProcess = Readonly<{
  pid: number;
  wait(): Promise<PublicFlowCommandResult>;
  terminate(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}>;

export type PublicFlowProcessTreeKind = "human" | "request_only" | "agent";

/** An isolated persistent CLI process tree with its own opaque auth store. */
export interface PublicFlowLauncher {
  readonly kind: PublicFlowProcessTreeKind;
  runCli(
    args: readonly string[],
    options?: PublicFlowCliOptions,
  ): Promise<PublicFlowCommandResult>;
  spawnCli(
    args: readonly string[],
    options?: PublicFlowCliOptions,
  ): Promise<PublicFlowProcess>;
  close(): Promise<void>;
}

export type PublicFlowConcurrentRequest = Readonly<{
  args: readonly string[];
  options?: PublicFlowCliOptions;
  launcher?: PublicFlowLauncher;
}>;

export type PublicFlowRestartOptions = Readonly<{
  bootstrapToken?: string | null;
  environment?: Readonly<Record<string, string | null>>;
}>;

export type PublicFlowDiagnostics = Readonly<{
  serverLogs: string;
  processTree: readonly number[];
  runtimeResources: readonly string[];
}>;

/** Capabilities shared by host-Hono and exact release-image acceptance. */
export interface CompletePublicFlowHarness {
  readonly backend: "host" | "release_container";
  readonly serverOrigin: string;

  compileCurrentCli(): Promise<string>;
  runCli(
    args: readonly string[],
    options?: PublicFlowCliOptions,
  ): Promise<PublicFlowCommandResult>;
  spawnCli(
    args: readonly string[],
    options?: PublicFlowCliOptions,
  ): Promise<PublicFlowProcess>;
  createProcessTreeLauncher(
    kind: PublicFlowProcessTreeKind,
  ): Promise<PublicFlowLauncher>;
  runConcurrent(
    requests: readonly PublicFlowConcurrentRequest[],
  ): Promise<readonly PublicFlowCommandResult[]>;

  packPath(pack: "crm" | "projects" | "migration"): Promise<string>;
  uploadPack(path: string): Promise<string>;
  crashServer(): Promise<void>;
  restartServer(options?: PublicFlowRestartOptions): Promise<void>;
  waitUntilReady(): Promise<void>;
  waitForProviderBarrier(name: string): Promise<void>;
  releaseProviderBarrier(name: string): Promise<void>;
  diagnostics(): Promise<PublicFlowDiagnostics>;
  cleanup(): Promise<void>;
}

export type CompleteFlowDriver = (
  harness: CompletePublicFlowHarness,
) => Promise<void>;
