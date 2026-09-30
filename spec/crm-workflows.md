<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-crm-workflows; contract: 1; input: sha256:af535560f08ab6decc73dd3d2dd6c323794f3579b7bfb83a5e55dc30eb987199 -->

# Headless CRM Workflows

Generated exact-contract projection imported into project-model/model.json from the reviewed crm-workflows.md source.

## Exact migrated contract

<a id="obj-com-exact-crm-workflows-v1"></a>

### Exact v1 contract — Headless CRM Workflows

**Migration provenance.** Exact normative contract imported from `spec/crm-workflows.md` at `sha256:5175f46c78a9306567fd8cec586f09e8982c45167021752190a91ae8fc2a3597`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Research Summary

Common CRM systems organize sales work around accounts/companies, contacts,
leads, opportunities/deals, activities, pipeline stages, quotes/orders, and
reporting. Typical CRM workflows include lead capture, qualification,
assignment, follow-up activities, pipeline stage transitions, forecasting,
quote/proposal generation, close-won/close-lost handling, and post-sale handoff.

Odoo CRM documentation emphasizes organizing a pipeline, acquiring leads,
enriching leads, assigning leads/opportunities, activities, lost reasons,
recurring plans, and reporting. Broader CRM conventions from
Salesforce/HubSpot/Pipedrive-style systems map to similar concepts: lead ->
qualified lead/opportunity -> proposal/negotiation -> won/lost, with activities
and ownership throughout.

## Core CRM Resources

These should be default configuration, not special code:

- `contact`
- `company` / `account`
- `lead`
- `opportunity` / `deal`
- `pipeline`
- `pipeline_stage`
- `activity`
- `task`
- `note`
- `email_message`
- `call_log`
- `meeting`
- `product`
- `pricebook` / `pricelist`
- `quote`
- `quote_line`
- `order`
- `lost_reason`
- `lead_source`
- `campaign`
- `sales_team`
- `territory`
- `forecast`

## Typical Lifecycles

### Lead

- `new`
- `contacted`
- `qualified`
- `disqualified`
- `converted`

Example rules:

- A lead requires at least one contact channel: email, phone, or website.
- A lead can convert only when linked to a contact and company or when
  conversion creates them.
- Disqualification requires a lost/disqualified reason.

### Opportunity / Deal

- `new`
- `qualified`
- `discovery`
- `proposal`
- `negotiation`
- `won`
- `lost`

Example rules:

- Proposal stage requires expected value and close date.
- Negotiation with high discount requires approval.
- Won stage requires primary contact and company.
- Lost stage requires lost reason.

### Activity

- `open`
- `done`
- `canceled`

Example rules:

- Activities are assigned to a user/agent.
- Overdue activities drive reminders and stale-deal detection.

## Relationships and authorization proof

Use first-class relationships for domain links needing metadata/history. The
proof pack also includes `optd/crm:opportunity_viewer` from opportunity to
built-in `system:principal`, unique by active `(from,to)`, so one-hop ReBAC can
be exercised without actor-supplied arrays or deep team traversal. Ownership
ABAC uses UUID-formatted `owner_id == actor.id`.

## Automations via Scripts

CRM behavior should be built as hooks/scripts attached to resources and
transitions:

- Normalize phone/email fields.
- Dedupe contacts by email/domain.
- Score leads.
- Assign owners by territory or workload.
- Create follow-up tasks after stage transitions.
- Require approval for exceptional discounts.
- Generate quote documents.
- Notify on high-value opportunities.
- Auto-close stale leads after configured inactivity.

## CLI/API-Only UX

A headless CRM should be operable via:

- Resource configuration files.
- CLI commands to apply resources.
- API/MCP actions for agents.
- Query/search commands.
- Changeset stage/commit commands.

Example flow:

1. Apply default CRM resource pack.
2. Agent imports leads.
3. Agent previews normalization/dedupe changeset.
4. Runtime validations reject incomplete leads.
5. Agent commits valid leads.
6. Hooks assign owners and schedule activities.
7. Sales agent transitions opportunities through pipeline with preview/approval.

## Frozen proof-pack boundaries

- `lead` and `contact` are separate default resources. Conversion preserves lead
  provenance while creating/linking contact/company/opportunity records.
- `opportunity` is the only deal-pipeline resource identity; there is no `deal`
  alias in v1.
- The CRM proof pack owns lead/contact/company/opportunity/activity workflows.
  Quote, order, invoice, and fulfillment resources belong in a future sales pack
  and are not required for the platform MVP.
