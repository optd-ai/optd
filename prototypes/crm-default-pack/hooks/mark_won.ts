const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input ?? {};
const opportunityId = input.opportunity_id ?? input.id;
const expectedVersion = input.expected_version ?? input.version;
if (!opportunityId) {
  console.log(
    JSON.stringify({
      operations: [],
      errors: [{
        path: "/opportunity_id",
        code: "required",
        message: "Opportunity id is required.",
      }],
    }),
  );
} else {
  console.error(`mark_won ${opportunityId}`);
  console.log(JSON.stringify({
    summary: "Mark opportunity as won.",
    operations: [{
      op: "transition",
      resource: "opportunity",
      id: opportunityId,
      to: "won",
      expectedVersion,
    }, {
      op: "update",
      resource: "opportunity",
      id: opportunityId,
      fields: { probability: 100 },
    }],
  }));
}
