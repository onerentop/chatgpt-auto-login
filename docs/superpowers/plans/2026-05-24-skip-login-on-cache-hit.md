# Skip Phase 1 on Token Cache Hit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `account_status` 表持久化上次 protocol-login 返回的 accessToken + session JSON；下次同账号执行时若 JWT 未过期（含 60s buffer），构造 `result` 跳过整段 Phase 1，配合 v2.25 payment-link cache 让"失败重试"账号从 68-145s 缩到 30-60s。

**Architecture:** account_status 加 3 列 `last_access_token / last_session_json / last_access_token_at`；statusDB.set 扩展 merge（camelCase `accessToken / sessionJson` 入参；不传时保留 DB 现值——同 v2.25 paymentLink 套路）；新 helper `clearAccessToken`；两个 engine 入口 prevPersisted 之后立即用 v2.26 `decodeJwtExp` 校验 JWT exp，未过期则构造 `result = { accessToken, session, planType }` 跳过 Phase 1；Phase 1 成功后写库；payment 成功 / already-plus 时 clearAccessToken。

**Tech Stack:** Node + sql.js (WASM SQLite)、`node:test`、复用 `server/liveness/checker.js` 的 `decodeJwtExp`。

**Spec:** `docs/superpowers/specs/2026-05-24-skip-login-on-cache-hit-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/db.js` | CREATE TABLE +3 列；initDB PRAGMA-ALTER；statusDB.set 扩展 accessToken/sessionJson merge；setAlive 透传新列；新 `clearAccessToken` | 修改 |
| `__tests__/db-access-token.test.js` | 5 单元：默认值 / set 写入 / merge 不抹缓存 / clearAccessToken / reset 保留 | 新建 |
| `protocol-engine.js` | dispatchOne 入口加 cached-login 分支（在 L227 prevPersisted 之后）；Phase 1 成功后 statusDB.set 写 token；payment success + already-plus 加 clearAccessToken | 修改 |
| `server/engine.js` | 同 protocol-engine.js 形状（双引擎 mirror） | 修改 |
| `docs/CHANGELOG.md` | v2.27.0 节 | 修改 |

依赖链：Task 1 → Task 2 + Task 3 可并行（互不冲突文件），Task 3 含 CHANGELOG + smoke 收尾。

---

## Task 1: DB schema + setAccessToken merge + clearAccessToken + 5 单元测试

**Files:**
- Create: `__tests__/db-access-token.test.js`
- Modify: `server/db.js`

- [ ] **Step 1: 创建 `__tests__/db-access-token.test.js`（先红）**

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-access-token-test-'));
const fakeDb = path.join(tmpDir, 'data.db');

const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, statusDB } = require('../server/db');
realPath.join = origJoin;

test('setup: fresh db has access-token defaults', async () => {
  await initDB();
  statusDB.set('a@x.com', { status: 'idle' });
  const row = statusDB.get('a@x.com');
  assert.strictEqual(row.last_access_token, '');
  assert.strictEqual(row.last_session_json, '');
  assert.strictEqual(row.last_access_token_at, '');
});

test('statusDB.set writes accessToken + sessionJson, last_access_token_at auto-set', () => {
  statusDB.set('b@x.com', {
    status: 'running',
    accessToken: 'eyJ.fake.tok',
    sessionJson: '{"account":{"planType":"free"}}',
  });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.last_access_token, 'eyJ.fake.tok');
  assert.strictEqual(row.last_session_json, '{"account":{"planType":"free"}}');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(row.last_access_token_at), 'ISO timestamp set');
});

test('statusDB.set merge: not passing accessToken preserves cached token (critical invariant)', () => {
  // b@x.com already has tok from previous test; transient set without accessToken must preserve it
  statusDB.set('b@x.com', { status: 'error', reason: 'failed' });
  const row = statusDB.get('b@x.com');
  assert.strictEqual(row.last_access_token, 'eyJ.fake.tok', 'token preserved');
  assert.strictEqual(row.last_session_json, '{"account":{"planType":"free"}}', 'session preserved');
  assert.strictEqual(row.status, 'error', 'status updated as expected');
});

test('statusDB.clearAccessToken clears 3 columns', () => {
  statusDB.set('c@x.com', {
    status: 'running',
    accessToken: 'eyJ.tok.c',
    sessionJson: '{"foo":"bar"}',
  });
  statusDB.clearAccessToken('c@x.com');
  const row = statusDB.get('c@x.com');
  assert.strictEqual(row.last_access_token, '');
  assert.strictEqual(row.last_session_json, '');
  assert.strictEqual(row.last_access_token_at, '');
});

