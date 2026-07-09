import { startServer } from "./changeset-server.ts";

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

Deno.test("changeset preview validates and normalizes payloads over HTTP", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/changesets/preview", {
      actor: "agent_1",
      operations: [
        {
          op: "create",
          resource: "lead",
          as: "lead",
          fields: { name: "  Jane Agent  ", email: "JANE@EXAMPLE.COM" },
        },
      ],
    });

    if (result.status !== 200) {
      throw new Error(`unexpected status ${result.status}`);
    }
    if (!result.json.ok) {
      throw new Error(`expected preview ok: ${JSON.stringify(result.json)}`);
    }
    const normalized = result.json.normalizedOperations[0];
    if (normalized.fields.email !== "jane@example.com") {
      throw new Error("expected email normalization hook behavior");
    }
    if (normalized.fields.name !== "Jane Agent") {
      throw new Error("expected name trimming");
    }
    if (normalized.fields.status !== "new") {
      throw new Error("expected default status patch");
    }
    if (result.json.wouldCommit !== true) {
      throw new Error("expected wouldCommit true");
    }
  });
});

Deno.test("changeset commit writes SQL rows, audit, comments, links, and supports idempotency", async () => {
  await withServer(async (url) => {
    const payload = {
      actor: "agent_1",
      operations: [
        {
          op: "create",
          resource: "company",
          as: "company",
          fields: { name: "Acme" },
        },
        {
          op: "create",
          resource: "contact",
          as: "contact",
          fields: { name: "Ada", email: "ada@example.com" },
        },
        {
          op: "link",
          relationship: "contact_company",
          from: "@contact",
          to: "@company",
          fields: { role: "buyer" },
        },
        {
          op: "update",
          resource: "lead",
          id: "lead_1",
          expectedVersion: 1,
          set: { email: "ADA+NEW@EXAMPLE.COM" },
        },
        {
          op: "comment",
          resource: "lead",
          id: "lead_1",
          body: "Normalized and linked lead.",
        },
      ],
    };

    const first = await post(url, "/changesets/commit", payload, {
      "idempotency-key": "commit-1",
    });
    if (first.status !== 200 || !first.json.committed) {
      throw new Error(`commit failed: ${JSON.stringify(first)}`);
    }
    if (!first.json.ids.company || !first.json.ids.contact) {
      throw new Error("expected operation aliases to resolve to ids");
    }
    if (first.json.auditEvents.length !== 5) {
      throw new Error(
        `expected 5 audit events, got ${first.json.auditEvents.length}`,
      );
    }

    const replay = await post(url, "/changesets/commit", payload, {
      "idempotency-key": "commit-1",
    });
    if (replay.json.changesetId !== first.json.changesetId) {
      throw new Error(
        "expected idempotent replay to return original changeset id",
      );
    }
    if (JSON.stringify(replay.json.ids) !== JSON.stringify(first.json.ids)) {
      throw new Error(
        "expected idempotent replay to return original generated ids",
      );
    }

    const leadResponse = await fetch(`${url}/objects/lead/lead_1`);
    const lead = await leadResponse.json();
    if (lead.email !== "ada+new@example.com") {
      throw new Error(`expected normalized committed email, got ${lead.email}`);
    }
    if (lead.version !== 2) {
      throw new Error(`expected version bump to 2, got ${lead.version}`);
    }
  });
});

Deno.test("changeset commit returns validation errors instead of partially committing", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [
        {
          op: "update",
          resource: "lead",
          id: "lead_1",
          expectedVersion: 99,
          set: { email: "bad@example.com" },
        },
        { op: "transition", resource: "lead", id: "lead_1", to: "converted" },
      ],
    });

    if (result.status !== 200) {
      throw new Error(`unexpected status ${result.status}`);
    }
    if (result.json.committed !== false) {
      throw new Error("expected validation failure, not commit");
    }
    const codes = result.json.validation.errors.map((e: any) => e.code);
    if (!codes.includes("version_conflict")) {
      throw new Error(
        `missing version_conflict: ${JSON.stringify(result.json)}`,
      );
    }
    if (!codes.includes("invalid_transition")) {
      throw new Error(
        `missing invalid_transition: ${JSON.stringify(result.json)}`,
      );
    }

    const lead = await (await fetch(`${url}/objects/lead/lead_1`)).json();
    if (lead.email !== "ADA@EXAMPLE.COM") {
      throw new Error("expected failed commit to leave lead unchanged");
    }
    if (lead.version !== 1) {
      throw new Error("expected failed commit to leave version unchanged");
    }
  });
});

