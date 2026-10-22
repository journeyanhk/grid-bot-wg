# 任务清单: Tier1+Tier2（Lighter 移植 + 破界止损 + 部分成交修复）

## Tier1-1 部分成交记账
- [√] 1.1 lighter.js：FINAL_REJECTED 终态检查 filled_base_amount>0 时补发 fill（de/ex 已正确，仅 lr 有此 bug）

## Tier1-2 成交延迟
- [√] 2.1 lighter 轮询 5s->2s + inactive 核对 2500->1000（完整 RHC /stream WS 需协议文档，标注为阻塞项）

## Tier1-3 破界出口纪律
- [√] 3.1 bot.js：新增 recoverMaxLossUsd 配置，recover 模式未实现亏损达上限触发硬止损（撤单+平仓+停止）

## Tier2 Lighter 移植
- [√] 4.1 拷贝 src/exchange/lr/ 六文件；config.js lr 配置块 + optionalNumber；server.js 四处接线 + 凭据预检 + proxy 键；ai/service 加 lr；scripts/windows-launcher.ps1
- [√] 4.2 前端：CSS(lr 色/panel/card)、tab 按钮、lr 控制台面板、总览卡、渲染循环与数组、makeExchangeCtrl

## 测试与验证
- [√] 5.1 搬 test/lighter.test.js（移除无用 import、补 windows-launcher.ps1），npm test 全量通过
- [√] 5.2 启动冒烟：overview 四所、lr paper、/api/lr/markets 200；lint 干净

## 版本与文档
- [√] 6.1 version 1.4.0；CHANGELOG；.env.example(LIGHTER_*)；wiki
- [√] 6.2 提交推送 dev004（代理 10808）