test('statusDB.reset preserves last_access_token (reset only zeros state)', () => {
  statusDB.set('d@x.com', {
    status: 'running',
    accessToken: 'eyJ.tok.d',
    sessionJson: '{}',
  });
  statusDB.reset('d@x.com');
  const row = statusDB.get('d@x.com');
  assert.strictEqual(row.status, 'idle', 'status reset');
  assert.strictEqual(row.last_access_token, 'eyJ.tok.d', 'token preserved through reset');
});
```

- [ ] **Step 2: Run test, expect 5 failing**

Run: `node --test __tests__/db-access-token.test.js`
Expected: `# fail 5` (column not exists / `clearAccessToken is not a function`).

- [ ] **Step 3: Modify `server/db.js` — add 3 cols to CREATE TABLE**

Find the `CREATE TABLE IF NOT EXISTS account_status (...)` block around lines 27-39. Replace the entire block with:

```sql
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
      last_access_token TEXT DEFAULT '',
      last_session_json TEXT DEFAULT '',
      last_access_token_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
```

- [ ] **Step 4: Add PRAGMA-gated ALTER for existing data.db**

Find the alive_* ALTER block (added in v2.26). After the 3 alive_* ALTER guards, add:

```js
  if (!existingCols.has('last_access_token')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_access_token TEXT DEFAULT ''");
  }
  if (!existingCols.has('last_session_json')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_session_json TEXT DEFAULT ''");
  }
  if (!existingCols.has('last_access_token_at')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_access_token_at TEXT DEFAULT ''");
  }
```

- [ ] **Step 5: Extend statusDB.set merge to include accessToken/sessionJson**

In `statusDB.set` (around lines 148-182), AFTER the existing `payment_link_at` merge logic and BEFORE the `existingAlive` block, insert:

```js
    const last_access_token = 'accessToken' in incoming
      ? (incoming.accessToken || '')
      : (existing.last_access_token || '');
    const last_session_json = 'sessionJson' in incoming
      ? (incoming.sessionJson || '')
      : (existing.last_session_json || '');
    const last_access_token_at = ('accessToken' in incoming && incoming.accessToken)
      ? new Date().toISOString()
      : (existing.last_access_token_at || '');
```

Then update the `db.run("INSERT OR REPLACE INTO account_status ...")` SQL and params. The new SQL has 16 columns:

```js
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, last_access_token, last_session_json, last_access_token_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress || '', reason || '', has_auth_file ? 1 : 0,
       payment_link, payment_link_pk, payment_link_at,
       existingAlive.alive_status, existingAlive.alive_checked_at, existingAlive.alive_reason,
       last_access_token, last_session_json, last_access_token_at]
    );
```

- [ ] **Step 6: Update setAlive to preserve new 3 cols**

In `statusDB.setAlive` (around lines 190-207), the existing INSERT OR REPLACE has 13 cols + updated_at. Extend it to 16 cols, threading existing values through. Replace the `db.run(...)` call inside setAlive with:

```js
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, last_access_token, last_session_json, last_access_token_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email,
       existing.status || 'idle', existing.phase || '', existing.progress || '', existing.reason || '',
       existing.has_auth_file ? 1 : 0,
       existing.payment_link || '', existing.payment_link_pk || '', existing.payment_link_at || '',
       alive_status, alive_checked_at, alive_reason,
       existing.last_access_token || '', existing.last_session_json || '', existing.last_access_token_at || '']
    );
```

- [ ] **Step 7: Add `statusDB.clearAccessToken`**

In `statusDB` object, after `clearAlive` (around line 208-211), add:

```js
  clearAccessToken(email) {
    db.run("UPDATE account_status SET last_access_token='', last_session_json='', last_access_token_at='' WHERE email=?", [email]);
    save();
  },
```

- [ ] **Step 8: Run tests, expect 5 passing**

Run: `node --test __tests__/db-access-token.test.js`
Expected: `# pass 5`.

- [ ] **Step 9: Run full regression**

Run: `node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js`
Expected: 146 pass (141 existing + 5 new).

- [ ] **Step 10: Commit**

