import { runOptctl } from "./adapters/inbound/cli-cliffy/optctl.ts";

if (import.meta.main) {
  const result = await runOptctl(Deno.args);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  Deno.exit(result.code);
}
