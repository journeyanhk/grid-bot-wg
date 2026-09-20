# 变更提案: 补 recenterEnabled 独立开关（动态网格分支 A 放行闸门）

## 需求背景

Review21（9·18 暴涨夜复盘）结论：程序零瑕疵，影子交出首份"本应重定"正样本（21:39 全门通过，事后验证新上沿 82,050 可容纳当日全部行情）。但暴露一个旧欠账——**当初设计的 `recenterEnabled`（分支 A 独立开关）从未实装**（merge 后全库 grep 无此标识）：

- `shadow=false` 会**同时放行 A（漂移重定）、B（冷静门自动重启）两个分支**；
- 正确毕业路径是"**先 B 后 A**"：先放行 B（破界自动回场，冷静门代行纪律），A 带首个正样本继续影子攒到 3 个样本再评审；
- 没有独立开关就无法表达"B 实盘 + A 影子"的中间态——这是放行顺序的硬前提。

## 变更内容

1. **bot.js**：配置归一化增 `recenterEnabled`（默认 **false**，显式启用才放行 A）；分支 A 执行条件改为 `!shadow && recenterEnabled`，未放行时仍记录"本应重定"影子样本（注明"漂移重定未启用"）；getState 动态摘要暴露 `recenterEnabled/restartEnabled`；新增 `_dynModeText()`（启动告警/监督器心跳/总览摘要共用，明确展示分支放行状态）。
2. **前端**：6 个控制台（de/ex/rs/lr/hl/va）动态面板增"漂移重定"复选框（默认未勾选）；localStorage 持久化列表纳管；两处 start payload 带 `recenterEnabled`；总览动态摘要显示"影子 / 实盘·重启 / 实盘·重启+重定"。
3. **测试**：4 个既有用例补显式 `recenterEnabled: true`（语义收紧后 A 需显式放行）；新增 3 条：A 开关关闭不执行且仍记样本、B 不受 A 开关影响（先放行 B 的毕业路径）、`_dynModeText` 文案矩阵。

## 影响范围

- **模块**: bot（动态网格监督器）、web（6 控制台面板）
- **文件**: `src/bot.js`、`public/index.html`、`test/dynamic.test.js`
- **API**: start/adjust payload 增可选字段（向后兼容：缺省 = A 不放行）
- **数据**: 快照 config.dynamic 增字段（缺省安全）

## 核心场景

### 需求: 分支 A 独立放行
**模块:** bot

#### 场景: 中间态（B 实盘 + A 影子）
`shadow=false + restartEnabled=true + recenterEnabled=false`
- 预期结果: B 照常自动重启；A 不执行 adjustRange，但记录"本应重定"影子样本

#### 场景: A 显式放行
`shadow=false + recenterEnabled=true`
- 预期结果: A 执行漂移重定，计数 +1

## 风险评估

- **风险**: 默认 false 改变既有 `shadow=false` 行为（升级后 A 不再自动执行）
  - **缓解**: 生产当前 shadow=true（无行为变化）；这正是纪律要求的"显式放行"，旧快照缺字段 = 安全缺省
- **风险**: 前端 6 面板重复改动漏一处
  - **缓解**: check:html 交叉核对（重复 id/面板/P() 引用/残缺标签）+ 逐面板正则断言 6 处