```bash
git add server/db.js __tests__/db-access-token.test.js
git commit -m "feat(db): add last_access_token/last_session_json/last_access_token_at columns

account_status gets 3 new columns to persist the protocol-login
result so a subsequent retry of the same account can skip Phase 1
entirely when the JWT is still valid.

statusDB.set is extended to merge accessToken/sessionJson (camelCase
input keys mirror the existing paymentLink/paymentLinkPk pattern).
The merge invariant matters: a transient emitStatus({ status:
'running' }) call must NOT wipe the cached token, otherwise the
cache-check on the next attempt would always miss — same failure
mode v2.25 had with payment_link and v2.26.1 had to fix.

setAlive is extended to thread the new 3 cols through existing
values so a liveness probe doesn't clobber a cached token, and
vice versa. clearAccessToken is exposed for the post-payment
cleanup (token has migrated into cpa-auth/codex-*.json, the DB row
no longer needs it).

5 new unit tests cover defaults, write+read, merge-no-clobber,
clearAccessToken, and reset-preserves-token. 146 tests pass."
```

---

## Task 2: protocol-engine.js cached-login branch + write/clear hooks

**Files:**
- Modify: `protocol-engine.js`

- [ ] **Step 1: Add cached-login branch after prevPersisted snapshot**

In `protocol-engine.js`, find line 227:

```js
        const prevPersisted = statusDB.get(account.email) || {};
```

AFTER this line and BEFORE the existing `// Step 1: Protocol login` comment + first emitStatus, insert the cached-login branch. The replacement block is:

```js
        const prevPersisted = statusDB.get(account.email) || {};

        // Cached-login fast path: if a previous login persisted a JWT and the
        // exp is still in the future (with 60s buffer), reconstitute `result`
        // from the DB and skip Phase 1 entirely. Combined with the v2.25
        // payment-link cache below, a retry that hits both caches goes
        // directly to Phase 3 PayPal — saving 30-60s of OTP+auth0 churn.
        const JWT_BUFFER_SEC = 60;
        let result = null;
        if (prevPersisted.last_access_token) {
          const { decodeJwtExp } = require('./server/liveness/checker');
          const exp = decodeJwtExp(prevPersisted.last_access_token);
          if (exp > Date.now() / 1000 + JWT_BUFFER_SEC) {
            let session = null;
            try { session = JSON.parse(prevPersisted.last_session_json || '{}'); }
            catch { session = null; }
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

        // Step 1: Protocol login (skipped when result was reconstituted above)
```

- [ ] **Step 2: Wrap the existing Phase 1 login block in `if (!result)`**

The current Phase 1 login block runs unconditionally and ends by assigning `result = ...` from `protocol_register.py`. Find the block starting `this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });` (was line 224 before this Task's Step 1 inserted the cached-login section above it).

Wrap from this emitStatus call up to and including the `console.log(`[${progress}] Protocol login OK: ${result.accessToken}`);` line (and any line between that produces `result`) in an `if (!result) { ... }` block.

Concretely: open the brace immediately after the `// Step 1: Protocol login` comment, close it after the `Protocol login OK` log line.

After the `if (!result) { ... }` block, immediately add the persist-to-DB call:

```js
        // Persist the freshly-obtained token so the next retry can skip
        // Phase 1 entirely. Without this, the cached-login fast-path above
        // would never have anything to read.
        if (result) {
          statusDB.set(account.email, {
            accessToken: result.accessToken,
            sessionJson: JSON.stringify(result.session || {}),
          });
        }
```

- [ ] **Step 3: Add `clearAccessToken` in payment-success and already-plus branches**

Find the already-Plus branch (around lines 286-298). Locate:

```js
        if (isPlusOrAbove) {
          statusDB.clearPaymentLink(account.email);
```

Add immediately after the `clearPaymentLink` line:

```js
          statusDB.clearAccessToken(account.email);
```

Find the payment-success branch (around line 471-472). Locate:

```js
          if (paymentResult.success) {
            statusDB.clearPaymentLink(account.email);
```

Add immediately after:

```js
            statusDB.clearAccessToken(account.email);
```

- [ ] **Step 4: Verify syntax**

Run: `node --check protocol-engine.js`
Expected: no output (syntax OK).

- [ ] **Step 5: Run full regression**

Run: `node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js`
Expected: 146 pass (no regression).

- [ ] **Step 6: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol-engine): cached-login fast path skips Phase 1 when JWT valid

Right after the prevPersisted snapshot at the top of dispatchOne,
check whether a previously-stored access_token still has time on the
JWT exp (with a 60s buffer for the work that follows). If yes,
reconstruct result = { accessToken, session, planType } straight
from the DB and skip the entire protocol_register.py spawn —
saving 30-60s per retry.

