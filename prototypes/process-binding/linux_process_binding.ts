export type ProcessIdentity = {
  pid: number;
  parentPid: number;
  startTicks: bigint;
  uid: number;
  bootId: string;
};

export type ProcessBinding = {
  id: string;
  anchor: ProcessIdentity;
};

export function parseProcStat(text: string): {
  pid: number;
  parentPid: number;
  startTicks: bigint;
} {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new Error("invalid /proc stat");
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 1).trim().split(/\s+/);
  // fields[0] is state (field 3); ppid is field 4; starttime is field 22.
  const parentPid = Number(fields[1]);
  const startTicks = BigInt(fields[19]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) {
    throw new Error("invalid pid fields");
  }
  return { pid, parentPid, startTicks };
}

export function parseProcUid(text: string): number {
  const match = /^Uid:\s+(\d+)/m.exec(text);
  if (!match) throw new Error("missing real uid");
  return Number(match[1]);
}

export async function inspectLinuxProcess(
  pid: number,
): Promise<ProcessIdentity> {
  const [stat, status, bootId] = await Promise.all([
    Deno.readTextFile(`/proc/${pid}/stat`),
    Deno.readTextFile(`/proc/${pid}/status`),
    Deno.readTextFile("/proc/sys/kernel/random/boot_id"),
  ]);
  return {
    ...parseProcStat(stat),
    uid: parseProcUid(status),
    bootId: bootId.trim(),
  };
}

export async function ancestry(
  startPid: number,
  stopPid?: number,
): Promise<ProcessIdentity[]> {
  const result: ProcessIdentity[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    const process = await inspectLinuxProcess(pid);
    result.push(process);
    if (
      pid === stopPid || process.parentPid <= 0 || process.parentPid === pid
    ) {
      break;
    }
    pid = process.parentPid;
  }
  if (stopPid !== undefined && !result.some((item) => item.pid === stopPid)) {
    throw new Error(`tree stop pid ${stopPid} is not in caller ancestry`);
  }
  return result;
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTicks === b.startTicks && a.uid === b.uid &&
    a.bootId === b.bootId;
}

export function selectClosestBinding(
  chain: ProcessIdentity[],
  bindings: ProcessBinding[],
): ProcessBinding | null {
  for (const process of chain) {
    const binding = bindings.find((candidate) =>
      sameProcess(process, candidate.anchor)
    );
    if (binding) return binding;
  }
  return null;
}

if (import.meta.main) {
  const stop = Deno.env.get("OPERANT_AUTH_TREE_STOP_PID");
  const chain = await ancestry(Deno.ppid, stop ? Number(stop) : undefined);
  console.log(
    JSON.stringify(
      chain,
      (_, value) => typeof value === "bigint" ? value.toString() : value,
      2,
    ),
  );
}
