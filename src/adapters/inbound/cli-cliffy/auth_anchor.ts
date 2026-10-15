import {
  type ProcessIdentity,
  type ProcessInspector,
  sameProcess,
} from "../../../application/ports/process_inspection.ts";

import { isAgentHarness } from "../../../domain/auth/process_boundary.ts";
const shells = new Set(["bash", "zsh", "sh", "dash", "fish", "nu"]);
const basename = (path: string) => path.split("/").at(-1)!.replace(/^-/, "");

export function isSessionBoundary(argv: string[]): boolean {
  if (!argv.length) return false;
  const name = basename(argv[0]);
  if (isAgentHarness(argv)) return true;
  if (shells.has(name)) {
    // A command/script shell is a wrapper, not the interactive owner.
    return argv.slice(1).every((arg) => arg.startsWith("-")) &&
      !argv.slice(1).some((arg) =>
        /^-[^-]*c/.test(arg) || arg === "--commands" || arg === "--command" ||
        arg === "--stdin" || arg === "-s"
      );
  }
  return false;
}

export async function resolveProcessAnchor(
  inspector: ProcessInspector,
  startPid: number,
  options: {
    stopPid?: number;
    explicitPid?: number;
    nearestBinding?: ProcessIdentity;
  } = {},
): Promise<ProcessIdentity> {
  const chain = await inspector.ancestry(startPid, options.stopPid);
  if (!chain.length) {
    throw new Error("auth_anchor_unresolved: empty process ancestry");
  }
  if (
    options.explicitPid !== undefined &&
    !chain.some((p) => p.pid === options.explicitPid)
  ) {
    throw new Error(
      "auth_anchor_invalid: explicit PID is outside the allowed caller ancestry",
    );
  }
  let selected: ProcessIdentity | undefined;
  for (const identity of chain) {
    if (
      identity.uid !== chain[0].uid || identity.bootId !== chain[0].bootId ||
      identity.pid <= 1
    ) break;
    // Never widen a nearer grant, even if its authorization is insufficient.
    if (
      (options.nearestBinding &&
        sameProcess(identity, options.nearestBinding)) ||
      identity.pid === options.explicitPid ||
      identity.pid === options.stopPid ||
      isSessionBoundary(await inspector.command(identity.pid))
    ) {
      selected = identity;
      break;
    }
    const argv = await inspector.command(identity.pid);
    const name = basename(argv[0] ?? "");
    if (
      options.explicitPid === undefined && !shells.has(name) &&
      !["env", "timeout", "setsid", "nice", "nohup", "stdbuf"].includes(name)
    ) {
      throw new Error(
        "auth_anchor_unresolved: unrecognized launcher boundary; the launcher must set OPTD_AUTH_ANCHOR_PID to its own PID",
      );
    }
  }
  if (!selected) {
    throw new Error(
      "auth_anchor_unresolved: no persistent harness or interactive shell found; use a launcher that sets OPTD_AUTH_ANCHOR_PID to its own PID",
    );
  }
  // Classification is a selection policy, not proof of process identity.
  // Rewalk to validate liveness, identity, topology and isolate bounds.
  const verified = await inspector.ancestry(startPid, options.stopPid);
  if (
    chain.length !== verified.length ||
    chain.some((p, i) =>
      !sameProcess(p, verified[i]) || p.parentPid !== verified[i].parentPid
    )
  ) {
    throw new Error(
      "auth_anchor_changed: process ancestry changed during resolution",
    );
  }
  return selected;
}
