<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-extensions; contract: 1; input: sha256:5702a47dbc882aebcdcc3314c4af6b4921a01d1fd97f59dafdbca312734f1c8d -->

# Extensions

Generated exact-contract projection imported into project-model/model.json from the reviewed extensions.md source.

## Exact migrated contract

<a id="obj-com-exact-extensions-v1"></a>

### Exact v1 contract — Extensions

**Migration provenance.** Exact normative contract imported from `spec/extensions.md` at `sha256:9cf20279f696e6631047dee3a8905d6e1f2c2dd2fae76553dbf0811a52e5b167`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## MVP decision

A separate extension namespace/payload/schema composition system is not in MVP.
Runtime objects accept only fields declared by their exact active pack resource
revision; undeclared metadata is rejected and cannot bypass schema, policy,
history, query, or migration behavior.

Operators extend a domain by authoring/applying a normal publisher-qualified
pack revision. Added fields and relationships use ordinary strict definitions,
changesets, policy, generated Postgres schema, and pack migration
classification. For file-like data in MVP, a pack declares ordinary
URI/object-key/checksum/ content-type fields that point to S3 or another object
store; optd does not store the binary or hide metadata in an extension bag.
Cross-pack semantic field equivalence/conflict resolution is not inferred.

## Future research only

A later extension system could consider declared namespaced JSONB fields,
generated indexes, independent versioning, and composition conflicts. None of
those storage/API terms are reserved, and implementation work must not create a
generic `extensions` bag for compatibility.
