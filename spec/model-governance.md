<!-- generated-by: pi-dag-workflow/project-model; view: view-model-governance; contract: 1; input: sha256:c06add9628c42dfc8fa46b8e2bbe9f7b9ff6bd74e37e85619d793dea82e7138f -->

# Project-model governance and cutover

Canonical project-model governance and cutover decisions and contracts projected from project-model/model.json.

## Decisions

<a id="obj-dec-readiness-status"></a>

### Treat the old planning-readiness result as historical

The 2026-07-14 readiness result justified the completed implementation plan. Current authority cutover depends instead on the reviewed project-model conflict record, exact projection/omission coverage, replacement documentation, and user-approved spec cleanup.

**Rationale.** A historical planning conclusion must not claim current project-model cutover readiness.

<a id="obj-dec-generated-spec-layout"></a>

### Keep spec only as generated project-model projections

After completeness review, delete every hand-authored spec file and replace the directory with deterministic project-model-generated Markdown projections. project-model/model.json is the structured semantic source of truth; generated spec views are the compatible human-readable projection required by pi-dag-workflow. No hand-authored contract remains in spec.

**Rationale.** This eliminates dual authority while preserving authoritative workflow validation and generated-spec placement invariants.

## Commitments

<a id="obj-com-model-audit"></a>

### Create and validate the repository project model

Read the complete current Pi session, every spec, implementation/test/release surfaces, construct a non-authoritative candidate model, test it against source, preserve contradictions as discoveries/questions, and present inconsistencies for human resolution before cutover.
