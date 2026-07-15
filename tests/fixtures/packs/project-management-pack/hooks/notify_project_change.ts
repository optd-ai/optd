const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const event = envelope.input?.event ?? {};
console.error(
  `project change notification accepted for ${event.resource ?? "unknown"}:${
    event.object_id ?? "unknown"
  }`,
);
console.log(JSON.stringify({ errors: [], warnings: [] }));
