import { hash } from "npm:@node-rs/argon2";

const password = await new Response(Deno.stdin.readable).text();
const phc = await hash(password, {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});
await Deno.stdout.write(new TextEncoder().encode(phc));
