# 修复 custom message 启动观察异常

## 授权与执行器
- 用户已授权 Claude Code 修复并验证，推理强度 high。
- 使用本机 Claude 配置模型 `claude-opus-5-5`，显式传参；实际模型以响应为准。
- 仅开发仓库，禁止 commit/push/发布/部署/修改全局配置和已安装扩展。
- Git 基线：187b7b5e3afb7896761c2887521c5a6cb009c4cd；创建本任务书前工作区干净。

## Risk / Scope
关键任务的窄修：事件启动与任务边界。允许 src/index.ts、src/aggregator.ts、相关 tests、必要 README/docs 更新。不得泛化重构或更改依赖。

## 已确认原因与方案
已安装 Pi 的 sendCustomMessage 经 _prepareRun / emitBeforeAgentStart 发送 custom trigger，不带普通 prompt。当前入口无条件把 event.prompt 交给 onBeforeAgentStart，后者 fingerprint(undefined) 在 boundText 读取 length 时抛错。
- 普通字符串 prompt 保持现有 pending 匹配。
- 无 prompt 时不得计算空串指纹，不消费普通 pending，不将 custom 内容冒充用户输入。
- 无当前任务时允许现有 agent_start 兜底创建 unknown/partial；已有当前任务保持任务连续性。
- 防护应在聚合器边界有效，并覆盖真实入口事件路径；不得仅改 boundText 掩盖语义错误。

## Verify
- 回归覆盖 custom 无 prompt、其他非字符串边界、普通输入匹配不变、pending 未误消费、已有任务连续性、正常结束归档。
- Claude 运行 typecheck、全量 tests、build、package:smoke。
- Pi 检查完整 diff 并独立重跑上述命令。
- 至少一路全新只读 review。
- 当前源码候选由真实 Pi 入口加载，合成 custom-message triggerAgent 场景验证不报错、任务 partial 且可归档；隔离运行不更新已安装扩展。若真实 TUI 条件不足明确记录受阻，不能把 mock 当成真实验收。
- 测试日志只存临时目录，收尾清理测试资源。

## Pi 当前验收结果
- 已完整检查源码与测试 diff，`git diff --check` 通过。
- 独立重跑：106/106 tests、typecheck、build、package:smoke 全部通过。
- 真实 Pi 1.4.0 TUI + 本机合成 SSE：已安装旧版本同场景复现报错；开发候选 custom 无 prompt 不再报错、partial 原因正确、正常归档；随后普通输入完整观测，3 次状态查询未新增模型请求。
- 全新 Claude Code high 复审已返回：Medium 确认 custom 启动后 originalUserConsumed=false 会把首条 steer/follow-up 当原始输入。候选暂不通过，继续同范围窄修。

## 复审后窄修
- 在 onAgentStart 非 continuation 且 withoutPrompt 时标记 originalUserConsumed=true，custom 启动不存在原始 user 消息，不应吞掉首条实际交付的 steer/follow-up。
- 补 custom 启动后 steer 正确消费队列且不成为 promptSummary、follow-up 按实际交付拆任务、pendingNormals 不被误消费的回归。
- 精确限定原“标记不残留”测试名称或补事件未到 agent_start 时的重置覆盖。
- 全量重跑并重新真实 TUI 验证 custom 后 steering/follow-up；原验收不能覆盖窄修后候选。
- 窄修实际完成；Pi 已检查新增 diff，110/110 tests、typecheck、build、package smoke 通过。
- 窄修后真实 Pi 1.4.0 TUI 已通过 custom/普通输入/steering/follow-up；steering 交付正确，follow-up 独立历史与共享 Run 正确，无 Extension 错误，查询无额外模型请求。测试服务与进程已停止。
- 全新 Claude Code high 针对性复核完成：原 Medium 已解决，无 Blocker/High/Medium；本机候选验收通过。剩余非阻断 Low 为连续异常缺失事件可能导致标记残留，详见 HANDOVER。设计文档已补窄修语义；用户后续单独授权本地 commit，未授权 push 或安装更新。
