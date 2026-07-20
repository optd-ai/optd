import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { HistoryCursorSigner } from "../../../src/domain/history/cursor.ts";

const position = {
  createdAt: "2026-07-16T12:00:00.000Z",
  id: "019a0000-0000-7000-8000-000000000001",
};
const binding = {
  v: 1,
  project_id: "019a0000-0000-7000-8000-000000000002",
  definition: {
    kind: "resource",
    publisher: "operant",
    pack: "crm",
    name: "lead",
  },
  object_id: "019a0000-0000-7000-8000-000000000003",
  principal_id: "019a0000-0000-7000-8000-000000000004",
  authorization_id: "019a0000-0000-7000-8000-000000000005",
  authorization_root_id: "019a0000-0000-7000-8000-000000000006",
  policy_digest: "policy-one",
  limit: 1,
};

Deno.test("history cursors bind every actor, policy, definition, object, and page dimension", async () => {
  const signer = new HistoryCursorSigner("stable-master-key");
  const cursor = await signer.encode(binding, position);
  assertEquals(await signer.decode(cursor, binding), position);
  const mutations = [
    { ...binding, principal_id: "019a0000-0000-7000-8000-000000000007" },
    { ...binding, authorization_id: "019a0000-0000-7000-8000-000000000008" },
    {
      ...binding,
      authorization_root_id: "019a0000-0000-7000-8000-000000000009",
    },
    { ...binding, policy_digest: "policy-two" },
    { ...binding, project_id: "019a0000-0000-7000-8000-00000000000a" },
    { ...binding, definition: { ...binding.definition, kind: "relationship" } },
    { ...binding, definition: { ...binding.definition, publisher: "other" } },
    { ...binding, definition: { ...binding.definition, pack: "other" } },
    { ...binding, definition: { ...binding.definition, name: "other" } },
    { ...binding, object_id: "019a0000-0000-7000-8000-00000000000b" },
    { ...binding, limit: 2 },
  ];
  for (const changed of mutations) {
    await assertRejects(() => signer.decode(cursor, changed));
  }
  await assertRejects(() =>
    new HistoryCursorSigner("wrong-key").decode(cursor, binding)
  );
});

Deno.test("history cursors reject position, version, and ordinary-SHA recomputation forgeries", async () => {
  const signer = new HistoryCursorSigner("stable-master-key");
  const cursor = await signer.encode(binding, position);
  const bytes = decode(cursor);
  const payload = JSON.parse(new TextDecoder().decode(bytes.slice(32)));
  for (
    const mutate of [
      (value: Record<string, unknown>) =>
        value.created_at = "2020-01-01T00:00:00.000Z",
      (value: Record<string, unknown>) =>
        value.id = "019a0000-0000-7000-8000-00000000000c",
      (value: Record<string, unknown>) => value.v = 2,
    ]
  ) {
    const changed = structuredClone(payload);
    mutate(changed);
    const encodedPayload = new TextEncoder().encode(JSON.stringify(changed));
    const ordinarySha = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encodedPayload),
    );
    const forged = new Uint8Array(32 + encodedPayload.length);
    forged.set(ordinarySha);
    forged.set(encodedPayload, 32);
    await assertRejects(() => signer.decode(encode(forged), binding));
  }
});

Deno.test("history cursors reject noncanonical base64url aliases", async () => {
  const signer = new HistoryCursorSigner("stable-master-key");
  let canonical = "";
  let alias: string | null = null;
  let encodedBinding: typeof binding = binding;
  for (let suffix = 0; suffix < 4 && alias === null; suffix++) {
    encodedBinding = {
      ...binding,
      policy_digest: `policy-${"x".repeat(suffix)}`,
    };
    canonical = await signer.encode(encodedBinding, position);
    alias = trailingBitAlias(canonical);
  }
  if (alias === null) throw new Error("expected an aliasable cursor length");
  assertEquals(decode(alias), decode(canonical));
  await assertRejects(() => signer.decode(alias, encodedBinding));
  for (
    const malformed of [`${canonical}=`, ` ${canonical}`, `${canonical}\n`]
  ) {
    await assertRejects(() => signer.decode(malformed, encodedBinding));
  }
});

Deno.test("history cursor key configuration has no fallback", () => {
  assertThrows(() => new HistoryCursorSigner(" "));
});

function decode(cursor: string) {
  const raw = atob(
    cursor.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((cursor.length + 3) % 4),
  );
  return Uint8Array.from(raw, (value) => value.charCodeAt(0));
}
const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function trailingBitAlias(value: string): string | null {
  const unusedBits = value.length % 4 === 2
    ? 4
    : value.length % 4 === 3
    ? 2
    : 0;
  if (unusedBits === 0) return null;
  const last = base64UrlAlphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${base64UrlAlphabet[last | 1]}`;
}
function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
