# Handover

## 当前阶段

- 项目：`pi-task-observer`
- 远程仓库：`https://github.com/stones-hub/pi-task-observer.git`
- 当前阶段：Gate 2 完整 v0.1 实现及安全窄修已在当前工作区落地；Pi 已独立重跑
  100 项测试、typecheck、build 和 package smoke；Claude Opus 4.8 独立复审完成；
  真实 Pi TUI 核心黑盒场景已通过，仍有明确未验证项
- 编码授权：已于 2026-09-11 获得；允许使用 Cursor，模型使用
  `cursor-grok-4.6-high`（用户允许 Grok）
- commit / push / 发布授权：用户已于当前会话明确授权；计划发布 GitHub `v0.1.0`
  tag/Release。npm 未登录且 package 明确为 `private: true`、`UNLICENSED`，不擅自发布 npm。
- Git：空仓库克隆后 HEAD 尚未建立；当前变更均为未提交工作区文件

## 已确认产品决策

- Extension 加载后自动观察所有任务，不提供观察开关。
- 用户界面中文优先，必要技术信息中英文结合。
- 每个 Session 保存当前活跃任务和最近 3 条已结束任务。
- `/status` 是综合入口；删除面向用户的 `raw`、`process`、`watch` 子命令。
- 提供 `help`、`timeline`、`files`、`analyze`、`history` 和历史编号查询。
- Steering 属于当前任务；Follow-up 真正作为 user turn/batch 交付时成为新任务；
  一个低层 Execution Run 可跨越多个任务，各任务记录自己的 Segment；retry/compaction
  属于当前任务的底层执行片段。
- 首个可用版本完整实现已确认方案，不发布功能残缺的 MVP。

## 已完成调查

- Pi Extension command 在 input/Agent 处理前分派，文档说明 streaming 时可立即执行。
- Pi 暴露 input、agent、turn、message、tool、compaction 和 session 生命周期事件。
- `agent_end` 是低层 run 结束，`agent_settled` 才表示无自动 continuation。
- `ctx.modelRegistry.complete(...)` 支持不写入主 Session 的独立 AI 调用。
- 内置 bash 工具事件不暴露 PID；只能做 Pi 后代进程的候选关联，不能精确归因。
- Git 没有任务级原子快照 API，需异步基线、指纹和完整性标记。
- Gate 1 真实 Pi 0.85.1 动态探针：命令旁路/隔离、streaming/长 bash 中响应、
  steering、并行工具、abort 与方案相容；follow-up 在原 `agent_start/end` 内消化。
  用户已选择方案 A。原始 JSONL 在
  `/tmp/pi-task-observer-probe/gate1-20260911-125410/`。

独立只读调查证据位于仓库外：

```text
/tmp/pi-task-observer-evidence/feasibility.json
```

## 当前文档

- `AGENTS.md`
- `README.md`
- `docs/requirements.md`
- `docs/design.md`
- `docs/feasibility.md`
- `docs/acceptance.md`
- `dev/probe/README.md`（Gate 1 可重复说明）
- `dev/probe/FINDINGS.md`（Gate 1 脱敏结论）

## 已确认方案与参数

用户已于 2026-09-11 确认 v0.1 产品需求、技术方案和验收标准，包括任务聚合边界、
最近 3 条内存历史、reload 后不恢复、Git 异步基线、候选进程可信度、独立 AI 分析、
隐私和脱敏规则，以及完整首版而非缩水 MVP。`/status analyze` 代表同意该次额外模型
调用，不二次确认；默认硬超时为 300 秒。其余容量、截断、Git 预算、展示数量和缓存
默认值已写入 `docs/design.md`。

## Gate 1 后续决策

用户已于 2026-09-11 选择方案 A：保持 follow-up 实际执行时成为新任务；允许一个低层
Execution Run 跨越原任务和后续任务，并按实际交付 turn/batch 建立各任务的 Execution
Segment。`one-at-a-time` 逐次交付分别建任务，`all` 一次合并批次建一个任务；证据不足
时标记部分观测，不伪造新的 `agent_start`。相关需求、设计、可行性和验收文档已更新。

## 当前验证与复审

- Pi 独立重跑：`typecheck`、98/98 tests、`build`、`package:smoke` 均通过。
- Cursor 前三次全新只读 review 调用均返回成功状态，但终态正文停留在“准备/正在复审”，
  没有给出完整 findings，不能算独立复审通过。
