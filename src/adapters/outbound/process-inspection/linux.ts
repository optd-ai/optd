import {
  type ProcessIdentity,
  ProcessInspectionError,
  type ProcessInspector,
  sameProcess,
} from "../../../application/ports/process_inspection.ts";

export function parseProcStat(text: string): {
  pid: number;
  parentPid: number;
  startTicks: string;
} {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close <= open) throw new Error("invalid /proc stat");
  const pid = Number(text.slice(0, open).trim());
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTicks = fields[19];
  if (
    !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 || !startTicks || !/^\d+$/.test(startTicks)
  ) throw new Error("invalid /proc stat fields");
  return { pid, parentPid, startTicks };
}

export function parseProcUid(text: string): number {
  const match = /^Uid:\s+(\d+)(?:\s|$)/m.exec(text);
  const uid = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("invalid real uid");
  }
  return uid;
}

export class LinuxProcessInspector implements ProcessInspector {
  constructor(private readonly procRoot = "/proc") {}

  async inspect(pid: number): Promise<ProcessIdentity> {
    try {
      const [stat, status, bootId] = await Promise.all([
        Deno.readTextFile(`${this.procRoot}/${pid}/stat`),
        Deno.readTextFile(`${this.procRoot}/${pid}/status`),
        Deno.readTextFile(`${this.procRoot}/sys/kernel/random/boot_id`),
      ]);
      return {
        ...parseProcStat(stat),
        uid: parseProcUid(status),
        bootId: bootId.trim(),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new ProcessInspectionError("gone", `process ${pid} is gone`);
      }
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new ProcessInspectionError(
          "denied",
          `process ${pid} cannot be inspected`,
        );
      }
      throw error;
    }
  }

  async ancestry(
    startPid: number,
    stopPid?: number,
  ): Promise<ProcessIdentity[]> {
    const result: ProcessIdentity[] = [];
    const seen = new Set<number>();
    let pid = startPid;
    while (pid > 0 && !seen.has(pid)) {
      seen.add(pid);
      const identity = await this.inspect(pid);
      result.push(identity);
      if (
        pid === stopPid || identity.parentPid <= 0 || identity.parentPid === pid
      ) break;
      pid = identity.parentPid;
    }
    if (stopPid !== undefined && result.at(-1)?.pid !== stopPid) {
      throw new ProcessInspectionError(
        "denied",
        `tree stop pid ${stopPid} is not in caller ancestry`,
      );
    }
    // /proc is not an atomic snapshot. Reject a walk if its starting process changed.
    if (
      result.length && !sameProcess(result[0], await this.inspect(startPid))
    ) {
      throw new ProcessInspectionError(
        "gone",
        `process ${startPid} changed during inspection`,
      );
    }
    return result;
  }
}

export function platformProcessInspector(): ProcessInspector {
  if (Deno.build.os !== "linux") {
    throw new ProcessInspectionError(
      "unsupported",
      "process_inspection_unsupported",
    );
  }
  return new LinuxProcessInspector();
}
