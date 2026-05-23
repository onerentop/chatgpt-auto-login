# 账号一键测活功能设计

> **日期**：2026-05-24  
> **目标**：在 Accounts 页提供"一键测活"按钮，针对选中或全部账号快速判定 Plus 订阅是否还在 + access_token 是否还能用；过期或无 token 时自动用密码 + OTP 重登并手工拼装 `cpa-auth/codex-{email}.json`。

---

## 1. 背景与现状

### 1.1 现有零件

- `cpa-auth/codex-{email}.json` 存放 codex 客户端凭证。字段：`access_token`（JWT，~2KB）、`account_id`、`email`、`expired`（access_token JWT exp 的 ISO8601）、`id_token`、`last_refresh`、`refresh_token`、`type:'codex'`。
- 当前 103 个凭证文件中 **102 个 `refresh_token` 为空**（PKCE 流程并未持久化 RT），意味着 OAuth refresh_token grant 路径对绝大多数账号不可用。
- `accounts.refresh_token` 字段实际是 **Outlook IMAP OAuth** 的 refresh_token，跟 ChatGPT 无关。
- `account_status` 现有状态码 `plus / plus_no_rt / no_link / error / idle / running / no_jp_proxy / no_promo / verify_error` 都承载"上一次执行流水线的结果"语义。
- 主代理 `:7890` (US 出口) 与 OpenAI 的 `/backend-api/*` 路径走同一出口，注册时就用这条线。

### 1.2 业界主流测活方案对比

| 方案 | 原理 | 适配本项目 |
|---|---|---|
| OAuth refresh_token grant | POST `auth0.openai.com/oauth/token` 拿新 access_token | ⚠️ 102/103 没存 RT，先天受限 |
| 用现存 access_token 调 `/backend-api/me` | 401 = 死；200 = 活 | ✓ 但不告诉你 Plus 在不在 |
| 调 `/backend-api/accounts/check` | 返回 `plan_type` + 到期日，同时验 token + Plus | ✓ **采用** |
| JWT exp 本地解析 + 远端验证 | 本地秒过滤已过期，节省远端调用 | ✓ 采用（作为前置） |

### 1.3 决策摘要

| 维度 | 决策 |
|---|---|
| 测活语义 | `/backend-api/accounts/check` 同时判 Plus + token |
| access_token 过期且无 RT | 重登拿新 token（**不走** PKCE），手工拼 `codex-{email}.json` |
| UI 入口 | 顶部按钮 "测活选中" / "测活全部" |
| DB | 加独立列 `alive_status / alive_checked_at / alive_reason` |
| 并发 | 3 并发 + 1s 节流 |
| 顺序 | Lazy hybrid（先 check，401 再重登） |
| 引擎 | 跟 `config.protocolMode` 走 |
| 状态码 | `plus / canceled / login_fail / token_expired / proxy_error / network_error / unknown / checking` |
| 出口代理 | 主代理 `:7890` (US) |

---

## 2. 架构

### 2.1 文件结构

```
server/liveness/
├── checker.js          # 单账号测活核心：调 accounts/check + 解析 JWT
├── light-login.js      # 不走 PKCE 的"轻登录"：密码+OTP+/api/auth/session → access_token
├── codex-file.js       # 拼装/覆写 cpa-auth/codex-{email}.json
├── runner.js           # 批量调度器：3 并发 + 1s 节流 + socket.io 事件
└── __tests__/
    ├── checker.test.js
    ├── light-login.test.js
    ├── codex-file.test.js
    └── runner.test.js

server/routes/liveness.js   # /api/liveness/start | /status | /stop
server/db.js                # +3 列 + statusDB.setAlive() + clearAlive()

chatgpt_register/liveness_login.py   # 协议模式下的轻登录（curl_cffi）
                                     # 仅在 config.protocolMode=true 时被 light-login.js spawn

web/src/views/Accounts.vue  # 顶部按钮 + alive 列 + 筛选
web/src/status.js           # alive_status 代码 → label / type 映射
```

### 2.2 依赖关系（单向）

