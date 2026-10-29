# 更新日志

## [0.2.0] - 2026-10-29

精力机制修正：不再把闲聊算成干活，恢复等待从 12 小时缩短到 1 小时。

### 变更

- 精力恢复的等待时长 `ENERGY.idleRecoverAfter` 从 12 小时改为 1 小时。
- 「干活」的判据改为这一轮有没有工具调用：新增 `session.toolsInTurn`，由 `tool/result` 累加（成功、失败都算）；`settleTurn` 遇到 `tools === 0` 的轮次直接返回，既不扣精力，也不给收尾奖励。
- 恢复计时改用新增的 `state.lastWorkAt`（只在干完一轮活时更新），闲聊不再推迟恢复；`project` 里缺该字段时回退 `updatedAt`。
- README / DESIGN 的规则表同步；单测从 33 例扩到 35 例（新增「闲聊不扣精力」「闲聊不推迟恢复」）。

### 升级

- 覆盖安装即可，`state.json` 无需迁移（旧文件缺 `lastWorkAt` 会自动用 `updatedAt` 兜底）。
- 重启 DSH 生效。

## [0.1.0] - 2026-10-28

首个版本：三个连续变化的状态（cortisol / energy / dopamine），由会话事件驱动、随时间衰减，越界时才向系统提示注入一句话。
