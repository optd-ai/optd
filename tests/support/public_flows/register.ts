import type { CompleteBackendDriver } from "./matrix.ts";
import { runCompletePublicFlowMatrix } from "./matrix.ts";
import { createHostPublicFlowBackend } from "./host_adapter.ts";
import { createContainerPublicFlowBackend } from "./container_adapter.ts";
import { startLiveHarness } from "../live_harness.ts";

export function registerHostPublicFlowMatrix(): void {
  Deno.test({
    name: "forced-current host CLI completes the shared public-flow matrix",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      await runCompletePublicFlowMatrix(async (
        _driver: CompleteBackendDriver,
      ) =>
        createHostPublicFlowBackend(
          await startLiveHarness({
            forceFreshCompile: true,
            environment: {
              OPERANT_OUTBOX_POLL_INTERVAL_MS: "60000",
              OPERANT_OUTBOX_INITIAL_BACKOFF_MS: "600000",
              OPERANT_OUTBOX_MAX_BACKOFF_MS: "600000",
              OPERANT_SECRET_MASTER_KEY: btoa(
                String.fromCharCode(
                  ...crypto.getRandomValues(new Uint8Array(32)),
                ),
              ),
            },
          }),
        )
      );
    },
  });
}

export function registerContainerPublicFlowMatrix(
  image: () => Promise<string>,
): void {
  Deno.test({
    name:
      "container release: exact-image CLI completes the shared public-flow matrix",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const exactImage = await image();
      await runCompletePublicFlowMatrix((_driver: CompleteBackendDriver) =>
        createContainerPublicFlowBackend(exactImage)
      );
    },
  });
}
