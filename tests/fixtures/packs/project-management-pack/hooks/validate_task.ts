const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const operation = envelope.input?.operation ?? {};
const before = envelope.input?.current ?? null;
const after = envelope.input?.proposed ?? operation.fields ?? {};
const resource = operation.resource ?? "";
const errors = [];
const warnings = [];
if (resource.endsWith(".task") || resource === "task") {
  if (!after.title || String(after.title).trim() === "") {
    errors.push({
      path: "/fields/title",
      code: "required",
      message: "Task title is required.",
    });
  }
  if (
    after.state === "blocked" &&
    (!after.blocked_reason || String(after.blocked_reason).trim() === "")
  ) {
    errors.push({
      path: "/fields/blocked_reason",
      code: "blocked_reason_required",
      message: "Blocked tasks require blocked_reason.",
    });
  }
  if (
    after.state === "done" && after.blocked_reason &&
    String(after.blocked_reason).trim() !== ""
  ) {
    errors.push({
      path: "/fields/blocked_reason",
      code: "blocked_reason_unresolved",
      message: "Done tasks must have no active blocked_reason.",
    });
  }
  if (before?.state && after.state && before.state !== after.state) {
    const allowed = new Set([
      "todo->in_progress",
      "blocked->in_progress",
      "todo->blocked",
      "in_progress->blocked",
      "in_progress->done",
      "blocked->done",
    ]);
    const edge = `${before.state}->${after.state}`;
    if (!allowed.has(edge)) {
      errors.push({
        path: "/fields/state",
        code: "invalid_transition",
        message: `Task transition ${edge} is not allowed.`,
      });
    }
  }
}
if (resource.endsWith(".timesheet_entry") || resource === "timesheet_entry") {
  const hours = Number(after.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    errors.push({
      path: "/fields/hours",
      code: "invalid_hours",
      message: "Timesheet hours must be greater than 0 and no more than 24.",
    });
  }
}
console.error(
  `validate_task errors=${errors.length} warnings=${warnings.length}`,
);
console.log(JSON.stringify({ errors, warnings }));
