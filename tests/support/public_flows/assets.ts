// deno-lint-ignore-file no-import-prefix no-unversioned-import no-explicit-any
import { join } from "jsr:@std/path";
import { parseYamlJsonObject } from "../../../src/adapters/outbound/yaml/pack_loader.ts";
import type { PublicFlowAsset } from "./backend.ts";

export class PublicFlowAssets {
  readonly #root: string;
  readonly #generated = new Map<PublicFlowAsset, string>();
  #providerUrl: string | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  setProviderUrl(url: string): void {
    this.#providerUrl = url;
    this.#generated.delete("projects_auxiliary");
  }

  async path(asset: PublicFlowAsset): Promise<string> {
    if (asset === "crm") {
      return join(Deno.cwd(), "prototypes", "crm-default-pack");
    }
    if (asset === "projects") {
      return join(Deno.cwd(), "prototypes", "project-management-pack");
    }
    const existing = this.#generated.get(asset);
    if (existing) return existing;
    if (asset === "projects_auxiliary") {
      if (!this.#providerUrl) {
        throw new Error("Projects provider is not configured");
      }
      const destination = join(this.#root, asset);
      await copyTree(await this.path("projects"), destination);
      await replace(
        join(destination, "pack.yaml"),
        "version: 0.1.0",
        "version: 0.2.0",
      );
      await writeProjectsAuxiliary(destination, this.#providerUrl);
      this.#generated.set(asset, destination);
      return destination;
    }
    const destination = join(this.#root, asset);
    await copyTree(await this.path("crm"), destination);
    const version = asset === "crm_migration_v1"
      ? "1.0.0"
      : asset === "crm_migration_transitional"
      ? "1.1.0"
      : "2.0.0";
    await replace(
      join(destination, "pack.yaml"),
      "version: 0.1.0",
      `version: ${version}`,
    );
    if (asset !== "crm_migration_v1") {
      const leadPath = join(destination, "resources", "lead.yaml");
      const lead = parseYamlJsonObject(
        await Deno.readTextFile(leadPath),
        leadPath,
      ) as any;
      lead.spec.fields.normalized_phone = { type: "string" };
      if (asset === "crm_migration_final") {
        delete lead.spec.fields.phone;
        lead.spec.axi.list.defaultFields = lead.spec.axi.list.defaultFields
          .filter((field: string) => field !== "phone");
        const actionPath = join(destination, "actions", "convert_lead.yaml");
        const action = parseYamlJsonObject(
          await Deno.readTextFile(actionPath),
          actionPath,
        ) as any;
        action.spec.reads.lead.fields = action.spec.reads.lead.fields.filter((
          field: string,
        ) => field !== "phone");
        await Deno.writeTextFile(actionPath, JSON.stringify(action, null, 2));
      }
      await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));
    }
    this.#generated.set(asset, destination);
    return destination;
  }
}

async function writeProjectsAuxiliary(root: string, providerUrl: string) {
  for (const directory of ["roles", "relationships", "policies", "hooks"]) {
    await Deno.mkdir(join(root, directory), { recursive: true });
  }
  await Deno.writeTextFile(
    join(root, "roles", "linked_reader.yaml"),
    `kind: Role\napiVersion: optd.dev/v1\nmetadata: { name: linked_reader }\nspec:\n  display_name: Linked Reader\n  description: Direct task reader.\n  axi:\n    purpose: Direct linked task reader.\n    whenToUse: [Use for one-hop task reads.]\n    help: [optctl metadata role optd/projects:linked_reader]\n`,
  );
  await Deno.writeTextFile(
    join(root, "relationships", "task_viewer.yaml"),
    `kind: Relationship\napiVersion: optd.dev/v1\nmetadata: { name: task_viewer }\nspec:\n  from: { resource: optd/projects:task }\n  to: { resource: system:principal }\n  unique: [from, to]\n  axi:\n    purpose: Direct task viewer relationship.\n    whenToUse: [Use to grant a principal one task read.]\n    help: [optctl metadata relationship optd/projects:task_viewer]\n`,
  );
  await Deno.writeTextFile(
    join(root, "policies", "access.yaml"),
    `kind: Policy\napiVersion: optd.dev/v1\nmetadata: { name: access }\nspec:\n  default_assignment: all_projects\n  rules:\n    - name: manager_links\n      effect: allow\n      roles: [optd/projects:project_manager]\n      actions: [link, unlink]\n      resources: [optd/projects:task_viewer, optd/projects:task_tag_assignment]\n      axi: { summary: Managers may link task viewers. }\n    - name: direct_reader\n      effect: allow\n      roles: [optd/projects:linked_reader]\n      actions: [read]\n      resources: [optd/projects:task]\n      relation:\n        relationship: optd/projects:task_viewer\n        object_side: from\n        subject_side: to\n        subject: actor.id\n      axi: { summary: Linked readers may read one task. }\n  axi:\n    purpose: Auxiliary Projects access policy.\n    whenToUse: [Use for shared public-flow ReBAC.]\n    help: [optctl metadata policy optd/projects:access]\n`,
  );
  const host = new URL(providerUrl).host;
  await Deno.writeTextFile(
    join(root, "hooks", "deliver.yaml"),
    `kind: Hook\napiVersion: optd.dev/v1\nmetadata: { name: deliver }\nspec:\n  script: deliver.ts\n  timeout: 2s\n  permissions: { net: [${host}], env: false, read: false, write: false, run: false }\n  secrets:\n    - slot: projects_provider_token\n      env: PROJECTS_PROVIDER_TOKEN\n  effects: { operations: [] }\n  output: { schema: delivery.v1 }\n  attachments:\n    - phase: event.after_commit\n      event: object.created\n      order: 100\n      input: { event: '$event' }\n    - phase: event.after_commit\n      event: object.updated\n      order: 101\n      input: { event: '$event' }\n    - phase: event.after_commit\n      event: object.transitioned\n      order: 102\n      input: { event: '$event' }\n    - phase: event.after_commit\n      event: object.archived\n      order: 103\n      input: { event: '$event' }\n  axi:\n    purpose: Deliver Projects changes to the test provider.\n    whenToUse: [Use for durable outbox evidence.]\n    help: [optctl metadata hook optd/projects:deliver]\n`,
  );
  await Deno.writeTextFile(
    join(root, "hooks", "deliver.ts"),
    `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text());\nconst delivery=envelope.metadata.delivery;\nconst response=await fetch(${
      JSON.stringify(`${providerUrl}/projects`)
    },{method:"POST",headers:{"content-type":"application/json","idempotency-key":delivery.idempotency_key,"x-provider-token":Deno.env.get("PROJECTS_PROVIDER_TOKEN")??""},body:JSON.stringify({attempt_id:delivery.attempt_id})});\nif(response.status===503) console.log(JSON.stringify({outcome:"retry",code:"provider_unavailable",message:"retry",retry_after:(response.headers.get("retry-after")??"1")+"s"})); else console.log(JSON.stringify({outcome:"succeeded",external_id:"projects-provider"}));\n`,
  );
}

async function replace(path: string, from: string, to: string) {
  await Deno.writeTextFile(
    path,
    (await Deno.readTextFile(path)).replace(from, to),
  );
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}
