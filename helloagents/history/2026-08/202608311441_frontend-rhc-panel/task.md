# 任务清单: 修复 RHC 前端面板缺失（阻断级，review2）

## 修复
- [√] 1.1 补齐 tab-lr 面板（克隆 tab-rs，rs→lr 全量替换）+ 导航按钮 + switchTab 数组
- [√] 1.2 CSS：--lr-color/--lr-bg 定义、.panel.lr/.ov-card.lr/.dot-lr、图表颜色 lr 分支
- [√] 1.3 防御守卫：makeExchangeCtrl 缺面板跳过初始化；两处 start payload max-loss null 守卫

## 验证
- [√] 2.1 静态交叉核对：JS 引用的全部 lr-* id 均在 HTML 中存在（49 个），P('...') 动态引用全解析
- [√] 2.2 前端语法 + 全量测试 + lint 通过；version 1.4.2；CHANGELOG/wiki 同步
- [√] 2.3 提交推送 dev004
