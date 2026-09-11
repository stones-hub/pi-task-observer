export type ProbeCheckStatus = "pass" | "fail" | "unverified";

export interface ProbeLogRecord {
  ts: number;
  seq: number;
  source: "extension" | "runner" | "command";
  kind: string;
  scenario?: string;
  data?: Record<string, unknown>;
}

export interface SessionSnapshot {
  sessionIdPrefix: string;
  leafIdPrefix: string | null;
  entryCount: number;
  contextCount: number;
  entryTypes: string[];
  contextRoles: string[];
  commandInEntries: boolean;
  commandInContext: boolean;
}

export interface CommandSnapshot extends SessionSnapshot {
  args: string;
  isIdle: boolean;
  hasPendingMessages: boolean;
  signalPresent: boolean;
  contextUsageTokens: number | null;
  handlerMs: number;
}

export interface ProbeCheck {
  id: string;
  title: string;
  status: ProbeCheckStatus;
  designCompatible: boolean | null;
  blockingForGate2: boolean;
  evidence: string[];
  notes?: string;
}

export interface ProbeReport {
  generatedAt: string;
  piVersion: string;
  model?: { provider: string; id: string };
  checks: ProbeCheck[];
  scenarioSummaries: Record<string, { eventKinds: string[]; notes: string[] }>;
  unverified: string[];
  incompatible: string[];
  recommendGate2: boolean;
}
