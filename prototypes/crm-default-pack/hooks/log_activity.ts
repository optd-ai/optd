const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const resource = input.resource;
const objectId = input.object_id;
if (!resource || !objectId || !input.subject || !input.type) {
  console.log(
    JSON.stringify({
      operations: [],
      errors: [{
        path: "/",
        code: "required",
        message: "resource, object_id, type, and subject are required.",
      }],
    }),
  );
  Deno.exit(0);
}
const fields: Record<string, unknown> = {
  subject: input.subject,
  type: input.type,
  status: input.status ?? "planned",
  owner_id: input.owner_id,
  due_at: input.due_at,
};
if (resource === "lead") fields.lead_id = objectId;
if (resource === "opportunity") fields.opportunity_id = objectId;
if (resource === "contact") fields.contact_id = objectId;
const operations: Array<Record<string, unknown>> = [{
  op: "create",
  resource: "operant/crm:activity",
  key: "activity",
  fields,
}];
if (input.note) {
  operations.push({
    op: "create",
    resource: "operant/crm:note",
    fields: {
      body: input.note,
      [`${resource}_id`]: objectId,
      author_id: input.principal_id,
    },
  });
}
console.error(`log_activity ${resource}:${objectId}`);
console.log(JSON.stringify({ operations }));
