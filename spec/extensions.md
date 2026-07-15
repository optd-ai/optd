# Extensions

## MVP decision

A separate extension namespace/payload/schema composition system is not in MVP.
Runtime objects accept only fields declared by their exact active pack resource
revision; undeclared metadata is rejected and cannot bypass schema, policy,
history, query, or migration behavior.

Operators extend a domain by authoring/applying a normal publisher-qualified pack
revision. Added fields and relationships use ordinary strict definitions,
changesets, policy, generated Postgres schema, and pack migration classification.
For file-like data in MVP, a pack declares ordinary URI/object-key/checksum/
content-type fields that point to S3 or another object store; Operant does not
store the binary or hide metadata in an extension bag.
Cross-pack semantic field equivalence/conflict resolution is not inferred.

## Future research only

A later extension system could consider declared namespaced JSONB fields,
generated indexes, independent versioning, and composition conflicts. None of
those storage/API terms are reserved, and implementation work must not create a
generic `extensions` bag for compatibility.
