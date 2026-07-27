import type {
  StageHookDeclaration,
  StageHookInput,
} from "../../../domain/changesets/stage.ts";
export { StageHookError } from "../../ports/hook_executor.ts";

export type HookEnvelope = Readonly<{
  hook: string;
  phase: string;
  input: Record<string, unknown>;
  metadata: {
    pack_revision: string;
    script_digest: string;
    attachment_id: string;
  };
}>;

export function buildHookEnvelope(
  declaration: StageHookDeclaration,
  input: StageHookInput,
  working: Readonly<Record<string, Record<string, unknown>>>,
): HookEnvelope {
  const operation = declaration.operation_key === null
    ? null
    : input.operations.find((value) =>
      value.key === declaration.operation_key
    ) ?? null;
  const context: Record<string, unknown> = {
    "$operation": operation,
    "$project_id": operation?.project_id ?? null,
    "$current": declaration.operation_key === null
      ? null
      : input.base_states[declaration.operation_key],
    "$proposed": declaration.operation_key === null
      ? null
      : working[declaration.operation_key],
    "$object_version": null,
  };
  return {
    hook: declaration.hook,
    phase: declaration.phase,
    input: mapValue(declaration.input_mapping, context) as Record<
      string,
      unknown
    >,
    metadata: {
      pack_revision: declaration.pack_revision_id,
      script_digest: declaration.script_digest,
      attachment_id: declaration.attachment_id,
    },
  };
}

function mapValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) return context[value];
  if (Array.isArray(value)) return value.map((item) => mapValue(item, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        mapValue(item, context),
      ]),
    );
  }
  return value;
}
