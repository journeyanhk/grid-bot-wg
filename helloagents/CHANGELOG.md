# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.5.5] - 2026-09-02

### 修复（dev004-dy review11+12）
- 审计锚点：start() 与库存基线同刻锚定 _auditBuysBase/_auditSellsBase（成交计数跨重启累计，重启前成交被双重计数成假漂移）；快照持久化、旧快照缺省=从恢复时刻重新对账
- 审计公式改全带符号（修空头基线假警/方向翻转漏报）；告警带所名（两所同时叫时分得清）
- 空快照升级为健康事件：Extended 空快照持续 >3 分钟置 operationalIssue（仪表盘变红/哨兵可见），快照恢复时清除

### 变更
- 盲飞期间暂停开仓侧补单：暂缓（review12 建议观察一次完整自愈周期后再定）

## [1.5.4] - 2026-09-02

### 修复（dev004-dy review10）
- P1 订单重现清除 gone 状态：Extended 订单在 open-orders 快照中重现时，同步清零 goneFirstAt/_lastProbeAt（此前只清了 goneAttempts，10 分钟耐心被一次预热毛刺预支，后续瞬时快照抖动会"零等待"批量判死档位）
- P2 适配器层空快照守卫：Extended _poll 在"快照为空但本地跟踪≥10"时视为接口异常快照，本轮跳过 gone 判定（不启动/累积耐心计时），镜像 bot 层 reconcile 的 massVanish 逻辑，消除服务重启预热期批量误判
- 修复 1/2 共同闭合"服务重启后 10 分钟惊吓"的缺口（随常规发版，不为此单独重启）

### 变更
- (review9 判定挂单 136-140 震荡为正常不变量，无需改动)

## [1.5.3] - 2026-09-02

### 修复（dev004-dy review8）
- P1-a 库存审计阈值：容忍从 gridCount 格(140→无意义)改为 max(2, gridCount×3%)（140格→5格），能抓住 21 格事故；新增 _invBase 库存基线（start/resume 记录、快照持久化），保留持仓重启不误报已知遗留库存
- P1-b 费率：`Number(...)||0.0005` 吞掉合法零费率 → 改 Number.isFinite 区分"零"与"未知"，Extended/RHC 虚假手续费告警真正消除
- P2-a 成交流水探测 30s 节流（避免 20 单未决时每秒 8 请求加剧 API 滞后为限流雪崩）
- P2-b goneFirstAt 复活后清零（二次消失重新计时）
- P2-c 确认撤销恢复事件（措辞含"取消"命中撤单熔断，Extended 撤单风暴不失明）

### 变更
- 测试新增：带基线重启不误报；库存审计测试改用新容差语义

## [1.5.2] - 2026-09-02

### 修复（Extended 挂单衰减，Review7）
- _resolveGone 耐心改为时间制（10 分钟），修复夜间 API 结算滞后下把"实际已成交的买单"误判为"已撤销"导致档位永久空洞 + 库存漂移（Starknet 成交确认，21 档被丢根因）
- 新增成交流水第二证据源（/api/v1/user/trades，尽力而为：命中即确认成交并按真实价/量入账）
- 静默丢弃改响亮告警 + droppedLevels 计数（明确"该档位已空洞，请核对并考虑重启补齐"）
- 修复 2：30 秒对账新增库存漂移审计（实际持仓 vs 成交流水推导，超容差告警，把静默漏气变可见）
- 修复 3：Extended 展示费率与签名 maxFee 分离（displayFeeRate=maker0），消除"间距不足手续费"虚假告警

### 变更
- 测试新增：库存漂移审计（±N 格容差 / 超阈值告警）

## [1.5.1] - 2026-09-01

### 修复（dev004-dy review6）
- P1-a: restore() 现在启动动态监督器——崩溃重启后持久化恢复的自动停机态可被冷静门消费（此前监督器失联，"跨重启自动重启"失效）
- P1-b: stats 重建基对象包含 recenters/autoRestarts，修复旧快照缺失键导致 NaN 计数静默丢失；resetStats 保留动作计数（非盈亏统计）
- P2-a: 分支 A 漂移重定排除 outOfRange/recover 态（回收阶梯挂着时不重定，状态机不被搅浑）
- P2-b: width 显式取 upper-lower；alignToStep 分支 A 传 this.grid.spacing、分支 B 仅按 stepPrice 对齐（buildGrid 重算 spacing）

