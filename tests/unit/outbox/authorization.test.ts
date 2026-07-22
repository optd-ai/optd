// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { sanitizeOutboxAuthorizationResult } from "../../../src/application/services/process_outbox.ts";

Deno.test("outbox authorization errors expose only stable noncredential details", () => {
  assertEquals(
    sanitizeOutboxAuthorizationResult({
      ok: false,
      error: {
        code: "policy_denied",
        message: "denied",
        severity: "authorization",
        details: {
          auth_context_id: "varying-context",
          principal_id: "principal",
          session_id: "session",
          request_id: "request",
          token: "token",
          action: "outbox.inspect",
          boundary: { type: "system" },
          resource: "system:outbox",
          effective_roles: [],
          checked_policies: [],
        },
      },
    }),
    {
      ok: false,
      error: {
        code: "policy_denied",
        message: "denied",
        severity: "authorization",
        details: {
          action: "outbox.inspect",
          boundary: { type: "system" },
          checked_policies: [],
          effective_roles: [],
          resource: "system:outbox",
        },
      },
    },
  );
});
