// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { attemptDto, deliveryDto } from "../../../src/domain/outbox/dto.ts";

Deno.test("outbox DTOs use strict allowlists and redact all credential material", () => {
  const hostile = {
    id: "delivery",
    status: "dead_letter",
    hook_identity: "acme/pack:notify",
    last_error_code: "hook_secret_unavailable",
    ciphertext: "cipher",
    nonce: "nonce",
    key_id: "key",
    secret_value: "plaintext",
    token: "bearer",
    env: { SECRET: "plaintext" },
    pinned_grants_json: [{ secret_id: "secret" }],
    stack: "stack",
    sql: "select secret",
  };
  assertEquals(deliveryDto(hostile), {
    id: "delivery",
    hook_identity: "acme/pack:notify",
    status: "dead_letter",
    last_error_code: "hook_secret_unavailable",
  });
  assertEquals(
    attemptDto({
      id: "attempt",
      outcome: "dead_letter",
      error_code: "hook_secret_unavailable",
      grant_evidence_json: [{ value: "plaintext" }],
      logs: "plaintext",
    }),
    {
      id: "attempt",
      outcome: "dead_letter",
      error_code: "hook_secret_unavailable",
      state: "completed",
      grants: [{}],
    },
  );
  assertEquals(
    attemptDto({
      id: "attempt-safe",
      completed_at: "2026-01-01T00:00:00Z",
      worker_instance_id: "worker",
      hook_revision_id: "hook",
      hook_execution_id: "execution",
      grant_evidence_json: [{
        grant_id: "grant",
        slot: "token",
        secret_id: "stable-secret",
        value_version: 2,
        env: "PROVIDER_TOKEN",
        name: "provider",
        value: "plaintext",
        ciphertext: "ciphertext",
        key_id: "key",
      }],
    }),
    {
      id: "attempt-safe",
      worker_instance_id: "worker",
      hook_revision_id: "hook",
      completed_at: "2026-01-01T00:00:00Z",
      hook_execution_id: "execution",
      state: "completed",
      grants: [{
        grant_id: "grant",
        slot: "token",
        secret_id: "stable-secret",
        value_version: 2,
      }],
    },
  );
});
