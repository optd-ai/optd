import { hash, verify } from "npm:@node-rs/argon2";

const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as
  | { operation: "hash"; password: string }
  | { operation: "verify"; password: string; phc: string };
if (input.operation === "hash") {
  const phc = await hash(input.password, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
  await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({ phc })));
} else {
  const valid = await verify(input.phc, input.password).catch(() => false);
  await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({ valid })));
}