Deno.test("persisted preview commit revalidates and catches stale versions", async () => {
  await withServer(async (url) => {
    const preview = await post(url, "/changesets/preview", {
      actor: "agent_1",
      operations: [
        {
          op: "update",
          resource: "lead",
          id: "lead_1",
          expectedVersion: 1,
          set: { email: "preview@example.com" },
        },
      ],
    });
    if (!preview.json.ok) {
      throw new Error(`preview failed: ${JSON.stringify(preview.json)}`);
    }

    const concurrent = await post(url, "/changesets/commit", {
      actor: "agent_2",
      operations: [
        {
          op: "update",
          resource: "lead",
          id: "lead_1",
          expectedVersion: 1,
          set: { email: "concurrent@example.com" },
        },
      ],
    });
    if (!concurrent.json.committed) {
      throw new Error("expected concurrent commit to succeed");
    }

    const commit = await post(
      url,
      `/changesets/${preview.json.changesetId}/commit`,
      {},
      { "idempotency-key": "persisted-commit" },
    );
    if (commit.json.committed !== false) {
      throw new Error("expected stale persisted commit to fail validation");
    }
    const codes = commit.json.validation.errors.map((e: any) => e.code);
    if (!codes.includes("version_conflict")) {
      throw new Error(
        `missing version_conflict: ${JSON.stringify(commit.json)}`,
      );
    }
  });
});

Deno.test("minimal policy and archive semantics are enforced", async () => {
  await withServer(async (url) => {
    const denied = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [{
        op: "archive",
        resource: "lead",
        id: "lead_1",
        expectedVersion: 1,
      }],
    });
    if (denied.json.committed !== false) {
      throw new Error("expected non-admin archive to be denied");
    }
    if (
      !denied.json.validation.errors.some((e: any) =>
        e.code === "policy_denied"
      )
    ) {
      throw new Error(`missing policy_denied: ${JSON.stringify(denied.json)}`);
    }

    const archived = await post(url, "/changesets/commit", {
      actor: "admin",
      operations: [{
        op: "archive",
        resource: "lead",
        id: "lead_1",
        expectedVersion: 1,
      }],
    });
    if (!archived.json.committed) {
      throw new Error(`admin archive failed: ${JSON.stringify(archived.json)}`);
    }

    const hidden = await fetch(`${url}/objects/lead/lead_1`);
    await hidden.text();
    if (hidden.status !== 400) {
      throw new Error("expected archived object to be hidden by default");
    }
    const visible =
      await (await fetch(`${url}/objects/lead/lead_1?include_archived=true`))
        .json();
    if (!visible.archived_at) {
      throw new Error("expected include_archived to return archived row");
    }

    const updateArchived = await post(url, "/changesets/commit", {
      actor: "admin",
      operations: [{
        op: "update",
        resource: "lead",
        id: "lead_1",
        set: { email: "after@example.com" },
      }],
    });
    if (
      !updateArchived.json.validation.errors.some((e: any) =>
        e.code === "archived_object"
      )
    ) {
      throw new Error(
        `expected archived object update denial: ${
          JSON.stringify(updateArchived.json)
        }`,
      );
    }
  });
});

Deno.test("relationship validation rejects bad aliases and avoids partial commits", async () => {
  await withServer(async (url) => {
    const before = await (await fetch(`${url}/debug/count/company`)).json();
    const failed = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [
        {
          op: "create",
          resource: "company",
          as: "company",
          fields: { name: "Partial Co" },
        },
        {
          op: "link",
          relationship: "contact_company",
          from: "@missing_contact",
          to: "@company",
        },
      ],
    });
    if (failed.json.committed !== false) {
      throw new Error("expected invalid alias changeset not to commit");
    }
    const codes = failed.json.validation.errors.map((e: any) => e.code);
    if (!codes.includes("not_found")) {
      throw new Error(
        `missing not_found for bad alias: ${JSON.stringify(failed.json)}`,
      );
    }
    const after = await (await fetch(`${url}/debug/count/company`)).json();
    if (after.count !== before.count) {
      throw new Error(
        "expected no partial company create after failed link validation",
      );
    }
  });
});

