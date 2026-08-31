# 任务清单: dev004 review 修复（P1-A/P1-B/P2/P3）

## P1-A 前端硬止损入口
- [√] 1.1 三个控制台加 max-loss 输入框；start/start-recovery payload 注入 recoverMaxLossUsd；总览卡渲染止损线

## P1-B 硬止损覆盖独立回收模式
- [√] 2.1 bot.js _checkMaxLoss 门条放开（outOfRangeAction!=='recover' 且非 recovery 才返回；outOfRange 或 recovery 任一即可）
- [√] 2.2 startRecovery config 加 recoverMaxLossUsd

## P2 总览广播补 lr
- [√] 3.1 server.js 1s SSE 广播构造含 lr

## P3 尘埃仓守卫
- [√] 4.1 _handleFill 部分成交 < minOrderSize 跳过补挂对腿 + 提示；start() config 加 minOrderSize

## 测试
- [√] 5.1 safety-progress 新增 3 例（recover 硬止损/独立回收硬止损/尘埃仓），全量通过 + lint 干净

## 版本与文档
- [√] 6.1 version 1.4.1；CHANGELOG；wiki；提交推送 dev004
