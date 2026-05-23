# 支付链接缓存：失败重试时跳过 Phase 2 + 2.5

**日期：** 2026-05-24
**范围：** `server/db.js` schema migration + `statusDB` API + 两个 engine 的 Phase 2 入口
**目标：** 拿到 Stripe checkout link 后立即写库；下次同账号在 `error / aborted / paypal_captcha / verify_error` 状态下重试时，直接复用缓存 link 跳过 Phase 2 + Phase 2.5，省 ~15-35 秒/账号

---

## 1. 背景与现状

**Phase 2/2.5 当前耗时：**
- Phase 2 (`fetchCheckoutLink` API / `getPaymentLink` Discord) ≈ 10s (API) / 30s (Discord)
- Phase 2.5 (`verifyCheckoutIsFree` Stripe init) ≈ 2-5s

**当前问题：** 账号在 Phase 3 或更后阶段失败（支付填表、SMS、CAPTCHA、PayPal redirect 等）时，下次重试得**完整重跑** Phase 2 + 2.5 + 3，浪费已经拿到的有效 link。

**DB 现状：** `account_status` 表当前字段 `email / status / phase / progress / reason / has_auth_file / updated_at`，**没有 paymentLink 字段**——emitStatus 事件已经在传 `paymentLink`（`server/engine.js:514`），但只走 WebSocket 给前端，没持久化。

**链接失效检测器现成可用：** `server/stripe-verify.js::verifyCheckoutIsFree(link, pk)` 通过 Stripe `/v1/payment_pages/{cs}/init` 验证。但本次设计**不强制 re-verify**——Phase 3 内部已有 `payment.js::handleOpenAIPage` 的 `NOT_FREE_TRIAL` 安全网（扫页面 DOM，非 $0 即 throw）。

---

## 2. 决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 缓存读取的状态范围 | `error / aborted / paypal_captcha / verify_error` 四个状态 |
| 缓存失效后行为 | 走**完整流程**（登录 → Phase 2 → 2.5 → 3）。不区分 timeout 还是真失效 |
| 缓存命中跳过范围 | **Phase 2 + Phase 2.5**；Phase 1 仍跑（需要 fresh accessToken 给 PKCE / cpa-auth） |
| 缓存命中时是否 re-verify | **不 verify**；Phase 3 内置 NOT_FREE_TRIAL 检测兜底 |
| 缓存存储位置 | `account_status` 表加 3 字段，不开新表 |
| 缓存清除时机 | 支付成功（status → plus / plus_no_rt）→ 清。`statusDB.reset` 不清 |

---

## 3. 架构

```
engine.start() loop per account
  ├─ Phase 1: login → result.accessToken (必跑)
  ├─ 缓存查询：const cached = statusDB.get(email)
  ├─ if (cached.payment_link && cached.status ∈ {error, aborted, paypal_captcha, verify_error}):
  │    link = cached.payment_link
  │    pk   = cached.payment_link_pk
  │    skip Phase 2 + 2.5
  │    → 直接进 Phase 3
  ├─ else:
  │    Phase 2: fetchCheckoutLink / getPaymentLink → { link, pk }
  │    statusDB.set({ ..., paymentLink: link, paymentLinkPk: pk })  ← 立即存,在 Phase 2.5 之前
  │    Phase 2.5: verifyCheckoutIsFree(link, pk)
  │    if !verified → emitStatus verify_error (link 已存,下次重试可读)
  │    if !free → emitStatus no_promo
  │    → Phase 3
  ├─ Phase 3: page.goto(link) → autoPayment(page, ...)
  │    若 link 失效 → NOT_FREE_TRIAL 检测 throw → catch → status='no_link' (无 link 可读路径)
  ├─ Phase 3 success → statusDB.clearPaymentLink(email) + 写 cpa-auth
  └─ Phase 3 fail → emitStatus error/aborted/paypal_captcha (link 保留,下次可读)
```

---

## 4. DB 改动

### 4.1 Schema migration

在 `server/db.js::initDB()` 中，紧接 `CREATE TABLE IF NOT EXISTS execution_logs` 块之后、`hasOld` 状态迁移之前，加防御性补列逻辑：

```js
// Defensive column migration: add payment_link / payment_link_pk / payment_link_at
// to account_status if absent. SQLite has no ALTER TABLE ADD COLUMN IF NOT
// EXISTS, so we check PRAGMA first. Newly-created tables already have the
// columns from CREATE TABLE; this branch only fires on upgrades from <v2.25.
const colsResult = db.exec("PRAGMA table_info(account_status)");
const existingCols = new Set(
  colsResult[0]?.values.map((row) => row[1]) || []
);
if (!existingCols.has('payment_link')) {
  db.run("ALTER TABLE account_status ADD COLUMN payment_link TEXT DEFAULT ''");
}
if (!existingCols.has('payment_link_pk')) {
  db.run("ALTER TABLE account_status ADD COLUMN payment_link_pk TEXT DEFAULT ''");
}
if (!existingCols.has('payment_link_at')) {
  db.run("ALTER TABLE account_status ADD COLUMN payment_link_at TEXT DEFAULT ''");
}
```

