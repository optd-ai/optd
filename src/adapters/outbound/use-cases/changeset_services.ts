import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import { query, type Queryable, quoteIdentifier } from "../postgres/client.ts";
import type { TransactionManager } from "../../../application/ports/transaction_manager.ts";
import type {
  DenoHookRunner,
  HookDefinition,
} from "../deno-hooks/hook_runner.ts";
import { loadHook, recordHookExecution } from "./run_action.ts";
import {
  type ActorContext,
  assertPolicyAllowed,
  auditPolicy,
  authorizeObjectRuntime,
  normalizeActor,
  PolicyDeniedError,
} from "../../../domain/policies/policy_engine.ts";
import type { FieldSpec } from "../../../domain/queries/expression_lowerer.ts";

type JsonRecord = Record<string, unknown>;
export type ChangesetOperation = {
  op:
    | "create"
    | "update"
    | "archive"
    | "transition"
    | "link"
    | "unlink"
    | "comment";
  resource?: string;
  relationship?: string;
  id?: string;
  as?: string;
  fields?: JsonRecord;
  expected_version?: number;
  from?: string;
  to?: string;
  body?: string;
};
export type ChangesetRequest = {
  actor?: string | Record<string, unknown>;
  actor_id?: string;
  actor_context?: Record<string, unknown>;
  idempotency_key?: string;
  source?: string;
  operations: ChangesetOperation[];
};

type ValidationIssue = {
  level: "error";
  path: string;
  code: string;
  message: string;
};
type ResourceMeta = {
  namespace: string;
  name: string;
  revision: string;
  tableName: string;
  fields: Record<string, { type?: string; required?: boolean }>;
  lifecycleField?: string;
};
type RelationshipMeta = {
  namespace: string;
  name: string;
  revision: string;
  tableName: string;
};

type PlannedOperation = ChangesetOperation & {
  index: number;
  meta?: ResourceMeta;
  relationshipMeta?: RelationshipMeta;
  objectId?: string;
  before?: JsonRecord | null;
  after?: JsonRecord | null;
  changed_fields?: string[];
};

export type ChangesetPreviewDto = {
  id: string;
  actor_id: string;
  committable: boolean;
  validation: { errors: ValidationIssue[]; warnings: unknown[] };
  operations: Array<Record<string, unknown>>;
};

export type ChangesetCommitDto = ChangesetPreviewDto & {
  committed: boolean;
  object_versions: Array<
    { id: string; resource: string; object_id: string; version: number }
  >;
};

export function makeChangesetServices(
  deps: {
    sql: Queryable;
    tx: TransactionManager<Queryable>;
    hookRunner?: DenoHookRunner;
  },
) {
  return {
    async preview(
      input: ChangesetRequest,
    ): Promise<Result<ChangesetPreviewDto>> {
      try {
        const actor = actorOf(input);
        const plan = await planChangeset(
          deps.sql,
          input,
          actor,
          deps.hookRunner,
        );
        const preview = previewDto(crypto.randomUUID(), actor.id, plan);
        await query(
          deps.sql,
          `insert into changesets(id, actor_id, status, request_json, preview_json, source)
           values ($1,$2,'previewed',$3::jsonb,$4::jsonb,$5)`,
          [
            preview.id,
            actor.id,
            JSON.stringify(input),
            JSON.stringify(preview),
            input.source ?? null,
          ],
        );
        await query(
          deps.sql,
          `insert into audit_events(id, changeset_id, actor_id, event_type, action, decision, validation_summary_json)
           values ($1,$2,$3,'changeset.previewed','changeset.preview',$4,$5::jsonb)`,
          [
            crypto.randomUUID(),
            preview.id,
            actor.id,
            preview.committable ? "allowed" : "failed",
            JSON.stringify(preview.validation),
          ],
        );
        return ok(preview);
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          return err(validationError(error.code, error.message, error.details));
        }
        return err(validationError("bad_changeset", message(error)));
      }
    },
    async commit(input: ChangesetRequest): Promise<Result<ChangesetCommitDto>> {
      try {
        const result = await deps.tx.transaction((tx) =>
          commitPlanned(tx, input, deps.hookRunner)
        );
        return ok(result);
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          const actor = actorOf(input);
          await auditPolicy(
            deps.sql,
            { actor, resource: "changeset", action: "commit" },
            {
              allowed: false,
              bypassed: false,
              digest: "denied",
              matched_rules: [],
              checked_rules: [],
              reason: error.message,
            },
            "policy.denied",
          );
          return err(validationError(error.code, error.message, error.details));
        }
        return err(validationError("bad_changeset", message(error)));
      }
    },
    async view(
      resourceId: string,
      id: string,
      includeArchived = false,
      actorInput?: unknown,
    ): Promise<Result<unknown>> {
      try {
        const meta = await getResourceMeta(deps.sql, resourceId);
        if (!meta) {
          return err({
            code: "not_found",
            message: `resource ${resourceId} not found`,
            severity: "not_found",
          });
        }
        const row = await readObject(deps.sql, meta, id, includeArchived);
        if (!row) {
          return err({
            code: "not_found",
            message: `${resourceId} ${id} not found`,
            severity: "not_found",
          });
        }
        const actor = normalizeActor(actorInput ?? "anonymous");
        const decision = await authorizeObjectRuntime(deps.sql, {
          actor,
          resource: resourceId,
          action: "read",
          fields: fieldContext(meta),
          object: row,
        });
        await assertPolicyAllowed(
          deps.sql,
          decision,
          { actor, resource: resourceId, action: "read", object_id: id },
        );
        return ok({ resource: resourceId, object: row });
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          return err(validationError(error.code, error.message, error.details));
        }
        return err(validationError("bad_view", message(error)));
      }
    },
    async history(resourceId: string, id: string): Promise<Result<unknown>> {
      const versions = await query(
        deps.sql,
        `select id, version, previous_version_id, changeset_id, operation, snapshot_json, changed_fields, actor_id, created_at
         from object_versions where resource=$1 and object_id=$2 order by version`,
        [resourceId, id],
      );
      const audits = await query(
        deps.sql,
        `select id, event_type, action, decision, object_version_id, created_at from audit_events
         where resource=$1 and object_id=$2 order by created_at`,
        [resourceId, id],
      );
      const events = await query(
        deps.sql,
        `select id, event_type, object_version_id, payload_json, occurred_at from events
         where resource=$1 and object_id=$2 order by occurred_at`,
        [resourceId, id],
      );
      const comments = await query(
        deps.sql,
        `select id, body, actor_id, object_version_id, created_at from comments
         where resource=$1 and object_id=$2 order by created_at`,
        [resourceId, id],
      );
      return ok({
        resource: resourceId,
        object_id: id,
        versions: versions.rows,
        audit_events: audits.rows,
        events: events.rows,
        comments: comments.rows,
      });
    },
  };
}

