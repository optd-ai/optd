import { err, ok, type Result } from "../errors/result.ts";

export type BootstrapState =
  | "bootstrap_required"
  | "bootstrap_in_progress"
  | "active";

export function beginBootstrap(
  state: BootstrapState,
): Result<"bootstrap_in_progress"> {
  if (state !== "bootstrap_required") {
    return err({
      code: "bootstrap_already_completed",
      message: "bootstrap has already been completed",
      severity: "conflict",
      details: {},
    });
  }
  return ok("bootstrap_in_progress");
}

export function completeBootstrap(
  state: BootstrapState,
): Result<"active"> {
  if (state !== "bootstrap_in_progress") {
    return err({
      code: "bootstrap_transition_invalid",
      message: "bootstrap is not in progress",
      severity: "conflict",
      details: { state },
    });
  }
  return ok("active");
}
