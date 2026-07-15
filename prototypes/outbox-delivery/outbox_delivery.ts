import postgres from "npm:postgres";

export type Sql = ReturnType<typeof postgres>;
type Tx = { // deno-lint-ignore no-explicit-any
  unsafe: any;
};

type DeliveryRow = {
  id: string;
  hook_identity: string;
  hook_revision: string;
  script_digest: string;
  security_digest: string;
  grant_id: string;
  event_id: string;
  envelope: unknown;
  status: DeliveryStatus;
  retry_generation: number;
  attempts_in_generation: number;
  total_attempts: number;
  max_attempts: number;
  lease_attempt_id: string | null;
};

export type DeliveryStatus =
  | "pending"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "dead_letter"
  | "cancelled";

export type DeliveryOutcome =
  | { outcome: "succeeded"; summary?: string; external_id?: string }
  | {
    outcome: "retry";
    code: string;
    message: string;
    retry_after_ms?: number;
  }
  | { outcome: "dead_letter"; code: string; message: string };

export type ExecutionContext = {
  delivery_id: string;
  idempotency_key: string;
  attempt_id: string;
  retry_generation: number;
  attempt_number: number;
  hook_identity: string;
  hook_revision: string;
  event_id: string;
  secret_value_version: number;
  envelope: Record<string, unknown>;
};

export type Executor = (context: ExecutionContext) => Promise<DeliveryOutcome>;

export type DeliveryConfig = {
  leaseMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
};