export async function applySeedDefinitionsThroughChangesets(
  sql: Queryable,
  actor: string | Record<string, unknown> = {
    id: "system:seed",
    roles: ["super_admin"],
  },
): Promise<{ planned: number; committed: number; skipped: number }> {
  const seeds = await query<
    {
      namespace: string;
      name: string;
      resource: string;
      key_field: string;
      spec: unknown;
    }
  >(
    sql,
    `select namespace,name,resource,key_field,spec from seed_definitions
     where revision in (select revision from pack_revisions where active=true)
     order by namespace,name`,
  );
  let planned = 0, committed = 0, skipped = 0;
  for (const seed of seeds.rows) {
    const spec = asRecord(seed.spec);
    const rows = Array.isArray(spec.rows) ? spec.rows.filter(isRecord) : [];
    const resourceId = `${seed.namespace}.${seed.resource}`;
    const meta = await getResourceMeta(sql, resourceId);
    if (!meta) {
      throw new Error(`seed ${seed.name}: resource ${resourceId} not found`);
    }
    for (const row of rows) {
      planned++;
      const key = row[seed.key_field];
      if (key === undefined || key === null) {
        throw new Error(`seed ${seed.name}: missing key ${seed.key_field}`);
      }
      const existing = await query<JsonRecord>(
        sql,
        `select * from ${qi(meta.tableName)} where ${
          qi(seed.key_field)
        } = $1 and archived_at is null limit 1`,
        [key],
      );
      const existingRow = existing.rows[0];
      const source = `seed:${seed.namespace}.${seed.name}:${String(key)}`;
      if (!existingRow) {
        await commitPlanned(sql, {
          actor,
          source,
          idempotency_key: source,
          operations: [{
            op: "create",
            resource: resourceId,
            fields: {
              ...row,
              id: stableSeedId(
                seed.namespace,
                seed.resource,
                seed.key_field,
                key,
              ),
            },
          }],
        });
        committed++;
      } else if (diffFields(existingRow, row).length) {
        await commitPlanned(sql, {
          actor,
          source,
          idempotency_key: source,
          operations: [{
            op: "update",
            resource: resourceId,
            id: String(existingRow.id),
            fields: row,
            expected_version: Number(existingRow.version),
          }],
        });
        committed++;
      } else {
        skipped++;
      }
    }
  }
  return { planned, committed, skipped };
}

