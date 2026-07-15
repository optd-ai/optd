const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input?.action_input ?? envelope.input ?? {};
const taskId = input.task_id;
if (!taskId) {
  console.log(
    JSON.stringify({
      operations: [],
      errors: [{
        path: "/task_id",
        code: "required",
        message: "task_id is required.",
      }],
    }),
  );
  Deno.exit(0);
}
console.error(`start_task generating update for ${taskId}`);
console.log(JSON.stringify({
  operations: [{
    op: "update",
    resource: "task",
    object_id: taskId,
    set: {
      state: "in_progress",
      stage_id: input.stage_id ?? "in_progress",
      blocked_reason: "",
    },
  }],
}));