The full Phase 1 block now lives inside an 'if (!result)' branch.
After it runs, the freshly-obtained token is persisted to DB
immediately so subsequent retries can read it back via the
cached-login path.

clearAccessToken is invoked in both terminal-success branches
(payment success and already-Plus) — once the token has been
written to cpa-auth/codex-*.json, the DB row no longer needs it
and stale tokens shouldn't linger after the account has gone Plus.

decodeJwtExp is imported lazily inside the cache check from
server/liveness/checker.js to avoid pulling that module on every
batch boot. Bad JWT / corrupted session_json fall through to the
full Phase 1 login — no error is surfaced to the user.

146 tests still pass; the new behavior is integration-tested
manually per the spec smoke checklist."
```

---

## Task 3: server/engine.js mirror + CHANGELOG + integration smoke

**Files:**
- Modify: `server/engine.js`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add cached-login branch after prevPersisted in server/engine.js**

In `server/engine.js`, find line 205:

```js
        const prevPersisted = statusDB.get(account.email) || {};
```

AFTER this line and BEFORE the existing `this.emitStatus( { email: account.email, status: 'running', phase: 'login', progress, });` at line 207, insert the cached-login branch:

```js
        const prevPersisted = statusDB.get(account.email) || {};

        // Cached-login fast path: if a previous login persisted a JWT and the
        // exp is still in the future (with 60s buffer), reconstitute
        // loginResult from the DB and skip the browser login entirely.
        const JWT_BUFFER_SEC_LOGIN = 60;
        let loginResult = null;
        if (prevPersisted.last_access_token) {
          const { decodeJwtExp } = require('./liveness/checker');
          const exp = decodeJwtExp(prevPersisted.last_access_token);
          if (exp > Date.now() / 1000 + JWT_BUFFER_SEC_LOGIN) {
            let session = null;
            try { session = JSON.parse(prevPersisted.last_session_json || '{}'); }
            catch { session = null; }
            if (session) {
              loginResult = {
                accessToken: prevPersisted.last_access_token,
                session,
                lastOtp: '',
              };
              const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
              console.log(`${p} Phase 1: reusing cached access token (exp in ${minLeft} min)`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
            }
          }
        }
```

- [ ] **Step 2: Wrap the existing browser-login flow in `if (!loginResult)`**

The current code flow has `this.emitStatus({ ... phase: 'login' ... });` at line 207 followed by the full browser-driven login. Locate where `loginResult = await something(...)` is assigned (search for `loginResult =` in server/engine.js to find the assignment around the login block).

Wrap the existing emitStatus + browser login code from line 207 down to and including the line that produces `loginResult` in an `if (!loginResult) { ... }` block.

After that block closes, add the persist-to-DB call:

```js
          // Persist the freshly-obtained token so the next retry can skip
          // the browser login entirely.
          if (loginResult && loginResult.accessToken) {
            statusDB.set(account.email, {
              accessToken: loginResult.accessToken,
              sessionJson: JSON.stringify(loginResult.session || {}),
            });
          }
```

- [ ] **Step 3: Add `clearAccessToken` in payment-success and already-plus branches**

Find the already-Plus branch (around line 280): `statusDB.clearPaymentLink(account.email);`. Add immediately after:

```js
            statusDB.clearAccessToken(account.email);
```

Find the payment-success branch (search for `statusDB.clearPaymentLink` further down — the second occurrence). Add immediately after:

```js
              statusDB.clearAccessToken(account.email);
```

- [ ] **Step 4: Verify syntax**

Run: `node --check server/engine.js`
Expected: no output.

- [ ] **Step 5: Append CHANGELOG entry**

Open `docs/CHANGELOG.md`. At the very top of the file (immediately after `# Changelog` line), insert a new v2.27.0 section. The whole prefix becomes:

```markdown
# Changelog

## v2.27.0 — 2026-05-24

### Skip Phase 1 on Access-Token Cache Hit

Building on v2.25's payment-link cache (Phase 2 + 2.5 skip), this release also persists the protocol-login `accessToken + session JSON` to `account_status`. On retry of a failed account, if the JWT exp is still in the future (with 60s buffer), `result` is reconstituted from the DB and the entire Phase 1 login is skipped — saving the 30-60s OTP+auth0 round-trip on top of v2.25's 8-25s savings.

**核心改动：**

- **DB schema**：`account_status` 加 3 列 `last_access_token / last_session_json / last_access_token_at`，PRAGMA-gated ALTER 防御性迁移存量库。
- **statusDB.set 扩展 merge**：camelCase 入参 `accessToken / sessionJson`；未传时保留 DB 现值（同 v2.25 paymentLink 套路）；新 helper `clearAccessToken` 用于支付成功后清除。
- **双引擎同步**：`protocol-engine.js` 和 `server/engine.js` 都在 `dispatchOne` 入口加 cached-login 分支，紧跟 v2.26.1 引入的 `prevPersisted` snapshot。
- **JWT exp 校验**：复用 v2.26 `server/liveness/checker.js` 导出的 `decodeJwtExp` 工具——单一来源、不重复实现。
- **失败兜底**：cached token 还有效但 OpenAI 已 revoke（改密等）→ Phase 3 page.goto(link) 仍 OK（link 自带 stripe session）；Phase 5 PKCE 重登失败 → plus_no_rt 兜底，下次测活会标 token_expired。

**预期收益：** cache + token 都命中的重试场景，账号耗时从 68-145s 缩到 30-60s（节省 **40-90s/账号**）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-skip-login-on-cache-hit-design.md` + `docs/superpowers/plans/2026-05-24-skip-login-on-cache-hit.md`。

**测试**：`__tests__/db-access-token.test.js` 5 个新单元 + 集成 smoke（重试 iyjq50891 看 "Phase 1: reusing cached access token" 日志）。146 测试通过。

```

- [ ] **Step 6: Final regression + integration smoke**

Run full regression:

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 146 pass.

Integration smoke (manual): restart server and trigger a retry of any account whose previous run ended in error/aborted/paypal_captcha/verify_error AND whose JWT hasn't expired (i.e., ran within the last few hours). The log should print:

```
[1/1] Phase 1: reusing cached access token (exp in NN min)
[1/1] Phase 2: reusing cached payment link (was <status> at <timestamp>)
[1/1] Phase 3 ...   (PayPal proceeds without going through OTP / link fetch / verify)
```

- [ ] **Step 7: Commit**

```bash
git add server/engine.js docs/CHANGELOG.md
git commit -m "feat(engine): mirror cached-login fast path in browser mode + v2.27.0 CHANGELOG

server/engine.js gets the same cached-login fast path as
protocol-engine.js, threaded the same way through the prevPersisted
snapshot the v2.26.1 fix introduced. The two engines must mirror
per the CLAUDE.md invariant — every behavior change to the
account pipeline lands in both places or neither.

Persist hook fires after the browser login succeeds; clear hooks
fire in already-Plus and payment-success branches symmetrically to
protocol-engine.js.

CHANGELOG documents v2.27.0 as the third leg of the cache stool:
v2.25 cached the payment link, v2.26.1 fixed the cache-read order
bug, v2.27.0 caches the login result itself. 146 tests pass."
```

---

## Self-review

**1. Spec coverage check (§ by §):**

- Spec §1 background: informational, no task.
- Spec §2 DB schema + statusDB API: Task 1 covers CREATE TABLE + ALTER + set merge + setAlive transparency + clearAccessToken.
- Spec §3 data flow (write / read / clear): Task 2 + Task 3 covers all 3.
- Spec §4 behavior table: integration smoke in Task 3 verifies the "retry + cache + token valid" row; other rows fall out of the existing engine logic.
- Spec §5 boundaries (10 cases): each is either covered by try/catch in the cache check, or by the existing engine fallback (already-Plus, runProtocolPKCE retry, etc.) — Task 2 + 3 retain those.
- Spec §6 implementation impact: 3 files, double engine sync ✓.
- Spec §7 YAGNI: nothing added beyond the listed items.
- Spec §8 v2.27.0: Task 3 Step 5 CHANGELOG.

**2. Placeholder scan:** no "TBD" / "implement later" / "add error handling" — every step has the exact code or command.

**3. Type / symbol consistency:**

- `last_access_token` / `last_session_json` / `last_access_token_at` — same names everywhere ✓
- `accessToken` / `sessionJson` — camelCase input keys consistent ✓
- `clearAccessToken` — same name in db.js + protocol-engine.js + server/engine.js ✓
- `decodeJwtExp` — imported from `./server/liveness/checker` (protocol-engine.js) and `./liveness/checker` (server/engine.js since it's one level deeper) ✓
- `JWT_BUFFER_SEC` / `JWT_BUFFER_SEC_LOGIN` — different consts in different files, no cross-file dependency ✓