async function commitPlanned(
  sql: Queryable,
  input: ChangesetRequest,
  hookRunner?: DenoHookRunner,
): Promise<ChangesetCommitDto> {
  const actor = actorOf(input);
  const originalInput = structuredClone(input);
  if (originalInput.idempotency_key) {
    const existing = await query<
      { request_json: unknown; preview_json: unknown; status: string }
    >(
      sql,
      "select request_json, preview_json, status from changesets where actor_id=$1 and idempotency_key=$2",
      [actor.id, originalInput.idempotency_key],
    );
    if (existing.rows[0]) {
      if (
        stableJson(existing.rows[0].request_json) !== stableJson(originalInput)
      ) {
        throw new Error("idempotency key reused with different payload");
      }
      return parseStoredJson(
        existing.rows[0].preview_json,
      ) as ChangesetCommitDto;
    }
  }
  const plan = await planChangeset(sql, input, actor, hookRunner);
  const preview = previewDto(crypto.randomUUID(), actor.id, plan);
  if (!preview.committable) {
    const policyError = preview.validation.errors.find((e) =>
      e.code === "policy_denied"
    );
    if (policyError) {
      throw new PolicyDeniedError(policyError.message, {
        actor_id: actor.id,
        checked_errors: preview.validation.errors,
      });
    }
    throw new Error(
      preview.validation.errors.map((e) => `${e.code}: ${e.message}`).join(
        "; ",
      ),
    );
  }
  const changesetId = preview.id;
  await query(
    sql,
    `insert into changesets(id, actor_id, status, request_json, preview_json, idempotency_key, source, committed_at) values ($1,$2,'committed',$3::jsonb,$4::jsonb,$5,$6,now())`,
    [
      changesetId,
      actor.id,
      JSON.stringify(originalInput),
      JSON.stringify(preview),
      originalInput.idempotency_key ?? null,
      originalInput.source ?? null,
    ],
  );
  const objectVersions: ChangesetCommitDto["object_versions"] = [];
  for (const op of plan.planned) {
    if (op.meta) {
      const ov = await commitObjectOperation(sql, changesetId, actor.id, op);
      if (ov) objectVersions.push(ov);
    } else if (op.relationshipMeta) {
      await commitRelationshipOperation(sql, changesetId, actor.id, op);
    }
  }
  const committed = {
    ...preview,
    committed: true,
    object_versions: objectVersions,
  };
  await query(sql, "update changesets set preview_json=$2::jsonb where id=$1", [
    changesetId,
    JSON.stringify(committed),
  ]);
  await query(
    sql,
    `insert into audit_events(id, changeset_id, actor_id, event_type, action, decision, validation_summary_json) values ($1,$2,$3,'changeset.committed','changeset.commit','committed',$4::jsonb)`,
    [
      crypto.randomUUID(),
      changesetId,
      actor.id,
      JSON.stringify(preview.validation),
    ],
  );
  await query(
    sql,
    `insert into events(id, changeset_id, event_type, payload_json) values ($1,$2,'changeset.committed',$3::jsonb)`,
    [
      crypto.randomUUID(),
      changesetId,
      JSON.stringify({ operation_count: plan.planned.length }),
    ],
  );
  await enqueueAfterCommitHooks(sql, changesetId, actor.id, plan.planned);
  return committed;
}

