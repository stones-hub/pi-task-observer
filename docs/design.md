# 技术方案

状态：已确认（2026-09-11）  
版本：方案 v0.1

## 1. 总体架构

```text
Pi Extension runtime
├── Event Collector       监听 input/agent/turn/message/tool/session 事件
├── Task Aggregator       聚合用户任务与底层 Execution Run
├── Workspace Observer    异步采集 Git 基线与查询时快照
├── Process Observer      只读枚举 Pi 后代进程并做候选关联
├── History Store         内存：当前任务 + 最近 3 条结束任务
├── Analyzer              独立 modelRegistry.complete 调用
├── Redactor/Limiter      统一脱敏、截断和容量控制
└── /status Command       中文命令解析和自适应综合展示
```

所有观察模块只读，不注册 LLM tool，不覆盖 Pi 内置工具，不调用主 Agent 控制 API。

## 2. 核心数据模型

```ts
type TaskState =
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

type ObservationKind = "observed" | "workspace" | "process" | "inferred";

type Confidence = "confirmed" | "high" | "medium" | "low" | "unknown";

interface ObservedTask {
  id: string;
  sessionId: string;
  cwd: string;
  source: "interactive" | "rpc" | "extension" | "follow-up" | "unknown";
  promptSummary?: string;
  acceptedAt?: number;
  startedAt: number;
  endedAt?: number;
  state: TaskState;
  completeness: "complete" | "partial";
  completenessReasons: string[];
  executionSegments: ExecutionSegment[];
  activeTools: Map<string, ToolObservation>;
  timeline: RingBuffer<TimelineEvent>;
  baseline?: WorkspaceBaseline;
  finalWorkspace?: WorkspaceSnapshot;
  processSnapshot?: ProcessSnapshot;
}
```

`ExecutionRun` 表示 Pi 的低层 `agent_start → agent_end`；`ExecutionSegment` 表示某个
用户任务在该 Run 内的观测区段，至少含共享 Run ID、区段起止时间和边界证据。同一个
Run ID 可以出现在前后多个任务中，但任一时刻只允许一个当前任务接收新事件。

内部枚举为英文；Formatter 映射为中文。Prompt 仅保存经过脱敏和长度限制的摘要，
不是完整原文。

## 3. 生命周期聚合

### 3.1 输入暂存

`input` 事件建立有限的 Pending Input：

- idle + `streamingBehavior=undefined`：待创建普通任务；
- `steer`：追加到当前任务时间线，不创建任务；
- `followUp`：进入 pending follow-up 队列，不立即创建任务。

Extension command 在 `input` 之前被 Pi 分派，因此 `/status` 不会进入此逻辑。

### 3.2 任务与 Execution Run 开始

`before_agent_start.prompt` 与 pending 普通输入按来源、顺序和脱敏摘要匹配：

- 无活跃任务且匹配普通输入：创建任务；
- 无法匹配：创建 `source=unknown` 的部分观测任务，保留原因。

兼容 custom 消息触发的运行：新版 Pi 的 `before_agent_start` 在
`messageType=custom` 时没有 `prompt`。非字符串 prompt 不参与指纹匹配、不消费
pending 普通输入，也不把 custom 内容当成用户输入；已有任务保持连续性，无当前
任务则由后续 `agent_start` 兜底创建 `source=unknown` 的部分观测任务。
这类新启动不存在原始 user 消息，因此原始输入消费标记直接置为已消费，首条实际
交付的 user 消息仍按 steering / follow-up 队列匹配，不能当成原始输入吞掉。

`agent_start` 创建 Execution Run，并为当前任务建立引用该 Run ID 的第一个
Execution Segment；如果此前缺少 `before_agent_start`，以该事件兜底创建部分观测任务。

Gate 1 在 Pi 0.85.1 中确认：steering 和 follow-up 的实际交付均不会产生第二次
`before_agent_start` 或 `agent_start`。因此后续边界不能依赖新的 Run：

- `input(steer)` 只进入当前任务时间线，后续 user turn 仍属于当前任务；
- `input(followUp)` 进入有限 pending follow-up 队列，不立即创建任务；
- 当消息/turn 事件显示 pending follow-up 真正作为后续 user turn 交付时，按队列顺序、
  脱敏摘要和交付批次匹配：结束前一任务的当前 Segment 并归档，建立 follow-up 新任务，
  再为它建立引用同一 Run ID 的新 Segment；
- `one-at-a-time` 每个实际交付 turn 建立一个新任务；`all` 一次交付批次建立一个新任务，
  时间线保留批次内各条来源；
- 摘要碰撞、队列撤回、缺失事件或并发顺序导致无法可靠匹配时，保留可确认事实并标记
  `partial`，不得仅凭文本猜测边界。

### 3.3 低层结束与最终结束

- `agent_end`：结束当前 Execution Run 及当前任务引用它的 Segment，但不单独决定之前
  已因 follow-up 交付而归档的任务；
- compaction/retry 事件：更新当前任务状态，后续 `agent_start` 创建新 Run 和 Segment，
  不错误拆成新用户任务；
