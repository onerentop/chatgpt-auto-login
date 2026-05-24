# 测活日志新旧分区 + network_error 自动重试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v2.30.0 — runner.dispatchOne 自动重试 network_error 最多 3 次（每次间隔 2s），重试日志实时流到 UI；Accounts 页测活日志面板拆成"旧日志"（DB 历史，默认折叠）和"实时日志"（socket 推送，默认展开 + 自动滚动到底部）。

**Architecture:** Backend：抽 `dispatchOnceInner(email, account, onLog, signal)` 单次尝试函数，外层 `dispatchOne` 包 3-attempt 循环 + `await Promise(setTimeout)` 间 abort-aware。Frontend：`pushLivenessLog` 加 `isHistorical` 默认 false，`loadLivenessLogs` 显式传 true；Accounts.vue 一个 `<el-collapse>` 拆两个，watch `newLogs.length` 触发 `nextTick` + `scrollTop=scrollHeight`。

**Tech Stack:** Node + node:test、Vue 3 + Element Plus。

**Spec:** `docs/superpowers/specs/2026-05-24-liveness-log-partition-and-retry-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/liveness/runner.js` | 抽 `dispatchOnceInner`；外层 `dispatchOne` 3-attempt 循环；abort-aware sleep | 修改 |
| `server/liveness/__tests__/runner.test.js` | +3 测试（3 次 retry / 1 次 retry 成功 / plus 不 retry） | 修改 |
| `web/src/socket.js` | `pushLivenessLog` 加 `isHistorical=false` 默认参数 | 修改 |
| `web/src/views/Accounts.vue` | 单 collapse 改两个；`oldLogs/newLogs` computed；`newLogsContainer` ref + auto-scroll watch；`loadLivenessLogs` 设 `isHistorical:true`；废 `logsExpanded/livenessLogs` 旧名 | 修改 |
| `docs/CHANGELOG.md` | v2.30.0 节 | 修改 |

依赖：Task 1 → Task 2 串行（Task 1 backend, Task 2 frontend，互不阻塞但 Task 3 smoke 需两者就位）。

---

## Task 1: Backend — `dispatchOne` 重试循环 + 3 单元测试

**Files:**
- Modify: `server/liveness/runner.js`
- Modify: `server/liveness/__tests__/runner.test.js`

### Step 1: 读 `server/liveness/runner.js` 全文以理解 dispatchOne 现状

Run:
```bash
node --check server/liveness/runner.js && wc -l server/liveness/runner.js
```

Expected: syntax OK, ~190 lines. Read lines 39-133 to see the full dispatchOne body. The structure is roughly:

1. abort check + accountsDB.get
2. emitStatus 'checking' + setAlive 'checking'
3. construct onLog closure
4. try block: codexFile.read → probe → verifyDeactivated (token_expired only) → lightLogin (needsRelogin) → result
5. catch block: result = network_error 'unexpected'
6. abort check
7. deactivated fallback (v2.28 hotfix 3f9c437)
8. clipReason + setAlive(result) + state.done++ + emit terminal

### Step 2: Modify `server/liveness/runner.js` — add retry constants + refactor

Find the existing line `async function dispatchOne(email) {` (around line 39). Replace from that line through the final closing `}` of `dispatchOne` (around line 133) with this entire block:

```js
const NETWORK_RETRY_MAX = 3;
const NETWORK_RETRY_DELAY_MS = 2_000;

  // Sleep that wakes up early if the runner is aborted.
  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  // Single probe → verifyDeactivated → lightLogin pass. Returns a result
  // object {alive_status, alive_reason} without writing to DB or emitting
  // terminal events. Outer dispatchOne wraps this in a retry loop.
  async function dispatchOnceInner(email, account, onLog, abortSignal) {
    let result = null;
    try {
      const existing = await codexFile.read(email);
      const tok = existing?.access_token || '';

      let probeRes = null;
      if (tok) probeRes = await checker.probe(tok, { signal: abortSignal, onLog });

      // Case 2 deactivated detection: when probe returns token_expired, spawn a
      // lightweight Step 0-2 signin (no OTP) to discriminate "token genuinely
      // expired" from "OpenAI revoked the token because they banned the account".
      // verifyDeactivated network errors do NOT override the probe verdict —
      // we stay with token_expired in that case.
      if (probeRes && probeRes.alive_status === 'token_expired') {
        const verifyRes = await checker.verifyDeactivated(account, { signal: abortSignal, onLog });
        if (verifyRes.status === 'deactivated') {
          probeRes = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
          // After this overwrite, needsRelogin below evaluates to false: tok is
          // present and probeRes.alive_status is now 'deactivated', not
          // 'token_expired'. lightLogin is correctly skipped. If you ever
          // refactor the overwrite, re-verify the needsRelogin gate.
        }
      }

      const needsRelogin = !tok || (probeRes && probeRes.alive_status === 'token_expired');
      if (needsRelogin) {
        try {
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            signal: abortSignal,
          });
          await codexFile.write(email, {
            accessToken: fresh.accessToken,
            accountId: fresh.accountId,
            expiresAtIso: fresh.expiresAtIso,
          });
          probeRes = await checker.probe(fresh.accessToken, { signal: abortSignal, onLog });
        } catch (e) {
          const msg = String(e?.message || e);
          if (e?.name === 'LivenessLoginNotImplementedError' || /not.*implemented/i.test(msg) || /not yet supported/i.test(msg)) {
            // Protocol-mode lightLogin is a stub. If the original probe already
            // gave a real answer (token_expired from 401), preserve it instead
            // of overwriting with a vague "not yet supported" string — the
            // user cares whether the account is dead, not whether our re-login
            // path is implemented yet.
            if (probeRes && probeRes.alive_status === 'token_expired') {
              result = probeRes;
            } else {
              result = { alive_status: 'login_fail', alive_reason: 'liveness not yet supported in protocol mode' };
            }
          } else if (/bad password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'bad password' };
          else if (/no password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no password' };
          else if (/outlook oauth missing/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'outlook oauth missing' };
          else if (/otp/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: msg.includes('timeout') ? 'otp timeout' : 'otp fail' };
          else if (/captcha/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'captcha' };
          else if (/no session/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no session after login' };
          else if (/proxy reset|ECONNRESET/i.test(msg)) result = { alive_status: 'proxy_error', alive_reason: 'proxy reset (login)' };
          else result = { alive_status: 'network_error', alive_reason: `unexpected: ${msg.slice(0, 40)}` };
        }
      }
      if (!result) result = probeRes || { alive_status: 'network_error', alive_reason: 'no probe result' };
    } catch (e) {
      result = { alive_status: 'network_error', alive_reason: `unexpected: ${String(e?.message || e).slice(0, 40)}` };
    }
    return result;
  }

  async function dispatchOne(email) {
    if (state.abortCtrl?.signal.aborted) return;
    const account = accountsDB.get(email);
    if (!account) { state.done++; state.failed++; io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed }); return; }

    io.emit('liveness-status', { email, alive_status: 'checking', alive_reason: '' });
    statusDB.setAlive(email, { alive_status: 'checking', alive_reason: '' });

    const onLog = (level, message) => {
      const lvl = level || 'info';
      io.emit('liveness-log', { email, level: lvl, message });
      try { livenessLogsDB?.add({ email, level: lvl, message }); } catch {}
    };

    let result;
    for (let attempt = 1; attempt <= NETWORK_RETRY_MAX; attempt++) {
      if (state.abortCtrl?.signal.aborted) return;
      result = await dispatchOnceInner(email, account, onLog, state.abortCtrl.signal);
      if (result.alive_status !== 'network_error') break;
      if (attempt < NETWORK_RETRY_MAX) {
        onLog('warning', `network_error: ${result.alive_reason} — retrying ${attempt}/${NETWORK_RETRY_MAX} in ${NETWORK_RETRY_DELAY_MS / 1000}s`);
        await abortableSleep(NETWORK_RETRY_DELAY_MS, state.abortCtrl.signal);
      }
    }

    if (state.abortCtrl?.signal.aborted) return;

    // If the execution pipeline already determined this account is
    // OpenAI-banned (status='deactivated'), surface that as alive_status
    // 'deactivated' even though the probe returned 401 / token_expired.
    // A 401 on a deactivated account is just confirmation, not a separate
    // "token problem" — let the UI show 已删除 in both dimensions.
    try {
      const persisted = statusDB.get(email);
      if (persisted?.status === 'deactivated' && (result.alive_status === 'token_expired' || result.alive_status === 'login_fail')) {
        result = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
      }
    } catch {}

    result.alive_reason = clipReason(result.alive_reason);
    statusDB.setAlive(email, result);
    state.done++;
    if (result.alive_status !== 'plus') state.failed++;
    if (state.summary[result.alive_status] !== undefined) state.summary[result.alive_status]++;
    io.emit('liveness-status', { email, alive_status: result.alive_status, alive_reason: result.alive_reason });
    io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed });
  }
```