async function planChangeset(
  sql: Queryable,
  input: ChangesetRequest,
  actor: ActorContext,
  hookRunner?: DenoHookRunner,
): Promise<{ errors: ValidationIssue[]; planned: PlannedOperation[] }> {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error("operations must be a non-empty array");
  }
  const errors: ValidationIssue[] = [];
  const planned: PlannedOperation[] = [];
  const aliases = new Map<string, string>();
  for (let index = 0; index < input.operations.length; index++) {
    let op = normalizeOperation(input.operations[index]);
    const path = `/operations/${index}`;
    if (
      ["create", "update", "archive", "transition", "comment"].includes(op.op)
    ) {
      const meta = await getResourceMeta(sql, op.resource ?? "");
      if (!meta) {
        errors.push(
          issue(path, "unknown_resource", `unknown resource ${op.resource}`),
        );
        continue;
      }
      const objectId = op.op === "create"
        ? String(op.fields?.id ?? crypto.randomUUID())
        : resolveRef(op.id, aliases);
      const before = op.op === "create"
        ? null
        : await readObject(sql, meta, objectId, true);
      if (op.op !== "create" && !before) {
        errors.push(
          issue(path, "not_found", `${op.resource} ${objectId} not found`),
        );
      }
      if (before?.archived_at && op.op !== "comment") {
        errors.push(
          issue(path, "archived", `${op.resource} ${objectId} is archived`),
        );
      }
      if (
        op.expected_version !== undefined && before &&
        Number(before.version) !== op.expected_version
      ) {
        errors.push(
          issue(
            path,
            "version_conflict",
            `expected version ${op.expected_version}, found ${before.version}`,
          ),
        );
      }
      op = await runResourcePatchHooks(sql, hookRunner, op, actor, path);
      const fields = op.op === "transition"
        ? {
          [transitionField(meta)]: op.to ?? op.fields?.to ?? op.fields?.state ??
            op.fields?.status ?? op.fields?.stage,
        }
        : (op.fields ?? {});
      validateFields(path, meta, fields, errors, op.op === "create");
      if (op.op === "create") {
        for (const [field, cfg] of Object.entries(meta.fields)) {
          if (cfg.required && fields[field] === undefined) {
            errors.push(
              issue(
                `${path}/fields/${field}`,
                "required",
                `${field} is required`,
              ),
            );
          }
        }
      }
      const after = buildAfter(op.op, before, { ...fields, id: objectId });
      await runResourceValidationHooks(
        sql,
        hookRunner,
        op,
        actor,
        before,
        after,
        path,
        errors,
      );
      const action = policyAction(op.op);
      const decision = await authorizeObjectRuntime(sql, {
        actor,
        resource: op.resource ?? "",
        action,
        fields: fieldContext(meta),
        object: after,
      });
      if (!decision.allowed) {
        errors.push(
          issue(
            path,
            "policy_denied",
            `actor is not allowed to ${action} ${op.resource}`,
          ),
        );
        await auditPolicy(
          sql,
          { actor, resource: op.resource ?? "", action, object_id: objectId },
          decision,
          "policy.denied",
        );
      } else if (decision.bypassed) {
        await assertPolicyAllowed(
          sql,
          decision,
          { actor, resource: op.resource ?? "", action, object_id: objectId },
        );
      }
      if (op.as) aliases.set(op.as, objectId);
      planned.push({
        ...op,
        index,
        meta,
        objectId,
        before,
        after,
        changed_fields: diffFields(before ?? {}, after ?? {}),
      });
    } else if (op.op === "link" || op.op === "unlink") {
      const relationshipMeta = await getRelationshipMeta(
        sql,
        op.relationship ?? "",
      );
      if (!relationshipMeta) {
        errors.push(
          issue(
            path,
            "unknown_relationship",
            `unknown relationship ${op.relationship}`,
          ),
        );
      }
      planned.push({
        ...op,
        index,
        relationshipMeta: relationshipMeta ?? undefined,
        from: resolveRef(op.from, aliases),
        to: resolveRef(op.to, aliases),
      });
    } else {errors.push(
        issue(
          path,
          "unknown_operation",
          `unknown operation ${(op as { op?: unknown }).op}`,
        ),
      );}
  }
  return { errors, planned };
}