- 随后尝试 Claude 只读复审，wrapper 返回 `failure`：服务端 503，`No available
  accounts`，session `35105e90-322a-440a-9071-77628bca57b8`。按流程未重试、未自动
  换执行器。证据：`/tmp/pi-task-observer-evidence/gate2-review-claude.json`。
- 用户随后单独授权再执行一次 Cursor + Grok 全新只读复审。该次明确禁止 shell、要求
  终态直接返回 findings，但 wrapper 虽返回 success，正文仍停在“正在把完整分级结论
  写入复审结果”，未包含任何实际 findings，故仍不能算复审通过。session
  `94328b47-d043-45df-a74c-ea2b4ae68cb9`；证据：
  `/tmp/pi-task-observer-evidence/gate2-review4-cursor-grok.json`。本次授权已使用，不自动重试。
- 用户同意改用 `cursor-grok-4.6-xhigh` 再开一次全新只读 review；结果同样只有过程性
  文本，停在“正在写入完整分级结论”，未包含 findings，仍不能算复审通过。session
  `7b976556-9aee-4d67-b216-a202223ec526`；证据：
  `/tmp/pi-task-observer-evidence/gate2-review5-cursor-grok-xhigh.json`。未自动重试。
- Cursor 编码响应均未提供实际模型字段，只能证明请求模型为
  `cursor-grok-4.6-high`，不能证明实际生效模型。
- 用户确认 Claude Code 已恢复，并指定 `claude-opus-4-8` 验收。全新只读复审成功，
  响应明确证明模型为 `claude-opus-4-8`，session
  `94a5545a-d042-40cb-a660-ecf3cd8fab32`。结论：Critical/High 均无；1 项 Medium 是
  超长多行 secret（如超窗口 PEM）在展示层可能部分泄露；4 项 Low 为已知 API/动态
  验证边界。复审认为无阻断并建议进入真实 TUI。证据：
  `/tmp/pi-task-observer-evidence/gate2-review-claude-opus-4-8.json`。
- Medium 已交原 Cursor 编码会话窄修：以固定有界窗口处理未闭合 PEM 与跨窗口凭证，
  新增 4 项安全回归测试。Pi 已检查变更并独立重跑，98/98 tests、typecheck、build、
  package smoke 均通过。
- 修后由全新 Claude Code 会话、明确模型 `claude-opus-4-8` 做针对性只读复核，session
  `75275c82-400c-478d-8447-31ef8745db51`。结论：原 Medium 的可识别情形已解决，未引入
  Critical/High/Medium，可进入真实 TUI；剩余 Low 是真正未闭合且 tail 窗口只有无标记
  base64 body 时可能展示数十字符片段，不足以重建密钥且与普通 base64 不可区分。证据：
  `/tmp/pi-task-observer-evidence/gate2-review-fix-claude-opus-4-8.json`。

## 真实 Pi TUI 验收

验收使用 Pi 0.85.1，从当前工作区 `src/index.ts` 加载，隔离临时 Git 仓库和
`ai-model-vip/gpt-5.6` 测试模型；证据目录：
`/tmp/pi-task-observer-tui-qa-W6egei/`。未安装全局 Extension，未连接业务系统。

已通过：

- `/status help` 在真实 TUI 展示完整中文帮助，未触发 input/provider 请求；
- streaming 中 `/status` 即时响应，主模型继续并正常 `agent_end/agent_settled`；
- 长 bash 中 `/status` 显示工具执行中和候选 `sleep 8`，工具未被取消；
- 首次实测发现观察器自身 `ps` 被误报为候选，已窄修并补测试；修后真实 TUI 只显示
  `sleep 8`，不再显示观察器 `ps`；Pi 重跑 100/100 tests、typecheck、build、package
  smoke 均通过；
- 外部审计 Extension 记录所有 `/status` 均未进入 input 或后续 context；普通状态命令
  没有新增 provider 请求；
- steering 在同一 Run 中交付，历史 timeline 可见 steering；
- follow-up 真实 TUI 交付后形成两个历史任务，共享底层 Run 语义与方案 A 相容；
- Git 黑盒场景正确展示 tracked/untracked 变化，且明确“不能证明由当前 Agent 修改”；
- `/status analyze` 完整独立调用成功，显示“AI 推断”和规定小节；外部审计未看到主
  Session 的 provider/input/context 事件；Esc 取消只取消分析并显示“分析已取消”；
