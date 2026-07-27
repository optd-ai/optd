import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, type Result } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
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

export function parseResourceIdentity(value: string): {
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
export type ActionStageRequest = Readonly<{
  project_id: string;
  input: Record<string, unknown>;
}>;

/** Physical action catalog/read/authority/hook/persistence workflow pending finer port extraction. */
export interface ActionStagePort {
  stageValidated(
    publisher: string,
    pack: string,
    name: string,
    request: ActionStageRequest,
    auth: AuthContext,
  ): Promise<Result<StageActionResult>>;
}

/** Owns the strict public request boundary before physical action capabilities run. */
export function makeStageActionService(port: ActionStagePort) {
  return Object.freeze({
    stage(
      publisher: string,
      pack: string,
      name: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<StageActionResult>> {
      if (
        !isRecord(raw) ||
        Object.keys(raw).some((key) =>
          key !== "project_id" && key !== "input"
        ) ||
        typeof raw.project_id !== "string" || !isUuidV7(raw.project_id) ||
        !isRecord(raw.input)
      ) {
        return Promise.resolve(err({
          code: "validation_failed",
          message: "action stage request is invalid",
          severity: "validation",
          details: {},
        }));
      }
      return port.stageValidated(publisher, pack, name, {
        project_id: raw.project_id,
        input: raw.input,
      }, auth);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
