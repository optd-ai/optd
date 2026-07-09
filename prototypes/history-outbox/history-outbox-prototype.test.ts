import {
  commitCreateLead,
  commitUpdateLead,
  createDb,
  inspect,
  processOutbox,
} from "./history-outbox-prototype.ts";

Deno.test("commits create immutable object versions and current projection pointers", async () => {
  const db = await createDb();
  try {
    await commitCreateLead(db);
    await commitUpdateLead(db);
    const state = await inspect(db) as any;
    if (state.current[0].version !== 2) {
      throw new Error("expected current version 2");
    }
    if (!state.current[0].current_object_version_id) {
      throw new Error("missing current_object_version_id");
    }
    if (state.versions.length !== 2) {
      throw new Error(
        `expected two object versions, got ${state.versions.length}`,
      );
    }
    if (state.versions[1].previous_version_id !== state.versions[0].id) {
      throw new Error("version chain not linked");
    }
    if (!state.versions[1].changed_fields.includes("status")) {
      throw new Error("missing changed_fields cache");
    }
    if (!state.audit.every((a: any) => a.object_version_id)) {
      throw new Error("audit should point to object versions");
    }
    if (!state.events.every((e: any) => e.object_version_id)) {
      throw new Error("events should point to object versions");
    }
  } finally {
    await db.close();
  }
});

Deno.test("outbox processes committed events through hook executions using immutable snapshots", async () => {
  const db = await createDb();
  try {
    await commitCreateLead(db);
    await commitUpdateLead(db);
    await processOutbox(db);
    await processOutbox(db);
    const state = await inspect(db) as any;
    if (state.outbox.length !== 2) throw new Error("expected two outbox rows");
    if (!state.outbox.every((o: any) => o.status === "succeeded")) {
      throw new Error("expected succeeded outbox rows");
    }
    if (state.executions.length !== 2) {
      throw new Error("expected two hook executions");
    }
    if (!state.executions.every((e: any) => e.outbox_id)) {
      throw new Error("hook executions should point to outbox rows");
    }
  } finally {
    await db.close();
  }
});