- 连续 4 个任务后历史仅保留最近 3 条，编号 1/2/3 顺序正确；
- `/reload` 真实触发 shutdown/reload 和新 runtime，内存历史按设计清空；
- 调试日志仅有脱敏、有限 session 元数据；隔离 Git 工作区除测试场景外可清理恢复。

发现并修复的问题：

- 进程候选曾把观察器自己的 `ps -axo ...` 当成当前 bash 候选；现已精确排除观察器
  快照 argv，并过滤 `command`/`timeout` 等低信息 token。证据：
  `/tmp/pi-task-observer-evidence/tui-fix-process-self.json`。

补充隔离验收（证据目录 `/tmp/pi-task-observer-extra-qa-VgTv7Z/`）：

- Follow-up `all` 真实 TUI 通过：隔离项目设置 `followUpMode=all`，连续两条 Alt+Enter
  只形成一个 follow-up 历史任务，详情保留 2 条来源消息，并与原任务共享底层 Run；
- Follow-up 撤回真实 TUI 通过：Alt+Enter 入队后用 Alt+Up 取回并清空；最终没有交付
  context/provider 请求，也没有创建 follow-up 历史任务；Pi 没有向 Extension 发出撤回事件，
  但最终收敛行为正确；
- `/new`、恢复既有 Session（等价 `/resume` 的同一加载路径）和 `--fork` 逐项通过；新
  runtime 的内存历史为空，Session ID 隔离，后续新任务只进入当前 runtime；真实 `/resume`
  选择器没有再做脆弱键盘自动化，底层恢复路径已通过 `--session <id>` 验证；
- 成功 manual compaction 已真实发生：`session_before_compact(reason=manual)` →
  `session_compact(reason=manual)`，Session JSONL 写入 7,789-token compaction；恢复该
  Session 后新任务和 `/status history` 正常。第一次脚本因用输出 marker 过早匹配而把
  后续输入变成 steering，随后由持久 Session 证据和恢复续跑完成验证；
- 自动重试通过真实 Pi 调度 + 隔离 custom provider 确定性验证：第一次返回 synthetic
  503，Pi 显示 retry 并产生第二次 `agent_start`，第二次成功；观察器只保留一个用户任务，
  仅在最终 `agent_settled` 后归档。Extension API 仍不暴露 `auto_retry_*`，所以状态页不
  声称精确重试次数；
- overflow mock 尝试得出平台边界：首条用户消息没有可压缩的历史，Pi 对
  `context_length_exceeded` 直接 settled，未进入 compaction；这不是观察器失败。真实
  overflow compact-and-retry 仍需先构造存在可压缩前缀的 Session 后再触发；
- GitObserver 性能抽样通过（Darwin、Node v26.4.0，每组预热 5 次、正式 50 次）：100
  文件/20 dirty 的 uncached P95 26.05 ms；10,000/200 为 54.96 ms；50,000/500 为
  87.73 ms；缓存 P95 均低于 0.004 ms。完整 JSON：`performance/report.json`；
- Windows 进程平台本机不可做真机验收，但现有自动化确认 `win32` 明确局部降级且不调用
  Unix `ps`；Base64/PEM Low 边界已有跨窗口、孤立 END、未闭合 BEGIN 等自动化覆盖，
  100/100 全量测试通过，客观不可区分的无标记短 Base64 tail 风险维持 Low。

## 下一步

1. 若继续追求 overflow 完整动态证据，可在已经包含可压缩历史的隔离 Session 上，用
   custom provider 首次返回 overflow、Extension 提供确定性 compaction summary、第二次
   返回成功；不得用真实 300K provider 硬耗 Token；
2. `/resume` 若要求“选择器本身”的可视证据，可再做一次人工/稳健 TUI 选择器操作；核心
   `--session <id>` 恢复 runtime 路径已验证；
3. 清理临时验收目录前保留本交接中的证据路径；
4. 当前会话已获得 commit、push 和 GitHub Release 授权；完成后记录固定 SHA、远端分支、
   tag 和 Release URL。npm 发布因 manifest/认证明确不满足而不执行。
