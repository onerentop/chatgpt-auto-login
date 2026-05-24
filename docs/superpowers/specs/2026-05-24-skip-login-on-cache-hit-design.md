# 缓存 accessToken 跳过 Phase 1 设计

> **日期**：2026-05-24
> **目标**：在 `account_status` 表持久化上次 protocol-login 拿到的 `accessToken + session`，重试时如果 JWT 未过期就**整段跳过 Phase 1 登录**，配合 v2.25 payment-link cache，让"失败重试"账号从 60-120s 缩到 30-60s。

---

## 1. 背景

### 1.1 现状

- v2.25 payment-link cache：Phase 2 fetch link + Phase 2.5 verify 命中 → 跳过（节省 8-25s/账号）
- 但 Phase 1 (protocol login + OTP) 仍然每次都跑（30-60s/账号）
- 用户场景：iyjq50891 多次失败在 Phase 2.5 verify / Phase 3 PayPal — 每次都重新 IMAP 拉 OTP + 走 auth0 / oauth callback
- 实际数据流分析（protocol-engine.js）：
  - `result` 对象只在 Phase 2 `fetchCheckoutLink(result.accessToken)` 和 Phase 5 `saveCPAAuthFile(email, result.accessToken, result.session)` 用
  - 当 Phase 2 cache 命中时，`result.accessToken` 在 Phase 2 阶段**根本不需要**（已跳过）
  - 仅 Phase 5 还需 accessToken 写 cpa-auth json
  - `runProtocolPKCE` 内部自己重新登录、不用传入的 `result`
- iyjq50891 还没 plus 过 → **没有 cpa-auth/codex-*.json 文件** → 不能复用 cpa-auth 作为 token cache 源

### 1.2 决策摘要

| 维度 | 决策 |
|---|---|
| Cache 源 | 新加 3 列 DB 字段（不复用 cpa-auth json，因 plus 前文件不存在） |
| 字段名 | `last_access_token` / `last_session_json` / `last_access_token_at` |
| 写入时机 | Phase 1 protocol login 成功后 |
| 读取时机 | `dispatchOne` 入口 snapshot（紧跟 v2.26.1 fix 的 `prevPersisted`） |
| 跳登录条件 | `prevPersisted.last_access_token` 存在 AND JWT exp > `Date.now()/1000 + 60` |
| Buffer | 60 秒（留时间给后续 fetch + payment） |
| 浏览器模式 | 同步改 `server/engine.js`（双引擎 mirror） |
| 失败处理 | token 留 DB 等下次重试；payment 成功时 clearAccessToken |
| PKCE 路径 | 不动 — `runProtocolPKCE` 内部重登；cached token 失效时 PKCE fail → plus_no_rt 兜底 |

---

## 2. DB Schema 变更

### 2.1 Schema 增量

```sql
-- 新建 db 进 CREATE TABLE：
CREATE TABLE IF NOT EXISTS account_status (
  email TEXT PRIMARY KEY,
  status TEXT DEFAULT 'idle',
  phase TEXT DEFAULT '',
  progress TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  has_auth_file INTEGER DEFAULT 0,
  payment_link TEXT DEFAULT '',
  payment_link_pk TEXT DEFAULT '',
  payment_link_at TEXT DEFAULT '',
  alive_status TEXT DEFAULT 'unknown',
  alive_checked_at TEXT DEFAULT '',
  alive_reason TEXT DEFAULT '',
  last_access_token TEXT DEFAULT '',          -- NEW  JWT
  last_session_json TEXT DEFAULT '',          -- NEW  JSON.stringify(loginResult.session)
  last_access_token_at TEXT DEFAULT '',       -- NEW  ISO8601 当写入时间戳
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 存量 db.js initDB() 加 PRAGMA-gated ALTER（同 v2.25 / v2.26 套路）。
```

### 2.2 statusDB API 扩展

```js
// statusDB.set 扩展 merge（同 payment_link 套路）：
// - 未传 accessToken/sessionJson 时保留现有值（不被 transient emitStatus 抹掉）
// - 传入空字符串 '' 时清空（用于 clearAccessToken）
// - 写入非空 accessToken 时 last_access_token_at 自动更新到 now ISO

// 新 helper：
statusDB.clearAccessToken(email)
// 把 last_access_token / last_session_json / last_access_token_at 三列清空
// 用于：payment 成功后（token 已转写到 cpa-auth json）
```

