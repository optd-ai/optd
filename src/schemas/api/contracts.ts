import * as AjvModule from "npm:ajv/dist/2020.js";
import type { ErrorObject } from "npm:ajv";
import {
  type TProperties,
  type TSchema,
  Type,
} from "npm:@sinclair/typebox@0.34.38";
import { uuidV7 } from "../../domain/ids/uuid_v7.ts";
import type { StableError } from "../../domain/errors/result.ts";

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ContractValidator<T> = {
  check(value: unknown): value is T;
  issues(value: unknown): ValidationIssue[];
  assert(value: unknown): asserts value is T;
};

export type ApiMeta = { request_id: string } & Record<string, unknown>;
export type SuccessEnvelope<T> = { ok: true; data: T; meta: ApiMeta };
export type ErrorEnvelope = {
  ok: false;
  error: { code: string; message: string; details: Record<string, unknown> };
  meta: ApiMeta;
};

export function strictObject<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const AjvCtor = (AjvModule as unknown as {
  default?: new (options: Record<string, unknown>) => AjvLike;
}).default ?? (AjvModule as unknown as new (
  options: Record<string, unknown>,
) => AjvLike);
type Validate = ((value: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};
type AjvLike = { compile(schema: unknown): Validate };
const ajv = new AjvCtor({ allErrors: true, strict: true });

export function compileContract<T>(schema: TSchema): ContractValidator<T> {
  const validate = ajv.compile(schema);
  const issues = (value: unknown): ValidationIssue[] => {
    if (validate(value)) return [];
    return (validate.errors ?? []).map(toIssue).sort((left, right) =>
      left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
    );
  };
  return {
    check(value: unknown): value is T {
      return validate(value);
    },
    issues,
    assert(value: unknown): asserts value is T {
      const found = issues(value);
      if (found.length) throw new ContractValidationError(found);
    },
  };
}

export class ContractValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("request does not satisfy its contract");
    this.name = "ContractValidationError";
  }
}

export function successEnvelope<T>(
  data: T,
  meta: Record<string, unknown> = {},
): SuccessEnvelope<T> {
  return { ok: true, data, meta: { ...meta, request_id: uuidV7() } };
}

export function errorEnvelope(
  error: Pick<StableError, "code" | "message" | "details">,
  meta: Record<string, unknown> = {},
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: isRecord(error.details) ? error.details : {},
    },
    meta: { ...meta, request_id: uuidV7() },
  };
}

function toIssue(error: ErrorObject): ValidationIssue {
  const missing = error.keyword === "required" &&
      typeof error.params.missingProperty === "string"
    ? `/${escapePointer(error.params.missingProperty)}`
    : "";
  return {
    path: `${error.instancePath}${missing}` || "/",
    code: error.keyword === "additionalProperties"
      ? "unknown_field"
      : error.keyword,
    message: error.keyword === "additionalProperties"
      ? "unknown field"
      : error.message ?? "schema validation failed",
  };
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
