# 任务清单: review18 动态网格零输出修复

## 根因
- 前端"启用"无默认 checked（影子/自动重启有）-> 刷新即回未勾选 -> enabled:false -> 影子期空转两周
- 启动日志不记录动态状态 -> 潜伏不可见

## 动作
- [√] 1.1 四处 dyn-enable 默认 checked
- [√] 1.2 start() 告警追加动态状态 + _startDynTimer 心跳日志
- [√] 1.3 动态面板 localStorage 持久化（勾选+数值）
- [√] 1.4 测试/lint 全绿；version 1.5.11；提交推送
