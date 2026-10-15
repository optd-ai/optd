// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { Command } from "jsr:@cliffy/command";

type Help = {
  arguments?: string;
  options?: readonly (readonly [string, string])[];
};
const input = [
  "--input <input:string>",
  "JSON object or path to a JSON file.",
] as const;
const reason = [
  "--reason <reason:string>",
  "Reason recorded with this operation.",
] as const;
const version = [
  "--version <version:integer>",
  "Expected current version (required for updates).",
] as const;
const commit = [[
  "--timeout <duration:string>",
  "Commit lock timeout (for example 10s).",
]] as const;
const approval = [
  ["--safe", "Acknowledge a safe migration."],
  ["--reviewed", "Acknowledge a reviewed risky migration."],
  [
    "--confirm-token <token:string>",
    "Acknowledge a destructive migration with its exact confirmation token.",
  ],
  ...commit,
] as const;
const query = [
  [
    "--fields <fields:string>",
    "Comma-separated projection fields, including id.",
  ],
  ["--where <expression:string>", "Filter expression."],
  ["--sort <sort:string>", "Sort field and direction."],
  ["--limit <limit:integer>", "Maximum rows per page."],
  ["--cursor <cursor:string>", "Continue from next_cursor."],
  ["--include-total", "Compute the total matching row count."],
  ["--include-archived", "Include archived rows when authorized."],
] as const;
const boundary = [
  [
    "--workspace <workspace:string>",
    "Workspace UUID for a workspace boundary.",
  ],
  ["--boundary <boundary:string>", "system, all_workspaces, or workspace."],
] as const;
const requestBoundary = [
  [
    "--workspace <workspace:string>",
    "Exact Workspace UUIDv7 or slug within current requestable scope (no listing access).",
  ],
  [
    "--boundary <boundary:string>",
    "system or all_workspaces without --workspace; workspace is inferred when a selector is supplied.",
  ],
] as const;
const password = [
  ["--username <username:string>", "Human username."],
  ["--password-stdin", "Read password from standard input, never an argument."],
] as const;
const security = [[
  "--include-security",
  "Include privileged security metadata.",
]] as const;

