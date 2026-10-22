# 任务清单: Entropy(HL) 第5交易所接入 + 总览过滤

目录: `helloagents/plan/202609071613_entropy-hl/`

---

## 0. 分支与版本
- [√] 0.1 从 dev004-dy 切出 dev005 分支
- [√] 0.2 版本号 1.5.11 → 1.6.0（新功能 minor+1）

## 1. 总览过滤（先行，独立提交）
- [√] 1.1 在 `public/index.html` renderOverview(2123) 遍历处：按 `d.mode==='live' && d.balance>0 && d.running` 过滤，不满足的所隐藏 `.ov-card`（display:none），验证 why.md#需求-总览过滤-场景-隐藏非运行所
- [√] 1.2 汇总区动态化：`running` 计数只累加可见所；tot-modes(2204) 改为动态遍历可见所并顺带补上 lr，验证 why.md#需求-总览过滤-场景-运行态变化

## 2. HL 适配器（`src/exchange/hl/`）
- [√] 2.1 新建 `src/exchange/hl/market.js`：parseMarkets/metaAndAssetCtxs(dex:io)/candleSnapshot/toExchangeInteger/最小名义 $10，验证 why.md#需求-新增-HL-交易所接入-场景-HL-市场接入
- [√] 2.2 新建 `src/exchange/hl/signer_worker.py`：hyperliquid-python-sdk + agent wallet，命令面 place/cancel/updateLeverage(isolated=true)，读 HL_* env
- [√] 2.3 新建 `src/exchange/hl/signer.js`：HLSignerBridge spawn 桥（复制 lr/signer.js 模式）
- [√] 2.4 新建 `src/exchange/hl/hyperliquid.js`：HLExchange extends EventEmitter，轮询 clearinghouseState/frontendOpenOrders/userFills(游标)/markPx，AIMD 配速复用
- [√] 2.5 新建 `src/exchange/hl/paper.js`：模拟适配器
- [√] 2.6 新建 `src/exchange/hl/index.js`：createExchange 工厂（按 mode 选 live/paper）

## 3. 系统接线
- [√] 3.1 在 `src/config.js` 增 hl 块（HL_MODE/HL_AGENT_PRIVATE_KEY/HL_ACCOUNT_ADDRESS/HL_DEX/HL_PYTHON/HL_FEE_RATE/HL_PROXY）并加入 return
- [√] 3.2 在 `src/server.js` 全触点接线：import/实例化+GridBot/SSE 集合/handler/路由分发/overview 两处/init/resume/凭据预检
- [√] 3.3 在 `public/index.html` 全套 hl 前缀：tab 按钮/tab-hl 面板/ov-hl 卡片/hdr-hl 徽章/CSS/switchTab 数组/makeExchangeCtrl/总览遍历/图表配色/modes join
- [√] 3.4 在 `.env.example` 增 HL_* 块（含 DEX=io 注释）

## 4. 安全检查
- [√] 4.1 私钥处理：agent key 仅 env 注入 spawn 子进程，不落日志/磁盘；命令面白名单；确认无明文密钥写入

## 5. 文档更新
- [√] 5.1 更新 `helloagents/CHANGELOG.md`（1.6.0）
- [√] 5.2 更新 `helloagents/wiki/modules/exchange.md`（新增 hl 模块 + 接线变更 + 总览过滤）
- [-] 5.3（bot.js 无感知层改动，逐仓字段由适配器提供，不涉 bot.md） 更新 `helloagents/wiki/modules/bot.md`（如涉感知层逐仓字段）
- [√] 5.4 更新 `helloagents/history/index.md` + 迁移方案包至 history

## 6. 测试
- [√] 6.1 新建 `test/hl.test.js`：市场解析/逐仓字段/fills 游标（mock globalThis.fetch，模式同 lighter.test.js）
- [√] 6.2 运行 `npm test` 退出码 0（全量 7 套件）+ `npm run lint` 干净
- [√] 6.3 paper 模式冒烟：HL 以 paper 启动，控制台可操作，总览过滤正常

## 7. 提交与推送
- [√] 7.1 总览过滤独立提交（先）
- [√] 7.2 HL 接入独立提交（后）
- [√] 7.3 推送 origin/dev005

---

## 任务状态符号
- `[ ]` 待执行 / `[√]` 已完成 / `[X]` 执行失败 / `[-]` 已跳过 / `[?]` 待确认