export async function installOutboxPrototypeSchema(sql: Sql) {
  const statements = [
    `create table proto_pinned_hooks(
      revision text primary key,
      hook_identity text not null,
      script_digest text not null,
      security_digest text not null,
      enabled boolean not null,
      grant_id uuid not null,
      grant_active boolean not null,
      secret_active boolean not null,
      secret_value_version integer not null
    )`,
    `create table proto_active_hooks(
      hook_identity text primary key,
      revision text not null references proto_pinned_hooks(revision)
    )`,
    `create table proto_deliveries(
      id uuid primary key,
      event_id uuid not null,
      hook_identity text not null,
      hook_revision text not null,
      script_digest text not null,
      security_digest text not null,
      grant_id uuid not null,
      envelope jsonb not null,
      status text not null check(status in ('pending','running','retry_wait','succeeded','dead_letter','cancelled')),
      retry_generation integer not null default 0,
      attempts_in_generation integer not null default 0,
      total_attempts integer not null default 0,
      max_attempts integer not null default 10,
      available_at timestamptz not null,
      lease_owner text,
      lease_attempt_id uuid,
      lease_expires_at timestamptz,
      last_error_code text,
      last_error_message text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique(event_id, hook_identity)
    )`,
    `create table proto_attempts(
      id uuid primary key,
      delivery_id uuid not null references proto_deliveries(id),
      retry_generation integer not null,
      attempt_number integer not null,
      total_attempt_number integer not null,
      worker_id text not null,
      hook_revision text not null,
      grant_id uuid not null,
      secret_value_version integer,
      idempotency_key uuid not null,
      started_at timestamptz not null,
      lease_expires_at timestamptz not null,
      completed_at timestamptz,
      outcome text not null check(outcome in ('running','succeeded','retry','dead_letter','lease_expired','late_succeeded','late_failed')),
      error_code text,
      error_message text,
      external_id text,
      unique(delivery_id,retry_generation,attempt_number)
    )`,
  ];
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

export async function registerPinnedHook(
  sql: Sql,
  input: {
    revision: string;
    hookIdentity: string;
    scriptDigest: string;
    securityDigest: string;
    grantId: string;
    enabled?: boolean;
    grantActive?: boolean;
    secretActive?: boolean;
    secretValueVersion?: number;
    active?: boolean;
  },
) {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `insert into proto_pinned_hooks
       (revision,hook_identity,script_digest,security_digest,enabled,grant_id,grant_active,secret_active,secret_value_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.revision,
        input.hookIdentity,
        input.scriptDigest,
        input.securityDigest,
        input.enabled ?? true,
        input.grantId,
        input.grantActive ?? true,
        input.secretActive ?? true,
        input.secretValueVersion ?? 1,
      ],
    );
    if (input.active ?? true) {
      await tx.unsafe(
        `insert into proto_active_hooks(hook_identity,revision) values ($1,$2)
         on conflict(hook_identity) do update set revision=excluded.revision`,
        [input.hookIdentity, input.revision],
      );
    }
  });
}

export async function enqueueDelivery(
  sql: Sql,
  input: {
    id?: string;
    eventId?: string;
    hookIdentity: string;
    hookRevision: string;
    scriptDigest: string;
    securityDigest: string;
    grantId: string;
    envelope?: Record<string, unknown>;
    maxAttempts?: number;
    now?: Date;
  },
) {
  const id = input.id ?? uuidV7();
  const eventId = input.eventId ?? uuidV7();
  const now = input.now ?? new Date();
  await sql.unsafe(
    `insert into proto_deliveries
     (id,event_id,hook_identity,hook_revision,script_digest,security_digest,grant_id,envelope,status,max_attempts,available_at,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending',$9,$10,$10,$10)`,
    [
      id,
      eventId,
      input.hookIdentity,
      input.hookRevision,
      input.scriptDigest,
      input.securityDigest,
      input.grantId,
      JSON.stringify(input.envelope ?? {}),
      input.maxAttempts ?? 10,
      now,
    ],
  );
  return { deliveryId: id, eventId };
}

export async function claimOne(
  sql: Sql,
  workerId: string,
  now = new Date(),
  leaseMs = 60_000,
): Promise<(DeliveryRow & { attempt_id: string; attempt_number: number }) | null> {
  return await sql.begin(async (tx) => {
    await expireLeases(tx, now);
    const rows = await tx.unsafe(
      `select * from proto_deliveries
       where status in ('pending','retry_wait') and available_at <= $1
       order by available_at,id
       limit 1 for update skip locked`,
      [now],
    );
    const row = rows[0] as unknown as DeliveryRow | undefined;
    if (!row) return null;
    const attemptId = uuidV7();
    const attemptNumber = Number(row.attempts_in_generation) + 1;
    const totalAttempt = Number(row.total_attempts) + 1;
    const leaseExpires = new Date(now.getTime() + leaseMs);
    await tx.unsafe(
      `update proto_deliveries
       set status='running', attempts_in_generation=$2,total_attempts=$3,
           lease_owner=$4,lease_attempt_id=$5,lease_expires_at=$6,updated_at=$1
       where id=$7`,
      [now, attemptNumber, totalAttempt, workerId, attemptId, leaseExpires, row.id],
    );
    await tx.unsafe(
      `insert into proto_attempts
       (id,delivery_id,retry_generation,attempt_number,total_attempt_number,worker_id,
        hook_revision,grant_id,idempotency_key,started_at,lease_expires_at,outcome)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$2,$9,$10,'running')`,
      [
        attemptId,
        row.id,
        row.retry_generation,
        attemptNumber,
        totalAttempt,
        workerId,
        row.hook_revision,
        row.grant_id,
        now,
        leaseExpires,
      ],
    );
    return { ...row, attempt_id: attemptId, attempt_number: attemptNumber };
  });
}

export async function processNext(
  sql: Sql,
  workerId: string,
  executor: Executor,
  options: DeliveryConfig & { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const claimed = await claimOne(sql, workerId, now, options.leaseMs ?? 60_000);
  if (!claimed) return { status: "idle" as const };

  const pinnedRows = await sql.unsafe(
    "select * from proto_pinned_hooks where revision=$1",
    [claimed.hook_revision],
  );
  const pinned = pinnedRows[0] as Record<string, unknown> | undefined;
  const permanent = permanentConfigurationFailure(claimed, pinned);
  if (permanent) {
    await finishAttempt(sql, claimed, {
      outcome: "dead_letter",
      code: permanent.code,
      message: permanent.message,
    }, now, options);
    return { status: "dead_letter" as const, delivery_id: claimed.id, code: permanent.code };
  }

  let outcome: DeliveryOutcome;
  try {
    outcome = await executor({
      delivery_id: claimed.id,
      idempotency_key: claimed.id,
      attempt_id: claimed.attempt_id,
      retry_generation: Number(claimed.retry_generation),
      attempt_number: claimed.attempt_number,
      hook_identity: claimed.hook_identity,
      hook_revision: claimed.hook_revision,
      event_id: claimed.event_id,
      secret_value_version: Number(pinned!.secret_value_version),
      envelope: asRecord(claimed.envelope),
    });
  } catch (error) {
    outcome = {
      outcome: "retry",
      code: "hook_execution_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const status = await finishAttempt(sql, claimed, outcome, now, options);
  return { status, delivery_id: claimed.id, outcome };
}

export async function cancelDelivery(sql: Sql, id: string, now = new Date()) {
  return await sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      "select status from proto_deliveries where id=$1 for update",
      [id],
    );
    const status = rows[0]?.status as DeliveryStatus | undefined;
    if (!status) return "not_found" as const;
    if (status === "running") return "delivery_in_progress" as const;
    if (status !== "pending" && status !== "retry_wait") {
      return `already_${status}` as const;
    }
    await tx.unsafe(
      `update proto_deliveries set status='cancelled',updated_at=$2,
       lease_owner=null,lease_attempt_id=null,lease_expires_at=null where id=$1`,
      [id, now],
    );
    return "cancelled" as const;
  });
}

export async function retryDeadLetter(sql: Sql, id: string, now = new Date()) {
  return await sql.begin(async (tx) => {
    const rows = await tx.unsafe(
      "select status,retry_generation from proto_deliveries where id=$1 for update",
      [id],
    );
    if (!rows[0]) return "not_found" as const;
    if (rows[0].status !== "dead_letter") return "not_dead_letter" as const;
    await tx.unsafe(
      `update proto_deliveries
       set status='pending',retry_generation=retry_generation+1,
           attempts_in_generation=0,available_at=$2,last_error_code=null,
           last_error_message=null,lease_owner=null,lease_attempt_id=null,
           lease_expires_at=null,updated_at=$2 where id=$1`,
      [id, now],
    );
    return "pending" as const;
  });
}

export async function pollUntilIdle(
  sql: Sql,
  workerId: string,
  executor: Executor,
  options: DeliveryConfig & { intervalMs?: number; signal: AbortSignal },
) {
  while (!options.signal.aborted) {
    const result = await processNext(sql, workerId, executor, options);
    if (result.status === "idle") await delay(options.intervalMs ?? 100);
  }
}

export function fullJitterBackoffMs(
  attempt: number,
  random = Math.random,
  initialMs = 5_000,
  maxMs = 3_600_000,
) {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.max(0, Math.min(0.999999999, random())) * ceiling);
}

