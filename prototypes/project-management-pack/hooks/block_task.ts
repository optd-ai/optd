const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input?.action_input ?? envelope.input ?? {};
const errors = [];
if (!input.task_id) {
  errors.push({
    path: "/task_id",
    code: "required",
    message: "task_id is required.",
  });
}
if (!input.blocked_reason || String(input.blocked_reason).trim() === "") {
  errors.push({
    path: "/blocked_reason",
    code: "blocked_reason_required",
    message: "blocked_reason is required when blocking a task.",
  });
}
if (errors.length) {
  console.log(JSON.stringify({ operations: [], errors }));
  Deno.exit(0);
}
console.error(`block_task generating update for ${input.task_id}`);
console.log(JSON.stringify({
  operations: [{
    op: "update",
    resource: "task",
    id: input.task_id,
    fields: {
      state: "blocked",
      stage_id: input.stage_id ?? "blocked",
      blocked_reason: String(input.blocked_reason).trim(),
    },
  }],
}));
