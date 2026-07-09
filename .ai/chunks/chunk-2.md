# Chunk 2: Pack schemas, YAML loader, canonicalization, registry, and metadata APIs

## Deliverable
Preview and apply the CRM pack metadata through the real CLI/HTTP path, persist pack definitions, and expose metadata/home.

## Scope
- Implement TypeBox/Ajv pack schemas for Pack, Resource, Relationship, Lifecycle, Action, Hook, Policy, and Seed v0.
- Implement YAML adapter with merge-key support, canonical JSON normalization, source/script digests, and rejection of custom tags/non-JSON/multi-doc features.
- Implement strict pack directory scanner: known dirs only, child `metadata.name` required, basename match, hook YAML required for hook scripts, script refs are basenames only, no `docs/` directory.
- Implement multipart `POST /packs/preview` and `POST /packs/apply` for metadata-only first install.
- Implement pack registry tables/repositories for pack revisions, source files, and definitions.
- Implement metadata routes from Proposal A and `optctl home` / `optctl metadata ...` with TOON and `--json`.

## Validation requirements
- Unit tests for schema errors, filename/name mismatches, invalid hook script refs, advanced YAML rejection, and merge-key canonicalization.
- Live preview scenario: `optctl pack preview prototypes/crm-default-pack --json` packages the directory as multipart, calls server over HTTP, returns normalized summary, and proves no DB mutation by checking pack registry tables remain empty.
- Live apply scenario: `optctl pack apply prototypes/crm-default-pack`, then `optctl home`, `optctl metadata resource default.lead`, `optctl metadata action default.convert_lead`; assert TOON and JSON outputs include expected AXI/resources/actions/help.
- Restart validation: restart server and verify metadata commands load from Postgres, not memory.

## Notes
- If the CRM pack is internally inconsistent with the spec, fix the pack. Do not add CRM-specific engine special cases.
