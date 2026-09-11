# Gate 1 动态事件探针

本目录只服务 v0.1 的 **Gate 1**：验证真实 Pi 生命周期与非干扰边界。  
它不是产品 Extension，不实现 `/status`、Git、进程观察或 AI 分析。

## 它做什么

最小 Extension `extension.ts` 注册 `/probe-status`，并把脱敏后的事件元数据写入 JSONL：

- `input` / `before_agent_start` / `agent_start` / `agent_end` / `agent_settled`
- `turn_*`、`message_*`（不记录 token 正文）、`tool_execution_*`（仅 toolCallId 前缀、工具名、命令摘要）
- `context` 只记录条数、role、是否包含 `/probe-status`
- 命令 handler 记录 `isIdle`、pending、session/context 快照

证据默认写到仓库外：

```text
/tmp/pi-task-observer-probe/<timestamp>/
```

不记录完整 Prompt、完整模型响应、环境变量、凭证或无界工具输出。

## 自动实验（推荐）

在本机已安装 `pi`（当前调查版本 `0.85.1`）且已配置模型认证的前提下：

```bash
cd /Users/yelei/data/code/repos/pi-task-observer/dev/probe
mkdir -p node_modules/@earendil-works
ln -sfn /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent \
  node_modules/@earendil-works/pi-coding-agent
node --test --experimental-strip-types tests/*.test.ts
PI_TASK_OBSERVER_PROBE_DIR=/tmp/pi-task-observer-probe/manual-run \
  node --experimental-strip-types run.ts
node --experimental-strip-types analyze.ts /tmp/pi-task-observer-probe/manual-run/events.jsonl
```

`run.ts` 使用 Pi SDK 的 `createAgentSession`（与 TUI/RPC 同一 `AgentSession`），并按 TUI 方式调用：

```ts
session.prompt("/probe-status")
session.prompt(text, { streamingBehavior: "steer" })
session.prompt(text, { streamingBehavior: "followUp" })
```

不会调用 `setFollowUpMode()` / `setSteeringMode()`，避免写入 `~/.pi/agent/settings.json`。模式只改当前 `session.agent.*`。工作区是临时目录，Session 仅内存，结束时删除临时工作区。

## 手动 TUI 对照

不要在本仓库根目录加载全局 Extension。使用临时目录：

```bash
WS=$(mktemp -d /tmp/pi-task-observer-probe-tui-XXXX)
echo probe > "$WS/README.txt"
export PI_TASK_OBSERVER_PROBE_LOG=/tmp/pi-task-observer-probe/tui.jsonl
pi --no-extensions --no-skills --no-context-files --no-prompt-templates \
  --thinking off -e /Users/yelei/data/code/repos/pi-task-observer/dev/probe/extension.ts \
  -- "$WS"
```

建议场景：空闲 `/probe-status`；普通提问；streaming 中 `/probe-status`；`sleep` 期间 `/probe-status`；steering；Alt+Enter follow-up；Esc abort。结束后退出 Pi，不要把 JSONL 拷进仓库。

## 分析器判定

`analyze.ts` 对照 `docs/design.md` 第 3 节：

- 命令不得进入 `input`、session entries、LLM `context`，也不得在 handler 内发起 provider 请求
- 空闲普通输入：`input(streamingBehavior=undefined)` → `before_agent_start` → `agent_start` → `agent_end` → `agent_settled`
- steering 归入当前任务
- follow-up 入队不立即新开任务；真正执行时应出现后续 `before_agent_start`/`agent_start`，且 `agent_settled` 不能出现在 follow-up 开始之前
- 并行工具用 toolCallId 区分
- abort 应有 `agent_end` / `agent_settled`
- 手动 compaction 若能触发则记录；provider retry / overflow compaction 不能稳定触发时标 `unverified`

任一核心结果 `designCompatible=false` 时 **不得进入 Gate 2**。
