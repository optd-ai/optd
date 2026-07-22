export type PollBatch = () => Promise<{ claimed: number }>;

export function startOutboxPollLoop(
  processBatch: PollBatch,
  options: { intervalMs: number; shutdownGraceMs: number },
) {
  const controller = new AbortController();
  const task = run();

  async function run() {
    while (!controller.signal.aborted) {
      const result = await processBatch();
      if (controller.signal.aborted) break;
      if (result.claimed === 0) {
        await abortableDelay(options.intervalMs, controller.signal);
      }
    }
  }

  return {
    signal: controller.signal,
    async stop(): Promise<void> {
      controller.abort();
      const settled = task.then(() => true, () => true);
      await Promise.race([
        settled,
        new Promise<void>((resolve) =>
          setTimeout(resolve, options.shutdownGraceMs)
        ),
      ]);
      // SQL remains open until all claimed hooks have settled or their runner
      // timeout has killed them, even if the preferred grace period elapsed.
      await task;
    },
    finished: task,
  };
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