```
routes/liveness.js
    └─► liveness/runner.js
            ├─► liveness/checker.js  ←──┐
            ├─► liveness/light-login.js  │  失败回退
            └─► liveness/codex-file.js  ◄┘  Plus 时写盘
                    └─► (复用现有 login.js 里的 imapflow / TOTP 工具)
```

### 2.3 关键不变式

- `liveness/` 目录里的所有模块**只读** `accountsDB`、**只写** `statusDB.setAlive` + `cpa-auth/codex-*.json`。
- **不动** 现有 `account_status.status` 字段（执行流水线的状态）。
- **不调** 现有 `PipelineEngine` / `ProtocolEngine`（彻底解耦）。
- 复用：sing-box 主代理 `:7890`、imapflow（Outlook OTP）、otplib（Gmail TOTP）。
- **不动** `cpa-auth/sub2api-*.json` 文件。

---

## 3. 关键技术：不走 PKCE 怎么拿 access_token

ChatGPT Web 的标准登录链路（不用 codex 客户端的 deeplink）：

```
1. GET  https://auth.openai.com/authorize?...     ← 拿 csrf_token + state
2. POST https://auth.openai.com/u/login/identifier  body={username}
3. POST https://auth.openai.com/u/login/password    body={password}
4. (Outlook → IMAP 拉 OTP / Gmail → otplib 算 TOTP)
5. POST https://auth.openai.com/u/mfa-otp-challenge  body={code}
6. GET  https://chatgpt.com/api/auth/callback/...   ← 拿 Set-Cookie __Secure-next-auth.session-token
7. GET  https://chatgpt.com/api/auth/session        ← Cookie 自带，返回 JSON：{ accessToken, user:{id,email}, expires }
```

### 3.1 /api/auth/session 返回字段映射

```json
{
  "accessToken": "eyJhbGc...",
  "user": { "id": "user-xxx", "email": "..." },
  "expires": "2026-06-07T12:34:56Z"
}
```

JWT decode `accessToken.payload`：
- claim 路径在 ChatGPT JWT 里的具体命名以**实测**为准（参考现有 `cpa-auth/codex-*.json` 已有的 `account_id` 值是从同一来源解析的）
- 实现时先 decode JWT 看 payload，再决定从哪个 claim 取 `account_id` 写入 codex-{email}.json
- 兜底：如 JWT 里取不到，用 `session.user.id` 作为 `account_id`

### 3.2 codex-{email}.json 拼装规则

```js
{
  access_token:  <session.accessToken>,
  account_id:    <decoded.account_id>,
  email:         <session.user.email>,
  expired:       <new Date(session.expires).toISOString()>,
  id_token:      '',         // 不走 PKCE 拿不到，留空
  last_refresh:  <now ISO>,
  refresh_token: '',         // 跟现存 102/103 个文件保持一致
  type:          'codex',
}
```

### 3.3 两个引擎的实现路径

| 模式 | 库 | 入口 |
|---|---|---|
| `protocolMode=true` | `curl_cffi`（Python） | 新增 `chatgpt_register/liveness_login.py`，复用 `protocol_register.py` 已有的 auth0 套路，**只跑到步骤 7** 返回 JSON-lines；不走 PKCE callback |
| `protocolMode=false` | Playwright | 复用 `login.js` 的 Chrome 路径，登录后直接 `page.request.get('/api/auth/session')` 拿 JSON |

### 3.4 风险点与缓解

- **PoW sentinel**：步骤 2/3 可能挡 sentinel —— 复用 `chatgpt_register/sentinel.py` QuickJS pipeline。
- **CAPTCHA**：步骤 5 偶尔抛 —— 不重试，直接 `alive_status='login_fail', reason='captcha'`。
- **/api/auth/session 短 TTL**：返回的 `expires` 一般 1-7 天，比 PKCE 的 10 天短 —— 可接受，因为测活本身就是定期触发的语义。

---

## 4. 单账号测活数据流

