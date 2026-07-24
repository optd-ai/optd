const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const task = envelope.input.task;
console.error(`start_task transitioning ${input.task_id}`);
console.log(JSON.stringify({
  operations: [{
    op: "transition",
    resource: "task",
    object_id: input.task_id,
    to: "in_progress",
    expected_version: task.version,
    set: {
      stage_id: input.stage_id,
      blocked_reason: "",
    },
  }],
}));
