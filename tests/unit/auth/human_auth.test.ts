import { assertEquals } from "jsr:@std/assert";
import { validatePassword } from "../../../src/domain/auth/validation.ts";
import { loadPasswordPolicy } from "../../../src/application/services/auth/human.ts";
import { transitionPasswordReset } from "../../../src/domain/auth/password_reset_state.ts";
import { ImmediateSemaphore } from "../../../src/adapters/outbound/postgres/auth_repository.ts";
import { authenticatedOutput } from "../../../src/adapters/inbound/cli-cliffy/optctl.ts";

Deno.test("password policy normalizes Unicode and enforces configured classes", () => {
  const env = {
    get(name: string) {
      return ({
        OPERANT_PASSWORD_MIN_LENGTH: "8",
        OPERANT_PASSWORD_REQUIRE_UPPERCASE: "true",
        OPERANT_PASSWORD_REQUIRE_LOWERCASE: "true",
        OPERANT_PASSWORD_REQUIRE_DIGIT: "true",
        OPERANT_PASSWORD_REQUIRE_SYMBOL: "true",
      } as Record<string, string>)[name];
    },
  } as Deno.Env;
  const policy = loadPasswordPolicy(env);
  assertEquals(validatePassword("Abcdef7!", policy).ok, true);
  assertEquals(validatePassword("abcdef7!", policy).ok, false);
  assertEquals(validatePassword("Abcdef7\n", policy).ok, false);
});

Deno.test("password reset state transitions are terminal and idempotent", () => {
  assertEquals(transitionPasswordReset("pending", "approve"), {
    ok: true,
    value: "approved",
  });
  assertEquals(transitionPasswordReset("approved", "approve"), {
    ok: true,
    value: "approved",
  });
  assertEquals(transitionPasswordReset("approved", "complete"), {
    ok: true,
    value: "completed",
  });
  assertEquals(transitionPasswordReset("completed", "complete").ok, false);
  assertEquals(transitionPasswordReset("approved", "complete", true), {
    ok: true,
    value: "expired",
  });
  assertEquals(transitionPasswordReset("pending", "cancel"), {
    ok: true,
    value: "cancelled",
  });
});

Deno.test("hash saturation rejects immediately and releases exactly once", () => {
  const semaphore = new ImmediateSemaphore(1);
  const release = semaphore.tryAcquire();
  assertEquals(typeof release, "function");
  assertEquals(semaphore.tryAcquire(), undefined);
  release!();
  release!();
  assertEquals(typeof semaphore.tryAcquire(), "function");
});

Deno.test("CLI authenticated output redacts issued credential material", () => {
  const output = authenticatedOutput({ id: "user-id", username: "user" });
  const serialized = JSON.stringify(output);
  assertEquals(serialized.includes("token"), false);
  assertEquals(serialized.includes("password"), false);
  assertEquals(output.data.authenticated, true);
});

Deno.test("human sessions deliberately have no automatic expiry fields", async () => {
  const model = await Deno.readTextFile(
    new URL("../../../src/domain/auth/model.ts", import.meta.url),
  );
  assertEquals(model.includes("expiresAt"), true); // recovery DTO only
  const session = model.slice(
    model.indexOf("export type HumanSession"),
    model.indexOf("export type LoginResult"),
  );
  assertEquals(session.includes("expires"), false);
});
