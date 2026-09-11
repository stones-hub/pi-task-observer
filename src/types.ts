export type TaskState =
  | "starting"
  | "model-running"
  | "tool-running"
  | "waiting-user"
  | "retrying"
  | "compacting"
  | "settled"
  | "failed"
  | "aborted"
  | "unknown";

export type ObservationKind = "observed" | "workspace" | "process" | "inferred";
export type Confidence = "confirmed" | "high" | "medium" | "low" | "unknown";
export type Completeness = "complete" | "partial";
export type InputSource = "interactive" | "rpc" | "extension" | "follow-up" | "unknown";
export type TaskEndReason =
  | "settled"
  | "continued-by-follow-up"
  | "aborted"
  | "failed"
  | "unknown";

export type TimelineKind =
  | "task-start"
  | "task-end"
  | "segment-start"
  | "segment-end"
  | "run-start"
  | "run-end"
  | "input"
  | "steering"
  | "followup-queued"
  | "followup-delivered"
  | "model"
  | "turn-start"
  | "turn-end"
  | "tool-start"
  | "tool-update"
  | "tool-end"
  | "retry"
  | "compaction"
  | "compaction-failed"
  | "ui-wait"
  | "abort"
  | "settled"
  | "partial";

export interface TimelineEvent {
  ts: number;
  kind: TimelineKind;
  summary: string;
  detail?: string;
  toolCallId?: string;
  runId?: string;
}

export interface ExecutionSegment {
  id: string;
  runId: string;
  startedAt: number;
  endedAt?: number;
  boundaryEvidence: string;
}

export interface ToolObservation {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  resultSummary?: string;
}

export interface PendingInput {
  source: InputSource;
  streamingBehavior?: "steer" | "followUp";
  fingerprint: string;
  summary: string;
  acceptedAt: number;
}

export interface GitFileRecord {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
  fingerprint?: string;
  fingerprintPartial?: boolean;
  missing?: boolean;
  size?: number;
}

export interface WorkspaceSnapshot {
  ts: number;
  complete: boolean;
  reason?: string;
  repoRoot?: string;
  head?: string;
  branch?: string;
  files: GitFileRecord[];
  totalFiles?: number;
  filesDropped?: number;
  statusOutputTruncated?: boolean;
  startedAt: number;
  endedAt?: number;
  fromCache?: boolean;
}

export interface WorkspaceBaseline extends WorkspaceSnapshot {}

export type FileChangeKind =
  | "baseline-unchanged"
  | "baseline-further-changed"
  | "appeared"
  | "deleted"
  | "no-longer-changed"
  | "renamed"
  | "status-changed"
  | "current";

export interface FileDiffEntry {
  path: string;
  kind: FileChangeKind;
  before?: GitFileRecord;
  after?: GitFileRecord;
}

export interface ProcessCandidate {
  pid: number;
  ppid: number;
  command: string;
  cpu?: string;
  rssKb?: number;
  elapsed?: string;
  alive: boolean;
  descendantOfPi: boolean;
  confidence: Confidence;
  evidence: string[];
}

export interface ProcessSnapshot {
  ts: number;
  complete: boolean;
  reason?: string;
  platform: string;
  rootPid: number;
  candidates: ProcessCandidate[];
}

export interface ObservedTask {
  id: string;
  sessionId: string;
  cwd: string;
  source: InputSource;
  promptSummary?: string;
  sourceSummaries?: string[];
  acceptedAt?: number;
  startedAt: number;
  endedAt?: number;
  endReason?: TaskEndReason;
  state: TaskState;
  completeness: Completeness;
  completenessReasons: string[];
  executionSegments: ExecutionSegment[];
  executionSegmentsDropped: number;
  activeTools: Map<string, ToolObservation>;
  activeToolsDropped: number;
  finishedTools: ToolObservation[];
  finishedToolsDropped: number;
  sourceSummariesDropped: number;
  pendingInputsDropped: number;
  timelineDropped: number;
  timeline: TimelineEvent[];
  baseline?: WorkspaceBaseline;
  baselinePending?: boolean;
  finalWorkspace?: WorkspaceSnapshot;
  finalWorkspacePending?: boolean;
  processSnapshot?: ProcessSnapshot;
}

export interface TaskSnapshot {
  id: string;
  sessionId: string;
  cwd: string;
  source: InputSource;
  promptSummary?: string;
  sourceSummaries?: string[];
  acceptedAt?: number;
  startedAt: number;
  endedAt?: number;
  endReason?: TaskEndReason;
  state: TaskState;
  completeness: Completeness;
  completenessReasons: string[];
  executionSegments: ExecutionSegment[];
  executionSegmentsDropped: number;
  activeTools: ToolObservation[];
  activeToolsDropped: number;
  finishedTools: ToolObservation[];
  finishedToolsDropped: number;
  sourceSummariesDropped: number;
  pendingInputsDropped: number;
  timelineDropped: number;
  timeline: TimelineEvent[];
  baseline?: WorkspaceBaseline;
  baselinePending?: boolean;
  finalWorkspace?: WorkspaceSnapshot;
  finalWorkspacePending?: boolean;
  processSnapshot?: ProcessSnapshot;
}

export type StatusView = "summary" | "timeline" | "files" | "analyze" | "history" | "help";

export type ParseOk = {
  ok: true;
  view: StatusView;
  historyIndex?: 1 | 2 | 3;
};

export type ParseErr = {
  ok: false;
  error: string;
};

export type ParseResult = ParseOk | ParseErr;
