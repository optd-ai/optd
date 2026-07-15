const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input ?? {};
const opportunityId = input.opportunity_id ?? input.id;
const expected_version = input.expected_version ?? input.version;
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
    operations: [{
      op: "transition",
      resource: "opportunity",
      object_id: opportunityId,
      to: "won",
      expected_version,
      set: { probability: 100 },
    }],
  }));
}
