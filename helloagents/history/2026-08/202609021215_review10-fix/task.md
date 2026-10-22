# 任务清单: review10 修复（重启预热毛刺，2 项）

## 修复 1 (P1) 订单重现清 gone 计时
- [√] 1.1 extended.js _poll 中订单在 open-orders 重现时，清零 goneFirstAt/_lastProbeAt（补上 v1.5.3 P2-b 漏掉的快照直接看到这条路径）

## 修复 2 (P2) 适配器空快照守卫
- [√] 2.1 extended.js 空快照但 tracked≥10 时跳过 gone 判定（镜像 bot reconcile massVanish）

## 验证与版本
- [√] 3.1 其他适配器核对：Decibel/RISEx 用计数制且重现即清零、bot 层 massVanish 兜底，无同病
- [√] 3.2 npm test 退出码 0 + lint 干净；version 1.5.4；CHANGELOG/wiki；提交推送 dev004-dy