NOTE: The `NETWORK_RETRY_MAX` and `NETWORK_RETRY_DELAY_MS` constants are placed at module top (outside `createRunner`). Move them ABOVE the `function createRunner({...})` line. The `abortableSleep` and `dispatchOnceInner` helpers stay INSIDE `createRunner` (they reference closure variables like `state`, `checker`, `codexFile`, etc.).

After paste, the file structure becomes:

```js
const CONCURRENCY = 3;
const THROTTLE_MS = 1_000;
const NETWORK_RETRY_MAX = 3;             // ← new
const NETWORK_RETRY_DELAY_MS = 2_000;    // ← new

const REASON_MAX = 60;
function clipReason(s) { ... }
const SUMMARY_KEYS = [...];
function emptySummary() { ... }

function createRunner({ io, statusDB, ..., livenessLogsDB }) {
  let state = { ... };
  function snapshot() { ... }

  function abortableSleep(ms, signal) { ... }    // ← new
  async function dispatchOnceInner(...) { ... }  // ← new
  async function dispatchOne(email) { ... }      // ← refactored

  async function runBatch(emails) { ... }
  function start(emails) { ... }
  function stop() { ... }
  return { start, stop, status: snapshot };
}
module.exports = { createRunner };
```

### Step 3: Run syntax check

```bash
node --check server/liveness/runner.js
```

Expected: no output (syntax OK).

### Step 4: 添加 3 个新单元测试

Open `server/liveness/__tests__/runner.test.js`. At the **end** of the file (after the last `test(...)` block), append:

```js
test('runner: network_error retries up to 3 times', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'flaky@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => { attempts++; return { alive_status: 'network_error', alive_reason: 'check 503' }; },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['flaky@x.com']);
  // 3 attempts × probe-immediate + 2 delays × 2s ≈ 4.1s. Add overhead.
  await new Promise(r => setTimeout(r, 5000));
  assert.strictEqual(attempts, 3, 'probe called 3 times');
  const final = env.dbCalls.find(c => c.email === 'flaky@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'network_error');
});

test('runner: first network_error retry succeeds → terminal plus', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'recovery@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => {
        attempts++;
        return attempts === 1
          ? { alive_status: 'network_error', alive_reason: 'check 503' }
          : { alive_status: 'plus', alive_reason: 'check ok' };
      },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['recovery@x.com']);
  // 1 attempt + 2s delay + 1 attempt ≈ 2.1s. Add overhead.
  await new Promise(r => setTimeout(r, 3500));
  assert.strictEqual(attempts, 2, 'probe called 2 times (network_error then plus)');
  const final = env.dbCalls.find(c => c.email === 'recovery@x.com' && c.alive_status !== 'checking');
  assert.ok(final, 'terminal setAlive was called');
  assert.strictEqual(final.alive_status, 'plus');
});

test('runner: plus on first attempt does NOT retry', async () => {
  let attempts = 0;
  const env = mkEnv({
    accounts: [{ email: 'fast@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => { attempts++; return { alive_status: 'plus', alive_reason: 'check ok' }; },
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['fast@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(attempts, 1, 'probe called exactly once');
});
```

### Step 5: Run new tests

```bash
node --test server/liveness/__tests__/runner.test.js
```

Expected: `# pass 13`, `# fail 0` (was 10, +3 new). Total wall time ~10s due to the 5s + 3.5s + 1.5s sleeps.

If `network_error retries up to 3 times` test fails with `attempts === 1` instead of 3, the retry loop didn't fire — check that `NETWORK_RETRY_MAX` is exported into the closure properly (it should be a module-level const accessible from inside `createRunner`).

### Step 6: Full regression

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 168 pass (165 baseline + 3 new).

### Step 7: Commit

