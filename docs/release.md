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
