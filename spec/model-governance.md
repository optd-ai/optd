<!-- generated-by: pi-dag-workflow/project-model; view: view-model-governance; contract: 1; input: sha256:76ce7eac17661a59327285b9d90e41ae1946e1cc42e34cc13af01da420c5f470 -->

# Project-model governance and cutover

Canonical project-model governance and cutover decisions and contracts projected from project-model/model.json.

## Decisions

<a id="obj-dec-readiness-status"></a>

### Treat the old planning-readiness result as historical

The 2026-07-14 readiness result justified the completed implementation plan. Current authority cutover depends instead on the reviewed project-model conflict record, exact projection/omission coverage, replacement documentation, and user-approved spec cleanup.

**Rationale.** A historical planning conclusion must not claim current project-model cutover readiness.

<a id="obj-dec-generated-spec-layout"></a>

### Keep spec only as generated project-model projections

After completeness review, delete every hand-authored spec file and replace the directory with deterministic project-model-generated Markdown projections. project-model/model.json is the structured semantic source of truth; generated spec views are the compatible human-readable projection required by pi-dag-workflow. No hand-authored contract remains in spec. Retained model-contract and external-readiness outputs from a cancelled historical DAG are evidence rather than authority: independently inspect their exact local Git lineage and rerun current authoritative-model, deterministic-projection, source, and release checks before selectively adopting them into successor work.

**Rationale.** This eliminates dual authority while preserving authoritative workflow validation and generated-spec placement invariants.

## Commitments

<a id="obj-com-model-audit"></a>

### Create and validate the repository project model

Read the complete current Pi session, every spec, implementation/test/release surfaces, construct a non-authoritative candidate model, test it against source, preserve contradictions as discoveries/questions, and present inconsistencies for human resolution before cutover.