同时把 `CREATE TABLE IF NOT EXISTS account_status` 块里的字段也加上（让全新 db 直接有这 3 列）：

```js
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
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 4.2 `statusDB.set` 扩展

**关键不变式：未传 `paymentLink` 字段时，数据库现存的 payment_link 不被清。** 否则每次 `emitStatus({status:'running'})` 都会抹掉缓存。

```js
set(email, data) {
  const existing = this.get(email) || {};
  const incoming = data || {};

  // camelCase → snake_case for the new payment_link* fields. Only apply when
  // the caller explicitly passed the key (otherwise keep existing DB value).
  const payment_link = 'paymentLink' in incoming
    ? (incoming.paymentLink || '')
    : (existing.payment_link || '');
  const payment_link_pk = 'paymentLinkPk' in incoming
    ? (incoming.paymentLinkPk || '')
    : (existing.payment_link_pk || '');
  // Touch updated_at on link only when the link itself was set non-empty
  const payment_link_at = ('paymentLink' in incoming && incoming.paymentLink)
    ? new Date().toISOString()
    : (existing.payment_link_at || '');

  const merged = {
    status: 'idle', phase: '', progress: '', reason: '', has_auth_file: 0,
    ...incoming,
  };
  db.run(`INSERT OR REPLACE INTO account_status
    (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [email, merged.status, merged.phase, merged.progress || '', merged.reason || '',
     merged.has_auth_file ? 1 : 0,
     payment_link, payment_link_pk, payment_link_at]);
  save();
}
```

### 4.3 新 helper `statusDB.clearPaymentLink(email)`

```js
clearPaymentLink(email) {
  db.run("UPDATE account_status SET payment_link='', payment_link_pk='', payment_link_at='' WHERE email=?", [email]);
  save();
}
```

### 4.4 `statusDB.get` 不变

`getAsObject()` 自动返回新 3 字段。

### 4.5 `statusDB.reset` / `resetAll` / `resetRunning` 不变

reset 只重置 `status / phase / progress / reason`，**保留 payment_link 字段**——语义上 reset 是"重置状态"而非"清缓存"。

---

## 5. Engine 改动（`protocol-engine.js` + `server/engine.js`）

两个 engine 改动点和形态完全一样。

### 5.1 在 Phase 2 入口处加缓存查询

伪代码（实际接入点见 §6）：

```js
const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);

// Check cache before Phase 2 fetch
const cached = statusDB.get(account.email);
let link = '';
let pk = '';
let fetchResult = null;
let usedCachedLink = false;

if (cached && cached.payment_link && REUSE_STATUSES.has(cached.status)) {
  link = cached.payment_link;
  pk = cached.payment_link_pk || '';
  usedCachedLink = true;
  console.log(`${p} Phase 2: reusing cached payment link (status was ${cached.status}, cached at ${cached.payment_link_at})`);
}
```

### 5.2 缓存未命中时走原 Phase 2 + 拿到 link 后立即存

```js
if (!usedCachedLink) {
  // existing Phase 2 fetch retry loop (3 attempts)
  for (...) { ... fetchCheckoutLink / getPaymentLink ... }
  link = fetchResult.link;
  pk = fetchResult.pk || '';

  // Persist link immediately (BEFORE Phase 2.5) so verify_error retries can
  // skip Phase 2 too. This is the key write that makes the cache work.
  if (link) {
    statusDB.set(account.email, {
      status: 'running', phase: 'verify', progress,
      paymentLink: link, paymentLinkPk: pk,
    });
  }

  // existing Phase 2.5 verify logic — unchanged
  // ...
}
```

### 5.3 Phase 3 不变

`page.goto(link)` + `autoPayment(...)` 用同一份代码处理 cached/fresh link。link 失效场景由 Phase 3 内部 `NOT_FREE_TRIAL` 检测器兜底。

### 5.4 成功时清缓存

支付成功分支（status → `plus_no_rt` / `plus`）的 `saveCPAAuthFile` 调用之后，加一行：

```js
statusDB.clearPaymentLink(account.email);
```

避免下次同账号重试用旧 link（一个 Stripe session 用过一次再用大概率失败）。

---

## 6. 具体接入点

### 6.1 `protocol-engine.js`

| 改动点 | 位置 |
|---|---|
| 顶部 require | 与现有 `const { statusDB } = require('./server/db')` 一致；如未直接 require 需加 |
| Phase 2 缓存查询 | line 288-291 之间（Phase 2 retry loop 之前）|
| 拿 link 后立即存 | line 316 之后 `link = fetchResult.link;` 处加 statusDB.set |
| 成功清缓存 | line 422 `summary.success++;` 之前加 `statusDB.clearPaymentLink(account.email)` |

### 6.2 `server/engine.js`

| 改动点 | 位置 |
|---|---|
| 顶部 require | 现已 `const { statusDB } = require('./db')` |
| Phase 2 缓存查询 | line 297 注释 `// Phase 2: payment link fetch` 之后 |
| 拿 link 后立即存 | line 316 `discord.link = ...` 之后（或 fetch 成功分支内）|
| 成功清缓存 | line 437 `saveCPAAuthFile(...)` 之后 |

---

## 7. 错误处理 & 边缘情况

- **Discord 路径拿到 link 但没 pk**：`paymentLinkPk` 存空字符串。下次复用时 `pk=''`，autoPayment 不需要 pk（pk 仅 Phase 2.5 用），所以 cached Discord link 仍能复用
- **缓存 link 但 status 不在 REUSE_STATUSES**（如 `no_link` / `no_promo` / `no_jp_proxy` / 老的 `verify_error` 之前没存）：不读缓存，走完整流程
- **多账号同时跑**：每个 email 独立 cache，schema 主键是 email，无冲突
- **engine.stop() 中途中断**：链路写状态时已经写过 `paymentLink`，下次 retry 这个账号能读到缓存
- **缓存 link 已过期 / amount_due 变 $20**：进入 Phase 3 后 `payment.js::handleOpenAIPage` 扫页面 DOM 检测 → throw `NOT_FREE_TRIAL` → engine catch → status=`no_link` → 下次重试时 status=`no_link` ∉ REUSE_STATUSES，走完整流程（链接不会再读，自动失效路径）
- **链接被 chrome-error 拦下**：现有 chrome-error 检测 + markBad + rotate + 单次 retry 机制兜底（v2.23 加的）

---

## 8. 改动文件清单

| 文件 | 改动 | 行数 |
|---|---|---|
| `server/db.js` | `CREATE TABLE` 加 3 列；`initDB()` 加 PRAGMA-based ALTER；`statusDB.set` 扩展 merge 逻辑；新增 `statusDB.clearPaymentLink` | ~30 |
| `protocol-engine.js` | 入口加 cache 查询 + skip 逻辑；Phase 2 之后立即 statusDB.set 含 paymentLink；success 后 clearPaymentLink | ~20 |
| `server/engine.js` | 同上 | ~20 |
| `__tests__/db-payment-link.test.js` | 新建 4-5 个单元测试覆盖 statusDB.set 不抹缓存 + clearPaymentLink 工作 + REUSE_STATUSES 边界 | ~80 |

---

## 9. 测试策略

**新增 `__tests__/db-payment-link.test.js`：**
1. `statusDB.set` 传 `paymentLink: 'https://...'` → 存进去能 get 出来；`payment_link_at` 同时被设
2. `statusDB.set` 不传 `paymentLink` 字段 → 现存 `payment_link` **不被抹**（关键不变式）
3. `statusDB.set` 传 `paymentLink: ''` 显式空 → 现存 `payment_link` 被清
4. `statusDB.clearPaymentLink(email)` → 3 列都变空
5. `statusDB.reset(email)` → status 重置，但 `payment_link` 保留

**手工 dry-run（spec 完成判定）：**
1. 跑一个账号到 Phase 3 然后点 stop → 账号 status=`aborted`，db 里能看到 payment_link
2. 重试该账号 → engine log 出现 `Phase 2: reusing cached payment link`，**不打** `Phase 2: payment link via api/discord`
3. Phase 3 流程继续，能跑完或在同位置再次失败

---

## 10. 非目标

- **不缓存 accessToken / session** —— 这俩在 PKCE / cpa-auth 写盘时用，每次跑都需要 fresh，缓存收益小且复杂度高
- **不实现"链接失效主动检测"** —— Phase 3 内置 NOT_FREE_TRIAL 已经兜底
- **不改 Web UI** —— payment_link 字段可以在后续 ticket 暴露到 dashboard 显示，本次只做后端缓存
- **不动 reset/resetAll 语义** —— "重置状态"不等于"清缓存"，让 user 想强制刷新 link 时用 `clearPaymentLink` 显式调（暂无 UI 入口；可后续加）
- **不缓存 Phase 3 任何中间状态** —— 只缓存最简单的 link，复杂度低
