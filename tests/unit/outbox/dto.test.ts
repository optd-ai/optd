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
    },
  );
});