- `agent_settled`：若无待消费 follow-up 且 `ctx.isIdle()`，结束并归档当前任务；
- follow-up 的前一任务在交付边界归档，结束原因明确标记为被后续任务接续，而不是伪装
  成独立的 `agent_settled`；
- abort/failure：依据最终 Assistant stop reason、compaction failure、工具状态和 settled
  事件确定；证据不足时使用 `unknown` 而非猜测。

Gate 1 结论见 `dev/probe/FINDINGS.md`。产品保持“follow-up 实际执行时成为新任务”的
语义，同时诚实承认一个 Execution Run 可以跨越多个任务。

### 3.4 并行工具

`activeTools` 以 Tool Call ID 为键。Start/Update/End 可以交错；每个工具独立记录。
任务状态在任意工具活跃时为 `tool-running`。默认页展示最多若干活跃工具，详细时间线
展示全部保留事件。

### 3.5 Session 生命周期

Session ID 是状态隔离键。`session_shutdown` 清理资源；新 runtime 的内存历史重新
开始。`session_start(reason=reload)` 或中途加载且无法找到完整起点时，任务标记为
`partial`。首版不通过 `appendEntry` 持久化，避免污染 Session 与模型上下文。

## 4. Git 工作区观察

### 4.1 非阻塞基线

任务建立后立即异步采集，不等待基线完成才允许 Agent 继续。记录：

- repository root、HEAD、branch；
- staged/unstaged 状态；
- untracked 文件集合；
- 每个当前变化文件的轻量内容指纹；
- 采集开始、结束时间和失败原因。

候选实现使用 Git plumbing/porcelain 的 `-z` 输出避免路径解析错误；所有命令带超时。
对于已修改和未跟踪文件，按内容流式 hash，可配置总字节与文件数预算。超预算文件
记录元数据和 `fingerprint=partial`，并在输出声明精度降低。

### 4.2 查询快照和差异语义

`/status` 和 `/status files` 获取当前快照并与基线比较：

- 基线前已存在且指纹未变；
- 基线前已存在但内容进一步变化；
- 运行期间新出现、删除或状态改变；
- 查询时完整当前状态。

若基线尚未完成、失败或任务中途才开始观察，不使用“自任务开始以来”的确定措辞，
改为“自观察器建立基线以来”并标明时间窗口。

不默认扫描 ignored 文件和构建缓存；文件系统 watcher 不进入首版，因为高噪音且
不能解决进程归属。

## 5. 进程观察

### 5.1 原则

Pi API 不暴露 bash PID，且不覆盖内置 bash。Process Observer 仅在存在活跃的
`bash`/`powershell` 或明显长时间外部工具时按需采集；普通模型、read/edit/write
阶段不显示无意义的进程区块。

### 5.2 数据源和关联

- 根 PID：Extension 所在 `process.pid`；
- macOS/Linux：通过只读系统进程快照获取 PID、PPID、启动时间、命令、CPU、RSS；
- 构建 Pi 后代进程树；
- 用父子关系、工具开始时间、命令 token 相似度和并发关系给候选打分。

证据等级：

- `confirmed`：未来 Pi API 直接提供，首版预计不可达；
- `high`：唯一新出现的 Pi 后代且命令高度匹配；
- `medium`：后代关系成立但存在多个候选或命令部分匹配；
- `low`：仅时间/命令近似；
- `unknown`：无可靠候选。

`/status` 只陈述 PID 是否存活、是否为 Pi 后代等事实；“属于当前工具”必须带可信度。
进程观察绝不用于声称文件归属。Windows 若缺少可靠实现，显示平台暂不支持，而不
影响其他状态。

## 6. 独立 AI 分析

`/status analyze` 构造脱敏、有限的纯文本/结构化 Context，调用：

```text
ctx.modelRegistry.complete(ctx.model, independentContext, options)
```

使用新的分析 sessionId、独立 AbortController、明确超时和当前模型认证。输入包含：

- 任务摘要和持续时间；
- 最近 N 条关键时间线；
- 当前活跃工具与候选进程；
- Git 文件列表和 diff stat，不含完整 diff；
- 已截断的工具结果/错误摘要。

System prompt 强制中文输出并区分“观察事实”和“推断”。分析结果仅展示，不调用
`pi.sendMessage`/`appendEntry`，不写主 Session。对当前任务分析时采用命令触发时的
不可变快照，避免分析期间状态变化造成数据竞争。

## 7. 命令与展示

命令解析器实现 `docs/requirements.md` 的正式语法。所有输出走一个中文 Formatter：

- `/status`：综合摘要，自适应显示有价值的进程和文件信息；
- `timeline`：更完整的保留时间线；
- `files`：基线与当前变化详情；
- `analyze`：独立 AI 推断；
- `history` 和编号：最近 3 条历史；
- `help`：静态帮助，不触发任何探测。

未知命令、编号越界、无当前任务、非 Git、模型未配置、探测超时均返回可行动的中文
提示，不泄露内部堆栈。

## 8. 容量、并发与性能

