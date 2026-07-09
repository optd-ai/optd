import { startServer } from "../vertical-slice/vertical-slice-server.ts";

const optctl = new URL("./optctl.ts", import.meta.url).pathname;
const crmDefault = new URL("../crm-default-pack", import.meta.url).pathname;

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startServer(0);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
  }
}

async function run(args: string[]) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-net", optctl, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("optctl applies CRM pack, commits a lead, queries, converts, and reads history", async () => {
  await withServer(async (url) => {
    const apply = await run(["--server", url, "pack", "apply", crmDefault]);
    if (apply.code !== 0 || !apply.stdout.includes("ok: true")) {
      throw new Error(
        `apply failed\nstdout=${apply.stdout}\nstderr=${apply.stderr}`,
      );
    }
    if (!apply.stdout.includes("seedChangesets")) {
      throw new Error("expected seed changesets in output");
    }

    const home = await run(["--server", url, "home"]);
    if (!home.stdout.includes("active_pack: default.crm@0.1.0")) {
      throw new Error(`home missing active pack\n${home.stdout}`);
    }
    if (!home.stdout.includes("default.convert_lead")) {
      throw new Error(`home missing action guidance\n${home.stdout}`);
    }

    const metadata = await run([
      "--server",
      url,
      "metadata",
      "resource",
      "default.lead",
    ]);
    if (
      !metadata.stdout.includes("kind: resource") ||
      !metadata.stdout.includes("fields")
    ) {
      throw new Error(`metadata missing resource schema\n${metadata.stdout}`);
    }

    const change = await Deno.makeTempFile({ suffix: ".json" });
    await Deno.writeTextFile(
      change,
      JSON.stringify({
        actor_id: "agent_1",
        operations: [{
          op: "create",
          resource: "lead",
          id: "lead_cli",
          fields: {
            name: " CLI Lead ",
            email: "CLI@EXAMPLE.COM",
            company_name: "CLI Co",
          },
        }],
      }),
    );
    try {
      const commit = await run([
        "--server",
        url,
        "changeset",
        "commit",
        "--file",
        change,
      ]);
      if (commit.code !== 0 || !commit.stdout.includes("status: committed")) {
        throw new Error(
          `commit failed\nstdout=${commit.stdout}\nstderr=${commit.stderr}`,
        );
      }
    } finally {
      await Deno.remove(change).catch(() => {});
    }

    const query = await run([
      "--server",
      url,
      "query",
      "default.lead",
      "--where",
      'status == "new" && active()',
      "--fields",
      "id,name,email,status",
    ]);
    if (
      !query.stdout.includes("lead_cli") ||
      !query.stdout.includes("cli@example.com")
    ) {
      throw new Error(`query missed lead\n${query.stdout}`);
    }

    const preview = await run([
      "--server",
      url,
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      '{"lead_id":"lead_cli"}',
    ]);
    if (!preview.stdout.includes("resource: opportunity")) {
      throw new Error(`preview missing opportunity\n${preview.stdout}`);
    }

    const convert = await run([
      "--server",
      url,
      "action",
      "commit",
      "default.convert_lead",
      "--input",
      '{"lead_id":"lead_cli"}',
    ]);
    if (!convert.stdout.includes("status: committed")) {
      throw new Error(`convert failed\n${convert.stdout}`);
    }

    const history = await run([
      "--server",
      url,
      "history",
      "default.lead",
      "lead_cli",
    ]);
    if (
      !history.stdout.includes("versions") ||
      !history.stdout.includes("transition")
    ) {
      throw new Error(`history missing versions\n${history.stdout}`);
    }
  });
});
