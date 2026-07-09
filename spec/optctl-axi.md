# optctl AXI Guidance Model

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
- Mutations should preview by default when appropriate and make commit explicit.

## Resource `axi` Property

Each `kind: Resource` can include an `axi` property that teaches `optctl` how to
present and guide the resource.

Resource kind names in `optctl` commands are always lowercase, using snake case
for multi-word kinds. Examples: `crm.contact`, `crm.deal`, `crm.pipeline_stage`.
Display text may say “Contact” or “Pipeline Stage,” but command/config
identifiers stay lowercase.

Example:

```yaml
kind: Resource
apiVersion: operant.dev/v1
metadata:
  namespace: crm
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
      type: ref
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
          - optctl create crm.contact --preview
          - optctl list crm.company
    detail:
      sections:
        - title: Contact
          fields: [first_name, last_name, email, phone, title]
        - title: Relationships
          fields: [company_id, owner_id]
      help:
        - optctl action crm.contact.merge --id ${id} --preview
        - optctl list crm.opportunity --where primary_contact_id=${id}
    search:
      fields: [first_name, last_name, email, phone]
      examples:
        - optctl search crm.contact alice@example.com
    help:
      list:
        - optctl view crm.contact <id>
        - optctl create crm.contact --preview
      created:
        - optctl view crm.contact ${id}
        - optctl action crm.activity.create_follow_up --contact ${id} --preview
```

## Suggested `axi` Schema

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

### `actions`

Optional resource-local description of important actions. The action definition
remains canonical, but resource `axi` can highlight which actions matter in this
context.

```yaml
actions:
  primary:
    - crm.contact.merge
    - crm.activity.create_follow_up
  byState:
    active:
      - crm.contact.mark_inactive
```

### `help`

Contextual help templates keyed by command/result context:

- `home`
- `list`
- `empty`
- `view`
- `created`
- `updated`
- `deleted`
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
  namespace: crm
  name: convert_lead
spec:
  availability:
    resource: lead
    states: [qualified]
  input:
    lead_id:
      type: ref
      ref: lead
      required: true
  behavior:
    mode: hook
    preview: crm.preview_convert_lead
    commit: crm.commit_convert_lead
  axi:
    purpose: Convert a qualified lead into CRM operating records.
    whenToUse:
      - Use after a lead has been qualified and should become an active opportunity.
    previewFirst: true
    examples:
      - optctl action crm.convert_lead --lead <id> --preview
    successHelp:
      - optctl view crm.opportunity ${created.opportunity_id}
      - optctl list crm.activity --where related_id=${created.opportunity_id}
```

## Pack-Level AXI Guidance

Packs can define home-level guidance for `optctl pack home crm` or `optctl`
no-args when the pack is active.

```yaml
kind: Pack
metadata:
  namespace: crm
  name: crm
spec:
  axi:
    purpose: Headless CRM resources for leads, contacts, companies, opportunities, and sales activities.
    home:
      resources:
        - crm.lead
        - crm.opportunity
        - crm.contact
        - crm.company
      help:
        - optctl list crm.lead
        - optctl list crm.opportunity
        - optctl search crm.contact <email-or-name>
```

## optctl Command Surface Sketch

Resource commands:

```text
optctl                    # content-first home/dashboard
optctl resources          # configured resource kinds with purposes
optctl describe crm.lead  # schema + lifecycle + actions + axi guidance
optctl list crm.lead [--fields ...] [--where ...]
optctl view crm.lead <id> [--full]
optctl search crm.contact <query>
optctl create crm.lead --file lead.json --preview
optctl update crm.lead <id> --set status=contacted --preview
optctl transition crm.opportunity <id> proposal --preview
```

Action commands:

```text
optctl actions crm.lead
optctl action crm.convert_lead --lead <id> --preview
optctl action crm.close_won --opportunity <id> --preview
```

Pack commands:

```text
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack upload crm.tar.gz
optctl pack describe crm
```

## Query/Pagination Guidance

Resource list defaults should come from AXI guidance so agents do not
accidentally load full objects into context.

Example:

```yaml
spec:
  axi:
    list:
      fields: [id, name, status, updated_at]
      help:
        - optctl view crm.lead <id>
        - optctl query crm.lead --where 'status == "qualified"'
```

Structured list/query APIs should return compact fields by default, include
pagination metadata, and include filter/policy summaries so agents know what
they are seeing.

## Output Rules for optctl

- Use a compact structured format; TOON is a strong candidate because AXI tools
  use it for token efficiency.
- Default list schemas should be small.
- Include total counts/completeness when known.
- Empty states must be explicit.
- Long text must truncate with size hints and `--full` escape hatch.
- Errors should include `error`, `code`, and `help[]`.
- Mutating actions should support preview-first flows.
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
- **`action ... --preview`:** proposed changes, validation/policy/hook results,
  commit command.
- **Errors:** corrective command suggestions from relevant resource/action
  guidance.

## Open Questions

- Should `optctl` output TOON or JSON by default? AXI precedent strongly favors
  TOON, but implementation may keep JSON internally and encode at the boundary.
- Should `axi` templates use `${id}` syntax, JSONPath-like paths, or a safer
  limited placeholder system?
- How much of `axi` should be required for a resource to be considered
  agent-ready?
- Should `axi.whenToUse` also be compiled into an installable Agent Skill?