- 每 Session：当前任务 + 3 条结束任务；
- 每任务时间线：固定容量 Ring Buffer，具体默认值在实现任务书中确认；
- 文本字段按字符/字节双重限制；
- 事件 handler 只做同步轻量记录，Git/进程/AI I/O 不阻塞事件分发；
- 同一任务的 Git 查询去重，短时间重复 `/status` 可复用带时间戳快照；
- 查询读取任务不可变快照，避免并行事件更新导致半结构状态；
- 所有外部进程与 AI 调用支持超时和错误隔离。

## 9. 调试

不提供 `/status raw`。开发诊断通过显式环境变量开启，日志仅记录脱敏事件元数据：

```text
PI_TASK_OBSERVER_DEBUG=1
PI_TASK_OBSERVER_DEBUG_FILE=/path/to/file
```

默认关闭；即使调试开启也不记录环境变量、完整 Prompt、完整工具结果或凭证。

## 10. v0.1 默认实现参数

以下参数已于 2026-09-11 确认，作为首版初始默认值；动态探针或测试可基于证据做
不改变产品语义的工程校准，若明显影响用户体验、观测完整性或隐私边界则重新确认。

- 每个任务保留 256 条时间线事件；默认页显示最近 8 条关键事件，`timeline` 显示
  最近 64 条保留事件，并标注容量淘汰或未展开数量。
- 默认页最多显示 5 个活跃工具、10 个工作区变化文件和 5 个可靠候选进程。
- Prompt、steering、follow-up 摘要：512 字符且不超过 2 KiB UTF-8。
- 工具参数和命令摘要：1,024 字符且不超过 4 KiB；进程命令行摘要：512 字符且
  不超过 2 KiB。
- 工具结果和错误摘要：2,048 字符且不超过 8 KiB；单条时间线详情及 Git/进程
  内部错误摘要：1,024 字符且不超过 4 KiB。长结果保留首尾并标明中间省略。
- AI 输入总预算 32 KiB；AI 结果展示最多 8,192 字符且不超过 32 KiB。
- Git 指纹每次最多处理 512 个变化文件、单文件最多读取 8 MiB、Workspace Snapshot
  总计最多读取 64 MiB；内容总预算按实际 `bytesRead` 累加，不以 `stat` 文件大小占满。
  工作区文件记录同样最多 512 条，超出只计总数/省略数，不保存无界 `files`。
  `git status` stdout 达上限时标记截断且快照不完整。
- 单个 Git 子进程超时 1.5 秒，Git 快照总超时 3 秒；普通 `/status` 最多等待新 Git
  结果 100 毫秒；进程探测硬超时 1 秒；`/status analyze` 硬超时 300 秒。
- 活跃任务 Git 快照缓存 2 秒，同任务并发查询去重；历史任务使用结束时保存的
  `finalWorkspace`，展示快照时间。`/status` 摘要页必须标明工作区快照时间与年龄；
  命中缓存时明确写“缓存，非实时”，不得把缓存伪装成实时结果。
- 每任务已结束工具最多 256 条；steering / follow-up / 普通输入队列各最多 64 条；
  同一 turn 用户消息最多 64 条；执行区段最多 32 条；follow-up `all` 批次来源摘要
  最多 16 条；不完整原因最多 8 条。超出部分 FIFO 淘汰最早记录，并记录淘汰计数、
  标记 `partial`、在时间线/摘要给出一次性提示。提示文案去重且受原因容量约束，
  淘汰提示不得再撑爆容量。历史仍为当前任务 + 最近 3 条，合计内存随上述上限封闭。
  每任务时间线 Ring Buffer 随历史淘汰删除；长 Session 内部保留不超过当前 + 3。
  活跃工具与 session `toolsById` 各最多 256；超限不保存完整记录，仅保留有界
  dropped-ID 集合，后续 `tool_end` 不得误归到当前 follow-up。
- 候选进程结合后代关系、命令相似度和 `etime` 估算启动时间：只有启动时间落在
  工具窗口内、且唯一高度命令匹配才标 high；时间无法解析或进程早于工具不得 high；
  并行候选不得 high。
- 工具 args/result、Prompt 与对象序列化先按有界窗口裁剪再脱敏：最大深度 4、数组
  12 项、对象 16 键、序列化扫描 8 KiB；超长字符串只处理首尾窗口，裁剪边界保留
  128 字符 overlap，避免常见 secret 跨边界漏脱敏。getter 异常不得拖垮事件 handler。
- `/status analyze` 即代表用户同意该次额外模型调用，不再二次确认；超时后不自动
  重试或切换模型，且只终止独立分析。

性能数字是本机验收目标而非所有环境的绝对 SLA；非干扰和故障局部降级是硬要求。

## 11. 内部实施顺序

以下只是研发顺序，全部完成并验收后才形成首个可用版本：

1. 动态事件探针与边界实验；
2. 状态模型、命令解析、历史和中文 Formatter；
3. Git 基线与差异；
4. 候选进程观察；
5. 独立 AI 分析；
6. 安全、容量和故障降级；
7. 自动化测试、独立复审和真实 Pi TUI 验收。
