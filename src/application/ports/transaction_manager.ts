export interface TransactionManager {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export class NoopTransactionManager implements TransactionManager {
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return await fn();
  }
}
