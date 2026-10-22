# 任务清单: 修复登录弹窗重复弹出（微调）

## 1. 修复
- [√] 1.1 public/index.html：401 分流前等待鉴权模式探测（authProbe）；非 token 模式不弹 prompt；showLoginModal 幂等

## 2. 版本与文档
- [√] 2.1 version 1.3.1；CHANGELOG；web.md 变更历史

## 3. 验证
- [√] 3.1 前端语法检查通过
- [√] 3.2 提交推送 dev003（代理 10808）
