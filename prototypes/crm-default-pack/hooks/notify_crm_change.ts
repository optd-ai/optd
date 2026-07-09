const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
console.error(
  `notify_crm_change event=${
    envelope.input?.event_id ?? envelope.event_id ?? "unknown"
  }`,
);
console.log(JSON.stringify({ errors: [], warnings: [] }));
