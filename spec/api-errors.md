<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-api-errors; contract: 1; input: sha256:7c2df2d5867763e0af7987bb338cad1bea24fb024c18fa1e0919e33a2807366f -->

# API Response and Error Contract

Generated exact-contract projection imported into project-model/model.json from the reviewed api-errors.md source.

## Exact migrated contract

<a id="obj-com-exact-api-errors-v1"></a>

### Exact v1 contract — API Response and Error Contract

**Migration provenance.** Exact normative contract imported from `spec/api-errors.md` at `sha256:bd20733688be80787078a03a14648af699713c688331bc4d51465fcb1c65587f`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Decision

All `/api/v1` JSON routes use one envelope. Topic specs define stable domain
codes; this file freezes their transport shape and HTTP classification.

## Success

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "019b..."
  }
}
```

- `data` is always present and is the route DTO, including arrays/scalars when
  appropriate.
- `meta.request_id` is a server-issued UUIDv7 and is always present.
- Pagination cursors/counts belong in `meta`; domain lifecycle facts belong in
  `data`.
- Successful actions that create a durable resource use `201`; ordinary reads
  and transitions use `200`. Empty successful deletions/cancellations still use
  the envelope with `data: null`, not HTTP 204.

## Failure

```json
{
  "ok": false,
  "error": {
    "code": "object_version_conflict",
    "message": "the staged object version is no longer current",
    "details": {
      "stage_id": "019b...",
      "operation_id": "019c..."
    }
  },
  "meta": {
    "request_id": "019d..."
  }
}
```

- `code` is a stable lowercase snake-case machine identifier.
- `message` is safe concise text and is not a stable matching surface.
- `details` is an object, always present, and has a code-specific schema.
- Stack traces, SQL, secret names/values, hook environment, token material,
  filesystem paths, and hidden object/policy facts are never returned.
- Validation failures use `details.issues[]` with stable `path`, `code`, and
  safe `message`, sorted by path then code.
- `details.help[]` is allowed only for 400/422 repair guidance generated from
  validated AXI templates. Authentication/authorization/not-found/conflict/
  internal errors never add role, grant, credential, or escalation commands.

## HTTP classification

| HTTP | Meaning                                                                                                | Representative codes                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 400  | malformed JSON/transport shape or cursor mismatch                                                      | `bad_request`, `invalid_json`, `invalid_cursor`                        |
| 401  | no valid credential/session                                                                            | `authentication_required`, `credential_invalid`, `session_revoked`     |
| 403  | authenticated but current authority denies                                                             | `policy_denied`, `authorization_insufficient`                          |
| 404  | authorized lookup cannot find target                                                                   | `not_found`                                                            |
| 409  | current durable state conflicts with the requested transition                                          | stale-stage, object-version, already-terminal, grant/version conflicts |
| 410  | a one-time time-bounded recovery/redemption resource expired                                           | auth recovery/reset expiration codes                                   |
| 422  | well-formed request fails schema/domain/hook/migration validation, including unknown fields or aliases | `validation_failed`, `hook_rejected`, blocked migration codes          |
| 423  | required transactional lock was not acquired by the configured deadline                                | `commit_busy`, `pack_install_busy`                                     |
| 429  | authentication or general rate limit                                                                   | `rate_limited` plus `Retry-After`                                      |
| 500  | unexpected internal failure                                                                            | `internal_error`                                                       |
| 503  | required dependency unavailable or server draining/not ready                                           | `unavailable` plus optional `Retry-After`                              |

A route must not select status by parsing message text. Each stable code maps to
exactly one status in a central registry.

## Existence and authorization

For object/definition lookups, the server first evaluates whether the caller may
read within the requested boundary without revealing the target. Unauthorized
and hidden targets return the same safe `404 not_found` where revealing
existence would leak information. Routes that describe the caller's own failed
requested mutation may return `403 policy_denied` with the safe explanation
contract.

## Retries

- `409` is not automatically retryable unless the code-specific contract says to
  create a fresh stage or repeat an idempotent terminal read.
- `423`, `429`, and `503` may include `Retry-After`.
- Commit's bounded internal deadlock/serialization retry is invisible unless the
  final attempt fails.
- Authentication-request creation follows its explicit idempotency contract.
  Immutable changeset stage creation intentionally has no idempotency key.

## CLI rendering

`optctl --json` emits this envelope unchanged. Default TOON preserves every
field. Human stderr may summarize `error.code` and `error.message`, but exit
status and automation must use the structured response; denial output must not
add escalation coaching.
