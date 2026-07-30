import type { CompletePublicFlowBackend } from "./backend.ts";

export type CompleteBackendDriver = (
  backend: CompletePublicFlowBackend,
) => Promise<void>;
import { runCompleteCrmPublicFlow } from "./crm_driver.ts";
import { runCompleteProjectsPublicFlow } from "./projects_driver.ts";

export const COMPLETE_PUBLIC_FLOW_DRIVERS = Object.freeze(
  [
    runCompleteCrmPublicFlow,
    runCompleteProjectsPublicFlow,
  ] as const,
) satisfies readonly CompleteBackendDriver[];

export async function visitCompletePublicFlowDrivers(
  visit: (driver: CompleteBackendDriver) => Promise<void>,
): Promise<void> {
  for (const driver of COMPLETE_PUBLIC_FLOW_DRIVERS) await visit(driver);
}

export async function runCompletePublicFlowMatrix(
  createBackend: (
    driver: CompleteBackendDriver,
  ) => Promise<CompletePublicFlowBackend>,
): Promise<void> {
  await visitCompletePublicFlowDrivers(async (driver) => {
    const backend = await createBackend(driver);
    try {
      await driver(backend);
    } finally {
      await backend.cleanup();
    }
  });
}
