export const OPTD_VERSION = "0.1.0-dev";

export type RuntimeConfig = {
  host: string;
  port: number;
  dataDir?: string;
  databaseUrl?: string;
};

export function loadRuntimeConfig(env: Deno.Env = Deno.env): RuntimeConfig {
  return {
    host: env.get("OPTD_HOST") ?? "127.0.0.1",
    port: Number(env.get("OPTD_PORT") ?? "8789"),
    dataDir: env.get("OPTD_DATA_DIR") ?? undefined,
    databaseUrl: env.get("OPTD_DATABASE_URL") ?? undefined,
  };
}
