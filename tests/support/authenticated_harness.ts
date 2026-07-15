import { type LiveHarness, startLiveHarness } from "./live_harness.ts";

export async function startAuthenticatedHarness(): Promise<LiveHarness> {
  const harness = await startLiveHarness();
  const bootstrap = await harness.bootstrap({
    username: "scenario-admin",
    password: "scenario bootstrap password",
    displayName: "Scenario Administrator",
  });
  if (bootstrap.code !== 0) {
    const diagnostics = await harness.diagnostics().catch(() => undefined);
    await harness.close({ retain: true }).catch(() => undefined);
    throw new Error(
      `scenario bootstrap failed: ${bootstrap.stderr}\n${
        diagnostics?.server ?? ""
      }`,
    );
  }
  return harness;
}
