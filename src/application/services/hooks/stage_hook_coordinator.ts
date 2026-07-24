import type {
  HookAuthoritySnapshot,
  HookGrantSnapshot,
  StageHookCoordinator,
  StageHookDeclaration,
  StageHookExecution,
  StageHookInput,
  StageHookOutput,
} from "../../../domain/changesets/stage.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { applyPatches } from "../../../domain/changesets/patch.ts";
import {
  canonicalizeResolvedOperations,
  type CanonicalOperation,
  DEFAULT_OPERATION_LIMITS,
  type OperationLimits,
  resolveAddedOperations,
} from "../../../domain/changesets/operations.ts";
import {
  type AuthoredOperation,
  authoredOperationContract,
} from "../../../schemas/changesets/operations.ts";
import {
  DenoHookRunner,
  type HookDefinition,
  type HookEnvelope,
} from "../../../adapters/outbound/deno-hooks/hook_runner.ts";
import {
  HookSecretGrantUnavailableError,
  HookSecretUnavailableError,
  type ResolvedHookSecrets,
} from "../../../adapters/outbound/postgres/hook_secret_repository.ts";

export class StageHookError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type ActionStageHookDeclaration =
  & Omit<
    StageHookDeclaration,
    "phase" | "operation_key" | "output_schema"
  >
  & Readonly<{
    phase: "action.stage";
    operation_key: null;
    output_schema: "changeset.operations.v1";
  }>;
export type ActionStageReadDependency = Readonly<{
  name: string;
  project_id: string;
  resource_identity: string;
  object_id: string;
  object_version_id: string;
}>;
export type ActionStageHookInput = Readonly<{
  action: string;
  input: Readonly<Record<string, unknown>>;
  reads: Readonly<Record<string, unknown>>;
  read_dependencies?: readonly ActionStageReadDependency[];
  declarations: readonly ActionStageHookDeclaration[];
  authority_snapshot: HookAuthoritySnapshot;
  limits?: OperationLimits;
  allocate_id?: () => string;
}>;
export type ActionStageHookExecution = Readonly<{
  id: string;
  phase: "action.stage";
  output_schema: "changeset.operations.v1";
  hook: string;
  attachment_id: string;
  hook_revision_id: string;
  pack_revision_id: string;
  script_digest: string;
  security_digest: string;
  input_digest: string;
  output_digest: string;
  output: Readonly<Record<string, unknown>>;
  added_operations: readonly CanonicalOperation[];
  stderr: string;
  logs_truncated: boolean;
  secrets_redacted: boolean;
  duration_ms: number;
  authority_snapshot: HookAuthoritySnapshot;
  grant_snapshot: HookGrantSnapshot;
  read_dependencies: readonly ActionStageReadDependency[];
}>;

export class TrustedStageHookCoordinator implements StageHookCoordinator {
  constructor(
    private readonly secrets: {
      resolve(
        hookRevisionId: string,
        securityDigest: string,
        slots: readonly Readonly<{ slot: string; env: string }>[],
      ): Promise<ResolvedHookSecrets>;
    },
    private readonly runnerOptions: ConstructorParameters<
      typeof DenoHookRunner
    >[0] = {},
  ) {}

