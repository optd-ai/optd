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

Deno.test("prefix verifier propagates real formatting, model, type, regression and host failures", async () => {
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
            test: "deno test tests/full.test.ts",
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
    for (
      const path of [
        "tests/e2e/foundation",
        "tests/e2e/full_crm",
        "tests/support/public_flows",
      ]
    ) await Deno.mkdir(join(fixture, path), { recursive: true });
    for (
      const path of [
        "tests/unit/optd_distribution.test.ts",
        "tests/e2e/foundation/compiled_cli_smoke.test.ts",
        "tests/e2e/full_crm/compiled_cli.test.ts",
        "tests/support/public_flows/equivalence.test.ts",
        "tests/full.test.ts",
      ]
    ) await write(path, passing);
    const baseline = await run();
    assert.equal(baseline.code, 0, decode(baseline));
    assert.match(
      decode(baseline),
      /PREFIX CHECKS PASSED; image\/release acceptance has not been run/,
    );

    for (
      const failure of [
        "format",
        "model",
        "type",
        "regression",
        "distribution",
        "compiled",
        "host",
        "equivalence",
        "full",
      ] as const
    ) {
      const path = failure === "distribution"
        ? "tests/unit/optd_distribution.test.ts"
        : failure === "compiled"
        ? "tests/e2e/foundation/compiled_cli_smoke.test.ts"
        : failure === "host"
        ? "tests/e2e/full_crm/compiled_cli.test.ts"
        : failure === "equivalence"
        ? "tests/support/public_flows/equivalence.test.ts"
        : failure === "full"
        ? "tests/full.test.ts"
        : failure === "model"
        ? "spec/README.md"
        : failure === "regression"
        ? testPath
        : "src/check.ts";
      const original = await Deno.readTextFile(join(fixture, path));
      const broken = {
        format: "export const value:number=1;\n",
        model: "deliberate frozen projection drift\n",
        type: 'export const value: number = "wrong";\n',
        distribution:
          'Deno.test("distribution failure", () => {\n  throw new Error("deliberate distribution failure");\n});\n',
        compiled:
          'Deno.test("compiled failure", () => {\n  throw new Error("deliberate compiled failure");\n});\n',
        regression:
          'Deno.test("fixture regression", () => {\n  throw new Error("deliberate regression failure");\n});\n',
        host:
          'Deno.test("host failure", () => {\n  throw new Error("deliberate host failure");\n});\n',
        equivalence:
          'Deno.test("equivalence failure", () => {\n  throw new Error("deliberate equivalence failure");\n});\n',
        full:
          'Deno.test("full failure", () => {\n  throw new Error("deliberate full failure");\n});\n',
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
          distribution: /deliberate distribution failure/,
          compiled: /deliberate compiled failure/,
          host: /deliberate host failure/,
          equivalence: /deliberate equivalence failure/,
          full: /deliberate full failure/,
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