### 2.3 不变式

- `setAlive` / `clearAlive` / `clearPaymentLink` / `reset` / `resetAll` / `resetRunning` 均**不动** `last_access_token*` 三列。
- v2.26 setAlive 已经 preserve 全部其他字段；本次只需扩展 setAlive 的字段透传名单。
- transient `emitStatus({ status: 'running' })` 调用不写 `accessToken` 字段 → merge 不变式保护 cached token 不被抹。

---

## 3. 数据流

### 3.1 写入（Phase 1 login 成功后）

`protocol-engine.js` 在 line 278 附近 `Protocol login OK` 之后立即写库：

```js
console.log(`[${progress}] Protocol login OK: ${result.accessToken.slice(0, 32)}...`);
statusDB.set(account.email, {
  accessToken: result.accessToken,
  sessionJson: JSON.stringify(result.session || {}),
});
```

注意：这里**同时**保留现有 `status='running', phase='protocol-login'` 等字段，因为 set 是 merge — 不会污染状态机。

### 3.2 读取（dispatchOne 入口）

紧跟 v2.26.1 引入的 `prevPersisted` snapshot，**在任何 emitStatus 调用之前**：

```js
const prevPersisted = statusDB.get(account.email) || {};
const JWT_BUFFER_SEC = 60;

let result = null;
if (prevPersisted.last_access_token) {
  // decodeJwtExp 复用 v2.26 server/liveness/checker.js 导出的工具
  const { decodeJwtExp } = require('./server/liveness/checker');
  const exp = decodeJwtExp(prevPersisted.last_access_token);
  if (exp > Date.now() / 1000 + JWT_BUFFER_SEC) {
    let session = {};
    try { session = JSON.parse(prevPersisted.last_session_json || '{}'); }
    catch { /* corrupted session_json — fall through to full login */ session = null; }
    if (session) {
      result = {
        accessToken: prevPersisted.last_access_token,
        session,
        planType: session?.account?.planType || session?.chatgpt_plan_type || 'free',
      };
      const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
      console.log(`[${progress}] Phase 1: reusing cached access token (exp in ${minLeft} min)`);
      this.emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
    }
  }
}

if (!result) {
  // existing Phase 1 protocol login flow — unchanged
  this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });
  // ... protocol_register.py spawn / await login output
  // After login OK:
  statusDB.set(account.email, {
    accessToken: result.accessToken,
    sessionJson: JSON.stringify(result.session || {}),
  });
}
```

### 3.3 清除（payment success / already-plus）

```js
if (paymentResult.success) {
  statusDB.clearPaymentLink(account.email);
  statusDB.clearAccessToken(account.email);  // ← NEW
  // ... existing PKCE / saveCPAAuthFile logic
}
```

Already-plus 分支（line 286-298）同样清：

```js
if (isPlusOrAbove) {
  statusDB.clearPaymentLink(account.email);
  statusDB.clearAccessToken(account.email);  // ← NEW
  // ... existing PKCE / save logic
}
```

---

## 4. 行为表

| 场景 | Phase 1 | Phase 2 / 2.5 | Phase 3 | 总耗时 |
|---|---|---|---|---|
| 首次执行（无 cache） | 跑（30-60s） | 跑（8-25s） | 跑（30-60s） | 68-145s |
| 重试 + cache 命中 + token 有效 | **跳过** | **跳过** | 跑 | 30-60s |
| 重试 + cache 命中 + JWT 已过期 | 跑 | 跳过 | 跑 | 38-85s |
| 重试 + cache 命中 + token 被 OpenAI revoke（改密） | 跳过 | 跳过 | 跑（link 自带 stripe session 仍工作）→ Phase 5 PKCE 时 runProtocolPKCE 失败 → plus_no_rt 兜底 | 30-60s + 兜底分支日志 |
| Already-Plus 账号 | 跑（拿 token）| - | - | 30-60s + clearAccessToken |
| 成功支付 | - | - | - | clearAccessToken 触发 |

**预期收益**：重试场景 cache+token 都命中时，单账号从 68-145s 缩到 30-60s（节省 **40-90s/账号**）。

---