  async #resolveSecrets(
    declaration: StageHookDeclaration | ActionStageHookDeclaration,
  ): Promise<ResolvedHookSecrets> {
    try {
      return await this.secrets.resolve(
        declaration.hook_revision_id,
        declaration.security_digest,
        declaration.secret_slots,
      );
    } catch (error) {
      if (
        error instanceof HookSecretUnavailableError ||
        error instanceof HookSecretGrantUnavailableError
      ) {
        throw new StageHookError("hook_secret_unavailable", error.message, {
          hook: declaration.hook,
          slot: error.slot,
        });
      }
      throw error;
    }
  }

  async #runDeclaration(
    declaration: StageHookDeclaration | ActionStageHookDeclaration,
    resolved: ResolvedHookSecrets,
    envelope: HookEnvelope,
  ) {
    const runner = new DenoHookRunner({
      ...this.runnerOptions,
      secretValues: Object.fromEntries(
        declaration.secret_slots.map((slot) => [
          slot.slot,
          resolved.values[slot.env],
        ]),
      ),
    });
    const result = await runner.run(toRunnerDefinition(declaration), envelope);
    if (!result.ok || !result.output) {
      throw new StageHookError(
        result.error?.code ?? "hook_failed",
        result.error?.message ?? "hook execution failed",
        { hook: declaration.hook, logs: result.logs },
      );
    }
    return result;
  }

  async runActionStage(
    input: ActionStageHookInput,
  ): Promise<{
    added_operations: CanonicalOperation[];
    operation_graph_digest: string;
    read_dependencies: ActionStageReadDependency[];
    hook_executions: ActionStageHookExecution[];
  }> {
    let operations: CanonicalOperation[] = [];
    const executions: ActionStageHookExecution[] = [];
    const readDependencies = [...(input.read_dependencies ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    if (
      readDependencies.some((dependency) =>
        !Object.hasOwn(input.reads, dependency.name)
      ) || Object.keys(input.reads).some((name) =>
        !readDependencies.some((dependency) =>
          dependency.name === name
        )
      )
    ) {
      throw new StageHookError(
        "hook_input_invalid",
        "action read evidence does not match curated declared reads",
        {},
      );
    }
    for (
      const declaration of [...input.declarations].sort(compareDeclarations)
    ) {
      if (
        declaration.phase !== "action.stage" ||
        declaration.output_schema !== "changeset.operations.v1" ||
        declaration.operation_key !== null
      ) {
        throw new StageHookError(
          "hook_invalid_output_schema",
          "action.stage hooks must use changeset.operations.v1",
          { hook: declaration.hook },
        );
      }
      const resolved = await this.#resolveSecrets(declaration);
      const envelope: HookEnvelope = {
        hook: declaration.hook,
        phase: "action.stage",
        input: mapValue(declaration.input_mapping, {
          "$action.input": input.input,
          ...Object.fromEntries(
            Object.entries(input.reads).map(([name, value]) => [
              `$reads.${name}`,
              value,
            ]),
          ),
        }) as Record<string, unknown>,
        metadata: {
          pack_revision: declaration.pack_revision_id,
          script_digest: declaration.script_digest,
          attachment_id: declaration.attachment_id,
        },
      };
      const result = await this.#runDeclaration(
        declaration,
        resolved,
        envelope,
      );
      const emitted = result.output?.operations;
      if (!Array.isArray(emitted)) {
        throw new StageHookError(
          "hook_invalid_output",
          "action hook operations are malformed",
          { hook: declaration.hook },
        );
      }
      const authored: AuthoredOperation[] = [];
      for (let index = 0; index < emitted.length; index++) {
        if (!authoredOperationContract.check(emitted[index])) {
          throw new StageHookError(
            "hook_invalid_output",
            "action hook operation does not satisfy changeset.operations.v1",
            {
              hook: declaration.hook,
              operation_index: index,
              issues: authoredOperationContract.issues(emitted[index]),
            },
          );
        }
        authored.push(emitted[index]);
      }
      enforceEffects(declaration, authored);
      const priorLength = operations.length;
      try {
        operations = resolveAddedOperations(
          operations,
          authored,
          input.allocate_id ?? uuidV7,
        );
        await canonicalizeResolvedOperations(
          operations,
          input.limits ?? DEFAULT_OPERATION_LIMITS,
        );
      } catch (error) {
        throw new StageHookError(
          "hook_invalid_output",
          error instanceof Error
            ? error.message
            : "operation normalization failed",
          { hook: declaration.hook },
        );
      }
      const added = operations.slice(priorLength);
      executions.push({
        id: uuidV7(),
        phase: "action.stage",
        output_schema: "changeset.operations.v1",
        hook: declaration.hook,
        attachment_id: declaration.attachment_id,
        hook_revision_id: declaration.hook_revision_id,
        pack_revision_id: declaration.pack_revision_id,
        script_digest: declaration.script_digest,
        security_digest: declaration.security_digest,
        input_digest: `sha256:${await canonicalSha256(envelope)}`,
        output_digest: `sha256:${await canonicalSha256(result.output)}`,
        output: result.output!,
        added_operations: added,
        stderr: result.logs,
        logs_truncated: result.logsTruncated ?? false,
        secrets_redacted: result.secretsRedacted ?? false,
        duration_ms: result.durationMs,
        authority_snapshot: input.authority_snapshot,
        grant_snapshot: { grants: resolved.evidence },
        read_dependencies: readDependencies,
      });
    }
    const canonical = await canonicalizeResolvedOperations(
      operations,
      input.limits ?? DEFAULT_OPERATION_LIMITS,
    );
    return {
      added_operations: canonical.operations,
      operation_graph_digest: canonical.operationGraphDigest,
      read_dependencies: readDependencies,
      hook_executions: executions,
    };
  }

  async coordinateAction(input: ActionStageHookInput) {
    return await this.runActionStage(input);
  }

  async coordinate(
    input: StageHookInput,
  ): Promise<{ hook_executions: StageHookExecution[] }> {
    const executions: StageHookExecution[] = [];
    const working: Record<string, Record<string, unknown>> = structuredClone(
      input.proposed_states,
    );
    for (const declaration of input.hook_declarations) {
      if (!conditionMatches(declaration, input, working)) continue;
      let resolved;
      try {
        resolved = await this.secrets.resolve(
          declaration.hook_revision_id,
          declaration.security_digest,
          declaration.secret_slots,
        );
      } catch (error) {
        if (
          error instanceof HookSecretUnavailableError ||
          error instanceof HookSecretGrantUnavailableError
        ) {
          throw new StageHookError("hook_secret_unavailable", error.message, {
            hook: declaration.hook,
            slot: error.slot,
          });
        }
        throw error;
      }
      const envelope = buildHookEnvelope(declaration, input, working);
      const runner = new DenoHookRunner({
        ...this.runnerOptions,
        secretValues: Object.fromEntries(
          declaration.secret_slots.map((
            slot,
          ) => [slot.slot, resolved.values[slot.env]]),
        ),
      });
      const result = await runner.run(
        toRunnerDefinition(declaration),
        envelope,
      );
      if (!result.ok || !result.output) {
        throw new StageHookError(
          result.error?.code ?? "hook_failed",
          result.error?.message ?? "hook execution failed",
          { hook: declaration.hook, logs: result.logs },
        );
      }
      const output = stageOutput(declaration, result.output);
      if (declaration.phase === "changeset.before_stage") {
        const batch = output.patch_outputs[0];
        if (!batch || !declaration.operation_key) {
          throw new StageHookError(
            "hook_invalid_output",
            "hook patch output is incomplete",
            { hook: declaration.hook },
          );
        }
        const before = working[declaration.operation_key] ?? {};
        const paths = batch.output.patches.map((patch) =>
          patch.path.slice(1).split("/")[0].replaceAll("~1", "/").replaceAll(
            "~0",
            "~",
          )
        );
        working[declaration.operation_key] = applyPatches(
          before,
          batch.output.patches,
          new Set([...Object.keys(before), ...paths]),
        );
      }
      const inputDigest = `sha256:${await canonicalSha256(envelope)}`;
      const outputDigest = `sha256:${await canonicalSha256(output)}`;
      executions.push({
        id: uuidV7(),
        attachment_id: declaration.attachment_id,
        hook_revision_id: declaration.hook_revision_id,
        pack_revision_id: declaration.pack_revision_id,
        phase: declaration.phase,
        input_digest: inputDigest,
        output_digest: outputDigest,
        output,
        script_digest: declaration.script_digest,
        security_digest: declaration.security_digest,
        stderr: result.logs,
        logs_truncated: result.logsTruncated ?? false,
        secrets_redacted: result.secretsRedacted ?? false,
        duration_ms: result.durationMs,
        authority_snapshot: input.authority_snapshot,
        grant_snapshot: { grants: resolved.evidence },
      });
    }
    return { hook_executions: executions };
  }
}

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

