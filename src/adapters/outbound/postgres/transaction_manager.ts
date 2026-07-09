import type { TransactionManager } from "../../../application/ports/transaction_manager.ts";
import type { Queryable, Sql } from "./client.ts";

export class PostgresTransactionManager
  implements TransactionManager<Queryable> {
  constructor(private readonly sql: Sql) {}

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx) => await fn(tx)) as T;
  }
}
