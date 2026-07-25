const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const task = envelope.input.task;
console.error(`block_task transitioning ${input.task_id}`);
console.log(JSON.stringify({
  operations: [{
    op: "transition",
    resource: "operant/projects:task",
    object_id: input.task_id,
    to: "blocked",
    expected_version: task.version,
    set: {
      stage_id: input.stage_id,
      blocked_reason: input.blocked_reason.trim(),
    },
  }],
}));
