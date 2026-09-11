import { diffSnapshots } from "./git.ts";
import { includeProcesses } from "./formatter.ts";
import type { FileDiffEntry, ProcessSnapshot, TaskSnapshot, WorkspaceSnapshot } from "./types.ts";
import type { GitObserver } from "./git.ts";
import type { ProcessObserver } from "./process.ts";

export function workspaceForStatus(
  snapshot: TaskSnapshot,
  live?: WorkspaceSnapshot,
): { files: FileDiffEntry[]; workspace?: WorkspaceSnapshot } {
  if (snapshot.endedAt) {
    if (snapshot.finalWorkspace) {
      return {
        workspace: snapshot.finalWorkspace,
        files: diffSnapshots(snapshot.baseline, snapshot.finalWorkspace),
      };
    }
    const reason = snapshot.finalWorkspacePending
      ? "正在采集结束时工作区快照，未知"
      : "结束时工作区快照不可用，未知";
    return {
      workspace: {
        ts: snapshot.endedAt,
        complete: false,
        reason,
        files: [],
        startedAt: snapshot.endedAt,
      },
      files: [],
    };
  }
  return {
    workspace: live,
    files: live ? diffSnapshots(snapshot.baseline, live) : [],
  };
}

export async function loadExtras(
  snapshot: TaskSnapshot,
  includeGit: boolean,
  git: GitObserver,
  processes: ProcessObserver,
  gitWaitMs: number,
): Promise<{ files: FileDiffEntry[]; workspace?: WorkspaceSnapshot; processes?: ProcessSnapshot }> {
  if (!includeGit) {
    return { files: [], processes: await maybeProcesses(snapshot, processes) };
  }
  if (snapshot.endedAt) {
    return { ...workspaceForStatus(snapshot) };
  }
  const pending = git.captureCached(snapshot.cwd).catch((error) => ({
    ts: Date.now(),
    complete: false,
    reason: error instanceof Error ? error.message : String(error),
    files: [],
    startedAt: Date.now(),
  } satisfies WorkspaceSnapshot));
  const raced = await git.waitForSnapshot(snapshot.cwd, pending, gitWaitMs);
  let live = raced ?? snapshot.baseline;
  if (!raced && live) {
    live = {
      ...live,
      complete: false,
      reason: live.reason ?? "Git 查询等待超时，使用最近可用快照",
    };
  }
  const extras = workspaceForStatus(snapshot, live);
  return {
    ...extras,
    processes: await maybeProcesses(snapshot, processes),
  };
}

async function maybeProcesses(snapshot: TaskSnapshot, processes: ProcessObserver): Promise<ProcessSnapshot | undefined> {
  if (snapshot.endedAt || !includeProcesses(snapshot)) return undefined;
  return processes.snapshot(snapshot.activeTools).catch((error) => ({
    ts: Date.now(),
    complete: false,
    reason: error instanceof Error ? error.message : String(error),
    platform: process.platform,
    rootPid: process.pid,
    candidates: [],
  }));
}