### 变更
- P3-②: 分支 B 统一读 as.config（停机时点配置），防停机态后再改 config 造成不一致
- 测试新增 P1-a 例（restore 后监督器工作）

## [1.5.0] - 2026-08-31

### 新增
- 动态网格（基于 90 天回测：冷静门控自动重启为价值主体，漂移重定影子优先）：
  - 分支 B：破界/止损自动停机后，冷静门（近 5 日动量 ≤3%）满足才自动重启，区间以现价居中（走完整 start()，继承保证金预检/撤单确认/AIMD 配速）
  - 分支 A：价格漂移 + 净库存平 + 冷静门 + 冷却满足才漂移重定（默认影子模式，只告警不执行）
  - 安全语义：动态层零新增下单路径，仅复用 start()/adjustRange()
- 配置：dynamic { enabled/shadow/driftFrac/invGateGrids/recenterCooldownMin/restartEnabled/restartCooldownMin/calmWindowH/calmMaxMovePct }
- 自动停机语义：手动 stop/撤单/平仓取消自动重启（永不自动重启）；自动停机状态随快照持久化跨重启保留
- 前端：四所控制台"动态网格"折叠区 + 总览卡动态计数/自动重启待命状态

### 变更
- 配置数值解析用 Number.isFinite 尊重显式 0（原 || 兜底把 0 当未设置）

## [1.4.6] - 2026-08-31

### 修复
- 虚假手续费告警：RHC 零费率（maker/taker=0）不再被默认 0.0005 覆盖条件跳过，_loadMarkets 在有市场费率数据时一律覆盖 feeRate

### 变更
- 平仓腿优先级：重试队列出队时 reduce-only/平仓腿排最前，限额紧张时止盈腿不被远端铺单饿死
- AIMD 自适应配速：批间间隔从固定 1.5s 改为自适应——撞限乘性减半（封顶 40s）、成功向基线收敛，自动贴合 RHC 真实限额
- 批量 429 日志降噪：限流不再走告警通道，改 INFO 聚合（"剩余 X 单待铺"）
- 启动预估时长改用自适应配速现算（消除"预计 40 秒、实际 5 分钟"落差）

## [1.4.5] - 2026-08-31

### 修复
- market.js 浮点缺陷：三处 `10 ** -decimals` 改为 `1 / 10 ** decimals`（平台无关）——`10 ** -N` 在部分 V8 下产生 `0.00000999…` 污染 stepSize/stepPrice 元数据，并导致 npm test 在换机器时红
- setPollLight 恢复改为反映剩余铺单进程数（避免重试 drain 与成交补单重叠时提前恢复重轮询）

### 变更
- 无

## [1.4.4] - 2026-08-31

### 修复
- RHC 铺单限流自激（429 风暴）：批量配速从 0 加到 1.5s、重试地板 1s→5s、_confirmAccepted 由单次 350ms 改为多轮等待（合计 ~5.7s）部分确认、铺单期间轮询降载（setPollLight）、写请求最小间隔 ~1.1s 保险带
- 启动铺单按"离现价近者优先"排序（限流时首批即能开始工作）
- 启动告警标注预期铺单时长（限流保护配速，勿中途停止）

### 变更
- SAFE_GRID_BATCH 10→15（与 MAX_BATCH 对齐，140 单 14 批→10 批）

## [1.4.3] - 2026-08-31

### 修复
- RHC 市场下拉无数据：header 缺失 hdr-lr / hdr-lr-dot 徽标，loadMarkets 中 $('hdr-lr').textContent 抛 null 错误导致市场列表加载中断
- loadMarkets 加防御守卫：header 徽标缺失时不再阻断市场加载（避免同类半接线再次中断）

## [1.4.2] - 2026-08-31