async function expireLeases(tx: Tx, now: Date) {
  const expired = await tx.unsafe(
    `select id,lease_attempt_id from proto_deliveries
     where status='running' and lease_expires_at <= $1 for update skip locked`,
    [now],
  );
  for (const row of expired) {
    await tx.unsafe(
      `update proto_attempts set outcome='lease_expired',completed_at=$2,
       error_code='lease_expired',error_message='worker lease expired'
       where id=$1 and outcome='running'`,
      [row.lease_attempt_id, now],
    );
    await tx.unsafe(
      `update proto_deliveries set status='pending',available_at=$2,
       lease_owner=null,lease_attempt_id=null,lease_expires_at=null,updated_at=$2
       where id=$1`,
      [row.id, now],
    );
  }
}

async function finishAttempt(
  sql: Sql,
  row: DeliveryRow & { attempt_id: string; attempt_number: number },
  outcome: DeliveryOutcome,
  now: Date,
  config: DeliveryConfig,
): Promise<"succeeded" | "retry_wait" | "dead_letter" | "late"> {
  return await sql.begin(async (tx) => {
    const current = await tx.unsafe(
      "select status,lease_attempt_id from proto_deliveries where id=$1 for update",
      [row.id],
    );
    const ownsLease = current[0]?.status === "running" &&
      current[0]?.lease_attempt_id === row.attempt_id;
    if (!ownsLease) {
      await tx.unsafe(
        `update proto_attempts set outcome=$2,completed_at=$3,error_code=$4,error_message=$5
         where id=$1`,
        [
          row.attempt_id,
          outcome.outcome === "succeeded" ? "late_succeeded" : "late_failed",
          now,
          outcome.outcome === "succeeded" ? null : outcome.code,
          outcome.outcome === "succeeded" ? null : outcome.message,
        ],
      );
      return "late" as const;
    }

    if (outcome.outcome === "succeeded") {
      await tx.unsafe(
        `update proto_attempts set outcome='succeeded',completed_at=$2,external_id=$3 where id=$1`,
        [row.attempt_id, now, outcome.external_id ?? null],
      );
      await tx.unsafe(
        `update proto_deliveries set status='succeeded',lease_owner=null,
         lease_attempt_id=null,lease_expires_at=null,last_error_code=null,
         last_error_message=null,updated_at=$2 where id=$1`,
        [row.id, now],
      );
      return "succeeded" as const;
    }

    const exhausted = row.attempt_number >= Number(row.max_attempts);
    const dead = outcome.outcome === "dead_letter" || exhausted;
    const status = dead ? "dead_letter" : "retry_wait";
    const retryAfter = outcome.outcome === "retry" && outcome.retry_after_ms !== undefined
      ? outcome.retry_after_ms
      : fullJitterBackoffMs(
        row.attempt_number,
        config.random,
        config.initialBackoffMs,
        config.maxBackoffMs,
      );
    await tx.unsafe(
      `update proto_attempts set outcome=$2,completed_at=$3,error_code=$4,error_message=$5
       where id=$1`,
      [row.attempt_id, dead ? "dead_letter" : "retry", now, outcome.code, outcome.message],
    );
    await tx.unsafe(
      `update proto_deliveries set status=$2,available_at=$3,
       lease_owner=null,lease_attempt_id=null,lease_expires_at=null,
       last_error_code=$4,last_error_message=$5,updated_at=$6 where id=$1`,
      [
        row.id,
        status,
        new Date(now.getTime() + Math.max(0, retryAfter)),
        outcome.code,
        outcome.message,
        now,
      ],
    );
    return status;
  });
}

function permanentConfigurationFailure(
  delivery: DeliveryRow,
  pinned: Record<string, unknown> | undefined,
) {
  if (!pinned) return failure("pinned_hook_missing", "pinned hook revision is missing");
  if (!pinned.enabled) return failure("pinned_hook_disabled", "pinned hook revision is disabled");
  if (pinned.script_digest !== delivery.script_digest ||
    pinned.security_digest !== delivery.security_digest) {
    return failure("pinned_hook_digest_mismatch", "pinned hook digest does not match delivery");
  }
  if (String(pinned.grant_id) !== delivery.grant_id || !pinned.grant_active) {
    return failure("hook_secret_grant_unavailable", "pinned hook-secret grant is unavailable");
  }
  if (!pinned.secret_active) return failure("hook_secret_unavailable", "secret is disabled");
  return null;
}

function failure(code: string, message: string) {
  return { code, message };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function uuidV7(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
