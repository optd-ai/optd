import postgres from "npm:postgres";

export type Sql = ReturnType<typeof postgres>;
type Tx = {
  // postgres.js transaction clients expose the same unsafe query method.
  // deno-lint-ignore no-explicit-any
  unsafe: any;
};

type StageOperation = {
  table: string;
  object_id: string;
  mode: "mutate" | "read";
  expected_version: number;
  value?: string;
};

type StageRow = {
  id: string;
  pack_revision: number;
  project_id: string;
  actor_id: string;
  operations: StageOperation[];
};

export type CommitResult =
  | { status: "committed"; commit_id: string; attempts: number }
  | { status: "already_committed"; commit_id: string; attempts: number }
  | {
    status:
      | "stage_cancelled"
      | "stage_stale"
      | "authorization_changed"
      | "approval_changed"
      | "commit_busy"
      | "commit_retry_exhausted";
    reason?: string;
    attempts: number;
  };

export type CommitHooks = {
  afterStageLock?: () => Promise<void> | void;
  afterTableLocks?: () => Promise<void> | void;
  afterDependencyLocks?: () => Promise<void> | void;
  afterAuthorization?: () => Promise<void> | void;
};

export type PackApplyHooks = {
  afterTableLocks?: () => Promise<void> | void;
};

export function canonicalTableOrder(tables: Iterable<string>): string[] {
  return [...new Set(tables)].sort((a, b) => a.localeCompare(b));
}

export function canonicalDependencyOrder(operations: StageOperation[]) {
  const strongest = new Map<string, StageOperation>();
  for (const operation of operations) {
    const key = `${operation.table}\0${operation.object_id}`;
    const current = strongest.get(key);
    if (!current || operation.mode === "mutate") strongest.set(key, operation);
  }
  return [...strongest.values()].sort((a, b) =>
    a.table.localeCompare(b.table) || a.object_id.localeCompare(b.object_id)
  );
}

export function requestedLockTimeoutMs(
  requested: number | undefined,
  serverDefault = 10_000,
): number {
  if (requested === undefined) return serverDefault;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error("lock timeout must be a positive integer number of milliseconds");
  }
  return requested;
}