```bash
git add server/liveness/runner.js server/liveness/__tests__/runner.test.js
git commit -m "feat(liveness): retry network_error up to 3 times with 2s backoff

network_error currently terminates dispatchOne immediately, so a
single curl 28 timeout (proxy node briefly EOFing chatgpt.com)
labels the account as dead even though the next attempt would
succeed. Particularly painful for batches of 100+ accounts where
one bad node propagates to dozens of false network_error verdicts.

Refactor: pull the inner probe → verifyDeactivated → lightLogin
chain into dispatchOnceInner(email, account, onLog, signal) which
returns a result without writing the terminal status. Outer
dispatchOne loops up to NETWORK_RETRY_MAX (=3) times, sleeping
NETWORK_RETRY_DELAY_MS (=2s) between attempts via an
abortable sleep that resolves immediately if state.abortCtrl is
aborted — '停止测活' stays sub-second responsive.

Retry progress flows through the existing onLog callback as a
warning-level liveness-log event ('network_error: ... —
retrying 1/3 in 2s'), so the user sees the retry attempts in the
panel and they also persist to DB.

Trigger condition is alive_status==='network_error' regardless of
the specific reason — spawn ENOENT and stdout-unparsable retry
too, wasting 4s on a permanent local failure, which is acceptable
to keep the trigger simple.

3 new unit tests pin the behavior: 3-retry exhaustion, recovery on
attempt 2, and zero retry when plus on first attempt. 168 total
tests pass."
```

---

## Task 2: Frontend — 日志面板新旧分区 + 自动滚动

**Files:**
- Modify: `web/src/socket.js`
- Modify: `web/src/views/Accounts.vue`

### Step 1: Modify `web/src/socket.js` — pushLivenessLog 加 isHistorical 参数

Find the `function pushLivenessLog(email, level, message) {` body (around line 70). Replace the function definition:

```js
  function pushLivenessLog(email, level, message, isHistorical = false) {
    const prefixed = message?.startsWith('[') ? message : `[liveness] ${message}`;
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: email || '',
      level,
      message: prefixed,
      source: 'liveness',
      isHistorical,
    });
    if (socketState.logs.length > 500) {
      socketState.logs.splice(0, socketState.logs.length - 500);
    }
  }
```

The three existing callers — `socket.on('liveness-status')`, `socket.on('liveness-complete')`, `socket.on('liveness-log')` — leave `isHistorical` undefined → defaults to `false` (new event). No edits needed at the caller sites.

### Step 2: Modify `web/src/views/Accounts.vue` — template 两个折叠区

Find the existing single `<el-collapse>` block (around lines 59-70). Replace the **entire** `<el-collapse>` element with two consecutive `<el-collapse>` blocks:

```vue
    <el-collapse v-model="oldLogsExpanded" style="margin-bottom: 8px">
      <el-collapse-item :title="`旧日志 (${oldLogs.length})`" name="old">
        <div class="liveness-log-list">
          <div v-for="(log, i) in oldLogs" :key="'o-' + i" :class="'log-' + log.level">
            <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
            <span v-if="log.email" class="log-email">{{ log.email }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="oldLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无历史日志</div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <el-collapse v-model="newLogsExpanded" style="margin-bottom: 12px">
      <el-collapse-item :title="`实时日志 (${newLogs.length})`" name="new">
        <div ref="newLogsContainer" class="liveness-log-list">
          <div v-for="(log, i) in newLogs" :key="'n-' + i" :class="'log-' + log.level">
            <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
            <span v-if="log.email" class="log-email">{{ log.email }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="newLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无实时日志</div>
        </div>
      </el-collapse-item>
    </el-collapse>
```

### Step 3: Modify `web/src/views/Accounts.vue` — script 部分

Find the existing reactive state block. Replace the lines:

```js
const logsExpanded = ref([])
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness').slice(-200)
)
```

with:

```js
const oldLogsExpanded = ref([])                // 默认折叠
const newLogsExpanded = ref(['new'])           // 默认展开
const newLogsContainer = ref(null)             // DOM ref for auto-scroll

const oldLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && l.isHistorical).slice(-200)
)
const newLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && !l.isHistorical).slice(-500)
)

// Auto-scroll the realtime log container to the bottom whenever a new entry
// arrives. nextTick lets Vue re-render the v-for before we read scrollHeight.
watch(() => newLogs.value.length, () => {
  nextTick(() => {
    const el = newLogsContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
```

### Step 4: Modify `web/src/views/Accounts.vue` — auto-expand watch

Find the existing `watch(() => socketState.liveness.running, ...)` block (uses old `logsExpanded`). Replace its body:

```js
watch(() => socketState.liveness.running, (now) => {
  if (now && !newLogsExpanded.value.includes('new')) {
    newLogsExpanded.value = ['new']
  }
})
```

### Step 5: Modify `loadLivenessLogs` — mark as isHistorical

Find `async function loadLivenessLogs() { ... }`. Replace the body:

