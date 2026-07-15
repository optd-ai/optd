const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const operation = envelope.input?.operation ?? envelope.input?.proposed ?? {};
const fields = operation.fields ?? operation;
const patches = [];
if (typeof fields.email === "string") {
  patches.push({
    op: "replace",
    path: "/email",
    value: fields.email.trim().toLowerCase(),
  });
}
if (typeof fields.name === "string") {
  patches.push({ op: "replace", path: "/name", value: fields.name.trim() });
}
if (!fields.status) {
  patches.push({ op: "add", path: "/status", value: "new" });
}
if (fields.score === undefined) {
  patches.push({ op: "add", path: "/score", value: 0 });
}
console.error(`normalize_lead emitted ${patches.length} patches`);
console.log(JSON.stringify({ patches }));
