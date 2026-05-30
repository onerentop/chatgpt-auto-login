# 激活流水线步骤化重构 —— 设计文档

- 日期：2026-05-30
- 状态：设计待审
- 关联：`engine.js`(browser) / `protocol-engine.js`(protocol) / `gopay-engine.js`(GoPay) / 前端 `pipelineStore` + `PipelineHUD`

## 1. 背景与目标

当前三条 Plus 激活路径各自为政：

- **PayPal-browser**：`server/engine.js` `PipelineEngine`，Playwright 全程控 Chrome。
- **PayPal-protocol**（默认）：`protocol-engine.js` `ProtocolEngine`，Python `curl_cffi` 协议登录，仅支付起 Chrome。
- **GoPay**：`server/gopay-engine.js` `GoPayEngine`，纯协议 + Midtrans，单账号、纯内存、独立事件契约与前端。

三套引擎主循环高度重复，CLAUDE.md 已明文警告"改流水线要同时改多处，否则行为漂移"。

> **第一硬约束（高于一切）：逻辑零删减。** 本次重构只搬运代码的"位置"，绝不删除、合并、简化、遗漏任何一条现有逻辑分支。觉得某段逻辑像冗余，也必须标记上报、由用户裁决，不得自行删除。每条现有分支都要在迁移前登记进"行为清单/可追溯映射"（见 §12），谁都不能悄悄丢。

本次重构目标（**不改变任何业务逻辑**，纯结构 + 可观测性升级）：

1. **按功能模块化解耦**：把三套引擎的主循环抽象成一套共享的「步骤管线」（Step Pipeline）。
2. **激活步骤可视化**：把隐式的 `phase` 串显式建模成有序 Step；前端用纵向 stepper 呈现每个账号的步骤链。
3. **失败可从失败步继续**：把现有散落的缓存式恢复（cached-login / `REUSE_STATUSES`）统一成 per-step checkpoint；自动恢复 + 手动单步重试。
4. **每步可看日志**：日志按 step 归属落库，UI 可逐步查看。
5. **三路对等**：GoPay 与 PayPal 完全对等 —— 落库、每步日志、失败可从失败步继续，不再纯内存。

## 2. 非目标（Out of Scope）

- 不改任何 step 的内部业务逻辑（登录、取链接、验证、支付、PKCE、GoPay 注册/付款的算法与重试策略保持逐行等价）。
- 不引入 Temporal / AWS Durable / Lambda 等重型 workflow 框架（离线 Windows 单机工具，自研轻量 runner 即可）。
- 不引入 Saga 补偿/回滚（本管线是**前向恢复**，不撤销已成功步，例如不回滚已成功的支付）。
- 不动根目录临时调试脚本（`dump-token-*.js` / `get-checkout-*.js` / `test-3way-*.js` 等），其清理另开任务。
- 不改状态码语义（`web/src/status.js` 与 `emitStatus` 负载保持兼容）。

## 3. 现状分析

### 3.1 "步骤"其实已隐式存在

两套 PayPal 引擎都用 `phase:` 字符串标记同一组阶段：
`cached-login/protocol-login/login → plan check → checkout/discord → verify → payment → pkce/cpa → done`。
只是写死在一个约 460 行的 `for` 循环里，未抽象成可复用的独立单元。

### 3.2 "失败从失败步继续"已有雏形（但散落）

`protocol-engine.js` 现有两处缓存式恢复：

- **cached-login fast-path**：读 DB `last_access_token`，JWT 未过期（60s buffer）则跳过登录。
- **cached payment-link**：`REUSE_STATUSES = {error, aborted, paypal_captcha, verify_error}` 命中则复用 DB `payment_link` 跳过取链接 + 验证。

DB `account_status` 已有持久化底座：`phase / progress / payment_link* / last_access_token / last_session_json`。

### 3.3 GoPay 与 PayPal 的结构差异

| 维度 | PayPal | GoPay（现状） |
|---|---|---|
| 事件契约 | `account-status` / `complete` | `log` / `result`（不同） |
| 批量 | for 循环 | 单账号 `runOne` |
| 登录 | 引擎内部做 | 外部传入 `accessToken` |
| 持久化 | `account_status` DB | 纯内存 `_results`/`_logs` |
| 支付 | 取 link → 验 $0 → Chrome+PayPal+短信 | `gopay_activate.py`（钱包注册 + Midtrans 付款） |
| PKCE | 有 | 无 |

### 3.4 GoPay Python 内部结构（决定拆分粒度）

