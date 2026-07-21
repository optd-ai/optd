export function validateFieldMap(
  input: Record<string, unknown>,
  fields: Record<string, unknown>,
  requireRequired = true,
): string | null {
  const unknown = Object.keys(input).find((name) =>
    !Object.hasOwn(fields, name)
  );
  if (unknown) return `Field '${unknown}' is not declared`;
  for (const [name, descriptor] of Object.entries(fields)) {
    if (
      requireRequired && record(descriptor).required === true &&
      !Object.hasOwn(input, name)
    ) return `Required field '${name}' is missing`;
    if (Object.hasOwn(input, name)) {
      const issue = validateFieldValue(name, input[name], record(descriptor));
      if (issue) return issue;
    }
  }
  return null;
}

export function validateFieldValue(
  name: string,
  value: unknown,
  field: Record<string, unknown>,
): string | null {
  const invalid = (reason: string) => `Field '${name}' ${reason}`;
  if (value === null) return invalid("is not nullable");
  const type = String(field.type);
  if (type === "string") {
    if (typeof value !== "string") return invalid("has the wrong type");
    const length = [...value].length;
    if (field.minLength !== undefined && length < Number(field.minLength)) {
      return invalid("is shorter than its minimum length");
    }
    if (field.maxLength !== undefined && length > Number(field.maxLength)) {
      return invalid("is longer than its maximum length");
    }
    if (Array.isArray(field.enum) && !field.enum.includes(value)) {
      return invalid("is not an allowed value");
    }
    if (field.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return invalid("is not a valid email");
    }
    if (field.format === "uri") {
      try {
        const uri = new URL(value);
        if (!uri.protocol || /\s/.test(value)) {
          return invalid("is not a valid URI");
        }
      } catch {
        return invalid("is not a valid URI");
      }
    }
    if (
      (field.format === "uuid" || field.ref !== undefined) &&
      !UUID_V7.test(value)
    ) return invalid("must be a lowercase UUIDv7 reference");
    return null;
  }
  if (type === "integer") {
    if (!Number.isSafeInteger(value)) return invalid("has the wrong type");
    if (
      field.minimum !== undefined && (value as number) < Number(field.minimum)
    ) return invalid("is below its minimum");
    if (
      field.maximum !== undefined && (value as number) > Number(field.maximum)
    ) return invalid("is above its maximum");
    return null;
  }
  if (type === "decimal") {
    if (typeof value !== "string" || !DECIMAL.test(value) || value === "-0") {
      return invalid(
        typeof value === "string"
          ? "is not a canonical decimal"
          : "has the wrong type",
      );
    }
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const [whole, fraction = ""] = unsigned.split(".");
    if (
      field.precision !== undefined &&
      whole.replace(/^0$/, "").length + fraction.length >
        Number(field.precision)
    ) return invalid("exceeds decimal precision");
    if (field.scale !== undefined && fraction.length > Number(field.scale)) {
      return invalid("exceeds decimal scale");
    }
    if (
      typeof field.minimum === "string" &&
      compareDecimal(value, field.minimum) < 0
    ) return invalid("is below its minimum");
    if (
      typeof field.maximum === "string" &&
      compareDecimal(value, field.maximum) > 0
    ) return invalid("is above its maximum");
    return null;
  }
  if (type === "boolean") {
    return typeof value === "boolean" ? null : invalid("has the wrong type");
  }
  if (type === "date") {
    if (typeof value !== "string") return invalid("has the wrong type");
    if (!canonicalDate(value)) return invalid("is not a canonical date");
    if (typeof field.minimum === "string" && value < field.minimum) {
      return invalid("is below its minimum");
    }
    if (typeof field.maximum === "string" && value > field.maximum) {
      return invalid("is above its maximum");
    }
    return null;
  }
  if (type === "timestamp") {
    if (typeof value !== "string") return invalid("has the wrong type");
    if (!canonicalTimestamp(value)) {
      return invalid("is not a canonical UTC timestamp");
    }
    if (typeof field.minimum === "string" && value < field.minimum) {
      return invalid("is below its minimum");
    }
    if (typeof field.maximum === "string" && value > field.maximum) {
      return invalid("is above its maximum");
    }
    return null;
  }
  return invalid("has an unsupported type");
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function canonicalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}
function canonicalTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString() ===
    (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
export function compareDecimal(left: string, right: string): number {
  const parse = (value: string) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(
      ".",
    );
    return { negative, whole: whole.replace(/^0+(?=\d)/, ""), fraction };
  };
  const a = parse(left), b = parse(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  let magnitude = a.whole.length - b.whole.length;
  if (!magnitude) magnitude = a.whole.localeCompare(b.whole);
  if (!magnitude) {
    const width = Math.max(a.fraction.length, b.fraction.length);
    magnitude = a.fraction.padEnd(width, "0").localeCompare(
      b.fraction.padEnd(width, "0"),
    );
  }
  return (a.negative ? -1 : 1) * Math.sign(magnitude);
}
