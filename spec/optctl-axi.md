<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-optctl-axi; contract: 1; input: sha256:4823a39172e67b1449f213044343b6d5c2b0384ea2911e3ca3cb6cf1cac4aa43 -->

# optctl AXI Guidance Model

Generated exact-contract projection imported into project-model/model.json from the reviewed optctl-axi.md source.

## Exact migrated contract

<a id="obj-com-exact-optctl-axi-v1"></a>

### Exact v1 contract — optctl AXI Guidance Model

**Migration provenance.** Exact normative contract imported from `spec/optctl-axi.md` at `sha256:a0c0d6181e6a8bbc378c0ee893b0c34e267c2e1133fd3e3242c41681c2dd41aa`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Purpose

`optctl` should be an agent-ergonomic CLI in the AXI style. Packs should teach
the CLI how to expose resources to agents: what a resource is for, which fields
matter by default, what actions are available, what to do next, and what
guidance to show in each context.

This guidance should live in pack/resource configuration, not hardcoded CLI
branches.

## Research Summary: AXI Patterns

Research sources:

- `https://axi.md/`
- `kunchenguid/gh-axi`
- `kunchenguid/chrome-devtools-axi`
- `JarvusInnovations/slack-axi`
- `SSBrouhard/sqlite-axi`
- `SSBrouhard/npm-axi`
- `maximebrmd/notion-axi`
- `kunchenguid/lavish-axi`

Observed AXI patterns:

1. **No-args/home shows live state, not a manual.** Examples: `sqlite-axi`
   auto-discovers DBs and shows tables/row counts; AXI principles say no-args
   should show actionable current state.
2. **Output is structured and compact.** Many tools use TOON output, small
   default schemas, and stdout for structured data only.
3. **Lists default to minimal useful columns.** Slack specs call for 3–4 fields
   by default, with `--fields` for expansion.
4. **Detail views show self-contained enough context.** Detail views often omit
   generic help when the object view is already sufficient, but still include
   relevant follow-up hints when useful.
5. **Every list/mutation can end with contextual `help[]`.** `gh-axi` has
   state/action-specific suggestions such as next commands for open issues vs
   closed issues. `sqlite-axi` shows `schema`, `sample`, `query` next steps.
6. **Errors are structured and corrective.** Missing arguments and not-found
   errors include specific fixing commands.
7. **Empty states are explicit.** Zero-result output states zero with context,
   rather than blank output.
8. **Totals/completeness are visible.** Lists show total counts or completeness
   markers when possible.
9. **Commands carry forward disambiguating context.** Suggestions include
   repo/db/channel flags when needed.
10. **Skills/playbooks exist for deeper guidance.** Notion/Lavish expose “when
    to use” guidance and richer playbooks beyond normal command output.

## optctl Design Goals

- The CLI should be generic over configured resources.
- Packs should provide AXI guidance for each resource and action.
- Agents should learn how to use a pack from `optctl` output, not external docs.
- Output should be structured, compact, and content-first.
- Help should be contextual and concrete, not a generic wall of commands.
- Mutations should make immutable staging and commit explicit.

## Resource `axi` Property

Each `kind: Resource` can include an `axi` property that teaches `optctl` how to
present and guide the resource.

Resource/action component names are lowercase snake case. Public CLI definition
identities are publisher-qualified, for example `operant/crm:contact` and
`operant/crm:pipeline_stage`; runtime project is selected separately with
`--project` or context. Display text may use human titles.

Example:

```yaml
kind: Resource
apiVersion: operant.dev/v1
metadata:
  name: contact
spec:
  fields:
    first_name:
      type: string
    last_name:
      type: string
    email:
      type: string
    company_id:
      type: string
      ref: company
  axi:
    purpose: People associated with companies, leads, and opportunities.
    whenToUse:
      - Use Contact when tracking a real person you can email, call, meet, or link to a company.
      - Do not use Contact for an organization; use Company.
    identity:
      title: "${first_name} ${last_name}"
      subtitle: "${email}"
    list:
      defaultFields: [id, first_name, last_name, email]
      sort: updated_at desc
      empty:
        message: No contacts found.
        help:
          - optctl --project ${project} create operant/crm:contact --stage
          - optctl --project ${project} list operant/crm:company
    detail:
      sections:
        - title: Contact
          fields: [first_name, last_name, email, phone, title]
        - title: Relationships
          fields: [company_id, owner_id]
      help:
        - optctl action stage operant/crm:merge_contact --input merge.json
        - optctl --project ${project} list operant/crm:opportunity --where primary_contact_id=${id}
    search:
      fields: [first_name, last_name, email, phone]
      examples:
        - optctl --project ${project} search operant/crm:contact --text alice@example.com
    help:
      list:
        - optctl --project ${project} view operant/crm:contact <id>
        - optctl --project ${project} create operant/crm:contact --stage
      created:
        - optctl --project ${project} view operant/crm:contact ${id}
        - optctl action stage operant/crm:create_follow_up --input follow-up.json
```