```js
async function loadLivenessLogs() {
  try {
    const r = await api.get('/liveness/logs?limit=200')
    const existing = new Set(socketState.logs.filter(l => l.source === 'liveness').map(l => l.timestamp + '|' + l.message))
    for (const log of (r.data || [])) {
      const key = log.timestamp + '|' + log.message
      if (existing.has(key)) continue
      socketState.logs.push({
        timestamp: log.timestamp,
        email: log.email || '',
        level: log.level || 'info',
        message: (log.message?.startsWith('[') ? log.message : `[liveness] ${log.message}`),
        source: 'liveness',
        isHistorical: true,    // ← only diff vs current implementation
      })
    }
    if (socketState.logs.length > 500) socketState.logs.splice(0, socketState.logs.length - 500)
  } catch {}
}
```

### Step 6: Sanity check — search for any lingering references to old names

```bash
grep -n "logsExpanded\|livenessLogs" web/src/views/Accounts.vue
```

Expected: only the renamed ones (`oldLogsExpanded` / `newLogsExpanded` / `oldLogs` / `newLogs`). No bare `logsExpanded` or `livenessLogs` should remain. If any found, rename them too.

### Step 7: Build front-end

```bash
cd web && npm run build
```

Expected: ✓ built. If Vue compile errors mention undefined references like `livenessLogs`, you missed Step 6.

### Step 8: Restart server + manual smoke

```bash
cd ..
# Kill old server, restart
# (depends on shell; on Windows PowerShell):
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server/index.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
node server/index.js &
```

After server up, open `http://localhost:3000/accounts`, **hard refresh** (Ctrl+Shift+R), verify:

1. Two collapse rows visible: `旧日志 (N)` collapsed, `实时日志 (0)` expanded.
2. Click `测活选中` on 1-2 plus accounts → realtime panel starts streaming, each new line is auto-scrolled into view at the bottom.
3. After completion, scroll up in the realtime panel — old entries still there.
4. Refresh page → realtime panel goes back to 0, old logs panel reflects the latest 200 from DB (which now includes the just-streamed entries since they were persisted via `livenessLogsDB.add`).

### Step 9: Commit

```bash
git add web/src/socket.js web/src/views/Accounts.vue
git commit -m "feat(ui): partition liveness logs into 旧日志/实时日志 + auto-scroll new entries

socketState.logs entries gain an isHistorical boolean field. The
DB-hydration call (loadLivenessLogs) sets it true; live socket
events (liveness-log, liveness-status, liveness-complete) leave it
false via the pushLivenessLog default arg.

Accounts.vue's single <el-collapse> becomes two stacked collapses:
  - 旧日志 (count) — default collapsed, last 200 historical entries
  - 实时日志 (count) — default expanded, last 500 live entries
A watch on newLogs.length nextTick-scrolls the realtime container
to scrollHeight so the user always sees the latest line without
manual scrolling. No manual-scroll-pause detection — KISS.

Page refresh: live entries flush to historical (DB persisted them
via livenessLogsDB.add). Realtime panel resets to empty.

Renames: logsExpanded → oldLogsExpanded + newLogsExpanded;
livenessLogs computed → oldLogs + newLogs."
```

---

## Task 3: CHANGELOG v2.30.0 + 集成 smoke

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.30.0 section

Open `docs/CHANGELOG.md`. Insert IMMEDIATELY AFTER the `# Changelog` line:

```markdown
# Changelog

## v2.30.0 — 2026-05-24

### Liveness Log Partition + network_error Auto-Retry

**Part A — UI 日志面板拆分**

- 单一 `<el-collapse>` 拆成两个：
  - **旧日志** (默认折叠) — 来自 DB 的最近 200 条历史，跨页面刷新保留
  - **实时日志** (默认展开) — 本次会话 socket 推送的 500 条，自动滚动到底部
- `socketState.logs` 每条 entry 加 `isHistorical: boolean` 字段。`loadLivenessLogs` (onMounted) 设 true；`pushLivenessLog` (socket realtime) 默认 false。
- `watch(newLogs.length)` + `nextTick` + `scrollTop = scrollHeight` 实现自动滚动。无手动滚动暂停检测——KISS。

**Part B — network_error 自动重试**

- `runner.dispatchOne` 重构：抽 `dispatchOnceInner(email, account, onLog, signal)` 单次尝试，外层 3-attempt 循环每次间隔 2s。
- 重试触发：`alive_status === 'network_error'`（含 HTTP 429/5xx / probe timeout / curl exception / spawn ENOENT / stdout 不可解析 / unexpected）。
- 重试进度通过 `onLog('warning', ...)` 流到 UI 面板和 DB（`network_error: ... — retrying 1/3 in 2s`）。
- `abortableSleep` 让 `await sleep()` 在 `abortCtrl.signal` abort 时立刻 resolve，"停止测活" 秒级响应。
- Worst case 耗时：3 × 12s probe + 2 × 2s delay = **~40s/账号**（仅 network_error 触发；正常 plus 单次 1-3s 不受影响）。

**测试**：168 tests pass — runner +3 (3-attempt 重试 / 1-attempt 重试成功 / plus 不重试) on 165 baseline.

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-log-partition-and-retry-design.md` + `docs/superpowers/plans/2026-05-24-liveness-log-partition-and-retry.md`。
```

(Keep `## v2.29.1` and everything below it intact.)

