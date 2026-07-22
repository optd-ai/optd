import {
  type ActorValue,
  type FieldSpec,
  type LoweredExpression,
  lowerExpression,
} from "../expressions/cel.ts";

export const AFTER_COMMIT_CONDITION_FIELDS: Readonly<
  Record<string, FieldSpec>
> = {
  event_id: { type: "string", format: "uuid" },
  event_type: { type: "string" },
  project_id: { type: "string", nullable: true, format: "uuid" },
  resource: { type: "string", nullable: true },
  object_id: { type: "string", nullable: true, format: "uuid" },
  object_version_id: { type: "string", nullable: true, format: "uuid" },
  version: { type: "integer", nullable: true },
  operation: { type: "string", nullable: true },
  archived_at: { type: "timestamp", nullable: true },
};

export type AfterCommitActor = Readonly<{
  id: string | null;
  human_user_id: string | null;
  auth_context_id: string | null;
}>;

export function lowerAfterCommitCondition(
  source: string,
  options: {
    alias?: string;
    parameterOffset?: number;
    actor?: AfterCommitActor;
  } = {},
): LoweredExpression {
  const actor = options.actor ?? {
    id: null,
    human_user_id: null,
    auth_context_id: null,
  };
  const actorFields: Record<string, ActorValue> = {
    id: { type: "string", value: actor.id },
    human_user_id: { type: "string", value: actor.human_user_id },
    auth_context_id: { type: "string", value: actor.auth_context_id },
  };
  return lowerExpression(source, {
    fields: AFTER_COMMIT_CONDITION_FIELDS,
    actor: actorFields,
    alias: options.alias,
    parameterOffset: options.parameterOffset,
    allowNull: true,
  });
}