### 修复（dev004 review2 反馈）
- **RHC 前端面板整体缺失（阻断级）**：补齐 tab-lr 面板（克隆自 rs 面板，全部 lr-* 控件）、导航按钮、dot-lr/panel.lr/ov-card.lr CSS 与 --lr-color 变量、switchTab 数组加 lr——此前 makeExchangeCtrl('lr') 因 $('lr-modes') 为 null 抛 TypeError 导致全站脚本崩溃（总览 SSE 不刷新）
- 防御性守卫：makeExchangeCtrl 入口缺面板时跳过初始化（不再中断后续脚本）；两处 start payload 的 max-loss 加 null 守卫
- 图表颜色补 lr 分支（不再落到 RISEx 同色）

## [1.4.1] - 2026-08-31

### 修复（dev004 review 反馈）
- 破界硬止损真正可用：前端新增硬止损输入框（max-loss）并注入 start / start-recovery payload；_checkMaxLoss 门条放开，覆盖独立回收模式（outOfRange=false 场景）
- 总览 1s SSE 广播补上 lr（此前 RHC 总览卡首帧后永不刷新）
- 尘埃仓守卫：部分成交低于最小下单量时跳过补挂对腿（避免对腿被拒 + 无意义重试 + 告警噪音）

### 变更
- start() config 增加 minOrderSize（尘埃仓守卫数据源）；独立回收模式支持 recoverMaxLossUsd
- 测试新增 3 例：recover 硬止损 / 独立回收硬止损 / 尘埃仓守卫

## [1.4.0] - 2026-08-31

### 新增
- **RHC Lighter 交易所接入**（Robinhood Chain，第 4 所）：配置/服务端/前端接线、Python 签名器（signer_worker.py 离线签名）、测试
- **破界出口纪律**：recover 模式新增 `recoverMaxLossUsd` 硬止损——未实现亏损达到上限自动撤单+平仓+停止（recover 本身不止损，此值为单边行情提供硬退出线）
- 部分成交记账修复：Lighter 订单"部分成交后被撤"现补发 fill，消除库存静默漂移

### 变更
- Lighter 轮询 5s→2s，降低成交/补单延迟（完整 /stream WS 推送需 RHC 协议文档，暂以快速轮询替代，已标注）
- 快照/对账/AI 快照扩展到 4 所；outOfRangeAction 新增 recoverMaxLossUsd 参数

### 注意
- RHC 实盘需 Python 环境 + lighter-sdk（1.1.2）；部署见 README

## [1.3.1] - 2026-08-20

### 修复
- 登录弹窗重复弹出：并发 apiFetch 在鉴权模式探测完成前收到 401，误走旧的令牌 prompt 分支导致多次弹窗。改为 401 先等待模式探测（authProbe）再分流，非 token 模式不弹 prompt，登录框幂等（已在显示则不重复弹）

## [1.3.0] - 2026-08-19

### 新增
- 账号密码鉴权（DASHBOARD_USER/DASHBOARD_PASS）：/api/login 换取会话令牌（默认 12h，DASHBOARD_SESSION_MS 可调），登录弹窗 UI + 退出按钮；DASHBOARD_TOKEN 静态令牌模式保留为兼容回退
- 主题自动切换：跟随系统 prefers-color-scheme 白天/夜晚，header 图标按钮可手动覆盖（localStorage 记忆）
- 极简扁平化：统一圆角变量、按钮去除渐变、弱化立体感
- 移动端响应式（iPhone）：网格单列化、触控目标放大、iOS 聚焦防缩放、小屏隐藏次要信息

### 变更
- /api/version 豁免鉴权（仅元数据，供前端探测鉴权模式）

## [1.2.3] - 2026-08-19

### 修复
- Decibel 第 1+2 层死循环防护：
  - 撤单重试：cancelAll/cancelOrder 单笔失败 1s/2s 退避重试 3 次（链上瞬时拥堵常见），不再一失败就中止整个停止流程
  - 幽灵单快速清理：_resolveGone 提交后未被交易所确认的订单 3 轮（约 6-8s）即清理，明确"不视为成交、不补单、不撤单"
  - 回收阶梯撤单跳过幽灵单：只对交易所真实挂单簿中存在的订单发链上撤单，避免对不存在订单发撤单被拒、浪费 gas 并累积错误

