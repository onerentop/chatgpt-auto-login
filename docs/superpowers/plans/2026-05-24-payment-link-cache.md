# 支付链接缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把拿到的 Stripe checkout link 立即写进 `account_status` 表;下次同账号在 `error / aborted / paypal_captcha / verify_error` 状态下重试时,直接复用缓存 link 跳过 Phase 2 + Phase 2.5,省 ~15-35 秒/账号。

**Architecture:** `account_status` 表加 3 列(`payment_link / payment_link_pk / payment_link_at`)。`statusDB.set` 改成 merge 写法(未传 paymentLink 时保留 DB 现存值,关键不变式)。两个 engine 在 Phase 2 入口处查 cache,命中时直接跳到 Phase 3;Phase 3 内置的 `NOT_FREE_TRIAL` 检测兜底失效 link。支付成功时调新增的 `statusDB.clearPaymentLink` 清缓存。

**Tech Stack:** Node + sql.js(SQLite WASM), `node:test`

**Spec:** `docs/superpowers/specs/2026-05-24-payment-link-cache-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/db.js` | `CREATE TABLE` 加 3 列;`initDB()` 加 PRAGMA-based ALTER 防御性 migration;`statusDB.set` 扩展 merge 逻辑;新增 `statusDB.clearPaymentLink` | 修改 |
| `__tests__/db-payment-link.test.js` | 5 个单元测试:set 不抹缓存 / set 显式清 / clearPaymentLink / reset 保留 / 全新写入 | 新建 |
| `protocol-engine.js` | Phase 2 入口前 cache 查询;拿 link 后立即 `statusDB.set`;success 后 `clearPaymentLink` | 修改 |
| `server/engine.js` | 同上 | 修改 |

---

## Task 1: DB schema migration + `statusDB.set` 改造 + 5 个单元测试(TDD)

**Files:**
- Create: `__tests__/db-payment-link.test.js`
- Modify: `server/db.js`

- [ ] **Step 1: 创建测试文件,5 个 case(先红)**

Create `__tests__/db-payment-link.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a per-process temp data.db so tests don't clobber the real one
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-payment-link-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

// Override DB_PATH before requiring db.js by monkey-patching path.join.
// We do this once at module load; db.js resolves DB_PATH at require time.
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  // Match exactly the db.js call: path.join(__dirname, '..', 'data.db')
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};

const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;  // restore for other modules

test('setup: init schema in fresh temp db', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.ok(row, 'row created');
  assert.strictEqual(row.payment_link, '', 'fresh row has empty payment_link');
  assert.strictEqual(row.payment_link_pk, '', 'fresh row has empty payment_link_pk');
  assert.strictEqual(row.payment_link_at, '', 'fresh row has empty payment_link_at');
});

test('statusDB.set 写入 paymentLink 后能 get 出来,payment_link_at 同时被设', () => {
  statusDB.set('b@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_abc', paymentLinkPk: 'pk_live_xyz' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_abc');
  assert.strictEqual(row.payment_link_pk, 'pk_live_xyz');
  assert.ok(row.payment_link_at && row.payment_link_at.length > 0, 'payment_link_at should be set');
});

test('statusDB.set 不传 paymentLink 时 DB 现存 payment_link 不被抹(关键不变式)', () => {
  // b@x.com already has payment_link from previous test; subsequent set without paymentLink must preserve it
  statusDB.set('b@x.com', { status: 'error', reason: 'failed' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_abc', 'payment_link preserved');
  assert.strictEqual(row.payment_link_pk, 'pk_live_xyz', 'pk preserved');
  assert.strictEqual(row.status, 'error', 'status updated as expected');
});

test('statusDB.set 显式传 paymentLink="" 清空缓存', () => {
  statusDB.set('b@x.com', { status: 'error', paymentLink: '' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.payment_link, '', 'explicit empty wipes link');
});

test('statusDB.clearPaymentLink 清空 3 列', () => {
  statusDB.set('c@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_def', paymentLinkPk: 'pk_live_xyz' });
  statusDB.clearPaymentLink('c@x.com');
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.payment_link, '');
  assert.strictEqual(row.payment_link_pk, '');
  assert.strictEqual(row.payment_link_at, '');
});

test('statusDB.reset 保留 payment_link(reset 只重置状态)', () => {
  statusDB.set('d@x.com', { status: 'running', paymentLink: 'https://pay.openai.com/c/pay/cs_live_ghi', paymentLinkPk: 'pk_live_xyz' });
  statusDB.reset('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.status, 'idle', 'status was reset');
  assert.strictEqual(row.payment_link, 'https://pay.openai.com/c/pay/cs_live_ghi', 'payment_link preserved through reset');
});
```