async function commitObjectOperation(
  sql: Queryable,
  changesetId: string,
  actor: string,
  op: PlannedOperation,
) {
  const meta = op.meta!;
  const table = qi(meta.tableName);
  const objectId = op.objectId!;
  let row: JsonRecord;
  if (op.op === "create") {
    const fields = { ...op.fields, id: objectId } as JsonRecord;
    const cols = Object.keys(fields).filter((k) =>
      k in meta.fields || k === "id"
    );
    await query(
      sql,
      `insert into ${table} (${cols.map(qi).join(",")}) values (${
        cols.map((_, i) => `$${i + 1}`).join(",")
      })`,
      cols.map((c) => fields[c]),
    );
  } else if (op.op === "update" || op.op === "transition") {
    const fields = op.op === "transition"
      ? (op.after ?? {})
      : (op.fields ?? {});
    const cols = Object.keys(fields).filter((k) => k in meta.fields);
    if (cols.length) {
      await query(
        sql,
        `update ${table} set ${
          cols.map((c, i) => `${qi(c)}=$${i + 1}`).join(",")
        }, version=version+1, updated_at=now() where id=$${cols.length + 1}`,
        [...cols.map((c) => fields[c]), objectId],
      );
    }
  } else if (op.op === "archive") {
    await query(
      sql,
      `update ${table} set archived_at=now(), archived_by=$1, version=version+1, updated_at=now() where id=$2`,
      [actor, objectId],
    );
  } else if (op.op === "comment") {
    await query(
      sql,
      `update ${table} set version=version+1, updated_at=now() where id=$1`,
      [objectId],
    );
  }
  row = (await readObject(sql, meta, objectId, true))!;
  const previous = await query<{ id: string }>(
    sql,
    "select id from object_versions where resource=$1 and object_id=$2 order by version desc limit 1",
    [`${meta.namespace}.${meta.name}`, objectId],
  );
  const ovId = crypto.randomUUID();
  await query(
    sql,
    `insert into object_versions(id, resource, object_id, version, previous_version_id, changeset_id, operation, resource_revision, snapshot_json, changed_fields, actor_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [
      ovId,
      `${meta.namespace}.${meta.name}`,
      objectId,
      Number(row.version),
      previous.rows[0]?.id ?? null,
      changesetId,
      op.op,
      meta.revision,
      JSON.stringify(row),
      op.changed_fields ?? [],
      actor,
    ],
  );
  await query(
    sql,
    `update ${table} set current_object_version_id=$1 where id=$2`,
    [ovId, objectId],
  );
  if (op.op === "comment") {
    await query(
      sql,
      `insert into comments(id, resource, object_id, changeset_id, object_version_id, actor_id, body) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        crypto.randomUUID(),
        `${meta.namespace}.${meta.name}`,
        objectId,
        changesetId,
        ovId,
        actor,
        op.body ?? "",
      ],
    );
  }
  const eventType = op.op === "create"
    ? "object.created"
    : op.op === "archive"
    ? "object.archived"
    : op.op === "comment"
    ? "comment.added"
    : op.op === "transition"
    ? "object.transitioned"
    : "object.updated";
  await query(
    sql,
    `insert into audit_events(id, changeset_id, object_version_id, actor_id, event_type, resource, object_id, action, decision) values ($1,$2,$3,$4,$5,$6,$7,$8,'committed')`,
    [
      crypto.randomUUID(),
      changesetId,
      ovId,
      actor,
      eventType,
      `${meta.namespace}.${meta.name}`,
      objectId,
      op.op,
    ],
  );
  await query(
    sql,
    `insert into events(id, changeset_id, object_version_id, event_type, resource, object_id, payload_json) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      crypto.randomUUID(),
      changesetId,
      ovId,
      eventType,
      `${meta.namespace}.${meta.name}`,
      objectId,
      JSON.stringify({ changed_fields: op.changed_fields ?? [] }),
    ],
  );
  return {
    id: ovId,
    resource: `${meta.namespace}.${meta.name}`,
    object_id: objectId,
    version: Number(row.version),
  };
}

async function commitRelationshipOperation(
  sql: Queryable,
  changesetId: string,
  actor: string,
  op: PlannedOperation,
) {
  const meta = op.relationshipMeta!;
  if (op.op === "link") {
    const id = op.id ?? crypto.randomUUID();
    const fields = op.fields ?? {};
    const cols = [
      "id",
      "from_object_id",
      "to_object_id",
      ...Object.keys(fields),
    ];
    await query(
      sql,
      `insert into ${qi(meta.tableName)} (${cols.map(qi).join(",")}) values (${
        cols.map((_, i) => `$${i + 1}`).join(",")
      })`,
      [id, op.from, op.to, ...Object.values(fields)],
    );
  } else {
    await query(
      sql,
      `delete from ${
        qi(meta.tableName)
      } where from_object_id=$1 and to_object_id=$2`,
      [op.from, op.to],
    );
  }
  await query(
    sql,
    `insert into audit_events(id, changeset_id, actor_id, event_type, resource, object_id, action, decision) values ($1,$2,$3,$4,$5,$6,$7,'committed')`,
    [
      crypto.randomUUID(),
      changesetId,
      actor,
      op.op === "link" ? "relationship.created" : "relationship.deleted",
      `${meta.namespace}.${meta.name}`,
      `${op.from}->${op.to}`,
      op.op,
    ],
  );
  await query(
    sql,
    `insert into events(id, changeset_id, event_type, resource, object_id, payload_json) values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      crypto.randomUUID(),
      changesetId,
      op.op === "link" ? "relationship.created" : "relationship.deleted",
      `${meta.namespace}.${meta.name}`,
      `${op.from}->${op.to}`,
      JSON.stringify({ from: op.from, to: op.to }),
    ],
  );
}

async function runResourcePatchHooks(
  sql: Queryable,
  hookRunner: DenoHookRunner | undefined,
  op: ChangesetOperation,
  actor: ActorContext,
  path: string,
): Promise<ChangesetOperation> {
  if (
    !hookRunner || !op.resource || !(op.op === "create" || op.op === "update")
  ) return op;
  let next: ChangesetOperation = { ...op, fields: { ...(op.fields ?? {}) } };
  const hooks = await loadAttachedHooks(
    sql,
    "changeset.before_preview",
    op.resource,
    undefined,
  );
  for (const hook of hooks) {
    const result = await hookRunner.run(hook, {
      hook: hook.name,
      phase: "changeset.before_preview",
      input: { operation: next, actor, proposed: next.fields ?? {} },
      metadata: {
        pack_revision: hook.revision,
        script_digest: hook.scriptDigest,
        attachment_id: `${op.resource}:${path}`,
      },
    });
    await recordHookExecution(
      sql,
      hook,
      result,
      actor.id,
      "changeset.before_preview",
    );
    if (!result.ok) {
      throw new Error(
        `hook ${hook.namespace}.${hook.name} failed: ${
          result.error?.message ?? "unknown"
        }`,
      );
    }
    const patches = Array.isArray(result.output?.patches)
      ? result.output.patches.filter(isRecord)
      : [];
    for (const patch of patches) next = applyPatch(next, patch);
  }
  return next;
}