```
livenessRunner.test(email)
  │
  ├─[1] statusDB.setAlive(email, { alive_status: 'checking' })
  │     → socket.io emit 'liveness-status' { email, alive_status: 'checking' }
  │
  ├─[2] 读 cpa-auth/codex-{email}.json
  │       │
  │       ├─ 文件存在 → checker.probe(file.access_token)
  │       │       │
  │       │       ├─ JWT.exp > now ─► GET /backend-api/accounts/check
  │       │       │     ├─ 200 + plan=plus    → alive_status='plus',     reason='check ok'
  │       │       │     ├─ 200 + plan=free    → alive_status='canceled', reason='no plus'
  │       │       │     ├─ 200 + plan=team/enterprise → alive_status='canceled', reason='plan: <type>'
  │       │       │     ├─ 200 schema 异常    → alive_status='network_error', reason='check schema mismatch'
  │       │       │     ├─ 401                → 进 [3] 重登
  │       │       │     ├─ 403                → alive_status='login_fail', reason='check 403 forbidden'（不重登）
  │       │       │     ├─ 5xx / 429 / 超时    → alive_status='network_error', reason='check 5xx|429|timeout'
  │       │       │     └─ proxy ECONNRESET   → alive_status='proxy_error',   reason='proxy reset'
  │       │       │
  │       │       └─ JWT.exp ≤ now           → 进 [3] 重登
  │       │
  │       └─ 文件不存在 / parse 失败          → 进 [3] 重登
  │
  ├─[3] lightLogin(account, signal)
  │       │
  │       ├─ 成功 → { access_token, account_id, expired }
  │       │     ├─ codexFile.write(email, tokenData)   # 拼/覆写 codex-{email}.json
  │       │     └─ checker.probe(access_token) ────► 回到 [2] 的判 plan_type 分支
  │       │           ├─ plus     → alive_status='plus'
  │       │           ├─ free     → alive_status='canceled'（不删 json）
  │       │           └─ 异常     → alive_status='network_error'
  │       │
  │       ├─ 缺密码 / 缺 Outlook OAuth / 缺 TOTP secret → alive_status='login_fail', reason='no <field>'
  │       ├─ 401 identifier/password                  → alive_status='login_fail', reason='bad password'
  │       ├─ OTP fetch fail（IMAP 超时 / TOTP 错）      → alive_status='login_fail', reason='otp timeout|otp fail'
  │       ├─ CAPTCHA                                  → alive_status='login_fail', reason='captcha'
  │       ├─ ECONNRESET / 代理异常                     → alive_status='proxy_error', reason='proxy reset (login)'
  │       ├─ session 返回 null                         → alive_status='login_fail', reason='no session after login'
  │       ├─ codex-file 写盘失败                       → alive_status='network_error', reason='write codex fail'
  │       └─ 其它网络                                  → alive_status='network_error', reason='unexpected: <msg>'
  │
  └─[4] statusDB.setAlive(email, { alive_status, alive_reason })  # alive_checked_at 自动写
        → socket.io emit 'liveness-status' (终态)
        → 进度 +1：socket.io emit 'liveness-progress' { done, total, failed }
```

### 4.1 关键决策点（落地时不要改）

- `alive_status='canceled'` 时 **不删** `codex-{email}.json` —— 用户可能想看账号信息；要删走"删除账号"按钮。
- `alive_status='plus'` 时 **无条件覆写** `codex-{email}.json` —— 一致性优先：把 `last_refresh`、`expired` 都刷成最新。
- 重登成功但 check 失败（如 5xx）→ alive_status='network_error'（**不**回滚 json 覆写）。
- runner 并发池：`p-limit(3)`；任务间用 `await sleep(1000)` 强制节流。
- 取消机制：POST `/api/liveness/stop` → `AbortController.abort()`；已派发的 promise 走完当前账号，未派发的不再启动；语义跟 v2.24 abort 一致。

---

## 5. DB Schema + statusDB API

### 5.1 Schema 变更

