# Operant project model

`model.json` is the repository's **authoritative** project model.

It was synthesized from:

- all 53 tracked files under `spec/`;
- the complete current Pi session (`019f6baa-af86-725a-81a8-3ce65a3f5155`),
  including a hash-bound reviewed prefix of 209 user messages and 13
  compactions;
- current source, proof packs, tests, deployment and release surfaces at Git
  HEAD `7640287c1bf1ad11879b88dac36b81e092923ba4`;
- local archived implementation/repair evidence under `.ai/history/`.

## Authority status

Revision 14 established authority. The user explicitly approved candidate
manifest
`sha256:46120d55b3ce71869c196451f0bb8ce8d341cee55c76f853afffdc9dc22b2244`; the
isolated migration cutover accepted all 155 then-governing objects and generated
the reviewed projections. The cutover receipt is preserved at
`migrations/authoritative-cutover-receipt.json`. Subsequent reviewed directions
advanced the authoritative model to revision 21 with 160 governing objects.

Projection routing now assigns all 160 governing objects exactly once across 62
generated views under `spec/`. Forty-two normative files and eleven explicitly
non-normative historical/supporting files are preserved literally in the model;
all 53 files and 890 headings have reviewed dispositions with zero unresolved
sections. Successive independent audits drove closure of the remaining
information-loss risks, and the final revision-13 audit returned PASS. `spec/`
now remains solely as deterministic project-model projection output.

The authoritative model can be explored with:

```text
/dag brainstorm new Operant model audit
```

Future semantic changes must use reviewed project-model directions rather than
hand-editing generated `spec/` files.

## Evidence

- `migrations/initial-source-manifest.json` freezes the input corpus identities.
- `migrations/initial-candidate-audit.md` records mapping choices, repaired
  blockers, independent audits, and completion.
- `migrations/authoritative-cutover-receipt.json` binds authority to the exact
  approved candidate manifest.
- `migrations/authoritative-projection-manifest.json` freezes all generated
  projection identities.
- `migrations/post-cutover-conformance.json` records authoritative validation.
- `model.json` retains resolved questions and discoveries as review history
  rather than silently erasing prior contradictions.
