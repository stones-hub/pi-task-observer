# Gate 1 动态探针结论

状态：已执行真实 Pi SDK 实验，**发现与已确认方案不相容的 follow-up 任务边界**。  
依据任务书：立即停止，不进入 Gate 2，不静默改方案。

- Pi：`0.85.1`
- 模型：`ai-model-vip/gpt-5.6`（thinking off）
- 入口：`createAgentSession`（与 TUI/RPC 同一 `AgentSession`）
- 命令路径与 TUI 相同：`session.prompt("/probe-status")`、`prompt(..., { streamingBehavior })`
- 原始 JSONL 仅保存在仓库外 `/tmp/pi-task-observer-probe/gate1-20260911-125410/`，不入库

## 与方案相容的核心结果

1. **命令旁路**：`/probe-status` 4 次均有 `command_start/end`，0 次进入 `input`。符合「Extension command 在 input 之前分派」。
2. **不进入消息树/上下文**：命令快照 `commandInEntries=false`；后续 `context` 事件 `commandInContext=false`；handler 期间无 `before_provider_request`。
3. **streaming 中可响应**：`during-stream` 时 `isIdle=false`，随后主 run 仍 `agent_end`/`agent_settled`，未见 abort。
4. **长 bash 中可响应**：`sleep 8` 的 `tool_execution_start` 与 `tool_execution_end` 之间插入命令；工具 `isError=false`，主任务继续。
5. **普通生命周期**：空闲输入 `streamingBehavior=null`，顺序为 `input → before_agent_start → agent_start → agent_end → agent_settled`。
6. **steering**：`input(steer)` 入队后，在当前 run 的下一 turn 作为 user 消息注入；无额外 `agent_start`，也无提前 `agent_settled`。与「steering 属于当前任务」相容。注意：**没有**第二次 `before_agent_start`，匹配应依赖 `input(steer)` 而非 prompt 再匹配。
7. **并行工具**：同一 turn 两次 `tool_execution_start`（`sleep 3`/`sleep 4`），不同 toolCallId 前缀，时间重叠，结束顺序按完成时间。必须用 Tool Call ID Map。
8. **abort**：请求 abort 后出现 assistant `stopReason=aborted`，随后 `agent_end`/`agent_settled`。本次 abort 发生在 bash 启动前。

## 不相容：Follow-up 任务边界

已确认方案（`docs/requirements.md` §3、`docs/design.md` §3.2–3.3）：

- Follow-up 入队不新建任务；
- **真正开始执行时新建任务**；
- 用后续 `before_agent_start`/`agent_start` 识别；
- 不能仅靠 `agent_settled`，因为 settled 被定义为覆盖 queued continuation。

真实 Pi 0.85.1 行为：

- `input(followUp)` 会立即出现，并进入队列（`queue_update` follow-up 计数增加）；
- Follow-up **在原 `agent_start` 与 `agent_end` 之间被消化**，不会先 `agent_end` 再新开 run；
- **没有**第二次 `before_agent_start`/`agent_start`；
- 原 run 的最后若干 turn 注入 follow-up user 消息后，才 `agent_end` → `agent_settled`。

交付细节：

- `followUpMode=one-at-a-time`：两条 follow-up 变成后续两个独立 user turn；
- `followUpMode=all`：两条 follow-up 在同一后续 turn 里变成两条 user 消息，再一次 assistant 回复。

因此：若按已确认方案在「follow-up 开始执行」时拆成新任务，会把**同一次 Execution Run** 拆成两个用户任务，与「`agent_start`→`agent_end` 为 Execution Run」冲突。若改为「follow-up 也属当前任务」，则改变已确认产品语义。必须由用户重新确认，不能在 Gate 2 静默改语义。

## 未验证

- 真实 provider auto-retry / overflow compaction：未安全触发，标为未验证。不单独阻断，但 follow-up 已阻断 Gate 2。
- 手动 `/compact`：会话过小，`session_compact_failed`（Nothing to compact）。未观察到成功 compact 后再 `agent_start`。
- 真实 Pi TUI 交互（Alt+Enter / Esc）未单独开 TUI；SDK 使用与 TUI 相同的 `prompt(..., streamingBehavior)` 路径。
- 中途 `/reload`、Session replacement：本 Gate 未做。

## Gate 2 建议

**不建议进入 Gate 2。** 非干扰契约已验证通过；任务聚合边界中的 follow-up 与已确认方案不相容。