```sql
-- 新建 db 直接进 CREATE TABLE：
CREATE TABLE IF NOT EXISTS account_status (
  email             TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'idle',
  phase             TEXT DEFAULT '',
  progress          TEXT DEFAULT '',
  reason            TEXT DEFAULT '',
  has_auth_file     INTEGER DEFAULT 0,
  payment_link      TEXT DEFAULT '',
  payment_link_pk   TEXT DEFAULT '',
  payment_link_at   TEXT DEFAULT '',
  alive_status      TEXT DEFAULT 'unknown',   -- NEW
  alive_checked_at  TEXT DEFAULT '',          -- NEW  ISO8601
  alive_reason      TEXT DEFAULT '',          -- NEW
  updated_at        TEXT DEFAULT ''
);

-- 存量 db.js initDB() 里加 PRAGMA-gated ALTER（跟 payment_link 一样的模式）。
```

### 5.2 statusDB API 扩展

```js
statusDB.setAlive(email, { alive_status, alive_reason })
// 行为：
//   - alive_checked_at 自动写 new Date().toISOString()
//   - 不动 status / phase / progress / reason / payment_link* 任何字段
//   - 行不存在则 INSERT OR REPLACE（其它字段走 default）
//   - 跟 set() 一样是 merge-aware：未传的字段保持现值

statusDB.clearAlive(email)
// alive_status='unknown', alive_checked_at='', alive_reason='' 复位
// 注：保留 API 接口，本期 runner 不主动调用，UI 也不暴露。
// 留给未来"用户手动复位"或"执行流水线跑完后失效旧测活"场景。

statusDB.getAlive(email) → { alive_status, alive_checked_at, alive_reason }
```

### 5.3 不变式

- `setAlive` 绝不碰 `status` / `payment_link*` 等其它字段。
- 即便 `setAlive` 时这一行的其它字段为空（账号从没跑过执行），也只写 `alive_*` 三列。
- 现有 `statusDB.set / reset / resetAll / resetRunning` 不动 `alive_*`（执行流水线复位 ≠ 测活复位）。
- 老状态迁移（v2.19 那批）跟 alive 字段完全不交叉。

---

## 6. HTTP API + Socket.IO

### 6.1 REST 路由（`server/routes/liveness.js`）

```
POST /api/liveness/start
body: { emails?: string[] }   // 不传 = 全部账号
resp: { ok: true, total, batchId }
行为：
  - runner 已在跑 → 409 'liveness already running'
  - 启动 runner，立即返回；进度通过 socket.io 推送

POST /api/liveness/stop
resp: { ok: true, stopped: <已派发未完成数> }
行为：AbortController.abort()；在跑账号走完当前阶段后退出

GET /api/liveness/status
resp: {
  running: bool,
  batchId: string | null,
  total: number,
  done: number,
  summary: { plus, canceled, login_fail, token_expired, proxy_error, network_error, unknown },
  startedAt: ISO8601 | null
}
```

`server/index.js` 注册：`app.use('/api/liveness', livenessRouter)`。

### 6.2 Socket.IO 事件（独立命名）

| 事件名 | 触发时机 | payload |
|---|---|---|
| `liveness-status` | 单账号 alive_status 变化（含 'checking' 起手 + 终态） | `{ email, alive_status, alive_reason }` |
| `liveness-progress` | 每个账号完成时 | `{ done, total, failed }` |
| `liveness-complete` | 整批结束（含 abort） | `{ total, summary, durationMs }` |
| `liveness-log` | 子步骤日志（一行） | `{ email, level: 'info'\|'warn'\|'error', message }` |

前端订阅：跟现有 `account-status` / `log` / `complete` 同一个 socket 实例，事件名不同。

### 6.3 与 /api/execute 的关系

| 场景 | 是否允许 |
|---|---|
| 主流水线在跑 + 用户点"测活选中" | ✅ 允许（两者并发） |
| 测活在跑 + 用户点"执行选中" | ✅ 允许 |
| 测活在跑 + 用户再点"测活选中" | ❌ 409 拒绝 |
| 主流水线在跑 + 用户再点"执行选中" | ❌ 已有行为，保持 |

**关键不变式**：测活 runner 与 ExecuteEngine **不共享** `isRunning` 锁。

