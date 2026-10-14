# Retired DAG model history

Everything below this directory is **non-normative historical evidence**.
Current contracts live in the Markdown specifications above it; see
[specification governance](../model-governance.md).

`project-model/model.json` is the byte-preserved final revision 27 snapshot. Its
embedded authority flags, generated paths, source references and old permissions
describe the former workflow, not current authority. `project-model/migrations/`
and the original project-model README preserve prior audits and receipts without
rewriting their historical claims. No active check, build or release script
derives contract authority from this archive. It is excluded from formatting to
preserve evidence bytes.

Before migration, `deno task model:check` passed for all 62 specifications with
zero drift and zero stale paths. All 62 document paths and their stable anchors
are retained. Only obsolete generation/governance text is replaced; historical
and deferred content is not promoted into product requirements. The retired
validator/projector implementation remains available in Git history rather than
as a second live specification toolchain.
