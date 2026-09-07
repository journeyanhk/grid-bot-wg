# 技术设计: Entropy(HL) 第5交易所接入 + 总览过滤

## 技术方案

### 核心技术
- Hyperliquid 官方 REST API（`/info` 只读 + `/exchange` 签名写），`dex:"io"` 命名空间
- hyperliquid-python-sdk（Python，agent wallet 签名）
- Node.js 沿用现有四所模式：EventEmitter 适配器 + spawn Python 签名桥

### 实现要点

**HL 适配器（`src/exchange/hl/`）**
- `market.js`：`POST /info {"type":"metaAndAssetCtxs","dex":"io"}` 拉市场表（szDecimals/maxLeverage/onlyIsolated/最小名义 $10）；K 线 `candleSnapshot`；HIP-3 资产按 `"io:ANTH"` 名称寻址（SDK 自动解析，不手算 asset id）
- `signer_worker.py`：`import hyperliquid` SDK，读 `HL_*` env；命令面 place/cancel/updateLeverage(isolated=true)，其余不暴露；agent key 只持"可交易不可提现"权限
- `signer.js`：`HLSignerBridge`，spawn python 子进程 + JSON-lines 协议（完整复制 lr/signer.js 模式）
- `hyperliquid.js`：`HLExchange extends EventEmitter`，轮询三件套均带 `dex:"io"`：
  - `clearinghouseState`（逐仓仓位/保证金/强平价）
  - `frontendOpenOrders`（活跃挂单）
  - `userFills`（**带游标增量，成交检测权威源**——EX/LR 三层证据链在此不需要，穿越推定可省）
  - 价格取 assetCtxs 的 markPx
  - AIMD 配速层复用（HL 限流 ~1200 权重/分）
- `paper.js`：模拟适配器（内存撮合+合成 K 线）
- `index.js`：`createExchange(cfg)` 按 mode 选 live/paper

**GridBot 感知层**
- 逐仓字段：强平价/保证金从 isolated position 读取并展示
- 保证金预检全仓假设在逐仓下偏保守，不改

### 接线触点（对照 lr 全清单）

**config.js**: `getConfig()` 增 `hl` 块（HL_MODE/HL_AGENT_PRIVATE_KEY/HL_ACCOUNT_ADDRESS/HL_DEX=io/HL_PYTHON/HL_FEE_RATE/HL_PROXY），加入 return

**server.js**: ①import createExchange(12-15) ②实例化+GridBot(91-99) ③SSE 集合(123-126) ④handler(282-285) ⑤路由分发(527-538) ⑥overview 两处(394-423 / 577-591) ⑦init/resume(650-655 / 678-683) ⑧凭据预检(34-66 区)

**public/index.html**: ①tab 按钮(~444) ②tab-hl 面板(复制 tab-lr 块改 id) ③ov-hl 卡片(复制 568-592) ④hdr-hl 徽章(~414) ⑤CSS 变量/`.dot-hl`/`.panel.hl`/`.ov-card.hl` ⑥switchTab 数组(1532) ⑦makeExchangeCtrl('hl','hl-chart')(1947后) ⑧总览遍历(2021/2129/2424) ⑨图表配色(1926) ⑩modes join(2204)

**总览过滤**（需求2，先行）
- `renderOverview`(2123)：遍历数组处按 `d.mode==='live' && d.balance>0 && d.running` 过滤，不满足的所隐藏对应 `.ov-card`（`style.display='none'`）
- 汇总区：`running` 计数只累加可见所；`tot-modes`(2204) 改为动态遍历可见所（顺带修复漏 lr 的 bug）

**测试**
- `test/hl.test.js`：市场解析/逐仓字段/fills 游标（mock `globalThis.fetch`，模式同 lighter.test.js）
- 总览过滤前端无单测框架，靠手工验证 + lint

## 架构决策 ADR

### ADR-1: 同实例第5所 vs 独立实例(8087)
**上下文:** 设计文档建议独立实例彻底隔离；用户选择同实例以降低部署复杂度。
**决策:** 同实例第5所（与 de/ex/rs/lr 同进程）。
**理由:** 用户明确选择；v1.5.9 后 restart 安全；省一套 systemd/nginx/域名的运维面。
**替代方案:** 独立实例 + PORT=8087 + 独立 .env → 拒绝原因: 运维面翻倍，当前规模不必要。
**影响:** 每次发版全员重启；HL 故障会影响同进程其余所（首版以 $150 小额限风险）。

### ADR-2: userFills 游标作为成交权威源
**上下文:** EX/LR 苦修三层证据链（active/inactive/穿越推定）；HL 有权威成交流水 API。
**决策:** 用 userFills 游标增量确认成交，不移植穿越推定。
**理由:** HL fills API 是权威源，穿越推定在其上冗余。
**替代方案:** 移植三层证据链 → 拒绝原因: 无必要复杂度。
**影响:** 代码更简，成交确认更准；仍需处理轮询间隙毛刺（空快照守卫照抄）。

### ADR-3: agent wallet 签名（只交易不可提现）
**上下文:** 私钥安全是 EHRB。
**决策:** 主钱包官网授权 agent wallet，签名器只持 agent key；hyperliquid-python-sdk 签名。
**理由:** 安全模型比裸私钥更干净；agent key 泄露只能交易不能提现。
**影响:** 需要主钱包一次性授权操作；命令面严格白名单。

## 安全与性能
- **安全:** agent key 经 env 注入 spawn 子进程（同 lr）；不落磁盘；命令面白名单；私钥提示走 `HL_AGENT_PRIVATE_KEY`/`HL_AGENT_PRIVATE_KEY_FILE`
- **性能:** 2 秒轮询（HL 限流 1200 权重/分压力极小）；AIMD 配速复用；userFills 游标增量避免全量拉取

## 测试与部署
- **测试:** hl.test.js 单测（市场解析/逐仓/fills 游标）；npm test 全绿；lint 干净
- **部署:** 主网前 paper 验证 → HL 测试网（若 io 市场存在）→ 主网 $150 试点 io:ANTH（1,880–2,100 / 22 格 / $10 间距 / 0.005/格 / 3x 逐仓 / recover+$30）
---

## 2026-09-07 review19 修复记录（实测校准）

P0 签名器五处、P1 市场元数据四处、P2 逻辑三处已全部修复，均基于对 HL 主网真实 API 的探测（SDK 0.24.0）：
- metaAndAssetCtxs 返回数组 [meta, ctxs]；maxLeverage 在 universe；无 pxDecimals（stepPrice = 10**-(6-szDecimals)）
- 签名器真实启动通过 health（agent wallet 假 key）；io:ANTH asset id=200001（offset 200000）
- userFills 无 cursor → userFillsByTime + startTime 增量；_filledSeen 环形上限 5000
- 详见 CHANGELOG 1.6.1

---

## 2026-09-07 review20 修复记录（三颗运行时地雷）

① Tif 是类型别名非枚举（.Gtc AttributeError）→ 字符串 "Gtc"/"Ioc"
② bulk_cancel(cancel_requests: List[CancelRequest])，元素 {"coin","oid"} 字典
③ Cloid.from_str 强制 0x+32hex（16 字节）→ JS randomBytes 生成 + 归一化 + tracked 同源
签名器请求级冒烟（假 key 真实走 SDK 0.24.0）：place_order/bulk_cancel/update_leverage 签名上送全过，非法 cloid 优雅报错。
详见 CHANGELOG 1.6.2
