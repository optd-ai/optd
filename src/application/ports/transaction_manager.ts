import type { TransactionPort } from "./repair/repositories.ts";

/** Semantic alias retained for existing callers of the frozen transaction port. */
export type TransactionManager<TContext = void> = TransactionPort<TContext>;

export class NoopTransactionManager implements TransactionManager<void> {
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }
}
