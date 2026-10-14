# Specification governance

## Source of truth

`spec/` is the authoritative product and technical contract. Edit its Markdown
directly; no DAG workflow, JSON model, projection generator, or generation
receipt is required. This supersedes the former generated-only specification
policy.

The existing 62 documents were checked against model revision 27 with zero drift
before cutover. Their contract bodies and stable object anchors were retained;
source-of-truth and formatting policies were updated. The original model and
migration receipts are preserved under [history](history/README.md), including
records not previously rendered into normative specs. They are non-normative
history, not a second authority. Historical acceptance or publication permission
does not authorize a new external operation.

## Editing workflow

1. Read the relevant contract and accepted decisions before implementation.
2. Edit affected specifications and examples directly in the same reviewed
   change as implementation and tests. Update overlapping summaries and detailed
   contracts together; explicitly resolve conflicts rather than creating
   parallel truths.
3. Keep requirements distinct from proposals, deferred work and historical
   evidence. Never promote these merely by moving files.
4. Keep stable anchors used by links. Add new documents to the index in
   `README.md`; distinguish normative and historical material there.
5. Run `deno task spec:check`, formatting and relevant regression tests. The
   checker validates indexed files, headings, unique explicit anchors and
   absence of generated-model headers, and rejects symlinks. It does not freeze
   prose, interpret requirements, or establish behavioral conformance.
6. Release changes still require real host coverage, the complete exact-source
   image gate, artifact identity verification and ownership-scoped cleanup.

## Historical decision anchors

<a id="obj-dec-readiness-status"></a>

Historical planning-readiness results are evidence only, never current
acceptance.

<a id="obj-dec-generated-spec-layout"></a>

The generated-only policy is superseded by the source-of-truth rule above.

<a id="obj-com-model-audit"></a>

The completed DAG-model audit is archived; future reviews operate directly on
specifications and executable behavior.
