import { assertEquals } from "jsr:@std/assert";
import { validatePassword } from "../../../src/domain/auth/validation.ts";
import { loadPasswordPolicy } from "../../../src/application/services/auth/human.ts";

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
