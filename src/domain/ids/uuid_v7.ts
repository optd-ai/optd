const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastTimestamp = -1;
let sequence = 0;

/** Generates a lowercase RFC 9562 UUIDv7, monotonically within one process. */
export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError(
      "UUIDv7 timestamp must be a non-negative 48-bit integer",
    );
  }

  if (now < lastTimestamp) now = lastTimestamp;
  if (now === lastTimestamp) {
    sequence = (sequence + 1) & 0x0fff;
    if (sequence === 0) now = ++lastTimestamp;
  } else {
    lastTimestamp = now;
    const seed = new Uint16Array(1);
    crypto.getRandomValues(seed);
    sequence = seed[0] & 0x0fff;
  }

  const bytes = new Uint8Array(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  crypto.getRandomValues(bytes.subarray(8));
  bytes[6] = 0x70 | (sequence >>> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${
    hex.slice(6, 8).join("")
  }-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

export function assertUuidV7(
  value: unknown,
  label = "id",
): asserts value is string {
  if (!isUuidV7(value)) throw new TypeError(`${label} must be a UUIDv7`);
}
