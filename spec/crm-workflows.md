# Headless CRM Workflows

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
- Changeset preview/commit commands.

Example flow:

1. Apply default CRM resource pack.
2. Agent imports leads.
3. Agent previews normalization/dedupe changeset.
4. Runtime validations reject incomplete leads.
5. Agent commits valid leads.
6. Hooks assign owners and schedule activities.
7. Sales agent transitions opportunities through pipeline with preview/approval.

## Open Questions

- Should `lead` and `contact` be separate defaults, or should lead be a
  lifecycle state of contact/account interest?
- Should `deal` and `opportunity` both exist, or should one be an alias?
- How much sales quoting/order functionality belongs in CRM defaults vs a sales
  pack?
