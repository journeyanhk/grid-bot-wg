# 技术设计: 补 recenterEnabled 独立开关

## 技术方案

### 实现要点

**语义定义（分支放行矩阵）**

| shadow | recenterEnabled | restartEnabled | 实际行为 |
|---|---|---|---|
| true | — | — | 全影子（A/B 只记样本） |
| false | false | true | **B 实盘 + A 影子**（毕业中间态） |
| false | true | false | A 实盘 + B 关闭 |
| false | true | true | A+B 全实盘 |
| false | false | false | 无分支放行（仅记样本） |

- 分支 A 执行条件：`!dyn.shadow && dyn.recenterEnabled`；否则落影子记录分支（保留 A 的"本应重定"样本采集，供 3 样本评审）
- 分支 B 执行条件不变：`!dyn.shadow && dyn.restartEnabled`（不受 recenterEnabled 影响）

**观测（"查不到的配置迟早变成查不出的事故"）**
- `_dynModeText()` → `未启用 / 影子 / 实盘·自动重启 / 实盘·漂移重定 / 实盘·自动重启+漂移重定 / 实盘·无分支放行`
- 用于：start() 启动告警、_startDynTimer 心跳日志、getState（总览摘要 renderDynSummary）

**默认值决策（ADR）**
- `recenterEnabled` 默认 **false**：毕业路径"先开关后放行、先 B 后 A"；缺省值必须偏向不执行 A，否则"忘勾选"= 未评审即放行
- 前端复选框默认未勾选（与配置缺省一致）；localStorage 持久化随其余 dyn 字段

## 测试与部署
- **测试**: dynamic.test.js 4 用例补显式放行 + 3 新用例（中间态不执行/记样本、B 独立、文案矩阵）；npm test 全绿
- **部署**: 主 VPS 重启即可；动态配置"启用✓ 影子✓ 自动重启✓，漂移重定不勾"= 现状不变（影子期继续）
