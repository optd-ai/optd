# Chunk 12: CLI completeness, compiled binary, and TOON golden outputs

## Deliverable
Make `optctl` the complete primary agent interface and validate compiled binary behavior.

## Scope
- Complete command groups: home, pack preview/apply, metadata, query, view, changeset preview/commit, action preview/commit, history, outbox status/drain/retry, migration inspect/apply/confirm, and secrets if exposed.
- Ensure TOON default output, `--json`, and useful `--verbose` behavior.
- Normalize stable error envelopes and next-step help in CLI output.
- Add `deno compile` task for CLI binary.
- Add golden TOON/JSON output tests for representative success and error cases.

## Validation requirements
- CLI contract tests for parsing and API URL construction.
- Golden output tests for home, metadata, query, changeset, action, migration, outbox, and errors.
- Live scenario executes every major command against real server with CRM pack applied.
- Compile validation: produce runnable binary, run it against server, assert output.
