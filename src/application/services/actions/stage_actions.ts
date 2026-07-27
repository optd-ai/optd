import type { AuthContext } from "../../../domain/auth/model.ts";
import type { Result } from "../../../domain/errors/result.ts";
import type { StageDto } from "../../ports/stage_repository.ts";
import { validateFieldMap } from "../../../schemas/changesets/field_values.ts";
import type { TargetedActionPolicyTarget } from "../query_objects.ts";

export function validateActionInput(
  input: Record<string, unknown>,
  fields: Record<string, unknown>,
): string | null {
  return validateFieldMap(input, fields, true);
}

export function resolveActionPolicyTargets(
  reads: TargetedActionPolicyTarget[],
  effects: Array<{ resource: string }>,
): TargetedActionPolicyTarget[] | null {
  if (reads.length) return reads;
  const targets: TargetedActionPolicyTarget[] = [];
  for (
    const resource of [...new Set(effects.map((effect) => effect.resource))]
  ) {
    const definition = parseResourceIdentity(resource);
    if (!definition) return null;
    targets.push({ definition });
  }
  return targets.length ? targets : null;
}

function parseResourceIdentity(value: string): {
  kind: "resource";
  publisher: string;
  pack: string;
  name: string;
} | null {
  const match =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(value);
  return match
    ? { kind: "resource", publisher: match[1], pack: match[2], name: match[3] }
    : null;
}

export type StageActionResult = StageDto | {
  status: "no_changes";
  stage: null;
};

/** Application use-case boundary; the adapter owns SQL and pinned hook execution. */
export interface ActionStagePort {
  stage(
    publisher: string,
    pack: string,
    name: string,
    raw: unknown,
    auth: AuthContext,
  ): Promise<Result<StageActionResult>>;
}

export function makeStageActionService(port: ActionStagePort) {
  return Object.freeze({
    stage: (
      publisher: string,
      pack: string,
      name: string,
      raw: unknown,
      auth: AuthContext,
    ) => port.stage(publisher, pack, name, raw, auth),
  });
}
