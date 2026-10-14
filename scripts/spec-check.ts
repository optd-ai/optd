import { join, resolve } from "node:path";

async function readSpec(path: string): Promise<string> {
  const info = await Deno.lstat(path);
  if (info.isSymlink || !info.isFile) {
    throw new Error(
      `Invalid specification: expected regular file, no symlink: ${path}`,
    );
  }
  const content = await Deno.readTextFile(path);
  if (!/^# \S/m.test(content)) {
    throw new Error(`Invalid specification: missing title: ${path}`);
  }
  if (content.includes("<!-- generated-by: pi-dag-workflow/project-model")) {
    throw new Error(
      `Invalid specification: retired generated-model header: ${path}`,
    );
  }
  const anchors = [...content.matchAll(/<a id="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(anchors).size !== anchors.length) {
    throw new Error(
      `Invalid specification: duplicate explicit anchor: ${path}`,
    );
  }
  return content;
}

/** Check structure, not prose equality or semantic conformance. Never writes. */
export async function checkSpecs(root: string): Promise<number> {
  const directory = join(root, "spec");
  const info = await Deno.lstat(directory);
  if (info.isSymlink || !info.isDirectory) {
    throw new Error(
      "Invalid specification directory: expected directory, no symlink",
    );
  }
  const index = await readSpec(join(directory, "README.md"));
  const indexed = new Set(
    [...index.matchAll(/\]\(([a-zA-Z0-9_-]+\.md)(?:#[^)]*)?\)/g)].map((m) =>
      m[1]
    ),
  );
  if (!indexed.size) {
    throw new Error("Invalid specification index: no documents");
  }
  for (const name of indexed) await readSpec(join(directory, name));
  let count = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isSymlink) {
      throw new Error(`Invalid specification: symlink: ${entry.name}`);
    }
    if (!entry.name.endsWith(".md")) continue;
    await readSpec(join(directory, entry.name));
    if (entry.name !== "README.md" && !indexed.has(entry.name)) {
      throw new Error(
        `Invalid specification index: unindexed document: ${entry.name}`,
      );
    }
    count++;
  }
  return count;
}

if (import.meta.main) {
  if (Deno.args.length) {
    console.error(
      "Usage: deno task spec:check (read-only; no generation mode)",
    );
    Deno.exit(2);
  }
  try {
    const count = await checkSpecs(resolve(import.meta.dirname!, ".."));
    console.log(
      `${count} directly maintained specifications: structure valid (read-only).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