### 6.4 出口代理

- 全程走主代理 `:7890` (US)。
- **不走** JP 通道（JP 是 OpenAI checkout API 专用）。
- 主代理节点坏 → 单账号 `alive_status='proxy_error'`；**不自动 rotate**（rotate 是流水线职责，测活只反映）。

### 6.5 错误传播一览

| 阶段 | 异常类型 | alive_status | alive_reason |
|---|---|---|---|
| accounts/check | 401 | (进重登) | - |
| accounts/check | 5xx | network_error | `check 503` |
| accounts/check | 429 | network_error | `check 429` |
| accounts/check | ECONNRESET/timeout | proxy_error | `proxy reset` |
| accounts/check | 403 | login_fail | `check 403 forbidden` |
| lightLogin | 401 identifier/password | login_fail | `bad password` |
| lightLogin | OTP fetch fail | login_fail | `otp timeout` |
| lightLogin | CAPTCHA | login_fail | `captcha` |
| lightLogin | ECONNRESET | proxy_error | `proxy reset (login)` |
| codex-file 写盘 | EACCES/ENOENT | network_error | `write codex fail` |
| 任意 stage 抛未捕获 | - | network_error | `unexpected: <msg.slice(0,40)>` |

`alive_reason` 字段 ≤60 字符（跟 `reason` 列保持一致）。

---

## 7. UI 改动

### 7.1 Accounts.vue

**顶部 sticky toolbar** 新增 2 个按钮（紧挨现有"执行选中 / 取消选中 / 清除状态"）：

```
[执行选中]  [取消选中]  [清除状态]  |  [测活选中]  [测活全部]
                                       └─ 红色"停止测活"按钮在运行时切入
```

按钮启用规则：
- `测活选中`：选中 ≥1 且 runner 未在跑 → 启用
- `测活全部`：runner 未在跑 → 启用（无需选中）
- 运行时切成 "停止测活" + 进度条 `[34/103 ✓28 ✗6]`

**列表加一列 "活性"**（紧挨现有"状态"列右侧）：

```
| 邮箱 | 状态 | 活性          | 上次测活      | 操作 |
| ...  | plus | 🟢 Plus      | 2 分钟前      | ... |
| ...  | plus | 🟡 已取消     | 17 小时前     | ... |
| ...  | error| 🔴 登录失败   | 刚刚          | ... |
| ...  | idle | ⚪ 未测试     | -            | ... |
| ...  | plus | 🟠 网络异常   | 5 分钟前      | ... |
| ...  | -    | ⏳ 检测中      | -            | ... |
```

- 活性单元 hover → tooltip 显示 `alive_reason` 全文。
- `alive_checked_at` 用 `dayjs.fromNow()` 显示相对时间，hover 显示绝对时间。
- 字段为空 → `⚪ 未测试`、`-`。

**顶部筛选下拉** 新增"按活性筛选"：全部 / Plus / 已取消 / 登录失败 / Token 过期 / 代理异常 / 网络异常 / 未测试。

### 7.2 status.js

```js
const ALIVE_LABELS = {
  plus:           { label: 'Plus',       type: 'success' },
  canceled:       { label: '已取消',     type: 'warning' },
  login_fail:     { label: '登录失败',   type: 'danger'  },
  token_expired:  { label: 'Token 过期', type: 'danger'  },
  proxy_error:    { label: '代理异常',   type: 'warning' },
  network_error: { label: '网络异常',   type: 'warning' },
  unknown:        { label: '未测试',     type: 'info'    },
  checking:       { label: '检测中',     type: 'info'    },
};
export function aliveStatusLabel(code) {
  return ALIVE_LABELS[code] || ALIVE_LABELS.unknown;
}
```

### 7.3 Vue 组件逻辑（伪代码）

