# 变更历史索引

本文件记录所有已完成变更的索引，便于追溯和查询。

---

## 索引

| 时间戳 | 功能名称 | 类型 | 状态 | 方案包路径 |
|--------|----------|------|------|------------|
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