- [ ] **Step 2: 运行测试看到失败**

Run:
```
node --test __tests__/db-payment-link.test.js
```
Expected: 6 tests fail (some on `payment_link is undefined`, others on `statusDB.clearPaymentLink is not a function`).

- [ ] **Step 3: 改 `server/db.js` 的 `CREATE TABLE IF NOT EXISTS account_status` 加 3 列**

Find this block in `server/db.js` (around line 27-35):

```js
    CREATE TABLE IF NOT EXISTS account_status (
      email TEXT PRIMARY KEY,
      status TEXT DEFAULT 'idle',
      phase TEXT DEFAULT '',
      progress TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      has_auth_file INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
```

Replace with:

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

- [ ] **Step 4: 在 `initDB()` 内 hasOld 之前加防御性 ALTER**

Find this section in `server/db.js` (around line 46-53, the `hasOld` migration block):

```js
  // One-time migration of old status values
  const hasOld = db.exec("SELECT COUNT(*) FROM account_status WHERE status IN ('needs_phone','oauth_failed','success','already_plus','failed','pending')");
```

**Just before** that `// One-time migration of old status values` comment, insert:

```js
  // Defensive column migration: add payment_link / payment_link_pk / payment_link_at
  // to account_status if absent. SQLite has no ALTER TABLE ADD COLUMN IF NOT
  // EXISTS, so we PRAGMA first. Newly-created tables already have the columns
  // from CREATE TABLE; this branch only fires on upgrades from data.db files
  // created before v2.25.
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

- [ ] **Step 5: 改造 `statusDB.set` 为 merge 写法**

Find the current `statusDB.set` in `server/db.js` (around line 101-106):

```js
  set(email, data) {
    const { status, phase, progress, reason, has_auth_file } = { status:'idle', phase:'', progress:'', reason:'', has_auth_file:0, ...data };
    db.run("INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress||'', reason||'', has_auth_file?1:0]);
    save();
  },
```

Replace with:

```js
  set(email, data) {
    // Merge with existing row so callers can update just a subset of fields.
    // Critical invariant: NOT passing `paymentLink` must keep the existing
    // DB value — otherwise every transient emitStatus call (which doesn't
    // know about cached links) would silently wipe the cache.
    const existing = this.get(email) || {};
    const incoming = data || {};
    const { status, phase, progress, reason, has_auth_file } = {
      status: 'idle', phase: '', progress: '', reason: '', has_auth_file: 0,
      ...incoming,
    };
    // camelCase → snake_case for the new payment_link* fields. Only override
    // when the caller explicitly passed the key.
    const payment_link = 'paymentLink' in incoming
      ? (incoming.paymentLink || '')
      : (existing.payment_link || '');
    const payment_link_pk = 'paymentLinkPk' in incoming
      ? (incoming.paymentLinkPk || '')
      : (existing.payment_link_pk || '');
    const payment_link_at = ('paymentLink' in incoming && incoming.paymentLink)
      ? new Date().toISOString()
      : (existing.payment_link_at || '');
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress || '', reason || '', has_auth_file ? 1 : 0,
       payment_link, payment_link_pk, payment_link_at]
    );
    save();
  },