`gopay_activate.py main()` 内部按 **Phase 4 → 3 → 5** 顺序跑：

- **Phase 4 `_register_one(provider, pin, proxy)`**：注册 GoPay 钱包（取号 + 收 SMS + 换号重试），**耗时长、消耗一个手机号**。
- **Phase 3 `_phase3_stripe(access_token, proxy)`**：spawn `stripe_gopay_flow.py` 拿 Midtrans snap URL，**15 分钟 TTL**。
- **Phase 5 `_phase5_pay(account, pin, midtrans_url, provider, proxy)`**：Midtrans GoPay 付款（linking + charge + OTP）。

关键约束：**Phase 3 与 5 必须背靠背**（snap token 15 分钟失效），不可拆成跨次恢复的独立 step；Phase 4 则值得单独 checkpoint（付款失败重试时不重复注册、不浪费手机号）。

## 4. 设计概览

### 4.1 两个策略轴

三种激活方式 = （登录策略 × 支付策略）的组合：

```
登录策略：browser-login | protocol-login
支付策略：paypal | gopay

PayPal-browser  = browser-login  × paypal
PayPal-protocol = protocol-login × paypal
GoPay           = protocol-login × gopay
```

### 4.2 步骤清单按管线数据驱动（非全局写死）

共享步（登录、套餐检查）所有方式都有；中间步由**支付策略**贡献。前端 stepper 渲染"该管线声明的 Step[]"：

```
PayPal 管线（6 步）：
  1. 登录 + 获取 access token   （登录策略：browser / protocol）
  2. 套餐检查（已是 Plus → 跳过 3~5）
  3. 获取支付链接（api / discord）
  4. Stripe 验证 $0
  5. 支付（Chrome + PayPal + 短信）
  6. PKCE / 凭证写盘

GoPay 管线（5 步）：
  1. 登录 + 获取 access token   （有有效 token 则跳过，兼容现有"外部传入 token"入口）
  2. 套餐检查（已是 Plus → 跳过 3~4）
  3. GoPay 钱包注册            （Phase 4，可 checkpoint）
  4. 拿 snap + 付款            （Phase 3+5 焊死，背靠背）
  5. 验证 Plus
```

## 5. 核心抽象

新增目录 `server/pipeline/`：

```
server/pipeline/
  context.js   AccountContext —— 携带账号 + 各步产物 + checkpoint 读写 + 绑定当前步的 logger
  step.js      Step 契约定义
  runner.js    PipelineRunner —— 账号循环 / 按序跑步 / 跳过命中 checkpoint 的步 /
               持久化每步结果 / 发 step 事件 / 冷却 / 代理轮换 / abort（从三引擎上移去重）
  steps/
    login.js          LOGIN（注入 browserLogin / protocolLogin 策略）
    plan-check.js     套餐检查（共享）
    paypal-fetch.js   PayPal：获取支付链接
    paypal-verify.js  PayPal：Stripe $0 验证
    paypal-pay.js     PayPal：Chrome + PayPal + 短信（复用现有 payment.js）
    paypal-pkce.js    PayPal：PKCE / add-phone / saveCPAAuthFile
    gopay-register.js GoPay：钱包注册（Phase 4）
    gopay-pay.js      GoPay：拿 snap + 付款（Phase 3+5）+ 验证 Plus
  index.js     buildPipeline({ login, payment }) → 有序 Step[]
```

### 5.1 Step 契约

```js
{
  id: 'paypal-fetch',          // 稳定标识，用作日志 phase 与 step_state 主键
  label: '获取支付链接',         // UI 显示
  // 命中有效 checkpoint 则跳过（等价今天的 cached-login / REUSE_STATUSES）
  shouldSkip(ctx): boolean,
  // 校验已有 checkpoint 是否仍有效（如 JWT exp、payment_link 未失效）
  validateCheckpoint(ctx): boolean,
  // 真正干活；函数体从现有引擎"逐行搬运"——相同调用、相同重试次数、相同 status 串
  async run(ctx): StepResult,  // { ok, status?, reason?, output? }
}
```

### 5.2 AccountContext

承载单账号一次运行的全部状态：

- 账号字段（email / password / client_id / refresh_token / login_type）。
- 各步产物（accessToken / session / planType / paymentLink / pk / paidOk / registeredWallet / credentials …）。
- checkpoint 读写：封装对 `account_status` 与 `account_step_state` 的读写。
- `logger`：绑定 `currentStepId`，所有 `console.log` 经 LogCapture 自动归属当前 step。
- 共享资源句柄：proxy 管理器、Chrome 启停、Python spawn、abort signal。

