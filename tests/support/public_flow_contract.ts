export type PublicFlowCommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type PublicFlowProcess = Readonly<{
  pid: number;
  wait(): Promise<PublicFlowCommandResult>;
  terminate(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
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
    options?: Readonly<{ env?: Readonly<Record<string, string>> }>,
  ): Promise<PublicFlowCommandResult>;
  spawnCli(
    args: readonly string[],
    options?: Readonly<{ env?: Readonly<Record<string, string>> }>,
  ): Promise<PublicFlowProcess>;

  packPath(pack: "crm" | "projects" | "migration"): Promise<string>;
  uploadPack(path: string): Promise<string>;
  restartServer(): Promise<void>;
  waitForProviderBarrier(name: string): Promise<void>;
  releaseProviderBarrier(name: string): Promise<void>;
  diagnostics(): Promise<PublicFlowDiagnostics>;
  cleanup(): Promise<void>;
}

export type CompleteFlowDriver = (
  harness: CompletePublicFlowHarness,
) => Promise<void>;
