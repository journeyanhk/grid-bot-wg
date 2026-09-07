# 变更提案: Entropy(HL) 第5交易所接入 + 总览过滤

## 需求背景

1. **新增交易所 Entropy**：`io:ANTH` 美股网格（Hyperliquid HIP-3 建设者市场，"io" dex）。两周实测 ANTH σ_day 1.91%、价格 1,877–2,020 横盘、OI $18.4M（io dex 最深），是当前最接近网格理想环境的市场。预研结论（wg005-desgin1.md）：用官方 Hyperliquid SDK/API 接入，加 `dex:"io"` 命名空间。
2. **总览页过滤**：当前总览固定渲染 4 张卡片（de/ex/rs/lr），其中 paper 模式/无资金/未运行的所（当前 LR 即 paper）占用界面。用户希望只展示**有金额在运行**的交易所，更清晰。
3. **分支策略**：基于 dev004-dy 开发，完成后提交到 dev005。

## 变更内容

1. **HL 适配器（`src/exchange/hl/` 六文件）**：market.js（metaAndAssetCtxs + candleSnapshot，`dex:"io"`）、signer_worker.py（hyperliquid-python-sdk + agent wallet）、signer.js（spawn Python 签名桥，沿用 lr 模式）、hyperliquid.js（轮询 clearinghouseState/frontendOpenOrders/userFills 游标增量）、paper.js（模拟）、index.js（工厂）。
2. **系统接线**：config.js 增 hl 块、server.js 全触点（import/实例化/SSE/路由/overview/init/resume/预检）、前端 index.html 全套 hl 前缀（tab/面板/卡片/徽章/CSS/switchTab/makeExchangeCtrl/遍历/配色/modes）。
3. **总览过滤**：renderOverview 按 `mode==='live' && balance>0 && running` 隐藏非运行卡片，汇总区只统计可见所。
4. **branch**：dev004-dy → dev005 承载全部开发。

## 影响范围

- **模块**: exchange/hl(新), config, server, frontend(index.html), ai/service(可选)
- **文件**: `src/exchange/hl/*`(新), `src/config.js`, `src/server.js`, `public/index.html`, `.env.example`, `package.json`, `helloagents/*`
- **API**: `/api/hl/*`(新), `/api/overview`(改), `/api/overview/stream`(改)
- **数据**: 无（独立账户、独立市场）

## 核心场景

### 需求: 新增 HL 交易所接入
**模块:** exchange/hl + server + frontend
接入 Hyperliquid io dex，支持 io:ANTH 美股网格，与现有四所同实例运行。

#### 场景: HL 市场接入
配置 HL_MODE=live 后，总览/控制台出现第5所，市场表含 io:ANTH。
- 预期结果: `/api/hl/markets` 返回 io dex 市场；下单/撤单/查询走 Hyperliquid 官方 API（dex:"io" 命名空间）；userFills 游标增量确认成交。

#### 场景: 逐仓模式
ANTH 强制逐仓（最大杠杆 6x）。
- 预期结果: 仓位/强平价/保证金从 isolated position 读取展示；GridBot 感知层兼容。

#### 场景: 签名安全
agent wallet 授权"只能交易、不能提现"的代理私钥。
- 预期结果: 签名器只持 agent key，命令面仅 place/cancel/updateLeverage，其余不暴露。

### 需求: 总览过滤
**模块:** frontend
只展示有金额在运行的交易所（live + balance>0 + running），隐藏 paper/无资金/未运行所。

#### 场景: 隐藏非运行所
LR 为 paper（无资金）时不显示其卡片。
- 预期结果: 总览只显示 DE/EX/RS（当前 live），LR 卡隐藏；汇总区只统计可见所。

#### 场景: 运行态变化
某所由 running → stopped 或 balance 归零。
- 预期结果: 该所卡片自动隐藏，不残留空卡。

## 风险评估

- **风险**: HL 是全新交易所 API，市场解析/逐仓字段/fills 游标未经验证
  - **缓解**: 单元测试 + paper 适配器先行验证 + 主网 $150 小额试点
- **风险**: 同实例第5所 = 每次发版全员重启（设计文档倾向独立实例 8087）
  - **缓解**: 用户已确认同实例方案；v1.5.9 后 restart 是安全操作；保持所有所 restart 安全语义
- **风险**: hyperliquid-python-sdk 依赖需安装（venv），agent key 管理
  - **缓解**: 沿用 lr signer_worker.py 模式（spawn 子进程 + env 注入，私钥不落磁盘）
- **风险**: 前端 hl 前缀大量硬编码，遗漏接线导致全站崩溃
  - **缓解**: 逐条对照 lr 接线清单；面板缺失守卫已有（makeExchangeCtrl 首行）
- **风险**: 总览过滤改动汇总区（tot-running /3 硬编码、tot-modes 只列 de/ex/rs）
  - **缓解**: 改为动态统计可见所；顺带修复 tot-modes 漏 lr 的历史 bug