export async function installSchema(sql: Sql): Promise<void> {
  const statements = [
    `create table proto_pack_installations(
      pack text primary key,
      active_revision integer not null
    )`,
    `create table proto_projects(
      id uuid primary key,
      active boolean not null default true
    )`,
    `create table proto_authorizations(
      actor_id text primary key,
      allowed boolean not null
    )`,
    `create table proto_stages(
      id uuid primary key,
      pack_revision integer not null,
      project_id uuid not null,
      actor_id text not null,
      operations jsonb not null
    )`,
    `create table proto_stage_approvals(
      stage_id uuid primary key references proto_stages(id),
      approved boolean not null
    )`,
    `create table proto_stage_cancellations(
      stage_id uuid primary key references proto_stages(id),
      cancelled_at timestamptz not null default now()
    )`,
    `create table proto_commits(
      id uuid primary key,
      stage_id uuid not null unique references proto_stages(id),
      committed_at timestamptz not null default now()
    )`,
    `create table proto_object_versions(
      id uuid primary key,
      commit_id uuid not null references proto_commits(id),
      table_name text not null,
      object_id uuid not null,
      version integer not null,
      value text
    )`,
    `create table proto_events(
      id uuid primary key,
      commit_id uuid not null references proto_commits(id)
    )`,
    `create table proto_outbox(
      id uuid primary key,
      event_id uuid not null references proto_events(id)
    )`,
    `create table proto_a(
      id uuid primary key,
      version integer not null,
      value text
    )`,
    `create table proto_b(
      id uuid primary key,
      version integer not null,
      value text
    )`,
    "insert into proto_pack_installations values ('optd/test', 1)",
  ];
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

export async function commitStage(
  sql: Sql,
  stageId: string,
  options: {
    lockTimeoutMs?: number;
    serverDefaultLockTimeoutMs?: number;
    maxRetries?: number;
    hooks?: CommitHooks;
  } = {},
): Promise<CommitResult> {
  const timeout = requestedLockTimeoutMs(
    options.lockTimeoutMs,
    options.serverDefaultLockTimeoutMs,
  );
  const maxRetries = options.maxRetries ?? 3;
  let attempts = 0;

  while (attempts < maxRetries) {
    attempts++;
    try {
      const result = await sql.begin(async (tx) => {
        await setLockTimeout(tx, timeout);
        const stages = await tx.unsafe(
          `select id, pack_revision, project_id, actor_id, operations
             from proto_stages where id = $1 for update`,
          [stageId],
        );
        const stage = stages[0] as unknown as StageRow | undefined;
        if (!stage) throw new Error(`stage ${stageId} not found`);
        await options.hooks?.afterStageLock?.();

        const prior = await tx.unsafe(
          "select id from proto_commits where stage_id = $1",
          [stageId],
        );
        if (prior[0]) {
          return {
            status: "already_committed" as const,
            commit_id: String(prior[0].id),
          };
        }
        const cancellation = await tx.unsafe(
          "select 1 from proto_stage_cancellations where stage_id = $1",
          [stageId],
        );
        if (cancellation.length) return { status: "stage_cancelled" as const };

        const operations = typeof stage.operations === "string"
          ? JSON.parse(stage.operations) as StageOperation[]
          : stage.operations;
        const tables = canonicalTableOrder(operations.map((op) => op.table));
        for (const table of tables) {
          await tx.unsafe(`lock table ${quoteIdentifier(table)} in row exclusive mode`);
        }
        await options.hooks?.afterTableLocks?.();

        // Re-read revision only after acquiring table locks. READ COMMITTED gives
        // this statement a current snapshot after waiting for pack apply.
        const packs = await tx.unsafe(
          "select active_revision from proto_pack_installations where pack = 'optd/test'",
        );
        if (Number(packs[0]?.active_revision) !== Number(stage.pack_revision)) {
          return {
            status: "stage_stale" as const,
            reason: "pack_revision_changed",
          };
        }

        const projects = await tx.unsafe(
          "select active from proto_projects where id = $1 for share",
          [stage.project_id],
        );
        if (!projects[0]?.active) {
          return { status: "stage_stale" as const, reason: "project_changed" };
        }

        for (const dependency of canonicalDependencyOrder(operations)) {
          const mode = dependency.mode === "mutate" ? "update" : "share";
          await tx.unsafe(
            `select id from ${quoteIdentifier(dependency.table)} where id = $1 for ${mode}`,
            [dependency.object_id],
          );
        }
        await options.hooks?.afterDependencyLocks?.();

        // One statement snapshot represents the authorization decision point.
        const authorization = await tx.unsafe(
          `select a.allowed
             from proto_authorizations a
             join proto_projects p on p.id = $2
            where a.actor_id = $1 and p.active`,
          [stage.actor_id, stage.project_id],
        );
        if (!authorization[0]?.allowed) {
          return { status: "authorization_changed" as const };
        }
        await options.hooks?.afterAuthorization?.();

        const approvals = await tx.unsafe(
          "select approved from proto_stage_approvals where stage_id = $1",
          [stageId],
        );
        if (!approvals[0]?.approved) {
          return { status: "approval_changed" as const };
        }

        for (const dependency of canonicalDependencyOrder(operations)) {
          const rows = await tx.unsafe(
            `select version from ${quoteIdentifier(dependency.table)} where id = $1`,
            [dependency.object_id],
          );
          if (Number(rows[0]?.version) !== Number(dependency.expected_version)) {
            return {
              status: "stage_stale" as const,
              reason: "object_version_changed",
            };
          }
        }

        const commitId = crypto.randomUUID();
        await tx.unsafe(
          "insert into proto_commits(id, stage_id) values ($1,$2)",
          [commitId, stageId],
        );
        for (const operation of operations.filter((op) => op.mode === "mutate")) {
          await tx.unsafe(
            `update ${quoteIdentifier(operation.table)}
                set value = $2, version = version + 1
              where id = $1`,
            [operation.object_id, operation.value ?? null],
          );
          const rows = await tx.unsafe(
            `select version, value from ${quoteIdentifier(operation.table)} where id = $1`,
            [operation.object_id],
          );
          await tx.unsafe(
            `insert into proto_object_versions
               (id, commit_id, table_name, object_id, version, value)
             values ($1,$2,$3,$4,$5,$6)`,
            [
              crypto.randomUUID(),
              commitId,
              operation.table,
              operation.object_id,
              rows[0].version,
              rows[0].value,
            ],
          );
        }
        const eventId = crypto.randomUUID();
        await tx.unsafe(
          "insert into proto_events(id,commit_id) values ($1,$2)",
          [eventId, commitId],
        );
        await tx.unsafe(
          "insert into proto_outbox(id,event_id) values ($1,$2)",
          [crypto.randomUUID(), eventId],
        );
        return { status: "committed" as const, commit_id: commitId };
      });
      return { ...result, attempts };
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "55P03") return { status: "commit_busy", attempts };
      if ((code === "40P01" || code === "40001") && attempts < maxRetries) {
        await delay(5 * attempts);
        continue;
      }
      if (code === "40P01" || code === "40001") {
        return { status: "commit_retry_exhausted", attempts };
      }
      throw error;
    }
  }
  return { status: "commit_retry_exhausted", attempts };
}

