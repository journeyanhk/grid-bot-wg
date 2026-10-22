# 任务清单: 关闭 Extended/RISEx 开仓单安全重试（轻量迭代）

## 1. 改动
- [√] 1.1 移除 ex/extended.js、rs/risex.js 及三个 paper 适配器的 supportsSafeOpeningRetry（对齐原版：仅 Lighter 开启）
- [√] 1.2 说明：bot.js 守卫读取保持，未配置即走"开仓失败不自动重试"路径；进度跟踪 + 一键补格兜底

## 2. 版本与文档
- [√] 2.1 version 1.2.2；CHANGELOG；exchange.md 已知问题补充

## 3. 验证
- [√] 3.1 lint + 44 例测试全绿（safety-progress 用例用 MockExchange 显式开启，仍测 bot 机制本身）
- [√] 3.2 提交推送 dev003（代理 10808）
