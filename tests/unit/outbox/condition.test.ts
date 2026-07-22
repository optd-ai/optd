// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { lowerAfterCommitCondition } from "../../../src/domain/outbox/condition.ts";

Deno.test("after-commit conditions lower the frozen compound context", () => {
  const lowered = lowerAfterCommitCondition(
    'active() && event_type == "object.created" && version >= 2 && resource != null && actor.id == "principal"',
    {
      alias: "ctx",
      actor: {
        id: "principal",
        human_user_id: "human",
        auth_context_id: "context",
      },
    },
  );
  assertEquals(lowered.params, ["object.created", 2, "principal", "principal"]);
  assertEquals(lowered.sql.includes('"ctx"."archived_at" is null'), true);
  assertEquals(lowered.sql.includes('"ctx"."resource" is not null'), true);
});

Deno.test("after-commit conditions support false, strings, numbers and null", () => {
  for (
    const expression of [
      "false || version == 1",
      'operation == "archive" || archived_at != null',
      "project_id == null && object_version_id == null",
    ]
  ) lowerAfterCommitCondition(expression);
});

Deno.test("after-commit conditions reject malformed, mistyped and unavailable context", () => {
  for (
    const expression of [
      "version +",
      'version == "one"',
      "session_id == null",
      "actor.roles == null",
      "active(1)",
    ]
  ) assertThrows(() => lowerAfterCommitCondition(expression));
});
