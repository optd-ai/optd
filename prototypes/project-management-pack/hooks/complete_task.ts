const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input?.action_input ?? envelope.input ?? {};
if (!input.task_id) {
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
const fields: Record<string, unknown> = {
  state: "done",
  stage_id: input.stage_id ?? "done",
  blocked_reason: "",
};
if (input.spent_hours !== undefined) fields.spent_hours = input.spent_hours;
console.error(`complete_task generating update for ${input.task_id}`);
console.log(
  JSON.stringify({
    operations: [{
      op: "update",
      resource: "task",
      object_id: input.task_id,
      set: fields,
    }],
  }),
);
