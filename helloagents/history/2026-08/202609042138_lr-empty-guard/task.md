# 任务清单: review16 LR 补两条 EX 防线

## P1 重现清零计时
- [√] 1.1 _refreshOrders seen 分支加 goneFirstAt=0（防快照毛刺残留计时 -> 二次消失幻影推定成交）

## P2 空快照守卫
- [√] 2.1 _emptyStreakStart 模式：空快照+tracked>=10 本轮不做 gone 判定，>3min 升级 operationalIssue

## 测试
- [√] 3.1 lighter 新增：重现清零 / 空快照轮不删跟踪不启动计时不触发推定
- [√] 3.2 npm test 退出码 0 + lint 干净；提交推送
