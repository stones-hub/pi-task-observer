# Pi Extension 技术可行性调查

状态：静态调查完成，已获编码授权，动态实验待执行  
调查对象：本机安装的 `@earendil-works/pi-coding-agent`

## 1. 已确认能力

### 1.1 Extension 命令旁路分派

Pi 在普通 `input`、Skill/Template 展开及 Agent 处理之前先检查 Extension command；
命中后直接执行 handler。官方 SDK/RPC 文档也明确 Extension command 在 streaming
期间立即执行。

因此 `/status` 可以设计为 Extension command，不需要发送 steering 或 follow-up。
还需通过真实 TUI 实验确认：命令输出方式、handler 与长工具运行的调度表现，以及
session entry 是否产生任何非预期副作用。

参考：

- `docs/extensions.md` 的 Lifecycle Overview 和 Input Events；
- `docs/sdk.md` 的 prompt/extension command 行为；
- `docs/rpc.md` 的 streaming prompt 与 extension command 说明。

### 1.2 生命周期和并行工具事件

官方 API 提供：

- `input`，含 `source` 与 `streamingBehavior: steer | followUp | undefined`；
- `before_agent_start`，含本次 prompt；
- `agent_start`、`agent_end`、`agent_settled`；
- `turn_start`、`turn_end`；
- `message_start/update/end`；
- `tool_execution_start/update/end`，含 Tool Call ID、工具名和参数；
- `ui_prompt_start/end`；
- session compaction、switch、fork、shutdown 等事件。

并行工具事件可能交错，结束顺序与源码顺序不同，因此实现必须用 Tool Call ID 建立
Map，不能只保存单一“当前工具”。

`agent_end` 只是低层 run 结束；此后可能自动 retry、compaction retry 或 follow-up。
`agent_settled` 表示没有自动 continuation。这足以构建观测模型，但 Pi 没有现成的
`task_start/task_end`，用户任务聚合需要 Extension 自己实现。

### 1.3 独立 AI 调用

`ctx.modelRegistry.complete(model, context, options)` 是官方独立 completion API。官方
`examples/extensions/handoff.ts`、`qna.ts`、`summarize.ts` 和 custom compaction 示例
均使用该模式。该调用可以使用独立 Context 和新的 sessionId，不触发主 Agent turn，
也无需写入主 Session。

实现仍需明确：

- 使用当前 `ctx.model`，无模型或无认证时中文报错；
- 自建 `AbortController` 和超时；
- 输入只包含脱敏、裁剪后的观测快照；
- 不调用 `pi.sendMessage`、`pi.sendUserMessage` 或 `ctx.waitForIdle`；
- 统计并展示额外调用的 usage/cost（若 provider 返回）。

### 1.4 Session 身份和上下文

可通过 `ctx.sessionManager.getSessionId()`、`getSessionFile()`、entries/branch/tree 及
`ctx.cwd` 读取当前 Session 信息。Session replacement 会销毁旧 Extension runtime，
新 runtime 收到新的 `session_start`；首版内存状态因此不会跨 replacement 自动保留。

## 2. 已确认限制

### 2.1 Bash 事件不暴露 PID

`tool_execution_*`、`tool_call/tool_result` 和 `BashToolDetails` 均没有子进程 PID。
Pi 内部 bash 实现虽持有 PID 用于终止进程树，但没有公开给 Extension。

不采用“覆盖内置 bash 工具”方案，因为它会改变被观察对象、增加兼容和安全风险，
违反旁路观察原则。首版进程观察只能采用外部只读系统快照：

1. 以当前 Pi 进程 `process.pid` 为根；
2. 枚举其后代进程；
3. 结合当前活跃 bash/powershell 工具、命令摘要、进程启动时间进行候选匹配；
4. 输出确定事实（PID 存活、父子关系、命令）与关联可信度；
5. 并行 bash 或证据不足时显示多个候选或“无法确认”。

这不能证明某进程修改了哪些文件。文件变化必须由 Git/文件系统基线单独回答。

### 2.2 Git 没有任务级原子快照 API

Pi 只提供通用 `pi.exec`；Extension 需自行调用 Git。任务开始和 Git 基线采集不是
原子操作，存在短暂 TOCTOU 窗口。基线采集失败或尚未完成时必须标记完整性，不能
阻塞 Agent 启动。

只比较 `git status` 不足以识别“开始前已经 modified、运行中又被进一步修改”的
情况。设计需要按文件保存轻量指纹，见 `docs/design.md`。

