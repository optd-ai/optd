import { err, ok, type Result } from "../errors/result.ts";
import type { PasswordReset } from "./model.ts";

export type PasswordResetEvent =
  | "approve"
  | "deny"
  | "cancel"
  | "redeem"
  | "complete";

export function transitionPasswordReset(
  status: PasswordReset["status"],
  event: PasswordResetEvent,
  expired = false,
): Result<PasswordReset["status"]> {
  if (expired && status !== "completed") return ok("expired");
  if (event === "approve" || event === "deny") {
    const target = event === "approve" ? "approved" : "denied";
    if (status === target) return ok(target);
    if (status === "pending") return ok(target);
    return err(stateError("request_already_decided", status));
  }
  if (event === "cancel") {
    return status === "pending"
      ? ok("cancelled")
      : err(stateError("request_not_pending", status));
  }
  if (event === "redeem" || event === "complete") {
    if (status === "approved") {
      return ok(event === "complete" ? "completed" : "approved");
    }
    if (status === "completed") {
      return err(stateError("redemption_already_used", status));
    }
    return err(stateError("password_reset_capability_invalid", status));
  }
  return err(stateError("request_not_pending", status));
}

function stateError(code: string, status: PasswordReset["status"]) {
  return {
    code,
    message: "password reset transition is invalid",
    severity: "conflict" as const,
    details: { status },
  };
}
