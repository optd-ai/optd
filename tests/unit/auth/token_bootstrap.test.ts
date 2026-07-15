import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "jsr:@std/assert";
import {
  beginBootstrap,
  completeBootstrap,
} from "../../../src/domain/auth/bootstrap_state.ts";
import {
  constantTimeDigestEqual,
  opaqueToken,
  tokenDigest,
} from "../../../src/domain/auth/token.ts";
import { strictObject } from "../../../src/adapters/inbound/http-hono/auth_routes.ts";
import { makeBootstrapService } from "../../../src/application/services/auth/bootstrap.ts";
import type { AuthRepository } from "../../../src/application/ports/authentication.ts";

Deno.test("opaque credentials hash deterministically without retaining plaintext", async () => {
  const token = opaqueToken();
  assertMatch(token, /^[A-Za-z0-9_-]{43}$/);
  const digest = await tokenDigest(token);
  assertMatch(digest, /^[0-9a-f]{64}$/);
  assertNotEquals(digest, token);
  assert(!digest.includes(token));
  assert(constantTimeDigestEqual(digest, await tokenDigest(token)));
  assert(!constantTimeDigestEqual(digest, await tokenDigest(`${token}x`)));
});

Deno.test("bootstrap transition is one-way with stable errors", () => {
  const started = beginBootstrap("bootstrap_required");
  assert(started.ok);
  const completed = completeBootstrap(started.value);
  assert(completed.ok);
  assertEquals(completed.value, "active");
  const replay = beginBootstrap("active");
  assert(!replay.ok);
  assertEquals(replay.error.code, "bootstrap_already_completed");
  const invalid = completeBootstrap("bootstrap_required");
  assert(!invalid.ok);
  assertEquals(invalid.error.code, "bootstrap_transition_invalid");
});

Deno.test("bootstrap DTO and service reject unknown and invalid input strictly", async () => {
  assert(strictObject(
    { username: "admin", password: "password", display_name: "Admin" },
    ["username", "password", "display_name"],
    ["username", "password"],
  ));
  assert(
    !strictObject(
      { username: "admin", password: "password", actor: "root" },
      ["username", "password", "display_name"],
      ["username", "password"],
    ),
  );
  assert(
    !strictObject(
      { slug: "sales", display_name: "Sales", owner: "caller" },
      ["slug", "display_name", "description"],
      ["slug", "display_name"],
    ),
  );
  let called = false;
  const repository: AuthRepository = {
    bootstrapRequired: () => Promise.resolve(true),
    authenticate: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "credential_invalid",
          message: "invalid",
          severity: "authentication",
          details: {},
        },
      }),
    bootstrap: () => {
      called = true;
      throw new Error("must not be called");
    },
  };
  const result = await makeBootstrapService(repository).initialize({
    bootstrapToken: "token",
    username: "Bad Username",
    displayName: "Admin",
    password: "short",
  });
  assert(!result.ok);
  assertEquals(result.error.code, "validation_failed");
  assertEquals(called, false);
});
