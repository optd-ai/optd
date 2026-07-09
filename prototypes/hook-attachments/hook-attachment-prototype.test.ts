import {
  commitCreateLead,
  createDb,
  inspect,
  previewActionConvertLead,
  previewCreateLead,
  processOutbox,
} from "./hook-attachment-prototype.ts";

Deno.test("resource hook attachments normalize and validate changeset preview", async () => {
  const db = await createDb();
  try {
    const preview = await previewCreateLead(db, {
      name: " Jane ",
      email: "JANE@EXAMPLE.COM",
    }) as any;
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    if (preview.operation.fields.email !== "jane@example.com") {
      throw new Error("normalize hook did not patch email");
    }
    if (preview.operation.fields.status !== "new") {
      throw new Error("normalize hook did not default status");
    }
    if (
      !preview.validation.warnings.some((w: any) =>
        w.code === "missing_company"
      )
    ) throw new Error("validation hook warning missing");
  } finally {
    await db.close();
  }
});

Deno.test("action hook attachment emits changeset operations", async () => {
  const db = await createDb();
  try {
    const result = await previewActionConvertLead(db, "lead_1") as any;
    if (!result.operations.some((op: any) => op.resource === "opportunity")) {
      throw new Error("missing opportunity operation");
    }
    if (!result.operations.some((op: any) => op.op === "transition")) {
      throw new Error("missing transition operation");
    }
  } finally {
    await db.close();
  }
});

Deno.test("after commit hook attachment enqueues outbox and records execution", async () => {
  const db = await createDb();
  try {
    const commit = await commitCreateLead(db, {
      name: "Jane",
      email: "jane@example.com",
      company_name: "Acme",
    }) as any;
    if (!commit.committed) throw new Error(JSON.stringify(commit));
    let state = await inspect(db) as any;
    if (state.outbox.length !== 1 || state.outbox[0].status !== "pending") {
      throw new Error("expected pending outbox");
    }
    await processOutbox(db);
    state = await inspect(db) as any;
    if (state.outbox[0].status !== "succeeded") {
      throw new Error("expected succeeded outbox");
    }
    if (
      state.executions.length !== 1 ||
      state.executions[0].status !== "succeeded"
    ) throw new Error("expected hook execution");
  } finally {
    await db.close();
  }
});
