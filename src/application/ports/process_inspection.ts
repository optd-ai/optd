export type ProcessIdentity = {
  pid: number;
  parentPid: number;
  startTicks: string;
  uid: number;
  bootId: string;
};

export type ProcessInspectionFailure = "gone" | "denied" | "unsupported";

export class ProcessInspectionError extends Error {
  constructor(readonly reason: ProcessInspectionFailure, message: string) {
    super(message);
    this.name = "ProcessInspectionError";
  }
}

export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessIdentity>;
  ancestry(startPid: number, stopPid?: number): Promise<ProcessIdentity[]>;
}

export function sameProcess(
  left: ProcessIdentity,
  right: ProcessIdentity,
): boolean {
  return left.pid === right.pid && left.startTicks === right.startTicks &&
    left.uid === right.uid && left.bootId === right.bootId;
}
