import { encode } from "npm:@toon-format/toon";

export function formatToon(value: unknown): string {
  return encode(value);
}