### 变更
- 测试新增 decibel-safety（5 例），总计 49 例

## [1.2.2] - 2026-08-18

### 变更
- 对齐原版保守设计：移除 Extended/RISEx（live + paper）适配器的 supportsSafeOpeningRetry，开仓单失败不再自动重试（缺格通过挂单进度可见 + 一键补格人工补齐），消除挂单快照抖动下重复挂单的风险

### 修复
- 无

## [1.2.1] - 2026-08-18

### 新增
- 总览页持仓展示：每所卡片显示当前持仓（方向/数量/杠杆、均价、强平价、未实现盈亏）
- 总览页运维异常提示（operationalIssue + API Wallet 地址），与单所控制台一致

## [1.2.0] - 2026-08-18

### 新增
- 移植原作者最新版安全机制：一键补格 refillGrid、撤单确认（_cancelAllConfirmed 轮询交易所确认消失）、开仓单安全重试 + 挂单进度跟踪（placementProgress，两次权威快照去重）
- 适配器安全增强：撤单失败保留本地跟踪（确认后 forgetOrder 清理）、malformed 挂单快照不视为 0 单
- Decibel 友好错误翻译（operationalIssue）：gas 不足时仪表盘直接显示中文原因 + API Wallet 地址可一键复制
- 持仓展示增强：强平价（liquidationPrice）显示
- 前端：三个控制台"一键补格"按钮、挂单进度/交易所核实挂单数展示
- 测试：cancel-safety（10 例）+ safety-progress（5 例，补格/进度/安全重试/停止中止），总计 44 例

### 变更
- 保留既有安全与修复：VPS 鉴权、XSS 转义、结构化日志、ESLint、RISEx 余额/杠杆/撤单三项修复

## [1.1.3] - 2026-08-14

### 修复
- RISEx 杠杆设置失效：risex-client SDK 的 `updateLeverage` 请求体键名与服务端协议不匹配（发 `permit`，服务端要求 `permit_params`，实测 400），且杠杆值需 WAD 放大（×1e18）。已绕开 SDK 该方法，用其签名原语自组装请求

## [1.1.2] - 2026-08-14

### 修复
- RISEx 余额单位再修复：`balance` 字段单位在账户间不一致（有的原始 18 位单位、有的直接人/币单位），改为阈值启发式归一化（>1e12 视为原始单位 ÷1e18），并记录原始值便于排查

## [1.1.1] - 2026-08-14

### 修复
- RISEx 余额单位换算 bug：余额接口返回原始 18 位小数单位，此前直接当作人/币单位导致余额显示天文数字、保证金预检失效；现除以 1e18 并做 NaN 防御
- RISEx 余额读取失败不再静默：写入结构化日志，便于排查"无法读取余额"（账户无余额记录时接口返回 500）

### 新增
- 版本号机制：/api/version 端点 + 仪表盘右上角展示当前版本（随 package.json 自动更新）

## [1.1.0] - 2026-08-14

### 新增
- HTTP 鉴权：DASHBOARD_TOKEN 静态令牌（前端会话保存、SSE 支持 query token）+ Origin 白名单 + Host 回环校验，阻断 DNS rebinding / CSRF / 未授权访问
- 前端 XSS 转义：esc() 统一转义外部数据（交易所市场名、AI 输出、错误消息）
- bot.js 核心逻辑单元测试（内存 mock 交易所：铺单/补单链/风控/reconcile/resume/保证金）
- ESLint（flat config）与 npm run lint
- 结构化日志模块 src/log.js（JSON lines + 按天轮转 + LOG_LEVEL/LOG_DIR）
- README VPS 部署安全建议章节

### 修复
- 依赖漏洞：ws（ethers ← risex-client 传递依赖）内存泄露/DoS 漏洞修复

### 变更
- 全部 /api/* 端点受鉴权保护（配置 DASHBOARD_TOKEN 时）
- 关键事件日志从 console 迁移至结构化日志

### 移除
- （无）