```

- [ ] **Step 6: 新增 `statusDB.clearPaymentLink` 方法**

In `server/db.js`, inside the `const statusDB = { ... }` block, after the existing `resetRunning()` method (around line 109), add a new method:

```js
  clearPaymentLink(email) {
    db.run("UPDATE account_status SET payment_link='', payment_link_pk='', payment_link_at='' WHERE email=?", [email]);
    save();
  },
```

- [ ] **Step 7: 运行测试看到通过**

Run:
```
node --test __tests__/db-payment-link.test.js
```
Expected: `# pass 6 # fail 0` (all 5 plus the setup test).

- [ ] **Step 8: 跑现有 Node tests 不回归**

Run:
```
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected: existing pass count unchanged (will not include the new payment-link tests because we don't include that file in this run; the next task verifies cross-test).

- [ ] **Step 9: Commit**

```bash
git add server/db.js __tests__/db-payment-link.test.js
git commit -m "feat(db): payment_link cache columns + merge-aware statusDB.set

Adds 3 columns to account_status — payment_link, payment_link_pk,
payment_link_at — covered by CREATE TABLE (new dbs) and a PRAGMA-gated
ALTER TABLE branch in initDB() (existing data.db files).

The set() method is rewritten as a merge: not passing paymentLink in
the incoming data keeps the existing DB value. This is the key
invariant that makes the cache safe — every engine.emitStatus call
(transient running/phase updates) would otherwise wipe the cache
because those calls don't know to re-include the link. Explicit
paymentLink: '' still clears the value.

Adds statusDB.clearPaymentLink(email) for the success path to use.
reset/resetAll/resetRunning intentionally untouched — 'reset state'
isn't 'clear cache', and the only callers that should wipe the link
are success (about to write cpa-auth) or explicit user action.

