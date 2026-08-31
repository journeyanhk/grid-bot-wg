# Changelog

本文件记录项目所有重要变更。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
