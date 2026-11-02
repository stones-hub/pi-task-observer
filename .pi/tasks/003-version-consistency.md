# 版本一致性修正

用户明确授权修改版本、验证、commit、push、创建并推送 v0.1.2 tag、更新本机扩展；不创建 GitHub Release，不移动旧标签。
基线 bf328cb；已有 HANDOVER.md 未提交差异为 Pi 上次部署记录，保留。
允许 Claude Code（claude-opus-5-5，effort high）仅修改 package.json、package-lock.json 的本包版本为 0.1.2，不改变依赖，不修改源码测试。
Pi 维护文档、独立检查 diff，重跑 typecheck/tests/build/package smoke，打包检查版本字段一致。此次仅包元数据变化，不改变运行逻辑，已有真实 TUI 业务证据仍适用；安装后核对 HEAD、配置和包版本。不要求重复模型业务验收。
正式 commit、push、annotated tag v0.1.2 和 pi install 由 Pi 执行。中断失败立即报告不自动重试或切换执行器。
