# AGENTS.md

## 项目定位

`pi-task-observer` 是一个通用 Pi Extension。它自动旁路观察当前 Pi Session 中的
所有用户任务，通过 `/status` 提供中文优先的运行状态、活动时间线、工作区变化、
候选进程信息，以及可选的独立 AI 进度分析。

核心原则：

- 只观察，不介入主 Agent 的执行。
- 不依赖 Skill 或 Agent 主动维护状态。
- 观测事实、工作区事实、进程关联和 AI 推断必须分开展示。
- 无法确认的信息明确标为“未知”，不得伪造确定性。
- 用户可见内容中文优先；命令、工具名、路径、PID、Session ID 等保留英文。

## 研发流程

- 编码前先阅读 `HANDOVER.md`、`docs/requirements.md`、`docs/design.md`、
  `docs/feasibility.md` 和当前 `.pi/tasks/` 任务书。
- 方案确认不等于编码授权；获得用户明确编码授权后才能修改正式源码和测试。
- 正式业务代码和测试默认委派 Claude Code；Pi 负责方案、完整 diff 检查、测试重跑
  和真实 Pi TUI 业务验收。
- 同一真实工作区同一时刻只允许一个有写权限的编码 Agent。
- 未经单独授权不得 commit、push、发布或部署。

## 产品硬约束

- Extension 加载后自动观察每个任务，不提供观察开关。
- `/status` 等 Extension 命令不得成为 steering、follow-up 或主 Agent 上下文消息。
- 普通状态查询不得触发模型调用；只有 `/status analyze` 可发起独立模型调用。
- 每个 Session 保存 1 条当前活跃任务和最多 3 条最近结束任务。
- 默认仅内存保存，不修改被观察项目，不保存完整环境变量、Prompt、响应、diff 或
  无界工具输出。
- 不输出精确完成百分比。
- 工作区变化只能表述为“任务运行期间观察到”，不得无证据归因给当前 Agent。
- Pi 的 bash 工具事件不暴露子进程 PID；进程关联必须标注证据和可信度。

## 技术与质量要求

- 语言：TypeScript，运行形态为 Pi Extension package。
- 优先使用 Pi 官方 Extension API 和 Node.js 标准库。
- 内部状态使用稳定英文枚举，展示层统一映射为中文。
- 所有外部命令使用 argv 调用和超时，不拼接未经处理的 shell 字符串。
- Git 和进程探测失败必须局部降级，不能导致 `/status` 整体失败。
- 工具参数、命令、错误和 AI 输入必须截断并做常见凭证脱敏。
- 测试至少覆盖：生命周期聚合、并行工具、steering/follow-up、历史淘汰、Git 基线、
  命令解析、中文格式化、脱敏、进程降级和 AI 分析隔离。
- 发布前必须在真实 Pi TUI 中验证运行中调用 `/status` 不会中断主 Agent 或当前工具。
