import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname!, "../..");

async function copyTree(source: string, target: string) {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    if (entry.isDirectory) {
      await copyTree(join(source, entry.name), join(target, entry.name));
    } else {await Deno.copyFile(
        join(source, entry.name),
        join(target, entry.name),
      );}
  }
}

Deno.test("prefix verifier propagates real formatting, model, type and regression failures", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-verifier-test-" });
  const write = (path: string, text: string) =>
    Deno.writeTextFile(join(fixture, path), text);
  const run = () =>
    new Deno.Command("bash", {
      args: [join(fixture, "scripts/optd-integration-verify.sh")],
      cwd: "/",
      stdout: "piped",
      stderr: "piped",
    }).output();
  const decode = (result: Deno.CommandOutput) =>
    new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  try {
    for (
      const path of ["src", "tests/unit", "docs", "scripts", "project-model"]
    ) await Deno.mkdir(join(fixture, path), { recursive: true });
    await copyTree(
      join(root, "project-model/runtime"),
      join(fixture, "project-model/runtime"),
    );
    await copyTree(join(root, "spec"), join(fixture, "spec"));
    for (
      const path of [
        "project-model/model.json",
        "scripts/project-model.ts",
        "scripts/optd-integration-verify.sh",
      ]
    ) await Deno.copyFile(join(root, path), join(fixture, path));
    // Real Deno processes and checker, but intentionally tiny type/test subjects.
    // No recursive invocation of this suite, and no mocked successful commands.
    await write(
      "deno.json",
      JSON.stringify(
        {
          tasks: {
            "model:check":
              "deno run --allow-read scripts/project-model.ts check",
            check: "deno check src/check.ts",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await write("src/check.ts", "export const value: number = 1;\n");
    const testPath = "tests/unit/optd_model_contract.test.ts";
    const passing = 'Deno.test("fixture regression", () => {});\n';
    await write(testPath, passing);
    await write(
      "tests/unit/optd_integration_verify.test.ts",
      'Deno.test("fixture second regression", () => {});\n',
    );
    const baseline = await run();
    assert.equal(baseline.code, 0, decode(baseline));
    assert.match(
      decode(baseline),
      /PREFIX CHECKS PASSED; image\/release acceptance has not been run/,
    );

    for (const failure of ["format", "model", "type", "regression"] as const) {
      const path = failure === "model"
        ? "spec/README.md"
        : failure === "regression"
        ? testPath
        : "src/check.ts";
      const original = await Deno.readTextFile(join(fixture, path));
      const broken = {
        format: "export const value:number=1;\n",
        model: "deliberate frozen projection drift\n",
        type: 'export const value: number = "wrong";\n',
        regression:
          'Deno.test("fixture regression", () => {\n  throw new Error("deliberate regression failure");\n});\n',
      }[failure];
      await write(path, broken);
      const result = await run();
      const output = decode(result);
      assert.notEqual(result.code, 0, `${failure}: ${output}`);
      assert.ok(!output.includes("PREFIX CHECKS PASSED"), output);
      assert.match(
        output,
        {
          format: /not formatted/,
          model: /Specification drift/,
          type: /not assignable/,
          regression: /deliberate regression failure/,
        }[failure],
      );
      assert.equal(await Deno.readTextFile(join(fixture, path)), broken);
      await write(path, original);
    }
    // A successful regression command must not hide drift it introduced.
    await write(
      testPath,
      'Deno.test("fixture introduces drift", async () => {\n  await Deno.writeTextFile("spec/README.md", "post-test drift\\n");\n});\n',
    );
    const postTestDrift = await run();
    assert.notEqual(postTestDrift.code, 0, decode(postTestDrift));
    assert.match(decode(postTestDrift), /Specification drift/);
    assert.ok(!decode(postTestDrift).includes("PREFIX CHECKS PASSED"));
  } finally {
    await Deno.remove(fixture, { recursive: true });
  }
});

Deno.test("model command rejects generation instead of changing frozen authority", async () => {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      join(root, "scripts/project-model.ts"),
      "generate",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.code, 2);
  assert.match(new TextDecoder().decode(result.stderr), /read-only/);
});
