import type { Sql } from "../../adapters/outbound/postgres/client.ts";
import {
  query,
  quoteIdentifier,
} from "../../adapters/outbound/postgres/client.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import { err, ok, type Result } from "../../domain/errors/result.ts";
import { isUuidV7 } from "../../domain/ids/uuid_v7.ts";
import type { StageDto, StageSource } from "../ports/stage_repository.ts";
import {
  type ActionStageHookDeclaration,
  TrustedStageHookCoordinator,
} from "./hooks/stage_hook_coordinator.ts";
import { PostgresAuthorizationRepository } from "../../adapters/outbound/postgres/authorization_repository.ts";

export function makeStageActionService(
  sql: Sql,
  coordinator: TrustedStageHookCoordinator,
  common: {
    stageSource(
      input: unknown,
      source: StageSource,
      auth: AuthContext,
    ): Promise<Result<StageDto | null>>;
  },
) {
  return {
    async stage(
      publisher: string,
      pack: string,
      name: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<StageDto | { status: "no_changes"; stage: null }>> {
      try {
        if (
          !isRecord(raw) || Object.keys(raw).some((key) =>
            key !== "project_id" && key !== "input"
          ) || typeof raw.project_id !== "string" ||
          !isUuidV7(raw.project_id) || !isRecord(raw.input)
        ) {
          return invalid("action stage request is invalid");
        }
        const revision = (await query<{ id: string; normalized: unknown }>(
          sql,
          `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2`,
          [publisher, pack],
        )).rows[0];
        const action = record(
          record(record(revision?.normalized).actions)[name],
        );
        if (!revision || !Object.keys(action).length) {
          return err({
            code: "not_found",
            message: "action was not found",
            severity: "not_found",
            details: {},
          });
        }
        const spec = record(action.spec);
        const inputSpec = record(spec.input);
        const inputIssue = validateFields(raw.input, inputSpec);
        if (inputIssue) {
          return invalid(inputIssue);
        }
        const semantic = `action:${publisher}/${pack}:${name}`;
        const authority = await new PostgresAuthorizationRepository(sql)
          .authorize({
            auth,
            boundary: { type: "project", projectId: raw.project_id },
            action: semantic,
            resource: semantic,
          });
        if (!authority.ok) {
          return authority;
        }
        const reads: Record<string, unknown> = {};
        const readDependencies: Array<
          {
            name: string;
            project_id: string;
            resource_identity: string;
            object_id: string;
            object_version_id: string;
          }
        > = [];
        for (const readName of Object.keys(record(spec.reads)).sort()) {
          const declaration = record(record(spec.reads)[readName]);
          const source = String(declaration.id_from);
          const fieldName = source.replace(/^\$action\.input\./, "");
          const objectId = raw.input[fieldName];
          if (objectId === undefined && declaration.required === false) {
            continue;
          }
          if (
            typeof objectId !== "string" || !isUuidV7(objectId)
          ) {
            return invalid(
              `declared action read ${readName} requires a UUIDv7 input`,
            );
          }
          const resourceIdentity = String(declaration.resource);
          const qualified = resourceIdentity.includes(":")
            ? resourceIdentity
            : `${publisher}/${pack}:${resourceIdentity}`;
          const resourceName = qualified.split(":")[1];
          const table = (await query<{ table_name: string }>(
            sql,
            `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
            [publisher, pack, resourceName],
          )).rows[0]?.table_name;
          if (!table) {
            return invalid(
              "declared action read resource is unavailable",
            );
          }
          const fields = Array.isArray(declaration.fields)
            ? declaration.fields.map(String)
            : [];
          const columns = [
            "id",
            "version",
            "current_object_version_id",
            ...fields,
          ].map(quoteIdentifier).join(",");
          const row = (await query<Record<string, unknown>>(
            sql,
            `select ${columns} from ${
              quoteIdentifier(table)
            } where project_id=$1 and id=$2 and archived_at is null`,
            [raw.project_id, objectId],
          )).rows[0];
          if (!row) {
            if (declaration.required === false) {
              continue;
            }
            return invalid(`required action read ${readName} was not found`);
          }
          reads[readName] = Object.fromEntries(
            Object.entries(row).filter(([key]) =>
              key !== "current_object_version_id" && key !== "version"
            ),
          );
          readDependencies.push({
            name: readName,
            project_id: raw.project_id,
            resource_identity: qualified,
            object_id: objectId,
            object_version_id: String(row.current_object_version_id),
          });
        }
        const rows = (await query<Record<string, unknown>>(
          sql,
          `select a.id,a.hook_revision_id,a.ordinal,a.declaration_digest,a.declaration_spec,h.definition_name hook_name,
          h.hook_security_digest,h.hook_script_digest,h.hook_normalized_config,h.hook_script_content
         from pack_hook_attachment_revisions a join pack_component_revisions h on h.id=a.hook_revision_id
         where a.candidate_revision_id=$1 and a.phase='action.stage' and a.declaration_spec->>'action'=$2 order by a.ordinal,a.id`,
          [revision.id, `${publisher}/${pack}:${name}`],
        )).rows;
        if (!rows.length) {
          return invalid(
            "action has no active reviewed stage attachment",
          );
        }
        const declarations: ActionStageHookDeclaration[] = rows.map((row) => {
          const config = record(row.hook_normalized_config);
          const permissions = record(config.permissions);
          const declaration = record(row.declaration_spec);
          return {
            attachment_id: String(row.id),
            hook_revision_id: String(row.hook_revision_id),
            pack_revision_id: revision.id,
            hook: `${publisher}/${pack}:${String(row.hook_name)}`,
            phase: "action.stage",
            resource: null,
            operation_key: null,
            order: Number(row.ordinal),
            script_digest: String(row.hook_script_digest),
            security_digest: String(row.hook_security_digest),
            script_content: String(row.hook_script_content),
            timeout_ms: Number(config.timeout_ms),
            output_schema: "changeset.operations.v1",
            permissions: {
              net: array(permissions.net).map(String),
              env: array(permissions.env).map(String),
            },
            secret_slots: array(config.secrets).map((slot) => ({
              slot: String(record(slot).slot),
              env: String(record(slot).env),
            })),
            input_mapping: record(declaration.input),
            condition: declaration.condition == null
              ? null
              : String(declaration.condition),
            effects: array(record(config.effects).operations),
            declaration_digest: String(row.declaration_digest),
          };
        });
        const result = await coordinator.runActionStage({
          action: `${publisher}/${pack}:${name}`,
          input: raw.input,
          reads,
          read_dependencies: readDependencies,
          declarations,
          authority_snapshot: {
            principal_id: auth.principalId,
            auth_context_id: auth.id,
            assignment_digest: authority.value.digest,
            policy_digest: authority.value.digest,
          },
        });
        if (!result.added_operations.length) {
          return ok({
            status: "no_changes",
            stage: null,
          });
        }
        const effects = declarations.flatMap((declaration) =>
          declaration.effects
        ).filter((value): value is Record<string, unknown> =>
          isRecord(value)
        ).map((effect) => ({
          resource: String(effect.resource),
          ops: array(effect.ops).map(String),
        }));
        const source: StageSource = {
          kind: "action",
          identity: {
            action: `${publisher}/${pack}:${name}`,
            revision_id: revision.id,
          },
          authority: {
            project_id: raw.project_id,
            actions: [semantic],
            revision_id: revision.id,
            effects,
          },
          dependencies: readDependencies.map((dependency) => ({
            kind: "object_version",
            ...dependency,
            expected_version_id: dependency.object_version_id,
          })),
        };
        const staged = await common.stageSource(
          { operations: result.added_operations },
          source,
          auth,
        );
        return staged.ok ? ok(staged.value!) : staged;
      } catch (error) {
        console.error(error);
        return err({
          code: "internal_error",
          message: "unexpected server error",
          severity: "internal",
          details: {},
        });
      }
    },
  };
}
function validateFields(
  input: Record<string, unknown>,
  fields: Record<string, unknown>,
): string | null {
  if (Object.keys(input).some((key) => !Object.hasOwn(fields, key))) {
    return "action input contains an undeclared field";
  }
  for (const [name, raw] of Object.entries(fields)) {
    const field = record(raw);
    const value = input[name];
    if (field.required === true && value === undefined) {
      return `action input ${name} is required`;
    }
    if (value === undefined) continue;
    if (field.type === "string" && typeof value !== "string") {
      return `action input ${name} must be a string`;
    }
    if (field.type === "integer" && !Number.isSafeInteger(value)) {
      return `action input ${name} must be an integer`;
    }
    if (field.type === "boolean" && typeof value !== "boolean") {
      return `action input ${name} must be boolean`;
    }
  }
  return null;
}
function invalid(message: string): Result<never> {
  return err({
    code: "validation_failed",
    message,
    severity: "validation",
    details: {},
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
