Deno.test("PGlite destructive migration walkthrough reaches destructive cleanup", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      new URL("./pglite-destructive-prototype.ts", import.meta.url).pathname,
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
      "# 1. Preview destructive migration",
      "# 3. Validate after staging: blockers remain",
      '"ready": false',
      "# 4. Generic cleanup/backfill actions chosen by user/agent",
      '"ready": true',
      "# 6. Apply destructive cleanup with confirmation",
      '"tablename": "res_lead"',
      '"column_name": "score"',
      '"data_type": "text"',
      '"id": "export_lead_company_name"',
    ]
  ) {
    if (!stdout.includes(expected)) {
      throw new Error(`missing expected output: ${expected}`);
    }
  }
});
