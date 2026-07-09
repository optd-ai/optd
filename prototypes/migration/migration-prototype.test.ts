import {
  classifyScenario,
  loadPackDir,
  summarize,
} from "./migration-prototype.ts";

async function load(name: string) {
  return JSON.parse(
    await Deno.readTextFile(
      new URL(`./scenarios/${name}.json`, import.meta.url),
    ),
  ) as any;
}

Deno.test("safe additive scenario classifies as safe", async () => {
  const scenario = await load("safe-additive");
  const issues = classifyScenario(scenario);
  const summary = summarize(issues);
  if (summary.overall !== "safe") {
    throw new Error(`expected safe, got ${summary.overall}`);
  }
  if (summary.counts.safe !== 5) {
    throw new Error(`expected 5 safe changes, got ${summary.counts.safe}`);
  }
});

Deno.test("breaking CRM scenario finds blockers and destructive changes", async () => {
  const scenario = await load("breaking-crm");
  assertBreakingMigration(classifyScenario(scenario));
});

Deno.test("end-to-end pack diff builds proposed changes from strict pack directories", async () => {
  const current = await loadPackDir(
    new URL("./packs/crm-v1", import.meta.url).pathname,
  );
  const desired = await loadPackDir(
    new URL("./packs/crm-v2", import.meta.url).pathname,
  );
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL("./packs/live-facts.json", import.meta.url),
    ),
  ) as any;
  const issues = classifyScenario({
    name: "e2e pack diff",
    current,
    desired,
    live,
  });
  assertBreakingMigration(issues);
  const hook = desired.hooks!.convert_lead as any;
  if (!hook.scriptDigest) {
    throw new Error(
      "expected hook script digest to be computed from hooks/convert_lead.ts",
    );
  }
});

Deno.test("unsupported type changes are blocking and require agent changesets", () => {
  const issues = classifyScenario({
    name: "unsupported cast",
    current: {
      resources: {
        lead: { fields: { score_text: { type: "string" } } },
      },
    },
    desired: {
      resources: {
        lead: { fields: { score_text: { type: "integer" } } },
      },
    },
    live: { rows: { lead: 1 }, presentValues: { "lead.score_text": 1 } },
  } as any);
  const issue = issues.find((i: any) =>
    i.id === "field:type:lead.score_text"
  ) as any;
  if (!issue) throw new Error("missing type change issue");
  if (issue.class !== "blocking") {
    throw new Error(`expected blocking, got ${issue.class}`);
  }
  if (issue.facts.generatedCast !== null) {
    throw new Error("expected no generated cast");
  }
  if (!issue.suggestion.includes("ordinary changesets")) {
    throw new Error(`unexpected suggestion: ${issue.suggestion}`);
  }
});

Deno.test("edge pack diff exercises all current migration issue types", async () => {
  const current = await loadPackDir(
    new URL("./packs/crm-edge-v1", import.meta.url).pathname,
  );
  const desired = await loadPackDir(
    new URL("./packs/crm-edge-v2", import.meta.url).pathname,
  );
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL("./packs/edge-live-facts.json", import.meta.url),
    ),
  ) as any;
  const issues = classifyScenario({
    name: "edge pack diff",
    current,
    desired,
    live,
  });
  const changes = new Set(issues.map((i: any) => i.change));
  for (
    const change of [
      "add_resource",
      "remove_resource",
      "add_field",
      "add_required_field",
      "remove_field",
      "change_field_type",
      "make_optional",
      "narrow_field",
      "add_index",
      "remove_index",
      "add_foreign_key",
      "add_check_constraint",
      "remove_constraint",
      "remove_lifecycle",
      "remove_lifecycle_state",
      "remove_lifecycle_transition",
      "remove_action",
      "change_action",
      "remove_hook",
      "change_hook",
    ]
  ) {
    if (!changes.has(change)) {
      throw new Error(`missing migration issue type ${change}`);
    }
  }
  const summary = summarize(issues);
  if (summary.overall !== "blocking") {
    throw new Error(`expected blocking, got ${summary.overall}`);
  }
});

function assertBreakingMigration(issues: any[]) {
  const summary = summarize(issues);
  if (summary.overall !== "blocking") {
    throw new Error(`expected blocking, got ${summary.overall}`);
  }
  const ids = new Set(issues.map((i: any) => i.id));
  for (
    const id of [
      "field:make-required:lead.email",
      "index:add-unique:lead.lead_email_unique_when_present",
      "lifecycle:remove-state:lead.contacted",
      "field:remove:lead.company_name",
      "hook:change:convert_lead",
    ]
  ) {
    if (!ids.has(id)) throw new Error(`missing expected issue ${id}`);
  }
}
