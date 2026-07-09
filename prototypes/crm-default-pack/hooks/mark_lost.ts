const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input ?? {};
const opportunityId = input.opportunity_id ?? input.id;
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
  const operations = [
    {
      op: "transition",
      resource: "opportunity",
      id: opportunityId,
      to: "lost",
      expectedVersion: input.expected_version ?? input.version,
    },
    {
      op: "update",
      resource: "opportunity",
      id: opportunityId,
      fields: { probability: 0, lost_reason_id: input.lost_reason_id },
    },
  ];
  if (input.note) {
    operations.push({
      op: "create",
      resource: "note",
      fields: {
        body: input.note,
        opportunity_id: opportunityId,
        author_id: input.actor_id,
      },
    });
  }
  console.error(`mark_lost ${opportunityId}`);
  console.log(
    JSON.stringify({ summary: "Mark opportunity as lost.", operations }),
  );
}
