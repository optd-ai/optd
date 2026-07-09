export interface TransactionManager<TContext = void> {
  transaction<T>(fn: (context: TContext) => Promise<T>): Promise<T>;
}

export class NoopTransactionManager implements TransactionManager<void> {
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }
}
