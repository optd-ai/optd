import {
  findPostgresBins,
  psql,
  startManagedPostgres,
  stopManagedPostgres,
} from "./app-managed-postgres-spike.ts";

Deno.test("app-managed Postgres lifecycle starts initdb postgres psql and stops", async () => {
  const bins = await findPostgresBins();
  if (!bins) {
    console.log("skipping: postgres binaries not found; use direnv/nix shell");
    return;
  }
  const root = await Deno.makeTempDir({ prefix: "operant-pg-" });
  let pg;
  try {
    pg = await startManagedPostgres(root);
    const answer = await psql(
      pg,
      "create table spike(id text primary key); insert into spike values ('ok'); select id from spike;",
    );
    if (answer.split("\n").at(-1) !== "ok") {
      throw new Error(`unexpected psql output ${answer}`);
    }
  } finally {
    if (pg) await stopManagedPostgres(pg);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