export async function cancelStage(sql: Sql, stageId: string) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("select id from proto_stages where id = $1 for update", [stageId]);
    const committed = await tx.unsafe(
      "select id from proto_commits where stage_id = $1",
      [stageId],
    );
    if (committed[0]) return "already_committed" as const;
    await tx.unsafe(
      "insert into proto_stage_cancellations(stage_id) values ($1) on conflict do nothing",
      [stageId],
    );
    return "cancelled" as const;
  });
}

export async function setApproval(sql: Sql, stageId: string, approved: boolean) {
  return await sql.begin(async (tx) => {
    await tx.unsafe("select id from proto_stages where id = $1 for update", [stageId]);
    const committed = await tx.unsafe(
      "select id from proto_commits where stage_id = $1",
      [stageId],
    );
    if (committed[0]) return "already_committed" as const;
    await tx.unsafe(
      `insert into proto_stage_approvals(stage_id,approved) values ($1,$2)
       on conflict(stage_id) do update set approved=excluded.approved`,
      [stageId, approved],
    );
    return "updated" as const;
  });
}

export async function applyPackRevision(
  sql: Sql,
  revision: number,
  tables: string[],
  options: { lockTimeoutMs?: number; hooks?: PackApplyHooks } = {},
): Promise<"applied" | "pack_install_busy"> {
  try {
    return await sql.begin(async (tx) => {
      await setLockTimeout(tx, options.lockTimeoutMs ?? 10_000);
      for (const table of canonicalTableOrder(tables)) {
        await tx.unsafe(
          `lock table ${quoteIdentifier(table)} in share row exclusive mode`,
        );
      }
      await options.hooks?.afterTableLocks?.();
      await tx.unsafe(
        "update proto_pack_installations set active_revision = $1 where pack = 'optd/test'",
        [revision],
      );
      return "applied" as const;
    });
  } catch (error) {
    if (postgresErrorCode(error) === "55P03") return "pack_install_busy";
    throw error;
  }
}

export async function seedScenario(
  sql: Sql,
  input: {
    stageId: string;
    projectId: string;
    actorId?: string;
    packRevision?: number;
    operations: StageOperation[];
    approved?: boolean;
  },
) {
  const actor = input.actorId ?? "agent";
  await sql.begin(async (tx) => {
    await tx.unsafe(
      "insert into proto_projects(id,active) values ($1,true) on conflict do nothing",
      [input.projectId],
    );
    await tx.unsafe(
      `insert into proto_authorizations(actor_id,allowed) values ($1,true)
       on conflict(actor_id) do update set allowed=true`,
      [actor],
    );
    await tx.unsafe(
      `insert into proto_stages(id,pack_revision,project_id,actor_id,operations)
       values ($1,$2,$3,$4,$5::jsonb)`,
      [
        input.stageId,
        input.packRevision ?? 1,
        input.projectId,
        actor,
        JSON.stringify(input.operations),
      ],
    );
    await tx.unsafe(
      "insert into proto_stage_approvals(stage_id,approved) values ($1,$2)",
      [input.stageId, input.approved ?? true],
    );
  });
}

async function setLockTimeout(tx: Tx, milliseconds: number) {
  await tx.unsafe("select set_config('lock_timeout', $1, true)", [`${milliseconds}ms`]);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return String((error as { code?: unknown }).code ?? "") || undefined;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
