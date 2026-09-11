import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceForStatus } from "../src/status-query.ts";
import { fixtureSnapshot } from "./helpers.ts";

test("历史任务只用结束快照，未就绪不得用当前 workspace 或 baseline 冒充", () => {
  const baseline = {
    ts: 1,
    complete: true,
    files: [{ path: "old.ts", status: " M", staged: false, unstaged: true, untracked: false }],
    startedAt: 1,
  };
  const live = {
    ts: 9,
    complete: true,
    files: [{ path: "live.ts", status: "??", staged: false, unstaged: false, untracked: true }],
    startedAt: 9,
  };
  const pending = workspaceForStatus(fixtureSnapshot({
    endedAt: 5,
    baseline,
    finalWorkspacePending: true,
  }), live);
  assert.equal(pending.files.length, 0);
  assert.match(pending.workspace?.reason ?? "", /正在采集/);
  assert.equal(pending.workspace?.files.some((file) => file.path === "live.ts"), false);
  assert.equal(pending.workspace?.files.some((file) => file.path === "old.ts"), false);

  const unknown = workspaceForStatus(fixtureSnapshot({
    endedAt: 5,
    baseline,
    finalWorkspacePending: false,
  }), live);
  assert.match(unknown.workspace?.reason ?? "", /未知/);
  assert.equal(unknown.files.length, 0);

  const finalWorkspace = {
    ts: 6,
    complete: true,
    files: [{ path: "done.ts", status: "??", staged: false, unstaged: false, untracked: true }],
    startedAt: 6,
  };
  const ready = workspaceForStatus(fixtureSnapshot({
    endedAt: 5,
    baseline,
    finalWorkspace,
  }), live);
  assert.ok(ready.files.some((item) => item.path === "done.ts"));
  assert.equal(ready.workspace, finalWorkspace);
  assert.equal(ready.files.some((item) => item.path === "live.ts"), false);
});
