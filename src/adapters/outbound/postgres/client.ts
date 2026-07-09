import postgres from "npm:postgres";

export type Sql = ReturnType<typeof postgres>;
// postgres.js exposes compatible `unsafe` helpers on root clients and
// transaction clients, but its generic parameter types differ between them.
// Keep the adapter boundary narrow and normalize rows through `query`.
export type Queryable = {
  // deno-lint-ignore no-explicit-any
  unsafe: any;
};

export type QueryResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  rows: T[];
};

export function createPostgresClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function closePostgresClient(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}

export async function query<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  sql: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  const rows = await sql.unsafe(text, [...params]);
  return { rows: Array.from(rows as Iterable<unknown>) as unknown as T[] };
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function pingPostgres(sql: Queryable): Promise<boolean> {
  const result = await query<{ ok: number }>(sql, "select 1 as ok");
  return result.rows[0]?.ok === 1;
}
