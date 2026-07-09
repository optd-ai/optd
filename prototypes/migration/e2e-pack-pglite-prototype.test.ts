Deno.test("end-to-end pack diff migration runs against PGlite", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      new URL("./e2e-pack-pglite-prototype.ts", import.meta.url).pathname,
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
      "# 1. Apply active CRM v1 pack to a real PGlite database",
      "# 2. Upload/preview CRM v2 and compute migration plan from pack diff + live DB facts",
      '"change": "change_field_type"',
      '"change": "remove_resource"',
      '"ready": false',
      "# 6. Apply explicit cleanup/backfill changeset-like operations",
      '"ready": true',
      "# 8. Apply destructive cleanup and activate CRM v2 revision",
      '"revision": "crm@0.2.0"',
      '"indexname": "lead_email_unique_when_present"',
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