function toRunnerDefinition(
  declaration: StageHookDeclaration | ActionStageHookDeclaration,
): HookDefinition {
  return {
    namespace: declaration.hook.split(":")[0],
    name: declaration.hook,
    revision: declaration.pack_revision_id,
    scriptPath: `${declaration.script_digest}.ts`,
    scriptDigest: declaration.script_digest,
    securityDigest: declaration.security_digest,
    scriptContent: declaration.script_content,
    outputSchema: declaration.output_schema,
    timeoutMs: declaration.timeout_ms,
    permissions: {
      net: [...declaration.permissions.net],
      env: [...declaration.permissions.env],
      read: false,
      write: false,
      run: false,
    },
    secrets: declaration.secret_slots.map((slot) => ({
      name: slot.slot,
      slot: slot.slot,
      env: slot.env,
    })),
  };
}

function compareDeclarations(
  left: ActionStageHookDeclaration,
  right: ActionStageHookDeclaration,
): number {
  return left.order - right.order || left.hook.localeCompare(right.hook) ||
    left.attachment_id.localeCompare(right.attachment_id);
}

export async function runActionStage(
  coordinator: TrustedStageHookCoordinator,
  input: ActionStageHookInput,
) {
  return await coordinator.runActionStage(input);
}

function enforceEffects(
  declaration: ActionStageHookDeclaration,
  operations: readonly AuthoredOperation[],
): void {
  const effects = declaration.effects.map((value) =>
    isRecord(value) ? value : {}
  );
  for (const operation of operations) {
    const resource = String(
      "resource" in operation ? operation.resource : operation.relationship,
    );
    const op = String(operation.op ?? "");
    const allowed = effects.some((effect) =>
      effect.resource === resource && Array.isArray(effect.ops) &&
      effect.ops.includes(op)
    );
    if (!resource || !op || !allowed) {
      throw new StageHookError(
        "hook_effect_denied",
        "action hook emitted an undeclared operation effect",
        { hook: declaration.hook, resource, op },
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stageOutput(
  declaration: StageHookDeclaration,
  value: Record<string, unknown>,
): StageHookOutput {
  const empty = (): StageHookOutput => ({
    added_operations: [],
    patch_outputs: [],
    read_dependencies: [],
    warnings: [],
    approval_requirements: [],
    required_capabilities: [],
    effects: [],
    planned_events: [],
    planned_deliveries: [],
  });
  const output = empty();
  if (declaration.phase === "changeset.before_stage") {
    return {
      ...output,
      patch_outputs: [{
        operation_key: declaration.operation_key!,
        output: {
          patches: value
            .patches as StageHookOutput["patch_outputs"][number]["output"][
              "patches"
            ],
          ...(Array.isArray(value.warnings)
            ? { warnings: value.warnings as never[] }
            : {}),
        },
      }],
    };
  }
  const errors = value.errors as Array<
    {
      path: string;
      code: string;
      message: string;
      details?: Record<string, unknown>;
    }
  >;
  if (value.allow !== true || errors.length) {
    throw new StageHookError(
      "hook_rejected",
      "hook validation rejected the stage",
      {
        hook: declaration.hook,
        errors,
      },
    );
  }
  return {
    ...output,
    warnings: value.warnings as StageHookOutput["warnings"],
    approval_requirements: value
      .required_approvals as StageHookOutput["approval_requirements"],
  };
}

function conditionMatches(
  declaration: StageHookDeclaration,
  input: StageHookInput,
  working: Readonly<Record<string, Record<string, unknown>>>,
): boolean {
  if (declaration.condition === null) return true;
  if (declaration.condition === "true") return true;
  if (declaration.condition === "false") return false;
  if (declaration.condition === "active()") {
    const key = declaration.operation_key;
    if (key === null) return true;
    return (working[key]?.status ?? input.base_states[key]?.status) !==
      "archived";
  }
  throw new StageHookError(
    "hook_condition_invalid",
    "hook condition could not be evaluated",
    {
      hook: declaration.hook,
    },
  );
}

function mapValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    if (!Object.hasOwn(context, value)) {
      throw new StageHookError(
        "hook_input_invalid",
        "hook input reference is unavailable",
        {},
      );
    }
    return context[value];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapValue(entry, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, entry],
      ) => [key, mapValue(entry, context)]),
    );
  }
  return value;
}