## 5. 错误处理 + 边界

| # | 场景 | 处理 |
|---|---|---|
| 1 | `last_session_json` JSON 损坏 | try/catch parse → 回退全量 Phase 1（session=null 时不走 cached path） |
| 2 | `last_access_token` 是空串 | 跳过 cached 分支，走全量 Phase 1（条件 `if (prevPersisted.last_access_token)` 自然不进） |
| 3 | JWT 解析失败（malformed token） | `decodeJwtExp` 返回 0 → exp=0 < now → 不走 cached（同 v2.26 实现） |
| 4 | session 缺 `account.planType` | fallback 链 `account?.planType \|\| chatgpt_plan_type \|\| 'free'` |
| 5 | cached token 还有效 + 账号已是 plus（用户手动开 plus） | Phase 2 cache miss（status 不在 REUSE_STATUSES）→ 走 fetchCheckoutLink，返回 already plus → 走 isPlusOrAbove 分支 → clearAccessToken 清掉 |
| 6 | OpenAI revoke 了 token（账号被封 / 改密） | Phase 3 page.goto(link) 仍 OK（link 不依赖 OpenAI 登录态）；Phase 5 PKCE `runProtocolPKCE` 内部重登发现 token 不行 → catch → plus_no_rt 兜底；下次测活会标 token_expired |
| 7 | Cache 命中跳过 Phase 1 但 result.session 缺 `account` 字段 | saveCPAAuthFile 内部已有 `session?.account` 可选链 fallback；写盘字段空但不抛错 |
| 8 | 浏览器模式下 result.session 形状不同 | 同协议模式 — 实测 server/engine.js 的 loginResult.session 跟 protocol_register.py 输出同 schema |
| 9 | 用户在 cached login 跑到一半点停止 | AbortSignal 已贯穿 — checker.probe / lightLogin 都接受 signal；cached path 本身没异步 IO，stop 在 Phase 2 之前生效 |
| 10 | 缓存的 token 已过期但 `last_access_token_at` 还很新（不一致） | 以 JWT exp 为准；last_access_token_at 仅用于 UI 显示 |

---

## 6. 实现影响

### 6.1 双引擎 mirror

| 文件 | 改动 |
|---|---|
| `server/db.js` | CREATE TABLE +3 列 / PRAGMA-ALTER +3 / statusDB.set 扩展 merge / 新 clearAccessToken |
| `protocol-engine.js` | dispatchOne 入口 cached-login 分支 + login 后 statusDB.set 写 token + success 后 clearAccessToken |
| `server/engine.js` | 同 protocol-engine.js 等价改动（浏览器模式） |

### 6.2 复用 v2.26 工具

- `server/liveness/checker.js` 已导出 `decodeJwtExp` — 直接 require 不重复实现
- 同样的 try/catch 套路、同样的 JWT base64 解析

### 6.3 测试

- `__tests__/db-access-token.test.js` 5 个新单元：
  1. 默认值 / 新行 last_access_token=''
  2. statusDB.set 写入 accessToken + sessionJson 后能 get
  3. **merge 不变式**：不传 accessToken 时不抹缓存（同 payment_link 套路）
  4. clearAccessToken 清三列
  5. statusDB.reset 保留 last_access_token（reset 只动状态）

- protocol-engine.js + server/engine.js 的 cached-login 分支由集成 smoke 验证（无单元，太 IO-heavy）

### 6.4 回归保护

- 141 既有 + 5 新 = 146 测试目标
- 集成 smoke：跑一个失败重试场景 → 看日志 "Phase 1: reusing cached access token"

---

## 7. 不做的事（YAGNI）

- ❌ 不缓存 IMAP OTP（每次重新拉）
- ❌ 不缓存 Discord gateway（每次重连）
- ❌ 不缓存代理节点选择（每次 rotate）
- ❌ 不加"主动 refresh token"功能（exp 自然过期就重登）
- ❌ 不暴露 UI 入口管理 cached token（fully internal）
- ❌ 不加 TTL 单独表（exp 已在 JWT 里）
- ❌ 不存 IP / fingerprint / device_id（token 已绑这些）

---

## 8. 版本号

下次 release 标 **v2.27.0**（小功能，向后兼容；DB schema 增量但 PRAGMA-ALTER 兜底）。
