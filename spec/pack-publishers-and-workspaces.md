# Pack Publishers and Workspaces

Authoritative contract; edit this specification directly.

## Exact migrated contract

<a id="obj-com-exact-pack-publishers-and-projects-v1"></a>

### Exact v1 contract — Pack Publishers and Workspaces

**Migration provenance.** Exact normative contract imported from
`spec/pack-publishers-and-projects.md` at
`sha256:b959a489f0bc16f34c39c859442006ba9827b778937d478a5a32eb72e139987d`. Text
explicitly labeled historical, research, prototype evidence, or deferred remains
non-normative; all other versioned requirements below preserve the imported
contract semantics as maintained directly in these specifications.

## Decision

optd separates distributable pack identity from runtime data/authorization
boundaries:

- **publisher** identifies who makes the pack, analogous to an npm package owner
  or GitHub organization.
- **workspace** is a first-class runtime boundary for objects, role assignments,
  policy evaluation, and CLI context, analogous to a Kubernetes namespace.
- **namespace** is not a user-facing synonym for either concept.

Packs are installed globally on one optd server. They are not installed once per
workspace. A workspace scopes use of globally installed definitions.

## Pack identity and source

```yaml
kind: Pack
apiVersion: optd.dev/v1
metadata:
  publisher: optd
  name: crm
  version: 0.1.0
spec:
  purpose: Headless CRM operating resources.
  axi:
    home:
      resources: [optd/crm:lead, optd/crm:opportunity]
      help: ["optctl --workspace ${workspace} list optd/crm:lead"]
```

Canonical identities:

```text
optd/crm
optd/crm@0.1.0
acme/revenue_ops@2.3.0
```

For this version packs come only from local directories/uploads through
`optctl`:

```bash
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack inspect optd/crm
```

There is no pack registry, publisher-account claiming, remote publishing, trust
store, or registry ownership protocol in scope. `publisher` is declared stable
pack identity. Server authorization controls who may preview/apply/upgrade a
local pack, and applied source/revision/digest/principal provenance is audited.

Exactly one version/revision of a pack is active server-wide. Upgrading a pack
upgrades its definitions for every workspace atomically through the normal pack
migration lifecycle. Different workspaces cannot select different pack versions.

## Workspace identity

Workspaces are built-in UUIDv7 system records with immutable slug and explicit
lifecycle as frozen in [Platform Workspaces](workspaces.md). They are not pack
YAML or pack installation targets. Workspaces do not imply separate tenants;
optd remains single-tenant and workspaces scope data/authority within the
installation.

A global resource definition may have object instances in many workspaces:

```text
resource definition: optd/crm:lead
runtime object scope: workspace UUID (CLI may resolve slug `sales`)
```

The database/API store structured `workspace_id`, resource-definition identity,
and object ID fields. Dotted workspace/resource aliases are rejected.

Installing `optd/crm` once globally makes its resource/action/hook/lifecycle,
role, and policy definitions available server-wide. Creating or operating on a
lead still requires an explicit workspace boundary and matching role/policy
authority.

## Roles and policies

Role and policy definitions are globally registered and publisher-qualified:

```text
optd/crm:sales_manager
optd/crm:sales_access
```

Roles contain identity/guidance, not `allow` lists. Policies define permissions
and reference canonical role/resource definitions. Pack-relative references are
canonicalized during preview; undeclared or ambiguous references fail.

Pack-provided default policy assignments are installed globally, normally with
`all_workspaces` boundary, so the same policy logic applies to each workspace's
data. Workspace-specific/system policy assignments may further configure server
policy, but they do not install another pack copy. Role assignments and agent
authorizations carry workspace/all-workspace/system boundaries and determine
where a principal holds a role.

See [Authorization Definitions and Assignments](authorization-assignments.md).

## API and CLI addressing

```text
optctl --workspace sales list optd/crm:lead
```

The CLI resolves `sales` to a workspace UUID and sends it separately from global
resource definition `optd/crm:lead`. An explicit request workspace and selected
context/flag must agree or return `workspace_conflict`.

Pack lifecycle commands do not take a workspace:

```bash
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
optctl pack inspect optd/crm
```

## Current implementation transition

The existing pre-auth MVP overloaded `namespace` in identifiers such as
`default.crm` and `default.lead`. There are no deployed users/databases
requiring compatibility. The next schema may invalidate old databases and move
directly to publisher-qualified global definitions plus explicit workspace ids;
no alias or backfill layer is required.
