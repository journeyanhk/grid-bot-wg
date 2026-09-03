# 变更历史索引

本文件记录所有已完成变更的索引，便于追溯和查询。

---

## 索引

| 时间戳 | 功能名称 | 类型 | 状态 | 方案包路径 |
|--------|----------|------|------|------------|
| 202608201012 | fix-login-popup | 修复登录弹窗重复弹出 | ✅已完成 | [链接](2026-08/202608201012_fix-login-popup/) |
| 202609031026 | review13-rebase | 审计重校准（基线锚点同刻） | ✅已完成 | [链接](2026-08/202609031026_review13-rebase/) |
| 202609021839 | review1112-fix | 审计锚点/全带符号/空快照健康事件 | ✅已完成 | [链接](2026-08/202609021839_review1112-fix/) |
| 202609021215 | review10-fix | 订单重现清 gone 计时 + 空快照守卫 | ✅已完成 | [链接](2026-08/202609021215_review10-fix/) |
| 202609021119 | review8-fix | review8 修复（审计阈值/基线/零费率/节流） | ✅已完成 | [链接](2026-08/202609021119_review8-fix/) |
| 202609021054 | extended-resolve-fix | Extended 成交确认修复（10min耐心/库存审计） | ✅已完成 | [链接](2026-08/202609021054_extended-resolve-fix/) |
| 202609011222 | dynamic-review6-fix | 动态网格 review6 修复 | ✅已完成 | [链接](2026-08/202609011222_dynamic-review6-fix/) |
| 202609011205 | dynamic-grid | 动态网格（冷静门自动重启+漂移重定） | ✅已完成 | [链接](2026-08/202609011205_dynamic-grid/) |
| 202608311641 | review5-optimize | 零费率覆盖/AIMD 配速/平仓腿优先 | ✅已完成 | [链接](2026-08/202608311641_review5-optimize/) |
| 202608311620 | market-float-fix | market.js 浮点缺陷修复（平台无关） | ✅已完成 | [链接](2026-08/202608311620_market-float-fix/) |
| 202608311611 | rhc-throttle-fix | RHC 铺单限流自激修复（六补丁） | ✅已完成 | [链接](2026-08/202608311611_rhc-throttle-fix/) |
| 202608311441 | frontend-rhc-panel | 修复 RHC 前端面板缺失（全站崩溃） | ✅已完成 | [链接](2026-08/202608311441_frontend-rhc-panel/) |
| 202608311425 | review-fixes | review 修复（硬止损可用/尘埃仓/总览广播） | ✅已完成 | [链接](2026-08/202608311425_review-fixes/) |
| 202608311355 | lighter-port | Tier1(破界止损/部分成交)+Tier2(Lighter 移植) | ✅已完成 | [链接](2026-08/202608311355_lighter-port/) |
| 202608201002 | auth-login-theme | 账号密码鉴权 + 主题/响应式/扁平化 | ✅已完成 | [链接](2026-08/202608201002_auth-login-theme/) |
| 202608191510 | decibel-safety-l12 | Decibel 第 1+2 层防护（撤单重试/幽灵单清理） | ✅已完成 | [链接](2026-08/202608191510_decibel-safety-l12/) |
| 202608191501 | disable-opening-retry | 关闭 Extended/RISEx 开仓单安全重试 | ✅已完成 | [链接](2026-08/202608191501_disable-opening-retry/) |
| 202608181353 | overview-position | 总览页持仓/运维异常展示 | ✅已完成 | [链接](2026-08/202608181353_overview-position/) |
| 202608181326 | vps-hardening-v12 | v1.2.0 移植原版安全机制（补格/撤单确认/安全重试/进度） | ✅已完成 | [链接](2026-08/202608181326_vps-hardening-v12/) |
| 202608171533 | risex-leverage | RISEx 杠杆设置修复（permit_params + WAD） | ✅已完成 | [链接](2026-08/202608171533_risex-leverage/) |
| 202608141916 | risex-balance-unit | RISEx 余额单位启发式归一化 | ✅已完成 | [链接](2026-08/202608141916_risex-balance-unit/) |
| 202608141857 | risex-balance-fix | RISEx 余额单位修复 + 版本号机制 | ✅已完成 | [链接](2026-08/202608141857_risex-balance-fix/) |
| 202608141349 | vps-hardening | 安全加固+测试+工程化 | ✅已完成 | [链接](2026-08/202608141349_vps-hardening/) |

---

## 按月归档

### 2026-08

  - [202608141857_risex-balance-fix](2026-08/202608141857_risex-balance-fix/) - RISEx 余额 1e18 单位换算修复 + 版本号展示机制
- [202608141349_vps-hardening](2026-08/202608141349_vps-hardening/) - VPS 部署安全加固（鉴权/XSS/依赖漏洞）+ bot 测试 + ESLint + 结构化日志