```js
const livenessRunning = ref(false);
const livenessProgress = ref({ done: 0, total: 0, failed: 0 });

socket.on('liveness-status', ({ email, alive_status, alive_reason }) => {
  // 更新 accounts[i].alive_*
});
socket.on('liveness-progress', (p) => { livenessProgress.value = p });
socket.on('liveness-complete', ({ summary }) => {
  livenessRunning.value = false;
  ElMessage.success(`测活完成：${summary.plus} Plus / ${summary.canceled} 已取消 / ...`);
});

async function startLiveness(scope /* 'selected' | 'all' */) {
  const emails = scope === 'selected' ? selectedRows.value.map(r => r.email) : undefined;
  await axios.post('/api/liveness/start', { emails });
  livenessRunning.value = true;
}
async function stopLiveness() { await axios.post('/api/liveness/stop'); }
```

### 7.4 视觉

- 沿用 Element Plus `<el-tag :type>`，**不**引入新组件库。
- 进度条用 `<el-progress :percentage>`。
- 跟"执行选中"那条 toolbar 完全一致的间距/字号。

### 7.5 不做（YAGNI）

- ❌ Dashboard.vue KPI 卡 "测活快照"。
- ❌ 定时任务（每 N 小时自动测活）。
- ❌ 测活结果导出 CSV。
- ❌ alive 历史趋势图。

---

## 8. 错误处理 + 边界条件

### 8.1 边界条件清单

| # | 场景 | 处理 |
|---|---|---|
| 1 | 账号没 password | alive_status='login_fail', reason='no password'；不进重登 |
| 2 | Outlook 缺 client_id / refresh_token | alive_status='login_fail', reason='outlook oauth missing' |
| 3 | Gmail 缺 totp_secret | 走重登，OTP 阶段失败 → reason='otp fail (no totp_secret)' |
| 4 | codex-{email}.json JSON 损坏 | 当作"文件不存在"，直接重登 |
| 5 | accounts/check 200 但 body schema 异常 | alive_status='network_error', reason='check schema mismatch'（不重登） |
| 6 | accounts/check 403 | alive_status='login_fail', reason='check 403 forbidden'（不重登） |
| 7 | 重登成功但 /api/auth/session 返回 null | alive_status='login_fail', reason='no session after login' |
| 8 | codex-file 写盘失败 | alive_status='network_error', reason='write codex fail'；alive 仍标 |
| 9 | runner 跑到一半 server crash 重启 | 无恢复机制；下次测活时按 'checking' 当作"未测试"处理 |
| 10 | stop 时账号正在 lightLogin 中段 | AbortError → alive_status 保持上次值（不写 fail，避免误标 dead） |
| 11 | accounts 表里 email 重复 | accountsDB 已按 PK 去重 |
| 12 | 测活进行中删除某账号 | runner 检测到 `accountsDB.get(email)===null` → 跳过，progress.done++ 但不写 alive_status |
| 13 | OpenAI 返回 429 | alive_status='network_error', reason='check 429'；不自动 backoff |
| 14 | sing-box 主代理整体挂 | 第一个账号就 ECONNREFUSED → reason='proxy not running'；逐个标完 |
| 15 | plan_type 未见过的值（如 team/enterprise） | alive_status='canceled', reason=`plan: ${plan_type}` |

### 8.2 全局超时

| 阶段 | 超时 | 超时后行为 |
|---|---|---|
| accounts/check 单次 HTTP | 10s | network_error / reason='check timeout' |
| lightLogin 各步骤总和 | 90s | login_fail / reason='login timeout' |
| OTP 拉取（IMAP） | 60s | login_fail / reason='otp timeout' |
| OTP 拉取（TOTP） | 即时 | - |
| codex-file 写盘 | 5s | network_error |

### 8.3 取消传播

- `livenessRunner.stop()` → `controller.abort()`。
- `checker.probe(token, signal)` 把 signal 透传给 fetch。
- `lightLogin(account, signal)` 透传给 fetch + IMAP（imapflow 支持 AbortSignal）。
- 协议模式：Python 子进程 `liveness_login.py` 收到 SIGTERM 立即退出（已有 spawn 套路）。

### 8.4 日志

