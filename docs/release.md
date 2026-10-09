# Local optd distribution

This is an operational guide, not a release attestation. The canonical identity
is `optd`, source `https://github.com/optd-ai/optd`, server `optd`, CLI
`optctl`, and HTTP prefix `/api/v1`. Configuration and release controls use
`OPTD_*`. There are no legacy compatibility aliases.

## Local checks and artifacts

Run from a clean, committed checkout:

```sh
bash scripts/optd-integration-verify.sh
deno test -A tests/unit/optd_distribution.test.ts
deno test -A tests/e2e/foundation/compiled_cli_smoke.test.ts
```

The integration verifier requires the fresh-state host CRM and Projects shared
public-flow matrix using a current compiled `optctl`, independent driver/adapter
equivalence checks, and the full unit/integration/e2e/scenario suite. Host tests
require real PostgreSQL binaries (select them with `OPTD_PG_BIN_DIR`); no host
coverage may be skipped or replaced with mocks. Each shared flow owns a fresh
service and checks quiescent cleanup.

The verifier is still intentionally prefix-safe: its success is not image or
release readiness. The subsequent image acceptance step must extend it to the
mandatory full exact-image release gate on the composed clean HEAD before final
release readiness can be claimed.

The full local gate is `deno task release-gate`. It requires Docker, the
supported builder, Deno, existing PostgreSQL binaries for host tests, and the
shell tools used by the scripts. Do not install host packages as a side effect.
The current gate accounts for the legacy builder's exact image delta; merely
having Buildx installed does not demonstrate that this accounting supports
BuildKit. A builder mismatch must fail with retained evidence, not bypass
ownership checks.

The gate freezes a clean exact commit into `git archive`, builds once, and runs
the suite and artifact generation against that immutable image ID. See
[runtime.md](runtime.md) for ownership-scoped cleanup and retained failure
evidence. Do not replace failed checks with a completion report or a skipped
suite.

For artifact generation alone, pass a **full immutable image ID**, never a tag:

```sh
bash scripts/release-artifacts.sh sha256:<64-lowercase-hex-digits> dist
```

This command requires the image revision to equal clean `HEAD`, the canonical
source label, and `Apache-2.0` license label. It does not itself establish host
or image acceptance. It produces:

- `optctl`: compiled from that source using the frozen lockfile.
- `LICENSE` and `NOTICE`: exact source legal files; also included at
  `/opt/optd/` in the image. Third-party base filesystem notices are preserved.
- `image-metadata.json`: full image ID, available repository digests (possibly
  empty for a local image), source commit, source URL, license, OCI labels,
  runtime versions, and CLI checksum.
- `SHA256SUMS`: checksums of the CLI, metadata, and both legal files.

Artifacts are staged on the output filesystem, synced, and renamed atomically;
interruption rolls back to previous output. Existing output is replaced only by
this explicit operation. Output symlinks and changed parent identities fail
closed. `dist/` is ignored build output, not source evidence. SHA256SUMS
provides integrity checking, not authenticity, signing, or attestation.

## Read-only local/precreation preflight

`deno run -A scripts/optd-external-preflight.ts verify` records fresh, redacted
observations under ignored `.ai/optd-external-preflight/observation-*/`. Earlier
failures are retained, never replayed as proof. Success is **LOCAL/PRECREATION**
only, with `publicationAuthorized=false`; it is not publish-ready or an image
attestation. The independent source and final composed-proposal image gates
remain mandatory.

The intended publication manifest is exactly `refs/heads/master` and **all**
reachable ancestry/objects, with no squash. A detached candidate (and later the
actual checked composed proposal) must contain current accepted master ancestry;
it need not equal master. Evidence binds accepted master and the prospective tip
to immutable object IDs. Private DAG/work refs and every other ref are
inventoried separately and excluded from intended publication, not deleted.
Missing objects, shallow/promisor history, replacements, grafts, alternates,
dirty source and changing refs fail closed. No fetch, ref update or remote
mutation is performed.

