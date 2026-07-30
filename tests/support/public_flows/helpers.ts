// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
} from "../public_flow_contract.ts";
import type { CompletePublicFlowBackend } from "./backend.ts";

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export async function runJson(
  harness: CompletePublicFlowBackend,
  args: readonly string[],
  input: unknown,
  launcher?: PublicFlowLauncher,
): Promise<PublicFlowCommandResult> {
  const path = await harness.materializeInput("changeset", input);
  return await (launcher ?? harness).runCli([...args, "--file", path]);
}

export async function loginProcess(
  harness: CompletePublicFlowBackend,
  input: Readonly<{ username: string; password: string }>,
) {
  return await harness.loginProcess(input.username, input.password);
}

export function assertNoSecretLeaks(text: string, values: readonly string[]) {
  for (const value of values) {
    assertEquals(text.includes(value), false, `leaked ${value}`);
  }
}
