# 任务清单: 账号密码鉴权 + 主题/响应式/扁平化（标准开发）

## 1. 鉴权改造
- [√] 1.1 config.js 增加 DASHBOARD_USER/PASS
- [√] 1.2 server.js：会话管理（in-memory + 过期清理）、/api/login、/api/logout、守卫改造（login/token/none 三模式）、/api/version 豁免
- [√] 1.3 前端：登录弹窗、doLogin/doLogout、401 按模式分流、退出按钮

## 2. 主题与样式
- [√] 2.1 日夜主题：prefers-color-scheme 自动 + data-theme 手动覆盖（localStorage）
- [√] 2.2 极简扁平：统一圆角变量、按钮去渐变
- [√] 2.3 移动端响应式（iPhone）：单列布局、触控放大、iOS 防缩放、小屏精简

## 3. 验证与文档
- [√] 3.1 冒烟：login 模式（登录/错密码/带 token/SSE）与 token 回退模式均通过；49 例测试 + lint 全绿
- [√] 3.2 version 1.3.0；CHANGELOG/wiki/.env.example/README 同步
- [√] 3.3 提交推送 dev003（代理 10808）
