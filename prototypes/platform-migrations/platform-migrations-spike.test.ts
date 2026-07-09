import {
  applyPlatformMigrations,
  createDb,
  inspectMigrations,
  platformMigrations,
} from "./platform-migrations-spike.ts";

Deno.test("platform migrations apply idempotently and detect checksum drift", async () => {
  const db = await createDb();
  try {
    const first = await applyPlatformMigrations(db);
    if (first.applied.length !== platformMigrations.length) {
      throw new Error("expected first apply");
    }
    const second = await applyPlatformMigrations(db);
    if (second.applied.length !== 0) {
      throw new Error("expected idempotent second apply");
    }
    const rows = await inspectMigrations(db);
    if (rows.length !== platformMigrations.length) {
      throw new Error("missing migration rows");
    }
    try {
      await applyPlatformMigrations(db, [{
        ...platformMigrations[0],
        sql: platformMigrations[0].sql + "; select 1",
      }]);
      throw new Error("expected checksum drift failure");
    } catch (error) {
      if (
        !(error instanceof Error) || !error.message.includes("checksum changed")
      ) throw error;
    }
  } finally {
    await db.close();
  }
});