The GitHub observations use existing authentication and only GET `/user`,
`/user/memberships/orgs/optd-ai`, `/orgs/optd-ai`, complete paginated
`/orgs/optd-ai/repos?type=all&per_page=100`, and `/repos/optd-ai/optd`. The
authenticated identity must match active administrative membership. To avoid
mistaking token-filtered 404s for absence, this verifier requires documented
classic `repo` and org-read scopes, validates repository visibility, and
reconciles public/private counts with organization metadata. Missing scope/count
information (including an unprovable fine-grained-token view) fails closed; it
never requests new scopes or login. Two fresh inventories must agree. Account
names, tokens, response bodies and stderr are not persisted.

Organization creation-policy fields are recorded when returned; missing fields
are `UNKNOWN`, not capability success. Destination hooks, Actions, rules, GHCR
and write capabilities remain explicit `UNVERIFIED` postcreation obligations,
not prerequisites for a nonexistent destination. Local release/integration
scripts and canonical OCI identity are inspected and hashed; workflow
presence/absence is inventoried without claiming execution. TXT control is
checked against the exact frozen-model challenge at both authoritative servers
and both required public resolvers, within the bounded observation window.

API contracts:
[organization metadata](https://docs.github.com/en/rest/orgs/orgs),
[organization membership](https://docs.github.com/en/rest/orgs/members),
[repository inventory](https://docs.github.com/en/rest/repos/repos),
[authenticated user](https://docs.github.com/en/rest/users/users), and
[OAuth scope headers](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## External work is separate

The settled premise is creation of a **new public `optd-ai/optd` repository**
from complete validated local history, not transfer of an existing hosted
repository. Reverify active organization administration and destination absence
immediately before any separately authorized creation. This document does not
assert that the repository exists or that a release is published.

Repository creation, remote changes, push, tags, registry login/publication, and
GitHub release publication each require explicit later authorization. None is
performed by these local scripts. Domain-control TXT observations are historical
evidence, not instructions to repeat DNS setup or permission to change DNS or
credentials. Any further external observations must remain read-only unless
separately authorized. Never globally prune Docker resources: retain ambiguous
resources and their evidence for investigation.

SBOM generation, signing, attestation, and a Pack registry are excluded. A clean
candidate commit and passing distribution tests alone do not establish complete
release readiness; actual host and exact-image results and unresolved external
prerequisites must be reported separately.

## Tag-triggered publication

`.github/workflows/release.yml` publishes stable `vX.Y.Z` tags whose commits are
ancestors of `master`. Creating and pushing a version tag is the explicit
release operation; ordinary branch pushes do not publish. Only Linux x86_64 is
supported.

The read-only validation job runs the complete existing release gate with Deno
2.8.3, host PostgreSQL 18, and the default Docker Buildx driver. Its unchanged
12 GiB capacity guard may reject an undersized runner. No checks are skipped.
`OPTD_RELEASE_EXPORT_DIR` optionally exports the exact tested image and binary
before cleanup; export files are NOT acceptance evidence until the gate exits
zero, including its inventory-restoration cleanup. The publishing job depends on
that success, verifies checksums, and loads that image without rebuilding it.

The publishing job alone receives `contents: write` and `packages: write`
through GitHub's short-lived token. It publishes `ghcr.io/optd-ai/optd:vX.Y.Z`
and a GitHub Release containing `optctl-vX.Y.Z-linux-x86_64.tar.gz`, legal
notices, checksums, image metadata, and registry digest. No `latest` tag is
moved. OCI version labels retain the gate's source-derived identifier; the
registry tag supplies the release version. Existing image versions are not
intentionally overwritten. Network or authorization ambiguity fails closed. A
container push followed by a failed GitHub Release leaves a partial release
requiring operator recovery; do not move the version tag or blindly retry it.

GHCR package visibility is independent of repository visibility. After the first
successful publication, verify anonymous pulling and explicitly configure the
package as public if needed. No personal access token is required by the
workflow. Local export checks: `python3 tests/release_export_test.py`.
End-to-end hosted publishing must still be validated by an explicitly authorized
first version tag.