Tests: 5 unit cases covering set-then-get, the don't-wipe invariant,
explicit empty-clears, clearPaymentLink wipes all 3 cols, and
reset preserves the link."
```

---

## Task 2: `protocol-engine.js` cache 查询 + write + clear

**Files:**
- Modify: `protocol-engine.js` (3 spots)

- [ ] **Step 1: 添加 statusDB import**

In `protocol-engine.js`, find the existing requires near the top. Locate:
```js
const { saveCPAAuthFile } = require('./utils');
```
(actual line near 11). Right after that line, add:
```js
const { statusDB } = require('./server/db');
```

If `statusDB` is already imported elsewhere in the file, skip this. Verify by `grep "statusDB" protocol-engine.js`. If 0 hits, do the insert; if there are hits, the import already exists.

- [ ] **Step 2: 加 cache 查询逻辑(Phase 2 fetch 之前)**

Find this block in `protocol-engine.js` (around line 304-320, the Phase 2 fetch retry loop):

```js
        let linkFetchOk = false;
        let fetchResult = null;
        for (let dRetry = 0; dRetry < 3; dRetry++) {
          try {
            if (dRetry > 0) console.log(`[${progress}] Link fetch retry ${dRetry + 1}/3...`);
            if (linkSource === 'discord') {
              fetchResult = await getPaymentLink(this._gw, result.accessToken);
            } else {
              fetchResult = await fetchCheckoutLink(result.accessToken);
            }
            link = fetchResult.link;
```

The variable `link` is declared earlier (around line 292). Just **before** the `let linkFetchOk = false;` line, insert this cache-check block:

```js
        // Cache check: if this account failed in Phase 3+ on a previous run,
        // it may have a usable Stripe link still in the DB. Reuse it to skip
        // Phase 2 (fetch) + Phase 2.5 (verify). Phase 3's NOT_FREE_TRIAL
        // detector handles stale links by throwing → status='no_link', which
        // won't be in REUSE_STATUSES on the next retry → forced full refetch.
        const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);
        const cached = statusDB.get(account.email);
        let usedCachedLink = false;
        if (cached && cached.payment_link && REUSE_STATUSES.has(cached.status)) {
          link = cached.payment_link;
          fetchResult = { link, pk: cached.payment_link_pk || '', title: 'cached', raw: '' };
          usedCachedLink = true;
          console.log(`[${progress}] Phase 2: reusing cached payment link (was ${cached.status} at ${cached.payment_link_at})`);
        }

```

- [ ] **Step 3: 让 Phase 2 fetch 在 cache 命中时跳过**

Find the fetch retry loop now (it's the block immediately after the insert in Step 2). Wrap its entry with `if (!usedCachedLink) { ... }`. Specifically, find:

```js
        let linkFetchOk = false;
        let fetchResult = null;
```

We already declared `fetchResult` in Step 2 (it was reassigned there). Change this pair to:

```js
        let linkFetchOk = usedCachedLink;
        if (!fetchResult) fetchResult = null;
```

Then find the `for (let dRetry = 0; dRetry < 3; dRetry++) {` retry loop right after, and wrap the entire loop in `if (!usedCachedLink) { ... }`. The original loop:

```js
        for (let dRetry = 0; dRetry < 3; dRetry++) {
          try {
            ... (fetch + check + emitStatus on failure)
          } catch (e) { ... }
        }
        if (!link) continue;
```

becomes:

```js
        if (!usedCachedLink) {
          for (let dRetry = 0; dRetry < 3; dRetry++) {
            try {
              ... (unchanged body)
            } catch (e) { ... (unchanged) }
          }
        }
        if (!link) continue;
```

(Indent the original loop body by 2 spaces to nest it inside the new `if`. Do NOT modify any code inside the loop body.)

- [ ] **Step 4: 拿 link 后立即存库(在 Phase 2.5 之前)**

Find the existing Phase 2.5 block (around line 344-348):

```js
        // Phase 2.5: Stripe init 验证 (API path only; Discord skips — bot is authority)
        if (linkSource !== 'discord') {
          this.emitStatus({ email: account.email, status: 'running', phase: 'verify', progress });
          console.log(`[${progress}] Phase 2.5: Verifying $0 via Stripe init...`);
```

**Just before** the `// Phase 2.5:` comment, insert:

```js
        // Persist link to DB immediately so verify_error / Phase 3 retries
        // can skip Phase 2 next time. This is intentionally BEFORE verify —
        // if verify fails, the link is still cached for the next retry to
        // try (verify_error is one of REUSE_STATUSES).
        if (link && !usedCachedLink) {
          statusDB.set(account.email, {
            status: 'running', phase: 'verify', progress,
            paymentLink: link, paymentLinkPk: fetchResult.pk || '',
          });
        }

```

(The `&& !usedCachedLink` guard avoids re-writing the same link with a new `payment_link_at` timestamp when we already pulled it from cache.)

- [ ] **Step 5: 支付成功时清缓存**

Find the success branch where `saveCPAAuthFile` is called and emitStatus sends `plus_no_rt` (around line 282-286):

```js
        // Check if already Plus
        const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes((result.planType || 'free').toLowerCase());
        if (isPlusOrAbove) {
          ...
        }
```

Wait — that branch is "already Plus from login", not "payment success". The actual payment-success branch is further down. Search for `summary.success++` in this file. Around line 419-423:

```js
          if (paymentResult.success) {
            if (runtimeCfg.enableOAuth) {
              ...
              await this._finalizePkce(account, result, progress);
            } else {
              saveCPAAuthFile(account.email, result.accessToken, result.session);
              this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
            }
            summary.success++;
          }
```

**Inside the `if (paymentResult.success) {` block, right at the top** (immediately after the opening brace), add:

```js
            statusDB.clearPaymentLink(account.email);
```

So the block becomes:

```js
          if (paymentResult.success) {
            statusDB.clearPaymentLink(account.email);
            if (runtimeCfg.enableOAuth) {
              ...
```

Also handle the "already Plus" branch (around line 282-287) — that account didn't go through Phase 3 so it can't have written a payment_link this run, but if a stale link exists from a previous run (say the account became Plus after we already cached a link), clear it for hygiene:

In the `if (isPlusOrAbove) { ... }` block right at the top (after the opening brace), also add:

```js
          statusDB.clearPaymentLink(account.email);
```

- [ ] **Step 6: 语法 + 所有现有测试不回归**

Run:
```
node --check protocol-engine.js && echo SYNTAX OK
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js __tests__/db-payment-link.test.js server/proxy/__tests__/index.test.js
```
Expected: `SYNTAX OK` + total pass = previous (5 abort + 16 readiness + 12 proxy) + 6 db-payment-link = 39 pass

- [ ] **Step 7: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol-engine): reuse cached payment link when retrying after Phase 3 failures

ProtocolEngine now consults statusDB.get(email) before Phase 2. When
the account's current status is one of error / aborted / paypal_captcha
/ verify_error AND a payment_link is cached, skip the Phase 2 fetch
loop AND Phase 2.5 verify entirely — go straight to Phase 3 with the
cached link.

When the fetch path runs normally, persist the link to DB immediately
*before* Phase 2.5 verify. That way even verify_error retries can
benefit (the link is intentionally kept across verify failures because
verify might be a network blip).

Success branch (both 'already Plus' fast-path and the payment-just-
completed branch) calls statusDB.clearPaymentLink so the next time
this account is run it doesn't accidentally reuse a one-shot Stripe
session that's been consumed."
```

---

## Task 3: `server/engine.js` cache 查询 + write + clear

**Files:**
- Modify: `server/engine.js` (3 spots)

- [ ] **Step 1: 添加 statusDB import**

In `server/engine.js`, find the existing requires near the top (around line 18-25). Locate where statusDB is or isn't already imported. Run `grep "statusDB" server/engine.js` first.

If 0 hits, find a line like `const { saveCPAAuthFile } = require('./utils');` (around line 25) and add right after:

```js
const { statusDB } = require('./db');
```

If statusDB is already imported, skip.

- [ ] **Step 2: 加 cache 查询逻辑(Phase 2 fetch 之前)**

Find this block in `server/engine.js` (around line 297-310, the Phase 2 fetch retry):

```js
            // Phase 2: payment link fetch (retry up to 3 times on transient errors)
            currentPhase = 'discord';
            console.log(`${p} Phase 2: payment link via ${linkSource}...`);
            let discord = null;
            for (let dRetry = 0; dRetry < 3; dRetry++) {
              try {
                if (dRetry > 0) console.log(`${p} Link fetch retry ${dRetry + 1}/3...`);
                if (linkSource === 'discord') {
                  discord = await getPaymentLink(gw, loginResult.accessToken);
                } else {
                  discord = await fetchCheckoutLink(loginResult.accessToken);
                }
```

**Immediately after** the `console.log(`${p} Phase 2: ...);` line, before `let discord = null;`, insert:

```js
            // Cache check: skip Phase 2 fetch + Phase 2.5 verify when this
            // account previously failed in Phase 3+ and has a usable Stripe
            // link in the DB. Phase 3's NOT_FREE_TRIAL detector handles
            // stale links (becomes status='no_link', which is not in
            // REUSE_STATUSES → next retry forces full refetch).
            const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);
            const cached = statusDB.get(account.email);
            let usedCachedLink = false;

```

Then change:
```js
            let discord = null;
```
to:
```js
            let discord = null;
            if (cached && cached.payment_link && REUSE_STATUSES.has(cached.status)) {
              discord = { link: cached.payment_link, pk: cached.payment_link_pk || '', title: 'cached', raw: '' };
              usedCachedLink = true;
              console.log(`${p} Phase 2: reusing cached payment link (was ${cached.status} at ${cached.payment_link_at})`);
            }
```

- [ ] **Step 3: 让 Phase 2 fetch loop 跳过(if !usedCachedLink)**

Right after the cache-check block from Step 2, find the existing retry loop:

```js
            for (let dRetry = 0; dRetry < 3; dRetry++) {
              try {
                ...
              } catch (e) { ... }
            }
```

Wrap the entire `for` loop with `if (!usedCachedLink) { ... }`:

```js
            if (!usedCachedLink) {
              for (let dRetry = 0; dRetry < 3; dRetry++) {
                try {
                  ... (unchanged body, indented +2 spaces)
                } catch (e) { ... (unchanged) }
              }
            }
```

- [ ] **Step 4: 拿 link 后立即存库**

Find this section (around line 340-353):

```js
              // === 分支 C: 拿到 link → Phase 2.5 Stripe 验证 ===
            } else {
              console.log(`${p} Link: ${discord.link.slice(0, 80)}...`);
              ...
              // API path: enforce Phase 2.5 verify to fail-fast on non-$0 links.
              let v = null;
              if (linkSource === 'discord') {
                console.log(`${p} Phase 2.5: skipped (Discord path — bot is eligibility authority)`);
              } else {
                console.log(`${p} Phase 2.5: Verifying $0 via Stripe init...`);
                v = await verifyCheckoutIsFree(discord.link, discord.pk);
```

**Immediately after** the line `console.log(`${p} Link: ${discord.link.slice(0, 80)}...`);`, insert:

```js
              // Persist link to DB immediately so verify_error / Phase 3 retries
              // can skip Phase 2 next time. Guard with !usedCachedLink so a
              // cached-link rerun doesn't refresh payment_link_at.
              if (!usedCachedLink) {
                statusDB.set(account.email, {
                  status: 'running', phase: 'verify', progress,
                  paymentLink: discord.link, paymentLinkPk: discord.pk || '',
                });
              }
```

- [ ] **Step 5: 支付成功时清缓存**

Find the payment-success branch (around line 408-415):

```js
                if (paymentOk) {
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else if (paymentStatus === 'aborted') {
                  ...
```

**Inside the `if (paymentOk) {` block, right at the top** (immediately after the opening brace), add:

```js
                  statusDB.clearPaymentLink(account.email);
```

So the block becomes:

```js
                if (paymentOk) {
                  statusDB.clearPaymentLink(account.email);
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
```

Also find the "already Plus" branch (search for `isPlusOrAbove` in the file). It's around line 261-267. Find the block:

```js
            if (isPlusOrAbove) {
              console.log(`${p} Already Plus`);
              ...
            }
```

Right at the top inside (after opening brace), add the same line:
```js
              statusDB.clearPaymentLink(account.email);
```

- [ ] **Step 6: 语法 + 所有测试不回归**

Run:
```
node --check server/engine.js && echo SYNTAX OK
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js __tests__/db-payment-link.test.js server/proxy/__tests__/index.test.js
```
Expected: `SYNTAX OK` + 39 pass (same as Task 2 Step 6)

- [ ] **Step 7: Commit**

```bash
git add server/engine.js
git commit -m "feat(engine): reuse cached payment link in browser mode too

Mirrors the protocol-engine change one commit back. PipelineEngine
(browser mode) now reads statusDB.get(email) before Phase 2 and, when
the account is in error / aborted / paypal_captcha / verify_error AND
a payment_link is cached, skips the fetch loop and verify step. The
cached link feeds straight into Phase 3.

Persists the link to DB right after fetch (before Phase 2.5 verify),
so verify_error retries can short-circuit Phase 2.

Success branches (both 'already Plus' and payment-just-completed) call
statusDB.clearPaymentLink so stale one-shot Stripe sessions don't get
reused on subsequent runs of the same account."
```

---

## Task 4: 全量回归 + 重启 server + dry-run 指南

**Files:** None (verification only)

- [ ] **Step 1: 跑全量 Node 测试**

Run:
```
node --test __tests__/abortable-sleep.test.js __tests__/payment-readiness.test.js __tests__/db-payment-link.test.js server/proxy/__tests__/index.test.js
```
Expected: `# pass 39` (5 abort + 16 readiness + 6 db-payment-link + 12 proxy)

- [ ] **Step 2: 4 个文件 syntax check**

Run:
```
node --check server/db.js && node --check protocol-engine.js && node --check server/engine.js && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`

- [ ] **Step 3: Inventory grep**

Run:
```
grep -c "statusDB.clearPaymentLink\|statusDB.get(account.email)\|paymentLink:" protocol-engine.js server/engine.js
```
Expected: at least 3 hits in each file (1 cache read + 1 write + 1 clear in success branch; some files may have 2 clears for both Plus branches).

- [ ] **Step 4: 重启 server**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force }
```
Bash:
```bash
cd chatgpt-auto-login
node server/index.js > server.log 2>&1 &
sleep 5
```
Verify:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { "OK PID=$($p.OwningProcess)" } else { 'Not listening' }
Get-Content E:\workspace\projects\demo\chatgpt-auto-login\server.log -Tail 10
```
Expected: server listening + `[Proxy] sing-box running` + `[Proxy] Auto-started`.

- [ ] **Step 5: 手工 dry-run — 验证缓存命中路径**

Through web dashboard:
1. 选一个 idle 账号点 `执行选中`
2. 等账号进入 Phase 3 (日志出现 `[Pay] Starting auto-payment flow...`)
3. 点 `停止` (abort feature from v2.24.0 should stop within 1s)
4. 该账号 status 应为 `aborted`，且 `data.db` 里能看到该 email 行的 `payment_link` 非空（用 sqlite browser 或 `sqlite3 data.db "SELECT email, status, payment_link FROM account_status WHERE email='...'"`）
5. 再次 `执行选中` 同一账号
6. **观察日志**：应该出现一行 `Phase 2: reusing cached payment link (was aborted at ...)`，**不出现** `Phase 2: payment link via api/discord...` 或 `Phase 2.5: Verifying ...`
7. Phase 3 流程继续，从 `[Pay] Starting auto-payment flow...` 开始
8. 账号要么成功（status=plus_no_rt，且 db 里 payment_link 被 cleared）要么再次失败（status=error，db 里 payment_link 保留）

如果第 6 步看到 `Phase 2: payment link via api/discord` —— 缓存读取失败，回到 Task 2/3 检查 cache 查询代码是否真的运行到。

这是 verify-only task,没有 commit。

---

## 完成判定

- ✅ 6 个 db-payment-link 单元测试 pass
- ✅ 现有 33 个 Node 测试不回归（5 abort + 16 readiness + 12 proxy）
- ✅ 4 个 JS 文件 syntax check OK
- ✅ Server 重启正常 + sing-box 启动
- ✅ 手工 dry-run：第二次跑同账号时日志出现 `reusing cached payment link`，不出现 Phase 2 / 2.5 日志

---

## Self-Review Checklist（写完后已自审）

**Spec 覆盖：**
- §4.1 schema migration → Task 1 Step 3 + Step 4 ✓
- §4.2 set 改造 → Task 1 Step 5 ✓
- §4.3 clearPaymentLink → Task 1 Step 6 ✓
- §4.4 get 不变 → 不需改动 ✓
- §4.5 reset 不变 → 不需改动；测试覆盖（Task 1 Step 1 第 6 个 test） ✓
- §5 engine 改动 → Task 2 (protocol-engine) + Task 3 (server/engine) ✓
- §6 接入点行号 → Task 2/3 都给了 grep 锚点字符串 ✓
- §7 边缘情况 → 不需要专门 task（Discord 无 pk / 失效自动落 no_link 由 NOT_FREE_TRIAL 兜底；chrome-error 由 v2.23 节点轮换兜底）
- §8 改动文件 → 列出 4 个 ✓
- §9 测试策略 → 5 个单元测试 + dry-run guide 都在 ✓

**Placeholder 扫描：** 无 TBD / TODO；所有代码块完整。

**类型/方法一致性：**
- `paymentLink` / `paymentLinkPk` camelCase keys 在 Task 1 set 改造中识别，在 Task 2/3 emitStatus 调用中传入 — 一致 ✓
- `REUSE_STATUSES` Set 在 Task 2 / Task 3 都用同样 4 个 status 值 ✓
- `statusDB.clearPaymentLink(email)` 签名在 Task 1 定义、Task 2 / Task 3 调用 — 一致 ✓
- `payment_link / payment_link_pk / payment_link_at` snake_case 列名在 DB 读取（cached.payment_link）一致 ✓
