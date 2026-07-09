import {
  actorFor,
  bootstrapSuperAdmin,
  createDb,
  createSecret,
  grantRole,
  inspect,
  readSecret,
} from "./secret-bootstrap-spike.ts";

Deno.test("super admin bootstraps admin role with secret permissions", async () => {
  const db = await createDb();
  try {
    await bootstrapSuperAdmin(db, "root");
    await grantRole(db, await actorFor(db, "root"), "alice", "admin");
    await createSecret(
      db,
      await actorFor(db, "alice"),
      "clearbit_api_key",
      "sk_test_secret",
    );
    const value = await readSecret(
      db,
      await actorFor(db, "alice"),
      "clearbit_api_key",
    );
    if (value !== "sk_test_secret") {
      throw new Error("admin could not read secret");
    }
    const state = await inspect(db) as any;
    if (
      !state.permissions.some((p: any) =>
        p.role_name === "admin" && p.action === "secret.create"
      )
    ) {
      throw new Error("admin role missing secret.create permission");
    }
    if (
      !state.audit.some((e: any) => e.event_type === "bootstrap.super_admin")
    ) throw new Error("missing bootstrap audit");
  } finally {
    await db.close();
  }
});

Deno.test("non admin cannot access secrets until granted", async () => {
  const db = await createDb();
  try {
    await bootstrapSuperAdmin(db, "root");
    await createSecret(db, await actorFor(db, "root"), "crm_api_key", "secret");
    try {
      await readSecret(db, { id: "bob", roles: [] }, "crm_api_key");
      throw new Error("expected permission denial");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("permission denied")
      ) throw error;
    }
    await grantRole(db, await actorFor(db, "root"), "bob", "admin");
    const value = await readSecret(
      db,
      await actorFor(db, "bob"),
      "crm_api_key",
    );
    if (value !== "secret") {
      throw new Error("granted admin could not read secret");
    }
  } finally {
    await db.close();
  }
});
