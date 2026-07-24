const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const task = envelope.input.task;
console.error(`complete_task transitioning ${input.task_id}`);
console.log(JSON.stringify({
  operations: [
    {
      op: "transition",
      resource: "task",
      object_id: input.task_id,
      to: "done",
      expected_version: task.version,
      set: {
        stage_id: input.stage_id,
        blocked_reason: "",
        spent_hours: input.spent_hours,
      },
    },
    {
      op: "create",
      resource: "timesheet_entry",
      fields: {
        task_id: input.task_id,
        principal_id: input.principal_id,
        hours: input.spent_hours,
        entry_date: input.entry_date,
        description: "Task completion",
      },
    },
  ],
}));