### 5.3 PipelineRunner

- `run(accounts)`：账号循环（上移自三引擎），每账号构造 `AccountContext` → 跑该管线 Step[]。
- 每步：`validateCheckpoint && shouldSkip` → 标 `skipped`；否则设 `currentStepId='running'`、emit `step-status`、跑 `run()`、持久化结果、emit `step-status`（success/failed）。
- 第一个不可跳的 step = **恢复点**，从此往下跑。
- 失败：停在该 step，记 reason，跳过剩余步，进入账号间冷却/延迟（沿用现有 `COOLDOWN_*` / `ACCOUNT_DELAY_*` 与连续失败计数）。
- stop/abort：步与步之间检查 `stopFlag`，abort signal 透传给支付步（沿用现有 `_abortController.signal`）。
- 对外仍 emit `account-status` / `complete`（兼容），新增 emit `step-status`（叠加）。

## 6. Checkpoint / 恢复模型

### 6.1 产物持久化

复用现有 `account_status` 列存产物（`last_access_token` / `last_session_json` / `payment_link*`）。
**新增 `account_step_state` 表**只记每步状态 + 时序（不重复存产物）：

```sql
CREATE TABLE IF NOT EXISTS account_step_state (
  email      TEXT NOT NULL,
  step_id    TEXT NOT NULL,
  status     TEXT DEFAULT 'pending',   -- pending | running | success | failed | skipped
  reason     TEXT DEFAULT '',
  started_at TEXT DEFAULT '',
  finished_at TEXT DEFAULT '',
  updated_at TEXT DEFAULT '',
  PRIMARY KEY (email, step_id)
);
```

### 6.2 有效性判定（逐条对应今天的失效规则，不增不减）

- **登录步**：JWT exp + 60s buffer（沿用 `decodeJwtExp`）。
- **取链接步**：`payment_link` 存在 且 上次 status ∈ `REUSE_STATUSES` 且未被 `NOT_FREE_TRIAL` 判失效（沿用现有"失效 → no_link → 不在 REUSE → 强制重取"链路）。
- **GoPay 钱包注册步**：注册产物（钱包 account/phone）已持久化则视为命中。
- **GoPay 拿 snap+付款步**：snap token 15 分钟 TTL，**几乎不跨次复用** —— checkpoint 仅"已付款成功"算命中；未成功一律重跑（重新拿 fresh snap），符合现有逻辑。

### 6.3 自动恢复

重跑账号时 runner 从第一个未成功步接续，已成功步读 checkpoint 跳过。

### 6.4 手动单步重试

`POST /api/execute/retry-step { email, stepId }`：runner 从指定 step 起跑。若上游 checkpoint 缺失/过期，透明地先补跑必要上游步（如单独重试"支付"时 token/link 从 DB 读，过期则自动回补"登录/取链接"）。

### 6.5 already-Plus 分支

plan-check 步判定已是 Plus 时，置 `ctx.alreadyPlus=true`，使后续支付步 `shouldSkip=true`，直接落到凭证/收尾步 —— 等价今天的 `continue`。

## 7. 每步日志归属

现状：`LogCapture` 把所有 `console.log` 以 `phase:''` 落库，日志未归属步。

改法：runner 跑某步时设 `ctx.currentStepId`，log handler 给每行打上当前 step id，写入 `execution_logs(email, phase=step_id, message, ts)`（`phase` 列已存在，只是开始正确填充）。**业务代码的 `console.log` 一行不用动**。UI 按 `email + step_id` 拉该步日志。

## 8. GoPay 接入细节

### 8.1 Python 拆两入口（phase 内部不改）

把 `gopay_activate.py` 拆成两个独立入口：

- **register 入口**：执行 Phase 4 `_register_one`，输出注册产物（钱包 account/phone）到 stdout JSON。
- **pay 入口**：输入注册产物 + access_token，执行 Phase 3（拿 fresh snap）+ Phase 5（付款），**背靠背**，保住 15 分钟 TTL。

`_register_one` / `_phase3_stripe` / `_phase5_pay` 三个函数体逐行不改，只调整 `main()` 的编排边界（从单脚本一次性 4→3→5，改为两次 spawn：register、pay）。`stripe_gopay_flow.py` 完全不动（仍由 pay 入口内部 spawn）。

### 8.2 GoPay 迁 DB / 事件契约

