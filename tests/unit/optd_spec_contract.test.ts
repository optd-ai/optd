import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { checkSpecs } from "../../scripts/spec-check.ts";

const root = resolve(import.meta.dirname!, "../..");

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) Object.assign(result, await snapshot(path));
    else result[path] = await Deno.readTextFile(path);
  }
  return result;
}

Deno.test("spec check preserves every contract and historical evidence byte", async () => {
  const before = await snapshot(join(root, "spec"));
  assert.equal(await checkSpecs(root), 62);
  assert.deepEqual(await snapshot(join(root, "spec")), before);
  const readme = await Deno.readTextFile(join(root, "spec/README.md"));
  assert.match(readme, /source of truth/);
  assert.match(readme, /Edit the Markdown directly/);
  const packs = await Deno.readTextFile(join(root, "spec/packs-workspaces.md"));
  assert.match(packs, /optd\.dev\/v1/);
  assert.match(packs, /both\s+authoritative nameservers/);
  const product = await Deno.readTextFile(join(root, "spec/product.md"));
  assert.match(product, /created\s+new and public/);
  assert.match(product, /rather than\s+transferred/);
});

Deno.test("spec check accepts direct edits and new indexed contracts without a model", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-spec-test-" });
  try {
    await Deno.mkdir(join(fixture, "spec"));
    await Deno.writeTextFile(
      join(fixture, "spec/README.md"),
      "# Specs\n\n[Contract](contract.md)\n",
    );
    await Deno.writeTextFile(
      join(fixture, "spec/contract.md"),
      "# Contract\n\nOriginal requirement.\n",
    );
    assert.equal(await checkSpecs(fixture), 2);
    await Deno.writeTextFile(
      join(fixture, "spec/contract.md"),
      "# Contract\n\nReviewed new requirement.\n",
    );
    assert.equal(await checkSpecs(fixture), 2);
    await Deno.writeTextFile(join(fixture, "spec/new.md"), "# New contract\n");
    await assert.rejects(() => checkSpecs(fixture), /unindexed/);
    await Deno.writeTextFile(
      join(fixture, "spec/README.md"),
      "# Specs\n\n[Contract](contract.md)\n[New](new.md)\n",
    );
    assert.equal(await checkSpecs(fixture), 3);
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

Deno.test("spec check rejects missing, malformed, generated and symlinked contracts without repair", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-spec-test-" });
  const target = join(fixture, "spec/contract.md");
  try {
    await Deno.mkdir(join(fixture, "spec"));
    await Deno.writeTextFile(
      join(fixture, "spec/README.md"),
      "# Specs\n\n[Contract](contract.md)\n",
    );
    await assert.rejects(() => checkSpecs(fixture));
    for (
      const content of [
        "missing title\n",
        "# Contract\n<!-- generated-by: pi-dag-workflow/project-model -->\n",
        '# Contract\n<a id="duplicate"></a>\n<a id="duplicate"></a>\n',
      ]
    ) {
      await Deno.writeTextFile(target, content);
      await assert.rejects(() => checkSpecs(fixture), /Invalid specification/);
      assert.equal(await Deno.readTextFile(target), content);
    }
    await Deno.remove(target);
    await Deno.symlink(join(fixture, "spec/README.md"), target);
    await assert.rejects(() => checkSpecs(fixture), /symlink/);
    await Deno.remove(target);
    await Deno.rename(join(fixture, "spec"), join(fixture, "elsewhere"));
    await Deno.symlink(join(fixture, "elsewhere"), join(fixture, "spec"));
    await assert.rejects(() => checkSpecs(fixture), /symlink/);
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});
