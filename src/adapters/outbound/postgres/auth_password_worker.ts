import { hash, verify } from "npm:@node-rs/argon2";

type HashInput = {
  operation: "hash";
  password: string;
  parameters?: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    outputLen: number;
  };
};
type VerifyInput = { operation: "verify"; password: string; phc: string };

const input = JSON.parse(await new Response(Deno.stdin.readable).text()) as
  | HashInput
  | VerifyInput;
if (input.operation === "hash") {
  const parameters = input.parameters ?? {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  };
  const phc = await hash(input.password, {
    algorithm: 2,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
    outputLen: parameters.outputLen,
  });
  await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({ phc })));
} else {
  const valid = await verify(input.phc, input.password).catch(() => false);
  await Deno.stdout.write(new TextEncoder().encode(JSON.stringify({ valid })));
}