async function runResourceValidationHooks(
  sql: Queryable,
  hookRunner: DenoHookRunner | undefined,
  op: ChangesetOperation,
  actor: ActorContext,
  current: JsonRecord | null,
  proposed: JsonRecord | null,
  path: string,
  errors: ValidationIssue[],
): Promise<void> {
  if (
    !hookRunner || !op.resource ||
    !(op.op === "create" || op.op === "update" || op.op === "transition")
  ) return;
  const hooks = await loadAttachedHooks(
    sql,
    "changeset.validate",
    op.resource,
    undefined,
  );
  for (const hook of hooks) {
    const result = await hookRunner.run(hook, {
      hook: hook.name,
      phase: "changeset.validate",
      input: {
        operation: { ...op, fields: proposed ?? op.fields ?? {} },
        actor,
        current,
        proposed,
      },
      metadata: {
        pack_revision: hook.revision,
        script_digest: hook.scriptDigest,
        attachment_id: `${op.resource}:${path}`,
      },
    });
    await recordHookExecution(
      sql,
      hook,
      result,
      actor.id,
      "changeset.validate",
    );
    if (!result.ok) {
      errors.push(
        issue(
          path,
          result.error?.code ?? "hook_failed",
          `hook ${hook.namespace}.${hook.name} failed: ${
            result.error?.message ?? "unknown"
          }`,
        ),
      );
      continue;
    }
    if (result.output?.allow === false) {
      errors.push(
        issue(
          path,
          "hook_denied",
          `hook ${hook.namespace}.${hook.name} denied operation`,
        ),
      );
    }
    const hookErrors = Array.isArray(result.output?.errors)
      ? result.output.errors.filter(isRecord)
      : [];
    for (const hookError of hookErrors) {
      errors.push(
        issue(
          String(hookError.path ?? path),
          String(hookError.code ?? "hook_validation"),
          String(hookError.message ?? "hook validation failed"),
        ),
      );
    }
  }
}

async function loadAttachedHooks(
  sql: Queryable,
  phase: string,
  resource?: string,
  action?: string,
): Promise<HookDefinition[]> {
  const rows = await query<{ namespace: string; name: string; spec: unknown }>(
    sql,
    `select namespace,name,spec from hook_definitions where revision in (select revision from pack_revisions where active=true) order by namespace,name`,
  );
  const hooks: Array<{ id: string; order: number }> = [];
  for (const row of rows.rows) {
    const spec = asRecord(row.spec);
    const attachments = Array.isArray(spec.attachments)
      ? spec.attachments.filter(isRecord)
      : [];
    for (const raw of attachments) {
      const attachmentPhase = normalizePhase(String(raw.phase ?? ""));
      if (attachmentPhase !== phase) continue;
      const attachmentResource = raw.resource === undefined
        ? undefined
        : qualify(String(raw.resource), row.namespace);
      const attachmentAction = raw.action === undefined
        ? undefined
        : qualify(String(raw.action), row.namespace);
      if (resource && attachmentResource && attachmentResource !== resource) {
        continue;
      }
      if (action && attachmentAction && attachmentAction !== action) continue;
      hooks.push({
        id: `${row.namespace}.${row.name}`,
        order: typeof raw.order === "number" ? raw.order : 1000,
      });
    }
  }
  const loaded: HookDefinition[] = [];
  for (
    const item of hooks.sort((a, b) =>
      a.order - b.order || a.id.localeCompare(b.id)
    )
  ) {
    const hook = await loadHook(sql, item.id);
    if (hook) loaded.push(hook);
  }
  return loaded;
}

async function enqueueAfterCommitHooks(
  sql: Queryable,
  changesetId: string,
  actorId: string,
  planned: PlannedOperation[],
): Promise<void> {
  const hooks = await loadAttachedHooks(
    sql,
    "event.after_commit",
    undefined,
    undefined,
  );
  if (!hooks.length) return;
  const events = await query<{
    id: string;
    event_type: string;
    resource: string | null;
    object_id: string | null;
    object_version_id: string | null;
    payload_json: unknown;
  }>(
    sql,
    `select id,event_type,resource,object_id,object_version_id,payload_json
     from events where changeset_id=$1 order by occurred_at,id`,
    [changesetId],
  );
  const operations = planned.map((op) => ({
    op: op.op,
    resource: op.resource,
    relationship: op.relationship,
    id: op.objectId ?? op.id,
  }));
  for (const event of events.rows) {
    for (const hook of hooks) {
      const eventPayload = {
        id: event.id,
        event_id: event.id,
        type: event.event_type,
        event_type: event.event_type,
        resource: event.resource,
        object_id: event.object_id,
        object_version_id: event.object_version_id,
        payload: event.payload_json,
        changeset_id: changesetId,
      };
      await query(
        sql,
        `insert into outbox(id,event_id,hook,phase,hook_revision,script_digest,payload_json,envelope_json)
         values ($1,$2,$3,'event.after_commit',$4,$5,$6::jsonb,$7::jsonb)`,
        [
          crypto.randomUUID(),
          event.id,
          `${hook.namespace}.${hook.name}`,
          hook.revision,
          hook.scriptDigest,
          JSON.stringify({
            changeset_id: changesetId,
            actor_id: actorId,
            operations,
            event: eventPayload,
            event_id: event.id,
          }),
          JSON.stringify({
            hook: hook.name,
            phase: "event.after_commit",
            input: {
              actor_id: actorId,
              changeset_id: changesetId,
              operations,
              event: eventPayload,
              event_id: event.id,
            },
            metadata: {
              pack_revision: hook.revision,
              script_digest: hook.scriptDigest,
              event_id: event.id,
            },
          }),
        ],
      );
    }
  }
}