- 弃用 `gopay-engine.js` 的纯内存 `_results`/`_logs`，改写 `account_status` + `account_step_state`。
- 改发 `account-status` / `step-status`（与 PayPal 同契约），`complete` 汇总。
- `GoPayActivate.vue` 改用共享 `AccountStepDrawer`（见 §9）。
- GoPay 暂无 PKCE 步（保持现状，verify-plus 收尾）；后续如需可作为新增步另议。

## 9. 前端设计

- **新增 socket 事件 `step-status`**（additive）：`{ email, stepId, status, reason }`。
- **新增 `AccountStepDrawer.vue`**：纵向 stepper，渲染该账号所属管线的 Step[]；每步显示 done/running/error/skipped/pending 图标 + label，可展开看该步日志，失败步旁挂「重试这一步」按钮。
- **Accounts.vue / Results.vue**：行点击 → 右侧滑出该抽屉（历史查看 + 重试）。
- **Execute.vue**：跑批时当前账号的 stepper 实时高亮推进。
- **GoPayActivate.vue**：切换到共享抽屉，呈现 GoPay 5 步。
- **新增 API**：`GET /api/accounts/:email/steps`（步状态 + 日志）、`POST /api/execute/retry-step`。
- 现有 `PipelineHUD` / `pipelineStore` / `status.js` / 5 视图状态筛选**保持不变**，新组件叠加。

## 10. 数据库变更

- 新增 `account_step_state` 表（§6.1），含一次性建表 + 防御式存在判断（与现有 `CREATE TABLE IF NOT EXISTS` 风格一致）。
- 沿用现有 `save()` 快照 + tmp+rename 落盘机制（v2.29），不改持久化通道。

## 11. 事件 / API 契约（全部 additive，不破坏现有）

| 类型 | 名称 | 变化 |
|---|---|---|
| socket | `account-status` / `log` / `complete` | 不变 |
| socket | `step-status` | **新增** |
| REST | `/api/execute`、`/api/execute/stop` | 不变 |
| REST | `/api/execute/retry-step` | **新增** |
| REST | `/api/accounts/:email/steps` | **新增** |
| REST | `/api/gopay-activate/*` | 过渡期保留；前端切共享抽屉后逐步收敛 |

## 12. 行为不变保证（逻辑零删减）

> 本节是第一硬约束的落地机制。目标不是"大致等价"，而是**每一条现有分支都可追溯、可验证地搬到了新结构里，一条不少**。

### 12.1 流程（每个 P 阶段强制执行）

1. **先建行为清单（Behavior Inventory）再动手**：迁移某引擎前，先逐行通读，把它的每一条分支/状态/重试/边缘处理登记成一张可追溯映射表 —— `源 file:line → 现象/分支 → 去处 step.id`。这张表是该阶段的验收基线；表里每一行都必须在新代码里找到对应落点。
2. **逐行搬运**：每个 step 的 `run()` 从现有引擎原样迁移 —— 相同调用、相同重试次数、相同 status 串、相同代理轮换时机、相同 `summary.*` 计数。**禁止**顺手合并相似分支、删"看似无用"的 try/catch、简化重试次数、改 sleep 时长。
3. **冗余必须上报，不得自删**：若确信某段逻辑冗余/死代码，在映射表标注 `SUSPECT_DEAD` 并在该阶段交付时单列出来由用户裁决；在用户确认前保留原逻辑。
4. **每期 diff-review 闸门**：每个 P 阶段交付时附"旧分支 → 新 step"对照（含上面那张映射表的勾稽结果），供用户核对无遗漏后再进入下一期。

### 12.2 现有边缘分支清单（迁移时必须逐条落点，示例非穷举，实施期补全）

`protocol-engine.js` / `engine.js` 中易被误删的分支，至少包括：

