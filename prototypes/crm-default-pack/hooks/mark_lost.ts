const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const actor = envelope.input.actor;
const opportunityId = input.opportunity_id;
if (!opportunityId || !input.lost_reason_id) {
  console.log(
    JSON.stringify({
      operations: [],
      errors: [{
        path: "/",
        code: "required",
        message: "opportunity_id and lost_reason_id are required.",
      }],
    }),
  );
} else {
  const operations: Array<Record<string, unknown>> = [
    {
      op: "transition",
      resource: "optd/crm:opportunity",
      object_id: opportunityId,
      to: "lost",
      expected_version: input.expected_version,
      set: { probability: 0, lost_reason_id: input.lost_reason_id },
    },
  ];
  if (input.note) {
    operations.push({
      op: "create",
      resource: "optd/crm:note",
      fields: {
        body: input.note,
        opportunity_id: opportunityId,
        author_id: actor.id,
      },
    });
  }
  console.error(`mark_lost ${opportunityId}`);
  console.log(
    JSON.stringify({ operations }),
  );
}
