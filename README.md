# pi-task-observer

一个面向 [Pi coding agent](https://github.com/earendil-works/pi-mono) 的任务观察
Extension。加载后自动旁路观察当前 Session 中的用户任务，通过 `/status` 查看运行
状态、活动时间线、工作区变化、候选进程，以及可选的独立 AI 进度分析。

它只观察，不介入主 Agent：`/status` 不会成为 steering、follow-up 或主上下文消息。
普通查询不调用模型；只有 `/status analyze` 会发起一次独立模型调用。

## 安装与加载

从 Git 标签临时加载指定版本：

```text
pi -e git:github.com/stones-hub/pi-task-observer@v0.1.2
```

也可以从本地源码目录加载：

```text
pi -e /绝对路径/pi-task-observer
```

或直接指定入口：

```text
pi -e /绝对路径/pi-task-observer/src/index.ts
```

依赖：本机已安装 Pi（开发时按 `package.json` 对齐 `0.85.1`）和 Node.js 22+。
在项目目录执行 `npm install` 仅安装本地开发依赖。本项目当前不发布 npm package。

## 命令

观察在 Extension 加载后自动开启，没有开关。

```text
/status
/status help
/status timeline
/status files
/status analyze
/status history
/status <1|2|3>
/status <1|2|3> timeline
/status <1|2|3> files
/status <1|2|3> analyze
```

- `/status help` 只返回静态说明，不触发 Git、进程或 AI。
- 每个 Session 保留 1 个当前任务和最近 3 条已结束任务；编号 `1` 是最近结束的任务。
- 工作区变化只能表述为“任务运行期间观察到”，不能证明由当前 Agent 修改。
- 进程信息是 Pi 后代候选，带可信度，不能精确归属 bash 子进程。
- `/status analyze` 使用当前已配置模型做一次独立调用，可能产生额外费用；发出该
  命令即表示同意这次调用。硬超时 300 秒，超时后不自动重试。
- 不提供 `raw`、`process` 或 `watch` 子命令。

## 任务边界

- 空闲时的普通输入、Skill 或 Prompt Template：新任务。
- Steering：归入当前任务。
- Follow-up 入队不新建任务；真正作为后续 user turn/batch 交付时成为新任务。
- `one-at-a-time` 每次实际交付分别建任务；`all` 一次合并批次建一个任务。
- 一个 `agent_start → agent_end` Execution Run 可以跨越多个任务；各任务记录共享
  Run ID 下的 Execution Segment，不伪造新的 `agent_start`。
- retry / compaction 仍属当前任务。
- 证据不足时标记“不完整”，不猜测边界。

## 开发

```text
npm install
npm run typecheck
npm test
npm run build
npm run package:smoke
```

Gate 1 动态事件探针保留在 `dev/probe/`，不是产品入口。

调试（默认关闭）：

```text
PI_TASK_OBSERVER_DEBUG=1
PI_TASK_OBSERVER_DEBUG_FILE=/tmp/pi-task-observer-debug.jsonl
```

即使开启调试，也不会记录完整 Prompt、完整工具输出、环境变量或凭证。

## 文档

- [产品需求](docs/requirements.md)
- [技术方案](docs/design.md)
- [可行性](docs/feasibility.md)
- [验收标准](docs/acceptance.md)
