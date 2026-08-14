# 项目技术约定

---

## 技术栈
- **核心:** Node.js >= 20（ESM，原生模块优先，零构建）
- **依赖策略:** 运行时依赖极少化；第三方 SDK（@decibeltrade/sdk、risex-client）仅交易所适配层使用
- **测试:** Node 内置 assert + 自研轻量 runner（`test/*.test.js`，`npm test` 串联全部）

---

## 开发约定
- **代码规范:** ESLint（flat config，js.configs.recommended 基线，覆盖 src/ 与 test/）
- **命名约定:** 小驼峰（变量/函数）、大写常量；文件用 kebab-case
- **语言:** 面向国内用户，UI/日志/告警文案使用中文；代码注释中文为主
- **注释:** 重要设计决策必须写 WHY（示例见 bot.js 各风控点）

---

## 错误与日志
- **策略:** 交易路径任何错误不得抛出至进程崩溃（EventEmitter 'error' 必须始终有监听）；持久化/通知/日志失败不得影响交易主路径
- **日志:** 统一使用 `src/log.js`（JSON lines 写入 `logs/app-YYYY-MM-DD.log`，按天轮转；控制台同步可读输出）；禁止直接 console.log 关键事件
- **级别:** info（生命周期/下单/成交）/ warn（风控预警/重试）/ error（失败与异常）

---

## 测试与流程
- **测试:** `npm test` 必须全绿；bot.js 交易逻辑必须通过 MockExchange 覆盖（铺单/补单/风控/对账/恢复）
- **提交:** 变更必须同步更新 helloagents 知识库（CHANGELOG.md + wiki + history）
- **版本:** 每次代码改动必须升级 package.json 版本号（修复=Patch+1，新功能=Minor+1，破坏性=Major+1）并登记 CHANGELOG.md；前端通过 /api/version 自动展示
- **冒烟:** 启动 `npm start` 确认三所初始化与仪表盘可访问
