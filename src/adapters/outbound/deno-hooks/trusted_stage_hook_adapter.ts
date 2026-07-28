import type {
  HookExecutionResult,
  HookExecutor,
  HookInvocation,
  HookOutput,
  HookSecretResolver,
  JsonValue,
  ResolvedHookSecrets,
} from "../../../application/ports/repair/repositories.ts";
import type { PostgresHookSecretRepository } from "../postgres/hook_secret_repository.ts";
import {
  DenoHookRunner,
  type DenoHookRunnerOptions,
  type HookDefinition,
  type HookEnvelope,
} from "./hook_runner.ts";

/** Concrete subprocess adapter. It executes exactly one already-curated program. */
export class DenoHookExecutor implements HookExecutor {
  constructor(private readonly options: DenoHookRunnerOptions = {}) {}

  async execute<TPhase extends HookInvocation["program"]["phase"]>(
    invocation: HookInvocation<TPhase>,
  ): Promise<HookExecutionResult<TPhase>> {
    const program = invocation.program;
    const runner = new DenoHookRunner({
      ...this.options,
      secretValues: Object.fromEntries(
        program.secretDeclarations.map((declaration) => [
          declaration.slot,
          invocation.capabilities.secrets.values[declaration.env],
        ]),
      ),
    });
    const definition: HookDefinition = {
      namespace: program.hookIdentity.split(":")[0],
      name: program.hookIdentity,
      revision: program.revisionId,
      scriptPath: `${program.scriptDigest}.ts`,
      scriptDigest: program.scriptDigest,
      securityDigest: program.securityDigest,
      scriptContent: program.source,
      outputSchema: program.outputSchema,
      timeoutMs: program.timeoutMs,
      permissions: {
        net: [...program.permissions.net],
        env: [...program.permissions.env],
        read: false,
        write: false,
        run: false,
      },
      secrets: program.secretDeclarations.map((declaration) => ({
        name: declaration.slot,
        slot: declaration.slot,
        env: declaration.env,
      })),
    };
    const envelope: HookEnvelope = {
      hook: program.hookIdentity,
      phase: program.phase,
      input: { ...invocation.input },
      metadata: {
        pack_revision: program.revisionId,
        script_digest: program.scriptDigest,
        attachment_id: program.attachmentId,
      },
    };
    const result = await runner.run(definition, envelope);
    return {
      phase: program.phase,
      outputSchema: program.outputSchema,
      status: result.ok
        ? "succeeded"
        : result.error?.code === "hook_timeout"
        ? "timed_out"
        : result.error?.code === "hook_invalid_output"
        ? "invalid_output"
        : "failed",
      output: result.output
        ? hookOutput(program.phase, result.output) as HookOutput & {
          phase: TPhase;
        }
        : null,
      logs: result.logs,
      logsTruncated: result.logsTruncated ?? false,
      secretsRedacted: result.secretsRedacted ?? false,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      error: result.error
        ? {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details,
        }
        : null,
    } as HookExecutionResult<TPhase>;
  }
}

/** Concrete database/decryption adapter for application-owned secret sequencing. */
export function makeHookSecretResolver(
  repository: Pick<PostgresHookSecretRepository, "resolve">,
): HookSecretResolver {
  return {
    async resolve(request): Promise<ResolvedHookSecrets> {
      const resolved = await repository.resolve(
        request.revisionId,
        request.securityDigest,
        request.declarations,
      );
      return {
        values: resolved.values,
        grants: resolved.evidence.map((evidence) => ({
          grantId: evidence.grant_id,
          secretId: evidence.secret_id,
          secretVersion: evidence.value_version,
          hookRevisionId: request.revisionId,
          securityDigest: request.securityDigest,
          slot: evidence.slot,
          env: evidence.env,
        })),
      };
    },
  };
}

function hookOutput(
  phase: HookInvocation["program"]["phase"],
  raw: Record<string, unknown>,
): HookOutput {
  if (phase === "action.stage") {
    return {
      phase,
      schema: "changeset.operations.v1",
      operations: array(raw.operations) as JsonValue[],
      ...(Array.isArray(raw.warnings)
        ? { warnings: raw.warnings as never }
        : {}),
      ...(Array.isArray(raw.errors) ? { errors: raw.errors as never } : {}),
    };
  }
  if (phase === "changeset.before_stage") {
    return {
      phase,
      schema: "patch.v1",
      patches: array(raw.patches) as JsonValue[],
      ...(Array.isArray(raw.warnings)
        ? { warnings: raw.warnings as never }
        : {}),
    };
  }
  if (phase === "changeset.validate") {
    const errors = array(raw.errors) as never[];
    return raw.allow === true
      ? {
        phase,
        schema: "validation.v1",
        allow: true,
        errors: [],
        warnings: array(raw.warnings) as never[],
        required_approvals: array(raw.required_approvals) as JsonValue[],
      }
      : {
        phase,
        schema: "validation.v1",
        allow: false,
        errors: errors as [never, ...never[]],
        warnings: array(raw.warnings) as never[],
        required_approvals: array(raw.required_approvals) as JsonValue[],
      };
  }
  return {
    phase,
    schema: "delivery.v1",
    ...raw,
  } as HookOutput;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
