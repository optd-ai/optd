# Chunk 9: Secrets and encryption at rest

## Deliverable
Support encrypted platform secrets and safe hook secret injection.

## Scope
- Implement crypto adapter for application-level encryption/decryption.
- Implement `platform_secrets` table/repository and master-key behavior using `OPERANT_SECRET_MASTER_KEY` or equivalent.
- Fail closed if encrypted secrets exist and key is missing for decrypting paths.
- Implement secret policy checks and audited super_admin/admin bootstrap as needed.
- Add secret routes `GET /secrets`, `POST /secrets`, `DELETE /secrets/{name}`.
- Add `optctl secret list/set/delete` if CLI inclusion is straightforward; otherwise provide scenario harness calls and leave CLI exposure documented.
- Integrate hook secret resolution/injection into narrow env vars and Deno `--allow-env`.

## Validation requirements
- Unit tests for encrypt/decrypt, wrong key failure, and ciphertext != plaintext.
- Integration test inspects DB/audit/log fields to ensure plaintext is not stored or logged.
- Live scenario: set a secret as super_admin/admin, run a hook that requires it, verify declared env var only and successful output; missing secret/key fails before spawn.
- Verify policy engine participates in secret access.
