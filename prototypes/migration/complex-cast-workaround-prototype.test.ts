Deno.test("complex unsupported cast workaround uses additive field and ordinary changesets", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      new URL("./complex-cast-workaround-prototype.ts", import.meta.url)
        .pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`prototype failed\n${stderr}\n${stdout}`);
  }
  for (
    const expected of [
      "# 1. Direct unsupported type change is blocked",
      '"change": "change_field_type"',
      '"class": "blocking"',
      '"generatedCast": null',
      "# 3. Agent-generated changeset backfill attempts parse to integer",
      '"reason": "score_text cannot parse as integer"',
      "# 5. Agent fixes invalid rows with ordinary changesets",
      '"ready": true',
      "# 8. Agent clears old field through ordinary changeset, then destructive cleanup proceeds",
      '"column_name": "score"',
      '"data_type": "integer"',
      '"event": "destructive_field_dropped"',
    ]
  ) {
    if (!stdout.includes(expected)) {
      throw new Error(`missing expected output: ${expected}`);
    }
  }
  if (stdout.includes('"column_name": "score_text"\n')) {
    const finalSection = stdout.slice(stdout.indexOf("# 8."));
    if (finalSection.includes('"column_name": "score_text"')) {
      throw new Error("final schema still includes score_text");
    }
  }
});
