const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const op = envelope.input.operation;
const patches = [];
if (op?.fields?.email && typeof op.fields.email === "string") {
  patches.push({
    op: "set",
    path: "/fields/email",
    value: op.fields.email.trim().toLowerCase(),
  });
}
if (op?.fields && !op.fields.status) {
  patches.push({ op: "set", path: "/fields/status", value: "new" });
}
console.error(`normalize_lead processed ${patches.length} patches`);
console.log(
  JSON.stringify({
    allow: true,
    patches,
    warnings: [],
    summary: "Normalized lead input.",
  }),
);
