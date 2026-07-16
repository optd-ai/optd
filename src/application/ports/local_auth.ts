import type { ProcessIdentity } from "./process_inspection.ts";

export type LocalCredentialKind = "human" | "agent" | "authorization_request";

export type LocalCredential = {
  sessionId: string;
  token: string;
  kind: LocalCredentialKind;
  authorizationId?: string;
  anchor?: ProcessIdentity;
};

export type LocalBinding = {
  schema_version: 1;
  record_type: "process_binding";
  id: string;
  origin: string;
  session_id: string;
  anchor: ProcessIdentity;
  created_at: string;
};

export type DoctorFinding = {
  severity: "info" | "warning" | "error" | "unsafe";
  code: string;
  path: string;
  repairable: boolean;
  planned_action?: string;
};

export type DoctorReport = {
  healthy: boolean;
  findings: DoctorFinding[];
  fixes: Array<{ code: string; path: string; action: string }>;
};

export interface LocalCredentialStore {
  select(
    origin: string,
    parentPid: number,
    stopPid?: number,
  ): Promise<LocalCredential | null>;
  requestCredential(origin: string): Promise<LocalCredential | null>;
  doctor(fix?: boolean): Promise<DoctorReport>;
}
