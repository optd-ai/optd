const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const input = envelope.input.action_input;
const task = envelope.input.task;
const actor = envelope.input.actor;
const hasHours = input.spent_hours !== undefined;
const hasDate = input.entry_date !== undefined;
if (hasHours !== hasDate) {
  throw new Error("spent_hours and entry_date must be supplied together");
}
console.error(`complete_task transitioning ${input.task_id}`);
console.log(JSON.stringify({
  operations: [
    {
      op: "transition",
      resource: "optd/projects:task",
      object_id: input.task_id,
      to: "done",
      expected_version: task.version,
      set: {
        stage_id: input.stage_id,
        blocked_reason: "",
        ...(hasHours ? { spent_hours: input.spent_hours } : {}),
      },
    },
    ...(hasHours ? [{
      op: "create",
      resource: "optd/projects:timesheet",
      fields: {
        task_id: input.task_id,
        principal_id: actor.id,
        hours: input.spent_hours,
        entry_date: input.entry_date,
        description: "Task completion",
      },
    }] : []),
  ],
}));
