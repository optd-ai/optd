const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
console.log(
  JSON.stringify({
    operations: [{
      op: "transition",
      resource: "lead",
      id: envelope.input.lead_id,
      to: "converted",
    }],
  }),
);