- 登录：cached-login fast-path（JWT exp + 60s buffer）、TLS failure → rotate + retry once → 仍失败放弃、`deactivated` 账号处理。
- 代理健康打点：G1（业务返回即记 good）、T8（网络异常才记 bad）、G3（支付页可达记 good）、每账号轮换（hoisted 出 `!result` 以覆盖 cache-hit）。
- 套餐：`isPlusOrAbove`（plus/pro/team/enterprise）→ clearPaymentLink + clearAccessToken → PKCE 或 saveCPAAuthFile。
- 取链接：3 次重试 + Timeout/fetch 退避、`noJpProxy` → no_jp_proxy、`!link` → no_link、cached-link 复用（`REUSE_STATUSES`）、取链接后即落库（verify 前）。
- 验证：Discord 路径**跳过** Phase 2.5；`verify_error` / `no_promo`（amount_due）/ `is_free` 三分支。
- 支付：chrome-error/about:blank → rotate + retry once → 仍不可达 throw；`NOT_FREE_TRIAL` → notFreeTrial → no_link；支付结果 success / aborted / notFreeTrial / status / error 五分支。
- 凭证：PKCE 的 refresh_token / needsPhone（add-phone）/ no-RT 三分支。
- add-phone（协议）：provider acquire（zhusms / smscloud / oapi / local）、3 次 attempt、status 八分支（ok / phone-rejected / rate-limited / fraud-blocked / voip-blocked / sms-timeout / validate-error / submit-error / post-validate-error）、markRejected / deferred-cancel / markPhoneSaturated / releaseBinding、跨 country fallback、复用号 resend。
- 节流：连续失败计数（阈值 3）→ 5–10 分钟冷却、账号间 15–45s 延迟、可被 stopFlag 中断的分块 sleep。
- browser 引擎特有：`cpa` phase、phone_pool 内联处理等 —— 与 protocol 的差异点逐条对齐，不得在合并时丢失任一侧独有逻辑。
- GoPay：`_register_one` 换号重试语义（None=已注册重试 / NO_STOCK / RATE_LIMITED 不可重试 / dict 成功）、redact 脱敏、600s timeout、abort 处理。

### 12.3 测试与契约

5. **特征化测试**（characterization tests，`node:test`）：重构前先锁定"步序 + 跳过判据 + status 映射"再现今天的缓存行为；**覆盖 §12.2 每一个终态 status 仍可达**；重构后必须全绿。GoPay 额外锁定"register 成功 / pay 失败重试只重跑 pay、不重注册"。
6. **状态码契约不变**：`web/src/status.js` 与 `emitStatus` 负载兼容，老 UI 继续工作。
7. **Python 协议不变**：拆分后 register / pay 入口仍遵守 stdin JSON 配置 + stdout JSON-lines（`{"log":...}` 流式 + 末行 final）协议；导入期 print 仍重定向 stderr；每个 phase 函数体逐行不改。
8. **双/三引擎对齐**：共享步只有一份，CLAUDE.md 警告的"改一处忘改另一处"消失 —— 但合并前必须确认两侧独有分支都已并入（见 §12.2 browser 特有项）。

## 13. 分期落地（每期可独立验证、可回滚）

- **P0 脚手架**：`server/pipeline/` 契约 + runner + `account_step_state` 表 + `step-status` 事件（不接管引擎，空跑验证事件链）。
- **P1 迁 protocol（PayPal）**：protocol 主循环切到 runner，特征化测试守住。
- **P2 迁 browser（PayPal）**：注入 browserLogin 策略，两 PayPal 引擎收敛到一套 runner。
- **P3 接 GoPay**：拆 `gopay_activate.py` 两入口 + gopay payment 策略 + GoPay 迁 DB/事件契约。
- **P4 前端**：`AccountStepDrawer` + Execute 实时 + 单步重试 API；GoPayActivate.vue 切共享抽屉。
- **P5 清理**：删被上移的重复代码。

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 三引擎主循环细微差异在合并时丢失（行为漂移） | 特征化测试 + 逐行搬运；P1/P2/P3 分期，每期回归 |
| GoPay 拆 Python 入口破坏 4→3→5 时序 / snap TTL | Phase 3+5 焊死在 pay 入口背靠背；phase 函数体不改；专项测试锁定 |
| 手动单步重试时上游 checkpoint 过期 | 透明回补上游步；`validateCheckpoint` 统一判定 |
| 前端新事件与现有 HUD 并存冲突 | `step-status` additive；现有 store/HUD 不动 |

## 15. 决策记录

| 决策 | 选择 |
|---|---|
| 引擎范围 | 两 PayPal 引擎 + GoPay 全抽到共享步骤管线 |
| 恢复方式 | 自动恢复 + 手动单步重试（都要） |
| PayPal 步粒度 | 6 步（按真实原子阶段） |
| 可视化位置 | 账号抽屉 + Execute 实时 |
| GoPay 范围 | 纳入统一管线（支付策略轴），与 PayPal 对等：落库 / 每步日志 / 失败从失败步继续 |
| GoPay 步粒度 | 拆「钱包注册 \| 拿 snap+付款」两步（Phase 3+5 焊死） |
| 步骤状态存储 | 新建 `account_step_state` 表（默认，待审可改 JSON 列） |
| 临时调试脚本清理 | 本次不动（默认，另开任务） |