function applyPatch(
  op: ChangesetOperation,
  patch: JsonRecord,
): ChangesetOperation {
  const path = String(patch.path ?? "");
  if (!path.startsWith("/fields/")) return op;
  const field = path.slice("/fields/".length);
  const fields = { ...(op.fields ?? {}) };
  if (patch.op === "unset") delete fields[field];
  else fields[field] = patch.value;
  return { ...op, fields };
}

function normalizeOperation(op: ChangesetOperation): ChangesetOperation {
  const normalized = { ...op };
  const rec = normalized as ChangesetOperation & { expectedVersion?: number };
  if (
    rec.expectedVersion !== undefined &&
    normalized.expected_version === undefined
  ) {
    normalized.expected_version = rec.expectedVersion;
    delete rec.expectedVersion;
  }
  return normalized;
}
function normalizePhase(phase: string): string {
  if (phase === "before_preview") return "changeset.before_preview";
  if (phase === "validate") return "changeset.validate";
  if (phase === "action") return "action.preview";
  if (phase === "after_commit") return "event.after_commit";
  return phase;
}
function qualify(id: string, namespace: string): string {
  return id.includes(".") ? id : `${namespace}.${id}`;
}

function previewDto(
  id: string,
  actor: string,
  plan: { errors: ValidationIssue[]; planned: PlannedOperation[] },
): ChangesetPreviewDto {
  return {
    id,
    actor_id: actor,
    committable: plan.errors.length === 0,
    validation: { errors: plan.errors, warnings: [] },
    operations: plan.planned.map((op) => ({
      op: op.op,
      resource: op.resource,
      relationship: op.relationship,
      id: op.objectId ?? op.id,
      from: op.from,
      to: op.to,
      before: op.before,
      after: op.after,
      changed_fields: op.changed_fields,
    })),
  };
}

