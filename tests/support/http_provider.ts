export type ProviderBehavior =
  | { kind: "success"; status?: number; body?: unknown }
  | { kind: "delay"; delayMs: number; status?: number; body?: unknown }
  | {
    kind: "retry";
    status?: number;
    retryAfterSeconds: number;
    body?: unknown;
  }
  | { kind: "permanent_failure"; status?: number; body?: unknown }
  | { kind: "hold"; token: string; status?: number; body?: unknown };

export type ProviderAttempt = {
  id: number;
  method: string;
  path: string;
  idempotencyKey: string | null;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
  duplicate: boolean;
};

export type HttpProvider = {
  url: string;
  attempts: ProviderAttempt[];
  effects: ProviderAttempt[];
  enqueue(...behaviors: ProviderBehavior[]): void;
  release(token: string): void;
  waitForAttempts(
    count: number,
    timeoutMs?: number,
  ): Promise<ProviderAttempt[]>;
  close(): Promise<void>;
};

export function startHttpProvider(
  initial: ProviderBehavior[] = [],
  options: { hostname?: string; advertisedHostname?: string } = {},
): HttpProvider {
  const controller = new AbortController();
  const queue = [...initial];
  const attempts: ProviderAttempt[] = [];
  const effects: ProviderAttempt[] = [];
  const effectedKeys = new Set<string>();
  const waiters = new Set<() => void>();
  const holds = new Map<string, () => void>();
  const server = Deno.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen() {},
  }, async (request) => {
    const behavior = queue.shift() ?? { kind: "success" };
    const key = request.headers.get("idempotency-key");
    const duplicate = key !== null && effectedKeys.has(key);
    const attempt: ProviderAttempt = {
      id: attempts.length + 1,
      method: request.method,
      path: new URL(request.url).pathname,
      idempotencyKey: key,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
      receivedAt: Date.now(),
      duplicate,
    };
    attempts.push(attempt);
    if (
      !duplicate && (behavior.kind === "success" || behavior.kind === "delay" ||
        behavior.kind === "hold")
    ) {
      effects.push(attempt);
      if (key !== null) effectedKeys.add(key);
    }
    for (const notify of waiters) notify();

    if (behavior.kind === "delay") {
      await abortableDelay(behavior.delayMs, controller.signal).catch(() =>
        undefined
      );
    } else if (behavior.kind === "hold") {
      await new Promise<void>((resolve) => {
        holds.set(behavior.token, resolve);
        if (controller.signal.aborted) resolve();
      });
      holds.delete(behavior.token);
    }
    const status = behavior.kind === "retry"
      ? behavior.status ?? 503
      : behavior.kind === "permanent_failure"
      ? behavior.status ?? 422
      : behavior.status ?? 200;
    const headers = new Headers({ "content-type": "application/json" });
    if (behavior.kind === "retry") {
      headers.set("retry-after", String(behavior.retryAfterSeconds));
    }
    return new Response(JSON.stringify(behavior.body ?? { ok: status < 400 }), {
      status,
      headers,
    });
  });
  const address = server.addr as Deno.NetAddr;

  return {
    url: `http://${
      options.advertisedHostname ?? address.hostname
    }:${address.port}`,
    attempts,
    effects,
    enqueue(...behaviors) {
      queue.push(...behaviors);
    },
    release(token) {
      const release = holds.get(token);
      if (!release) throw new Error(`provider hold ${token} is not active`);
      release();
    },
    async waitForAttempts(count, timeoutMs = 5_000) {
      if (attempts.length >= count) return attempts.slice(0, count);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const notify = () => {
            if (attempts.length < count) return;
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
          timer = setTimeout(() => {
            waiters.delete(notify);
            reject(
              new Error(
                `provider received ${attempts.length}/${count} attempts`,
              ),
            );
          }, timeoutMs);
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      return attempts.slice(0, count);
    },
    async close() {
      controller.abort();
      for (const release of holds.values()) release();
      holds.clear();
      for (const notify of waiters) notify();
      waiters.clear();
      await server.finished.catch((error) => {
        if (!(error instanceof Deno.errors.Interrupted)) throw error;
      });
    },
  };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", aborted, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(signal.reason);
    }
  });
}