Deno.test("same idempotency key with different payload returns stable 409 error", async () => {
  await withServer(async (url) => {
    const first = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [{
        op: "comment",
        resource: "lead",
        id: "lead_1",
        body: "first",
      }],
    }, { "idempotency-key": "idem-conflict" });
    if (!first.json.committed) {
      throw new Error("expected first idempotent commit to succeed");
    }

    const second = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [{
        op: "comment",
        resource: "lead",
        id: "lead_1",
        body: "different",
      }],
    }, { "idempotency-key": "idem-conflict" });
    if (second.status !== 409) {
      throw new Error(`expected 409, got ${second.status}`);
    }
    if (second.json.error.code !== "conflict") {
      throw new Error(
        `expected stable conflict error: ${JSON.stringify(second.json)}`,
      );
    }
  });
});

Deno.test("explicit multi-resource changeset creates opportunity graph", async () => {
  await withServer(async (url) => {
    const result = await post(url, "/changesets/commit", {
      actor: "agent_1",
      operations: [
        {
          op: "create",
          resource: "company",
          as: "company",
          fields: { name: "Graph Co" },
        },
        {
          op: "create",
          resource: "contact",
          as: "contact",
          fields: { name: "Buyer", email: "buyer@graph.example" },
        },
        {
          op: "create",
          resource: "opportunity",
          as: "opportunity",
          fields: {
            name: "Graph deal",
            company_id: "@company",
            contact_id: "@contact",
            stage: "new",
          },
        },
        {
          op: "link",
          relationship: "contact_company",
          from: "@contact",
          to: "@company",
          fields: { role: "buyer" },
        },
        {
          op: "comment",
          resource: "lead",
          id: "lead_2",
          body: "Created related sales graph.",
        },
      ],
    });
    if (!result.json.committed) {
      throw new Error(
        `multi-resource commit failed: ${JSON.stringify(result.json)}`,
      );
    }
    for (const alias of ["company", "contact", "opportunity"]) {
      if (!result.json.ids[alias]) {
        throw new Error(`missing generated id for ${alias}`);
      }
    }
    if (result.json.auditEvents.length !== 5) {
      throw new Error(
        `expected 5 audit events, got ${result.json.auditEvents.length}`,
      );
    }
  });
});

Deno.test("action endpoint generates changeset operations and commits end to end", async () => {
  await withServer(async (url) => {
    const preview = await post(url, "/actions/convert_lead/preview", {
      actor: "agent_2",
      lead_id: "lead_1",
      expectedVersion: 1,
    });
    if (preview.status !== 200 || !preview.json.ok) {
      throw new Error(`action preview failed: ${JSON.stringify(preview)}`);
    }
    const ops = preview.json.normalizedOperations.map((op: any) => op.op);
    for (const expected of ["create", "link", "transition", "comment"]) {
      if (!ops.includes(expected)) {
        throw new Error(`missing generated action operation ${expected}`);
      }
    }

    const commit = await post(url, "/actions/convert_lead/commit", {
      actor: "agent_2",
      lead_id: "lead_1",
      expectedVersion: 1,
    }, { "idempotency-key": "convert-lead-1" });
    if (commit.status !== 200 || !commit.json.committed) {
      throw new Error(`action commit failed: ${JSON.stringify(commit)}`);
    }

    const lead = await (await fetch(`${url}/objects/lead/lead_1`)).json();
    if (lead.status !== "qualified") {
      throw new Error(`expected lead status qualified, got ${lead.status}`);
    }
    if (
      !commit.json.ids.company || !commit.json.ids.contact ||
      !commit.json.ids.opportunity
    ) {
      throw new Error("expected generated company/contact/opportunity ids");
    }
  });
});