async function getResourceMeta(
  sql: Queryable,
  id: string,
): Promise<ResourceMeta | null> {
  const [namespace, name] = splitId(id);
  if (!namespace || !name) return null;
  const rows = await query<
    {
      namespace: string;
      name: string;
      revision: string;
      spec: unknown;
      table_name: string;
    }
  >(
    sql,
    `select r.namespace,r.name,r.revision,r.spec,g.table_name from resource_definitions r join generated_sql_objects g on g.revision=r.revision and g.namespace=r.namespace and g.name=r.name and g.kind='resource_table' where r.namespace=$1 and r.name=$2 and r.revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const spec = asRecord(row.spec);
  return {
    namespace,
    name,
    revision: row.revision,
    tableName: row.table_name,
    fields: asRecord(spec.fields) as ResourceMeta["fields"],
    lifecycleField: typeof asRecord(spec.lifecycle).field === "string"
      ? String(asRecord(spec.lifecycle).field)
      : undefined,
  };
}
async function getRelationshipMeta(
  sql: Queryable,
  id: string,
): Promise<RelationshipMeta | null> {
  const [namespace, name] = splitId(id);
  if (!namespace || !name) return null;
  const rows = await query<
    { namespace: string; name: string; revision: string; table_name: string }
  >(
    sql,
    `select r.namespace,r.name,r.revision,g.table_name from relationship_definitions r join generated_sql_objects g on g.revision=r.revision and g.namespace=r.namespace and g.name=r.name and g.kind='relationship_table' where r.namespace=$1 and r.name=$2 and r.revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  return rows.rows[0]
    ? {
      namespace,
      name,
      revision: rows.rows[0].revision,
      tableName: rows.rows[0].table_name,
    }
    : null;
}
async function readObject(
  sql: Queryable,
  meta: ResourceMeta,
  id: string,
  includeArchived: boolean,
): Promise<JsonRecord | null> {
  const result = await query<JsonRecord>(
    sql,
    `select * from ${qi(meta.tableName)} where id=$1 ${
      includeArchived ? "" : "and archived_at is null"
    }`,
    [id],
  );
  return result.rows[0] ?? null;
}
function transitionField(meta: ResourceMeta): string {
  return meta.lifecycleField ??
    (meta.fields.status ? "status" : meta.fields.stage ? "stage" : "state");
}

function validateFields(
  path: string,
  meta: ResourceMeta,
  fields: JsonRecord,
  errors: ValidationIssue[],
  create: boolean,
) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === "id") continue;
    const field = meta.fields[key];
    if (!field) {
      errors.push(
        issue(`${path}/fields/${key}`, "unknown_field", `unknown field ${key}`),
      );
      continue;
    }
    if (value === null || value === undefined) continue;
    const type = field.type;
    if (type === "string" && typeof value !== "string") {
      errors.push(
        issue(`${path}/fields/${key}`, "type", `${key} must be string`),
      );
    }
    if (type === "integer" && !Number.isInteger(value)) {
      errors.push(
        issue(`${path}/fields/${key}`, "type", `${key} must be integer`),
      );
    }
    if (type === "boolean" && typeof value !== "boolean") {
      errors.push(
        issue(`${path}/fields/${key}`, "type", `${key} must be boolean`),
      );
    }
    if (
      type === "decimal" &&
      !(typeof value === "number" ||
        (typeof value === "string" && value.trim() !== "" &&
          !Number.isNaN(Number(value))))
    ) {
      errors.push(
        issue(`${path}/fields/${key}`, "type", `${key} must be decimal`),
      );
    }
    if (
      (type === "timestamp" || type === "date") && typeof value !== "string"
    ) {
      errors.push(
        issue(
          `${path}/fields/${key}`,
          "type",
          `${key} must be string timestamp/date`,
        ),
      );
    }
  }
  if (!create) return;
}
function buildAfter(
  op: string,
  before: JsonRecord | null | undefined,
  fields: JsonRecord,
): JsonRecord | null {
  if (op === "archive") {
    return before ? { ...before, archived_at: "<archived>" } : null;
  }
  if (op === "comment") return before ?? null;
  return { ...(before ?? {}), ...fields };
}
function diffFields(before: JsonRecord, after: JsonRecord): string[] {
  return Object.keys(after).filter((key) =>
    JSON.stringify(before[key]) !== JSON.stringify(after[key]) &&
    !["updated_at", "current_object_version_id", "version"].includes(key)
  ).sort();
}
function splitId(id: string): [string | null, string | null] {
  const parts = String(id).split(".");
  return parts.length === 2 ? [parts[0], parts[1]] : [null, null];
}
function resolveRef(
  value: string | undefined,
  aliases: Map<string, string>,
): string {
  if (!value) return "";
  const key = value.startsWith("@") ? value.slice(1) : value;
  return aliases.get(key) ?? aliases.get(value) ?? value;
}
function actorOf(input: ChangesetRequest): ActorContext {
  if (input.actor_context) return normalizeActor(input.actor_context);
  if (input.actor && typeof input.actor === "object") {
    return normalizeActor(input.actor);
  }
  if (input.actor_id) return normalizeActor(input.actor_id);
  return normalizeActor(input.actor ?? "anonymous");
}
function policyAction(op: ChangesetOperation["op"]): string {
  if (op === "transition") return "transition";
  if (op === "archive") return "archive";
  if (op === "comment") return "comment";
  if (op === "link") return "link";
  if (op === "unlink") return "unlink";
  if (op === "create") return "create";
  return "update";
}
function fieldContext(meta: ResourceMeta): Record<string, FieldSpec> {
  const fields: Record<string, FieldSpec> = {
    id: { type: "string" },
    version: { type: "integer" },
    archived_at: { type: "timestamp", nullable: true },
    archived_by: { type: "string", nullable: true },
    current_object_version_id: { type: "string", nullable: true },
    created_at: { type: "timestamp" },
    updated_at: { type: "timestamp" },
  };
  for (const [name, spec] of Object.entries(meta.fields)) {
    fields[name] = { type: mapFieldType(spec.type), nullable: !spec.required };
  }
  return fields;
}
function mapFieldType(type: unknown): FieldSpec["type"] {
  if (
    type === "integer" || type === "decimal" || type === "boolean" ||
    type === "timestamp" || type === "date"
  ) return type;
  return "string";
}
function issue(path: string, code: string, message: string): ValidationIssue {
  return { level: "error", path, code, message };
}
function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stableJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return stableJson(parsed);
    } catch {
      // Treat non-JSON strings as ordinary scalar JSON values.
    }
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")
  }}`;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function qi(identifier: string): string {
  return quoteIdentifier(identifier);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function stableSeedId(
  namespace: string,
  resource: string,
  keyField: string,
  key: unknown,
): string {
  return `seed_${namespace}_${resource}_${keyField}_${
    String(key).replace(/[^a-zA-Z0-9_]+/g, "_")
  }`.slice(0, 120);
}
