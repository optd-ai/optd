// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";

const PACK = join(Deno.cwd(), "prototypes", "project-management-pack");

Deno.test("Projects pack source has no legacy relationships, dotted aliases, or leak literals", async () => {
  const source = await Array.fromAsync(walkSources(PACK));
  const text = source.join("\n");
  assertEquals(
    /timesheet_entry|optd\.projects|project_task/.test(text),
    false,
  );
  assertEquals(
    /Bearer |authorization:|OPTD_DATABASE_URL|postgres:\/\//i.test(text),
    false,
  );
});

async function* walkSources(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* walkSources(path);
    else if (/\.(?:yaml|ts)$/.test(entry.name)) {
      yield await Deno.readTextFile(path);
    }
  }
}