const help: Record<string, Help> = {
  "auth user": {
    arguments: "<operation:string> [user-id:string]",
    options: [...password, [
      "--display-name <name:string>",
      "Display name for create; operations: list, create, enable, disable.",
    ]],
  },
  "auth password": {
    arguments: "<operation:string>",
    options: [[
      "--password-stdin",
      "For change, read current and new passwords on separate lines.",
    ]],
  },
  "auth password-reset": {
    arguments: "<operation:string> [request-id:string]",
    options: [...password],
  },
  "auth recover": { options: [...password] },
  "auth authority": { options: [...boundary, ...security] },
  "assignment role": {
    arguments: "<operation:string> <user-id:string>",
    options: [
      ...boundary,
      ["--role <role:string>", "Role identity for create."],
      ["--assignment <id:string>", "Assignment ID for disable."],
      ["--expected-version <version:integer>", "Required version for disable."],
    ],
  },
  "policy assignment": {
    arguments: "<operation:string>",
    options: [
      ...boundary,
      ["--policy-revision <id:string>", "Policy revision UUID for create."],
      ["--assignment <id:string>", "Assignment UUID for disable."],
      ["--expected-version <version:integer>", "Required version for disable."],
      ["--active <active:string>", "Filter list by true or false."],
    ],
  },
  "secret create": {
    arguments: "<name:string>",
    options: [["--stdin", "Read secret value from stdin."], [
      "--description <description:string>",
      "Secret description.",
    ]],
  },
  "secret rotate": {
    arguments: "<name:string>",
    options: [["--stdin", "Read replacement secret value from stdin."]],
  },
  "secret disable": { arguments: "<name:string>" },
  "secret grant": {
    arguments: "<name:string>",
    options: [
      ["--hook <identity:string>", "Required qualified hook identity."],
      ["--slot <slot:string>", "Required declared secret slot."],
    ],
  },
  "secret replace-grant": {
    arguments: "<grant-id:string>",
    options: [["--secret <name:string>", "Replacement secret name."]],
  },
  "secret revoke-grant": { arguments: "<grant-id:string>" },
  "outbox list": {
    options: [
      ["--status <status:string>", "Delivery status."],
      ["--hook <hook:string>", "Hook identity."],
      ["--event <event:string>", "Event identity."],
      ["--from <time:string>", "Start timestamp."],
      ["--to <time:string>", "End timestamp."],
      ["--limit <limit:integer>", "Page size."],
      ["--cursor <cursor:string>", "Next-page cursor."],
    ],
  },
  "outbox inspect": { arguments: "<delivery-id:string>" },
  "outbox attempts": {
    arguments: "<delivery-id:string>",
    options: [["--limit <limit:integer>", "Page size."], [
      "--cursor <cursor:string>",
      "Next-page cursor.",
    ]],
  },
  "outbox retry": { arguments: "<delivery-id:string>", options: [reason] },
  "outbox cancel": { arguments: "<delivery-id:string>", options: [reason] },
  "outbox drain": {
    options: [["--limit <limit:integer>", "Maximum deliveries to process."]],
  },
  "expression validate": { arguments: "<expression:string>" },
  "bootstrap init": {
    options: [...password, [
      "--display-name <name:string>",
      "Initial human display name; requires OPTD_BOOTSTRAP_TOKEN.",
    ]],
  },
  "auth login": { options: password },
  "auth logout": {
    options: [["--all", "Log out all human sessions."], [
      "--yes",
      "Confirm all-session logout.",
    ], ["--password-stdin", "Read confirmation password from stdin."]],
  },
  "auth request": {
    options: [
      ["--role <role:string>", "Requested role; repeat for multiple roles."],
      ...requestBoundary,
      reason,
      ["--agent-name <name:string>", "Agent display name."],
    ],
  },
  "auth roles": { options: [...requestBoundary, ...security] },
  "auth approve": {
    arguments: "<request-id:string>",
    options: [["--yes", "Confirm authorization approval."], [
      "--agent-name <name:string>",
      "Agent display name.",
    ]],
  },
  "auth deny": { arguments: "<request-id:string>", options: [reason] },
  "auth wait": { arguments: "<request-id:string>" },
  "auth revoke": { arguments: "<authorization-id:string>", options: [reason] },
  "auth isolate": { arguments: "[...command:string]" },
  "auth doctor": {
    options: [["--fix", "Repair local authentication records."], [
      "--yes",
      "Confirm repairs.",
    ], ["--strict", "Fail on warnings as well as errors."]],
  },
  "context show": { arguments: "[name:string]" },
  "context add": {
    arguments: "<name:string>",
    options: [["--server <origin:string>", "Required server origin."], [
      "--workspace <workspace:string>",
      "Initial workspace UUID or slug.",
    ]],
  },
  "context use": { arguments: "<name:string>" },
  "context remove": { arguments: "<name:string>" },
  "context set-workspace": { arguments: "<workspace:string>" },
  "workspace list": {
    options: [
      ["--slug <slug:string>", "Exact slug filter."],
      ["--status <status:string>", "active, archived, or all."],
      ["--limit <limit:integer>", "Maximum workspaces per page."],
      ["--cursor <cursor:string>", "Continue a previous page."],
    ],
  },
  "workspace create": {
    arguments: "<slug:string>",
    options: [["--display-name <name:string>", "Required display name."], [
      "--description <description:string>",
      "Optional description.",
    ]],
  },
  "workspace view": { arguments: "<workspace:string>" },
  "workspace select": { arguments: "<workspace:string>" },
  "workspace update": {
    arguments: "<workspace:string>",
    options: [
      [
        "--expected-version <version:integer>",
        "Required current workspace version.",
      ],
      ["--display-name <name:string>", "New display name."],
      ["--description <description:string>", "New description."],
    ],
  },
  "workspace archive": {
    arguments: "<workspace:string>",
    options: [[
      "--expected-version <version:integer>",
      "Required current workspace version.",
    ]],
  },
  "pack preview": { arguments: "<directory:string>" },
  "pack apply": { arguments: "<directory:string>", options: approval },
  "pack inspect": { arguments: "<pack:string>", options: security },
  "migration inspect": { arguments: "<plan-id:string>" },
  "migration validate": { arguments: "<plan-id:string>" },
  "migration apply": { arguments: "<plan-id:string>", options: approval },
  "changeset stage": {
    arguments: "[file:string]",
    options: [input, [
      "--file <file:string>",
      "Path to a changeset JSON file.",
    ]],
  },
  "changeset inspect": { arguments: "<stage-id:string>" },
  "changeset commit": { arguments: "<stage-id:string>", options: commit },
  "changeset cancel": { arguments: "<stage-id:string>", options: [reason] },
  "changeset approvals": { arguments: "<stage-id:string>" },
  "changeset approve": {
    arguments: "<stage-id:string> <requirement-id:string>",
    options: [reason],
  },
  "changeset reject": {
    arguments: "<stage-id:string> <requirement-id:string>",
    options: [reason],
  },
  "action stage": { arguments: "<action:string>", options: [input] },
  "action commit": {
    arguments: "<action:string>",
    options: [input, ...commit],
  },
  "seed stage": {
    arguments: "<pack:string>",
    options: [[
      "--all",
      "Explicitly reconcile all declared seeds in this workspace; may update data. Pack installation alone does not initialize seeds.",
    ], ["--seed <name:string>", "Seed name; repeat to select multiple seeds."]],
  },
  "link": {
    arguments: "<relationship:string>",
    options: [
      ["--from <object-id:string>", "Required source object UUIDv7."],
      ["--to <object-id:string>", "Required target object UUIDv7."],
      input,
      [
        "--file <path:string>",
        "Relationship fields JSON file; mutually exclusive with --input.",
      ],
      ["--stage", "Stage without committing."],
      ...commit,
    ],
  },
  "unlink": {
    arguments: "<relationship:string> <relationship-id:string>",
    options: [
      [
        "--expected-version <version:integer>",
        "Expected relationship version; positive integer.",
      ],
      ["--stage", "Stage without committing."],
      ...commit,
    ],
  },
  "create": {
    arguments: "<resource:string>",
    options: [
      input,
      [
        "--initial-state <state:string>",
        "Audited historical import; requires import permission and --reason.",
      ],
      reason,
      ["--stage", "Stage without committing."],
      ...commit,
    ],
  },
  "update": {
    arguments: "<resource:string> <object-id:string>",
    options: [
      input,
      version,
      ["--stage", "Stage without committing."],
      ...commit,
    ],
  },
  "transition": {
    arguments: "<resource:string> <object-id:string>",
    options: [
      input,
      version,
      ["--to <state:string>", "Required destination lifecycle state."],
      ["--stage", "Stage without committing."],
      ...commit,
    ],
  },
  "query": { arguments: "<definition:string>", options: query },
  "list": { arguments: "<resource:string>", options: query },
  "search": {
    arguments: "<resource:string>",
    options: [...query, ["--text <text:string>", "Required search text."]],
  },
  "view": { arguments: "<definition:string> <object-id:string>" },
  "history": {
    arguments: "<definition:string> <object-id:string>",
    options: [["--limit <limit:integer>", "Page size."], [
      "--cursor <cursor:string>",
      "Continue history page.",
    ]],
  },
};
help["seed commit"] = {
  ...help["seed stage"],
  options: [...help["seed stage"].options!, ...commit],
};
for (
  const kind of [
    "pack",
    "resource",
    "relationship",
    "lifecycle",
    "action",
    "hook",
    "role",
    "policy",
    "seed",
  ]
) {
  help[`metadata ${kind}`] = {
    arguments: "<identity:string>",
    options: kind === "pack" || kind === "hook" || kind === "policy"
      ? security
      : [],
  };
}

export function configureCommandHelp(command: Command, key: string): Command {
  const definition = help[key];
  if (definition?.arguments) command.arguments(definition.arguments);
  for (const [flags, description] of definition?.options ?? []) {
    command.option(flags, description);
  }
  return command;
}
