# Pack Publishers and Projects

## Decision

Operant separates distributable pack identity from runtime data/authorization
boundaries:

- **publisher** identifies who makes the pack, analogous to an npm package owner
  or GitHub organization.
- **project** is a first-class runtime boundary for objects, role assignments,
  policy evaluation, and CLI context, analogous to a Kubernetes namespace.
- **namespace** is not a user-facing synonym for either concept.

Packs are installed globally on one Operant server. They are not installed once
per project. A project scopes use of globally installed definitions.

## Pack identity and source

```yaml
kind: Pack
apiVersion: operant.dev/v1
metadata:
  publisher: operant
  name: crm
  version: 0.1.0
spec:
  purpose: Headless CRM operating resources.
  axi:
    home:
      resources: [operant/crm:lead, operant/crm:opportunity]
      help: ["optctl --project ${project} list operant/crm:lead"]
```

Canonical identities:

```text
operant/crm
operant/crm@0.1.0
acme/revenue_ops@2.3.0
```

For this version packs come only from local directories/uploads through
`optctl`:

```bash
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack inspect operant/crm
```

There is no pack registry, publisher-account claiming, remote publishing, trust
store, or registry ownership protocol in scope. `publisher` is declared stable
pack identity. Server authorization controls who may preview/apply/upgrade a
local pack, and applied source/revision/digest/principal provenance is audited.

Exactly one version/revision of a pack is active server-wide. Upgrading a pack
upgrades its definitions for every project atomically through the normal pack
migration lifecycle. Different projects cannot select different pack versions.

## Project identity

Projects are built-in UUIDv7 system records with immutable slug and explicit
lifecycle as frozen in [Platform Projects](projects.md). They are not pack YAML
or pack installation targets. Projects do not imply separate tenants; Operant
remains single-tenant and projects scope data/authority within the installation.

A global resource definition may have object instances in many projects:

```text
resource definition: operant/crm:lead
runtime object scope: project UUID (CLI may resolve slug `sales`)
```

The database/API store structured `project_id`, resource-definition identity,
and object ID fields. Dotted project/resource aliases are rejected.

Installing `operant/crm` once globally makes its resource/action/hook/lifecycle,
role, and policy definitions available server-wide. Creating or operating on a
lead still requires an explicit project boundary and matching role/policy
authority.

## Roles and policies

Role and policy definitions are globally registered and publisher-qualified:

```text
operant/crm:sales_manager
operant/crm:sales_access
```

Roles contain identity/guidance, not `allow` lists. Policies define permissions
and reference canonical role/resource definitions. Pack-relative references are
canonicalized during preview; undeclared or ambiguous references fail.

Pack-provided default policy assignments are installed globally, normally with
`all_projects` boundary, so the same policy logic applies to each project's
data. Project-specific/system policy assignments may further configure server
policy, but they do not install another pack copy. Role assignments and agent
authorizations carry project/all-project/system boundaries and determine where a
principal holds a role.

See [Authorization Definitions and Assignments](authorization-assignments.md).

## API and CLI addressing

```text
optctl --project sales list operant/crm:lead
```

The CLI resolves `sales` to a project UUID and sends it separately from global
resource definition `operant/crm:lead`. An explicit request project and selected
context/flag must agree or return `project_conflict`.

Pack lifecycle commands do not take a project:

```bash
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack inspect operant/crm
```

## Current implementation transition

The existing pre-auth MVP overloaded `namespace` in identifiers such as
`default.crm` and `default.lead`. There are no deployed users/databases
requiring compatibility. The next schema may invalidate old databases and move
directly to publisher-qualified global definitions plus explicit project ids; no
alias or backfill layer is required.
