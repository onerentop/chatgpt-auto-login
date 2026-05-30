# GoPay 邮箱列表批量激活（自带协议登录）—— 设计文档

- 日期：2026-05-31
- 状态：设计待审
- 关联：`server/gopay-engine.js`、`server/routes/gopay-activate.js`、`server/pipeline/index.js`、`web/src/views/GoPayActivate.vue`、`server/routes/execute.js`

## 1. 背景与目标

当前 GoPay 激活入口要求**外部提供 ChatGPT access token**：`GoPayActivate.vue` 贴一个 token → `POST /api/gopay-activate/start {accessToken}` → `GoPayEngine.runOne` 单账号跑 `buildPipeline({payment:'gopay'})`（无 login 步，token 外部注入 `ctx.outputs.login`）。

目标：把"获取 access token"的前置环节接进来。入口改成**邮箱列表页（仿执行控制/Execute）**：选中账号 → 「激活」→ 自动**纯协议注册登录** ChatGPT 账户 → 拿到 access token → 走现有 GoPay 激活逻辑。

本设计让 **GoPay 升级为与 PayPal 对等的批量激活**：同一份 `accountsDB`、同样的 `account-status`/`step-status` 事件、同样的账号列表 UI；唯一区别是管线（gopay vs paypal）与 **GoPay 的 login 永远走协议**（curl_cffi，不用浏览器）。

## 2. 关键洞察：复用现成扩展点

这次改造正是 P3 统一管线预留的扩展点（"GoPay = protocol-login × gopay"）：
- `login.js` 的 **protocol 策略已存在**（`runProtocolRegister` 注册登录 → 写 `ctx.outputs.login = {accessToken, session, planType}`）。
- gopay 三步（`gopay-register/pay/verify`）**已从 `ctx.outputs.login.accessToken` 取 token**。
- 只需把 login 步**前置**到 gopay 管线，并把 GoPayEngine 从"外部注入 token + 单账号"改成"login 步产出 token + 批量"。

## 3. 决策记录（用户已确认）

| # | 决策 | 选择 |
|---|---|---|
| 页面架构 | GoPay 入口形态 | 独立账号列表页（保留 GoPay激活 导航，内容改列表） |
| 1 | GoPay 与 PayPal 账号状态 | **共用 `account_status`**（一个账号一个激活状态；GoPay 成功写 `plus_gopay`/`already_plus`，失败写 `gopay_reg_fail` 等） |
| 2 | 与主 Execute(PayPal) 并发 | **互斥**（同时只跑一个激活批次，避免共享代理/资源争用） |
| login 策略 | GoPay 登录方式 | **永远 protocol**（纯协议，curl_cffi） |

## 4. 后端改造

### 4.1 `server/pipeline/index.js` —— gopay 分支前置 login 步
现状（约行 17–25）：gopay 分支返回 `[planCheckStep(), gopayRegisterStep(), gopayPayStep(), gopayVerifyStep()]`（无 login）。
改为前置 protocol login 步：
```js
if (payment === 'gopay') {
  return [
    loginStep({ login: 'protocol' }),   // 纯协议注册登录 → ctx.outputs.login
    planCheckStep(),
    gopayRegisterStep(),
    gopayPayStep(),
    gopayVerifyStep(),
  ];
}
```
（gopay 的 login 恒为 protocol，硬编码 `'protocol'`，不随 `login` 入参变。）

### 4.2 `server/gopay-engine.js` —— 单账号 token 注入 → 批量协议登录
把 `runOne(account-with-token)` 改成 **`start(startFrom = 0, filterEmails = null)` 批量**（结构仿 `protocol-engine.js` 的 `start()` 薄壳）：
- 从 `accountsDB.list()` 加载账号（email/password/login_type/client_id/refresh_token），`filterEmails` 非空时过滤（大小写不敏感）。**不再要求外部 token。**
- LogCapture 接线（劫持 `console.log` → emit `log` + `logsDB.add`，phase 用 `runner._activeCtx?.currentStepId`），仿 protocol。
- 每账号：
  - 在任何 step 写库前 `new AccountContext({email,password,client_id,refresh_token,login_type}, deps)`（prevPersisted 快照）。
  - proxy rotate（若启用）。
  - `deps.emitStatus` 升级为**像 `ProtocolEngine.emitStatus`**：注入 `proxyNode/exitIp`，`emit('account-status', data)`，`statusDB.set(email, data)`（→ 账号写 `account_status`，列表实时显示）。
  - **移除** `ctx.outputs.login` 外部注入（行 140 一带）——login 步现在产出它。
  - `runner._runAccount(ctx, buildPipeline({ login:'protocol', payment:'gopay' }))`。
  - 账号间延迟：仿 protocol 引擎（随机延迟 + 连续失败冷却，1s 分片可被 stopFlag 中断）。
- 升级事件：发 `account-status` / `step-status` / `complete`（仿 PayPal 引擎）。保留 `log`（日志框用）。**`result`/`gopay-result` 弃用**（账号状态改由 `account-status` 驱动列表）。
- `stop()`：`stopFlag=true` + `abortController.abort()` + `killTree` 杀 login 的 Python 子进程**和** gopay 步的 Python 子进程（都经 `ctx.deps.resources` 持有）+ `statusDB.resetRunning()`。
- 提供与 protocol shell 同形的 `deps`：`emitStatus, summary(throwaway), progress, proxyMgr, resources, runtimeCfg, statusDB, stepStateDB, save, abortController, log`。

