export type PostgresRuntimeMode = "external" | "app_managed";

export type PostgresRuntimePlan = {
  mode: PostgresRuntimeMode;
  databaseUrl?: string;
  dataDir?: string;
  pgBinDir?: string;
  binariesAvailable: boolean;
  skipReason?: string;
};

export function planPostgresRuntime(
  env: Deno.Env = Deno.env,
): PostgresRuntimePlan {
  const databaseUrl = env.get("OPERANT_DATABASE_URL") ?? undefined;
  if (databaseUrl) {
    return {
      mode: "external",
      databaseUrl,
      binariesAvailable: true,
    };
  }

  const pgBinDir = env.get("OPERANT_PG_BIN_DIR") ?? undefined;
  const dataDir = env.get("OPERANT_DATA_DIR") ?? undefined;
  const binariesAvailable = Boolean(pgBinDir);
  return {
    mode: "app_managed",
    dataDir,
    pgBinDir,
    binariesAvailable,
    skipReason: binariesAvailable
      ? undefined
      : "OPERANT_PG_BIN_DIR is not set; app-managed Postgres lifecycle is implemented in chunk postgres-foundation.",
  };
}

export async function assertPostgresLifecycleAvailable(
  env: Deno.Env = Deno.env,
): Promise<PostgresRuntimePlan> {
  const plan = planPostgresRuntime(env);
  if (!plan.binariesAvailable) {
    throw new Error(plan.skipReason);
  }
  return plan;
}