### 2.3 进程与文件不能精确归因

`lsof` 只能看到当前打开文件，不能恢复历史修改；系统级精确审计需要平台权限，
不适合作为普通 Extension 默认能力。产品只能表述工作区变化与候选进程，不能说
“PID X 修改了文件 Y”。

### 2.4 内存状态与 reload

官方 Extension runtime 在 `/reload`、`/new`、`/resume`、`/fork` 时重建。首版默认
内存状态会丢失。新 runtime 如果发现 Pi 已处于活动状态或缺少起始事件，只能建立
部分观测并显示“观测不完整”。

### 2.5 auto_retry 与 agent_end.willRetry 不对 Extension 暴露

Pi 0.85.1 的 `AgentSession` 内部事件总线有 `auto_retry_start` / `auto_retry_end`，
并向 session listener 发送带 `willRetry` 的 `agent_end`。但 `_emitExtensionEvent`
只把 `{ type: "agent_end", messages }` 转给 Extension，`ExtensionAPI.on` 也没有
`auto_retry_*`。因此观察器不能订阅底层 auto-retry 事件。

实现策略：若运行时 `agent_end` 意外带有 `willRetry` 则按重试处理；否则 `agent_end`
的 error/abort 不单独结束任务，等到 `agent_settled` 才归档；后续 `agent_start`
视为同一任务的新 Run/Segment。这不是伪造 auto_retry 事件。

### 2.6 自身 custom UI 抑制无法绝对区分并发其他扩展

Pi 的 `ui.custom()` / `ui_prompt_*` 对 custom 没有可用的 title 或调用方身份。观察器
用“即将调用自身 `custom` 之前立刻 `expectOwnCustomUi()`”把随后的 `custom` 起止事件
从 waiting-user 时间线里扣除。该窗口已缩到同步 `expect` 与 `custom()` 调用之间，
且非 TUI / 无 UI 的 `notify` 路径不会记账。

这不是绝对可靠的归属：若恰好在该极窄窗口内插入另一个扩展的 `custom` 起止事件，
可能被误当作自身 UI 而漏记，或（更少见）计数错位。实现不得宣称 100% 隔离，只能
尽量缩短窗口并在非 custom 路径避免误记账。

## 3. 动态验证状态

Gate 1 已在 Pi 0.85.1 上通过真实 `AgentSession` 执行，脱敏结论见
`dev/probe/FINDINGS.md`，原始有限 JSONL 仅保存在仓库外。

已确认：

1. Extension command 不进入 `input`、Session 消息树或后续模型上下文，普通命令不
   触发 provider 请求；
2. streaming、长时间 bash 和并行工具执行期间命令可响应，未中断主任务或工具；
3. 普通生命周期、steering、并行工具和 abort 的核心事件顺序与方案相容；
4. Pi 0.85.1 的 follow-up 在原 `agent_start → agent_end` 内作为后续 user turn 消化，
   不产生第二次 `before_agent_start` 或 `agent_start`；`one-at-a-time` 逐 turn 交付，
   `all` 在一个后续 turn 合并交付。

用户据此确认继续保持“follow-up 实际执行时成为新任务”的产品语义，并允许一个低层
Execution Run 跨越多个任务；任务按实际交付 turn/batch 记录 Run 内 Segment。

仍需在实现和最终验收中验证：

1. follow-up 撤回及边界匹配失败时的诚实降级；
2. 自动 retry 与 overflow compaction 的真实事件顺序；
3. 成功 compaction 后继续执行的 Run/Segment 关系；
4. `/reload`、Session replacement 和中途加载；
5. 真实 Pi TUI 的键盘输入路径；
6. macOS/Linux 进程树采集的权限、命令格式和并行候选匹配；
7. 当前模型独立 `modelRegistry.complete` 与主流式请求并发时的行为、取消和 usage；
8. 大型仓库 Git 基线采集的耗时与不阻塞策略。

## 4. 可行性结论

整体方案可行：事件观察、命令旁路、Git 查询和独立 AI 调用均有官方基础。

主要不可获得的强保证是“内置 bash 的精确子进程 PID”和“文件修改的进程归属”。
方案通过候选进程、证据等级、Git 基线和明确措辞完整呈现可获得信息，而不是覆盖
内置工具或引入系统级审计。这是产品的诚实能力边界。

独立只读复核证据保存在仓库外：

```text
/tmp/pi-task-observer-evidence/feasibility.json
```

该文件不是产品输入，也不提交仓库。
