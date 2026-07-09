import { Command } from "jsr:@cliffy/command";
import { encode } from "npm:@toon-format/toon";

export async function runCli(args: string[]) {
  let output = "";
  const command = new Command()
    .name("optctl-spike")
    .description("Compiled Cliffy + TOON spike")
    .command("home", "Show home")
    .option("--json", "Output JSON")
    .action((options) => {
      const value = {
        ok: true,
        system: { active_pack: "default.crm@0.1.0" },
        help: ["optctl metadata resource default.lead"],
      };
      output = options.json ? JSON.stringify(value) : encode(value);
    });
  await command.parse(args);
  return output;
}

if (import.meta.main) {
  console.log(await runCli(Deno.args));
}