### Step 2: Full regression

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 168 pass.

### Step 3: End-to-end smoke

This combines Task 1 + Task 2 + uses a known flaky node to actually exercise the retry path.

1. Restart server (if not already on the latest commits).
2. Open `http://localhost:3000/accounts`, hard refresh.
3. **Verify partition UI**:
   - Two collapses present, 旧日志 collapsed, 实时日志 expanded.
   - 旧日志 count reflects the existing DB history.
4. **Verify retry path** — stop sing-box to force network_error:
   ```bash
   curl -X POST http://localhost:3000/api/proxy/stop
   ```
5. Click `测活选中` on 1 account.
6. Watch realtime panel:
   - `[liveness] checking`
   - `[Liveness] GET /accounts/check attempt 1/3 via chromeXXX, proxy=off` (proxy=off because sing-box is stopped)
   - `[Liveness] exception: ... ECONNREFUSED ...` or similar
   - `network_error: ... — retrying 1/3 in 2s` (warning level, yellow)
   - … repeats for 2/3
   - Final terminal: `network_error: ...` (no retry suffix)
   - Auto-scroll keeps the latest line in view throughout.
7. Restart sing-box (POST `/api/proxy/refresh`) and click 测活选中 again — should succeed on first attempt, no retry log lines visible.

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.30.0 — log partition + network_error auto-retry"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 background: informational, no task.
- Spec §2.1 isHistorical field on entries → Task 2 Step 1 (`pushLivenessLog` default arg).
- Spec §2.2 template two `<el-collapse>` → Task 2 Step 2.
- Spec §2.3 oldLogs/newLogs computed + auto-scroll → Task 2 Step 3.
- Spec §2.4 loadLivenessLogs marks isHistorical → Task 2 Step 5.
- Spec §3.1 dispatchOne retry loop → Task 1 Step 2.
- Spec §3.2 dispatchOnceInner extraction → Task 1 Step 2 (single replacement covers both).
- Spec §3.3 retry log example → naturally produced by `onLog('warning', ...)` line in Task 1 Step 2.
- Spec §3.4 abort-aware sleep → Task 1 Step 2 (`abortableSleep` helper).
- Spec §4 boundaries (7 cases) → all covered by Task 1+2 implementations.
- Spec §5 testing (3 new tests) → Task 1 Step 4.
- Spec §6 file list → matches Task 1+2 file list.
- Spec §7 YAGNI → nothing in plan exceeds.
- Spec §8 v2.30.0 → Task 3 Step 1.

**2. Placeholder scan:** no "TBD" / "implement later" / "fill in" — every step has exact code, exact commands, expected outputs.

**3. Type/symbol consistency:**

- `oldLogs` / `newLogs` / `oldLogsExpanded` / `newLogsExpanded` / `newLogsContainer` — same identifiers in template (Task 2 Step 2) and script (Task 2 Steps 3, 4).
- `isHistorical` field — set in 2 places (Task 2 Steps 1 default, Step 5 explicit true) and read in 2 places (Task 2 Step 3 computed filters).
- `NETWORK_RETRY_MAX` / `NETWORK_RETRY_DELAY_MS` / `abortableSleep` / `dispatchOnceInner` — all defined and used inside Task 1 Step 2.
- `livenessLogsDB?.add` in onLog — same name used in existing runner.js (added in v2.29.0 commit 2ceede2) and the test fixtures already mock it via `livenessLogsDB: undefined` (optional chain handles).

No issues. Plan is ready.