- runner 启动/结束打 `[Liveness] start batch=xxx total=N` / `[Liveness] done in 23.4s ✓28 ✗6 ⊘12`
- 每个账号变化打 `[Liveness] alice@x.com checking → plus (check ok in 1.2s)`
- 错误打 stderr 不爆栈（reason 已写明）
- **不复用** `execution_logs` 表 —— 只保留最近一次 `alive_checked_at + alive_reason`，不留全量历史。

---

## 9. 测试策略

### 9.1 单元测试

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `server/liveness/__tests__/checker.test.js` | 8 | JWT exp 解析 / 200 plus / 200 free / 200 schema 异常 / 401 / 5xx / ECONNRESET / timeout |
| `server/liveness/__tests__/light-login.test.js` | 6 | session 解析 / 401 password / OTP 超时 / CAPTCHA / proxy reset / abort 中断 |
| `server/liveness/__tests__/codex-file.test.js` | 5 | 新文件写入 / 覆写已有 / JWT decode account_id / 拼接 last_refresh / 写盘失败 |
| `server/liveness/__tests__/runner.test.js` | 7 | 单账号派发 / 3 并发上限 / 1s 节流 / abort 半途 / 跳过删除账号 / progress 事件次序 / complete summary |
| `__tests__/db-alive.test.js` | 5 | 默认值 / ALTER 迁移 / setAlive merge / ISO 时间戳 / clearAlive |
| `server/__tests__/routes-liveness.test.js` | 4 | start/stop/status 三接口 + 409 already running |

合计 **35 个**新测试。

### 9.2 Mock 策略

- HTTP（accounts/check、auth0、/api/auth/session）→ `nock` 或手写 fetch mock。
- IMAP / TOTP → 抽 `getOtp(account)` 接口，测试时 stub。
- 协议模式 Python 子进程 → 注入 spawn factory，测试时返回 fake child process。
- 文件 IO → temp dir + path 注入（跟 `db-payment-link.test.js` 同套路）。
- socket.io → runner 把 `io.emit` 作依赖注入，测试时塞 fake `{ emit: jest.fn() }`。

### 9.3 集成 smoke（手工）

| 场景 | 期望 |
|---|---|
| 5 个账号"测活选中"，2 个 JWT 未过期 + Plus | 2 个秒变 🟢 Plus，其它 3 个走重登（10-30s） |
| 5 个账号 + sing-box 主代理关掉 | 5 个全部 🟠 代理异常 |
| 测活进行中点"停止" | 当前账号 1-2 秒退出，剩余 alive_status 不变 |
| 测活进行中同时点"执行选中" | 两边并行，互不干扰 |
| 主流水线跑完后 alive_status 还在？ | ✓ 还在 |
| 100 账号"测活全部" | 3 并发 + 1s 间隔，约 60-120s，summary 正确 |

### 9.4 回归保护

跑命令：`node --test __tests__ server/__tests__ server/proxy/__tests__ server/liveness/__tests__`，全部 **52 + 6 + 35 = 93 个**测试 pass。

### 9.5 验收门槛

最终交付前 reviewer 必须确认：

- [ ] 35 个新测试全 pass
- [ ] 既有 52 + 6 个测试无回归
- [ ] `setAlive` 不污染 `status` / `payment_link*` —— 手工 "既跑 execute 又跑 liveness" 小脚本验证独立
- [ ] 中文节点 tag 不会因 UTF-8 编码挂掉 runner
- [ ] `sub2api-*.json` 完全没被碰过（grep `sub2api` 在 `server/liveness/` 应 0 hits）
- [ ] 主流水线在跑时点测活立即可用（不被 isRunning 锁阻塞）

---

## 10. 不做的事（YAGNI 边界总结）

- ❌ 定时任务 / 后台自动测活
- ❌ 测活失败自动重试
- ❌ alive 历史趋势 / 时间序列
- ❌ Dashboard KPI 卡
- ❌ CSV / Excel 导出
- ❌ 自动 rotate proxy when proxy_error
- ❌ 写 sub2api-*.json
- ❌ refresh_token grant 路径（102/103 没存 RT，先天受限）
- ❌ 推送通知 / Slack 通知

如未来需要其中任一项，单独立项 spec。