> 实现注：`GoPayEngine.start` 与 `ProtocolEngine.start` 的薄壳逻辑高度相似（账号循环/ctx 构造/proxy rotate/LogCapture/cleanup）。本期各自实现即可（YAGNI）；若重复明显，可在实现期抽一个共享 runner-shell 助手，但不在本设计强制。

### 4.3 `server/routes/gopay-activate.js` —— 入参改 emails + 互斥
- `POST /start` 入参从 `{email, accessToken, planType}` 改为 **`{emails?: string[]}`**（选中账号；省略=全部，校验仿 `/api/execute`：array 或省略，元素非空串）。**不再要求 accessToken。**
- **互斥（决策2）**：start 前检查 ① 主 Execute 引擎 idle（`require('../engine-singleton').getEngine()?.getStatus() !== 'idle'` → 409）② GoPay 引擎 idle（`engine.state.running` → 409）。
- 调 `engine.start(0, emails || null)`，错误经 io.emit log/complete 转发（仿 execute 路由的 `.catch`）。
- 路由已是 factory(io)，引擎的 `account-status`/`step-status`/`complete` 转 `io.emit`（已有 `step-status` 转发；新增 `account-status`/`complete`；`gopay-log` 保留供日志框）。

### 4.4 `server/routes/execute.js` —— 反向互斥
主 Execute 的 `POST /` 与 `POST /retry-step` 开跑前，新增检查 **GoPay 引擎未运行**（`require('../gopay-engine').state.running` → 409），与决策2 对称。

## 5. 前端改造（`web/src/views/GoPayActivate.vue`）

改成**账号列表页**（仿 `Execute.vue`）：
- **移除** access-token 输入框。
- 顶部工具栏：「激活选中」（`POST /api/gopay-activate/start {emails: 选中}`）、「停止」（`POST /stop`）、状态筛选、刷新。
- **账号表**：拉 `/api/accounts`，列含 邮箱 / 状态（读 `socketState.accountStatuses[email]`，`account-status` 实时更新，复用 `status.js` 的 `statusLabel/statusType/rowClassFor`）/ 多选 checkbox / 「查看步骤」（打开 `AccountStepDrawer mode="gopay" :live="true"`）。可仿 Execute 的按状态分组（`groupAccountsByStatus`）。
- 引擎状态卡（运行中/阶段/当前账号）保留并接 `account-status`/`complete`。
- 实时日志框保留（`socketState.gopayLogs`）。
- 底部 **GoPay 配置卡**（SMS provider / 印尼代理）保留不动。
- `status.js` 的 gopay 状态映射（`plus_gopay`/`already_plus`/`gopay_reg_fail`/`gopay_pay_fail`/`gopay_fraud`）已存在，无需新增。

## 6. 数据流（单账号）

```
选中 emails → POST /gopay-activate/start {emails}
  → GoPayEngine.start 加载账号、批量循环
    → 每账号: AccountContext + runner.run(buildPipeline protocol×gopay)
       login(protocol)  → 注册登录 → ctx.outputs.login={accessToken,session,planType} → emit account-status running/protocol-login
       plan-check       → 已 Plus? → alreadyPlus flag
       gopay-register   → 钱包注册 (Python)
       gopay-pay        → midtrans+付款 (Python)
       gopay-verify     → finalStatus = already_plus | plus_gopay
    → emit account-status {status}/done + step-status(每步) + 写 account_status/account_step_state
  → 前端列表状态列实时更新 + 步骤抽屉实时推进
  → complete → 引擎 idle
```

## 7. 错误处理

- login 失败（注册/登录）：login 步 emit `error`/`deactivated`（已有），account_status 记之，账号停在 login 步（gopay 步不跑）。
- gopay 各步失败：`gopay_reg_fail`/`gopay_pay_fail`/`gopay_fraud`（已有映射），停在对应步。
- 已是 Plus：plan-check → `already_plus`，gopay 步 shouldSkip。
- 停止：stopFlag + abort + killTree 杀 login/gopay 的 Python 子进程。
- 互斥冲突：409（对方激活批次在跑）。

## 8. 测试

- 后端 `node:test`：
  - `buildPipeline({login:'protocol', payment:'gopay'})` 步序 = `['login','plan-check','gopay-register','gopay-pay','gopay-verify']`。
  - `GoPayEngine.start` 批量：mock login step（注入假 register）+ mock gopay spawn，断言 login→gopay 端到端、account-status 发出、account_status/step_state 写入、already_plus/plus_gopay/gopay_reg_fail 映射。
  - 路由互斥：gopay start 在 execute 运行时 409；execute start 在 gopay 运行时 409。
- 前端：`cd web && npm run build` 编译；人工冒烟（选账号→激活→列表状态推进→步骤抽屉）。
- 全套件 `npm test` 仅剩 5 个已知 `buildSingboxConfig` 基线失败。

## 9. 非目标（YAGNI）

- 不抽共享 runner-shell 助手（除非实现期重复明显）。
- 不改 PayPal Execute 的账号列表/逻辑（仅加反向互斥检查）。
- 不为 GoPay 单独建账号表（共用 accountsDB + account_status）。
- 不做 GoPay/PayPal 并发（决策2 互斥）。
- 不保留 access-token 手贴入口（完全由协议登录取代）。