## Canonical `axi` schema

### `purpose`

One sentence explaining the resource.

### `whenToUse[]`

Short decision guidance for agents. This is the equivalent of AXI/skill “when to
use” content, scoped to a resource.

### `doNotUseFor[]`

Optional negative guidance to avoid wrong resource selection.

### `identity`

How to refer to an object in compact output:

- `title`
- `subtitle`
- `labelFields`

### `list`

How to render list output:

- `defaultFields`: compact 3–5 field schema.
- `availableFields`: optional field expansion list.
- `sort`: default sort.
- `limit`: default list limit.
- `empty`: explicit empty-state message and help.
- `aggregates`: counts/statuses worth precomputing.

### `detail`

How to render detail output:

- Sections and fields.
- Related resources to include cheaply.
- Long fields that should truncate with `--full` escape hatch.
- Contextual help for next steps.

### `search`

How to search the resource:

- fields
- examples
- result fields
- disambiguation behavior

V1 `optctl search` requires `--text` and lowers exact equality across the
declared fields into the ordinary permission-filtered query API. It is not
semantic, vector, fuzzy, or full-text search.

### `actions`

Optional resource-local description of important actions. The action definition
remains canonical, but resource `axi` can highlight which actions matter in this
context.

```yaml
actions:
  primary:
    - operant/crm:merge_contact
    - operant/crm:create_follow_up
  byState:
    active:
      - operant/crm:mark_contact_inactive
```

### `help`

Contextual help templates keyed by command/result context:

- `home`
- `list`
- `empty`
- `view`
- `created`
- `updated`
- `archived`
- `validation_failed`
- `not_found`

Help lines should be concrete command templates. They may contain template
variables from the current object/result context.

## Action AXI Guidance

Actions should also support guidance, because they are the agent-invocable
“buttons.”

```yaml
kind: Action
metadata:
  name: convert_lead
spec:
  availability:
    resource: lead
    states: [qualified]
  input:
    lead_id:
      type: string
      format: uuid
      required: true
  reads:
    lead:
      resource: lead
      id_from: input.lead_id
      required: true
  axi:
    purpose: Convert a qualified lead into CRM operating records.
    whenToUse:
      - Use after a lead has been qualified and should become an active opportunity.
    stageFirst: true
    examples:
      - optctl action stage operant/crm:convert_lead --input action.json
      - optctl action commit operant/crm:convert_lead --input action.json
    successHelp:
      - optctl --project ${project} view operant/crm:opportunity ${created.opportunity_id}
      - optctl --project ${project} list operant/crm:activity --where related_id=${created.opportunity_id}
```

## Pack-Level AXI Guidance

Packs can define home-level guidance for `optctl pack home operant/crm` or
`optctl` no-args when the pack is active.

```yaml
kind: Pack
metadata:
  publisher: operant
  name: crm
spec:
  axi:
    purpose: Headless CRM resources for leads, contacts, companies, opportunities, and sales activities.
    home:
      resources:
        - operant/crm:lead
        - operant/crm:opportunity
        - operant/crm:contact
        - operant/crm:company
      help:
        - optctl --project ${project} list operant/crm:lead
        - optctl --project ${project} list operant/crm:opportunity
        - optctl --project ${project} search operant/crm:contact --text <email-or-name>
```

## Authentication and context UX

`optctl` contexts store only normalized server origin and optional default
project; they never select identity, roles, or authorization. Commands include
`context list/show/add/use/set-project/remove`. Bootstrap automatically creates
and activates the successful origin context without confirmation.

Credential selection walks to the nearest process binding and uses its one
current authorization token. It never searches for a better credential based on
roles/projects. `auth wait` redeems approved authority and atomically installs
the replacement token. `auth isolate -- <agent-command>` creates a request-only
subtree. `auth doctor [--fix]` diagnoses/repairs local auth files and contexts.

Authorization denials explain current principal/roles/boundary and failed
capability but do not recommend escalation, roles, or auth commands. A denied
auth request reports the human reason and stops. Global `--non-interactive` and
`OPERANT_NON_INTERACTIVE=1` disable prompts; piped-input and JSON commands do
not prompt.

Successful `changeset stage` and `action stage` commands return the complete
staged-changeset representation produced by `changeset inspect`; an agent does
not need a second command to review what it just staged. Direct commit commands
are client-side stage-then-commit conveniences. Required-capability/effect
manifests remain available in that representation and JSON output.

## optctl Command Surface Sketch

Resource commands:

```text
optctl                    # content-first home/dashboard
optctl resources          # configured resource kinds with purposes
optctl metadata resource operant/crm:lead
optctl --project sales list operant/crm:lead [--fields ...] [--where ...]
optctl --project sales view operant/crm:lead <id> [--full]
optctl --project sales search operant/crm:contact --text <query>
optctl --project sales create operant/crm:lead --input lead.json --stage
optctl --project sales create operant/crm:lead --input lead.json --commit
optctl --project sales update operant/crm:lead <id> --input update.json --stage
optctl --project sales transition operant/crm:opportunity <id> proposal --stage

optctl changeset stage --input changeset.json
optctl changeset inspect <stage-id>
optctl changeset commit <stage-id>
optctl changeset commit --input changeset.json  # client stages, then commits
optctl changeset cancel <stage-id>
```

Action commands:

```text
optctl metadata actions operant/crm:lead
optctl --project sales action stage operant/crm:convert_lead --input action.json
optctl --project sales action commit operant/crm:convert_lead --input action.json
```

Pack commands:

```text
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack inspect operant/crm
```

System secret and hook-secret grant commands:

```text
optctl secret list
optctl secret create <name> --stdin
optctl secret rotate <name> --stdin
optctl secret disable <name>
optctl secret grants
optctl secret grant <secret> --hook <hook> --slot <slot>
optctl secret replace-grant <grant-id> --secret <secret>
optctl secret revoke-grant <grant-id>
```

Secret values use stdin or an interactive no-echo prompt, never normal arguments
or flags. Grant confirmation displays non-plaintext hook revision/security,
network, read, effect, slot, and environment details. Exact DTOs and authority
are defined in [Hook-Secret Grants](hook-secret-grants.md).

Outbox delivery commands:

```text
optctl outbox list [--status ...]
optctl outbox inspect <delivery-id>
optctl outbox attempts <delivery-id>
optctl outbox retry <delivery-id> [--reason ...]
optctl outbox cancel <delivery-id> [--reason ...]
optctl outbox drain [--limit 25]
```

The main server performs normal delivery through one in-process polling loop;
`drain` is an audited admin/test trigger. Retry/cancel output the complete
resulting delivery representation. See
[Durable Outbox Delivery](outbox-delivery.md).

## Query/Pagination Guidance

Resource list defaults should come from AXI guidance so agents do not
accidentally load full objects into context.

Example:

```yaml
spec:
  axi:
    list:
      defaultFields: [id, name, status, updated_at]
      help:
        - optctl --project ${project} view operant/crm:lead <id>
        - optctl --project ${project} query operant/crm:lead --where 'status == "qualified"'
```

Structured list/query APIs should return compact fields by default, include
pagination metadata, and include filter/policy summaries so agents know what
they are seeing.

## Output Rules for optctl

- Render TOON by default; `--json` emits the canonical API envelope.
- Default list schemas should be small.
- Include total counts/completeness when known.
- Empty states must be explicit.
- Long text must truncate with size hints and `--full` escape hatch.
- Errors preserve the shared `error.code/message/details` envelope.
  `details.help[]` is limited to safe 400/422 AXI repair guidance; authorization
  and authentication denials never add escalation commands.
- Mutating actions should support explicit stage-first and direct-commit flows.
- Contextual `help[]` should be generated from resource/action/pack `axi` config
  plus command context.

## When AXI Guidance Is Shown

- **No args / home:** pack-level purpose, active packs/resources, high-value
  counts, and help.
- **`resources`:** resource names, purpose, common commands.
- **`describe <resource>`:** schema, lifecycle, actions, and `whenToUse`
  guidance.
- **`list <resource>`:** compact rows, counts, empty-state guidance, next
  commands.
- **`view <resource> <id>`:** detail sections, available actions for current
  state, next commands.
- **`action stage ...`:** the complete persisted stage, including operations,
  validation/policy/hook results and the commit command.
- **Errors:** corrective command suggestions from relevant resource/action
  guidance.

## Frozen v1 guidance decisions

- `optctl` renders TOON by default and `--json` emits the canonical JSON DTO.
- AXI templates use a safe `${field}` placeholder subset over explicitly
  supplied result/context fields. No JSONPath, expression evaluation, property
  traversal, function calls, or environment expansion is allowed. Unknown
  placeholders fail pack preview.
- An agent-ready resource requires non-empty `purpose`, at least one
  `whenToUse`, identity/title fields, compact list default fields, explicit
  empty state, and concrete list/view/create-or-primary-action help. An
  agent-ready action requires `purpose`, input schema, one example, and success
  guidance. Pack preview reports missing readiness guidance; bundled proof packs
  must pass.
- Compiling `axi.whenToUse` into an installable Agent Skill is deferred and is
  not an MVP pack-apply or CLI requirement.
