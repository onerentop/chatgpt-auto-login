# 测活集成 proxy 黑名单 + Accounts 页下载按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v2.31.0 — `server/liveness/runner.js` 在 dispatchOne 末尾按 alive_status 终态投票 (`recordBadAttempt` for network/proxy_error, `recordGoodAttempt` for plus/canceled/token_expired/login_fail/deactivated)。Accounts 页加跟 Execute 一致的下载 UI（顶部 2 dropdown + 行内 CPA/Sub 按钮）。

**Architecture:** runner.dispatchOne 末尾插入小 try/catch 块、读 currentNode + 派发 markBad/Good，gate 是 `proxyMgr.getState().enabled`。createRunner 加可选 `proxyMgr` 注入用于测试 mock。Accounts.vue 顶部 toolbar + 操作列 + script 各复用 Execute.vue 套路。

**Tech Stack:** Node + sql.js、node:test、Vue 3 + Element Plus、axios + blob.

**Spec:** `docs/superpowers/specs/2026-05-24-liveness-blacklist-and-accounts-download-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/liveness/runner.js` | `createRunner` 多接受 `proxyMgr` 注入；dispatchOne 末尾 markBad/Good 投票块 | 修改 |
| `server/liveness/__tests__/runner.test.js` | `mkEnv` 加 proxyMgr fake；+3 测试 | 修改 |
| `web/src/views/Accounts.vue` | toolbar +2 dropdown；操作列 +2 按钮（width 140→240）；script +3 函数 | 修改 |
| `docs/CHANGELOG.md` | v2.31.0 节 | 修改 |

依赖：Task 1 → Task 2 互相独立，Task 3 CHANGELOG 收尾。

---

## Task 1: Backend — 测活终态投票 + 3 单元测试

**Files:**
- Modify: `server/liveness/runner.js`
- Modify: `server/liveness/__tests__/runner.test.js`

### Step 1: 修 `createRunner` 接受 proxyMgr 注入

打开 `server/liveness/runner.js`。找到当前 `createRunner` 签名（约 line 21）：

```js
function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config, livenessLogsDB }) {
```

替换为（加 proxyMgr 可选注入）：

```js
function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config, livenessLogsDB, proxyMgr }) {
  // proxyMgr is optional — lazy-require fallback keeps the production wiring
  // working without explicit injection (mirrors checker.js:12-18 lazy pattern).
  function getProxyMgr() {
    if (proxyMgr) return proxyMgr;
    try { return require('../proxy'); } catch { return null; }
  }
```

### Step 2: 在 dispatchOne 末尾插入投票块

找到 `dispatchOne` 内末尾这段（约 line 153-167，紧跟 deactivated 兜底 try/catch 之后、`result.alive_reason = clipReason(...)` 之前）：

```js
    } catch {}

    result.alive_reason = clipReason(result.alive_reason);
    statusDB.setAlive(email, result);
```

在 `} catch {}` 和 `result.alive_reason = clipReason(...)` **之间** 插入：

```js
    } catch {}

    // Vote on the current proxy node based on terminal alive_status. Mirrors
    // server/engine.js:276/281 pattern. The runner has at this point exhausted
    // up to 3 retries (v2.30); a terminal network_error / proxy_error means
    // the node is persistently unreachable, not a transient blip — record
    // it as a bad attempt so the existing FAIL_THRESHOLD logic in
    // server/proxy/index.js can eventually blacklist the node.
    try {
      const pm = getProxyMgr();
      if (pm && pm.getState().enabled) {
        const currentNode = pm.getState().currentNode;
        if (currentNode) {
          if (result.alive_status === 'network_error' || result.alive_status === 'proxy_error') {
            pm.recordBadAttempt(currentNode, 'main', `liveness_${result.alive_status}`);
          } else if (
            result.alive_status === 'plus' ||
            result.alive_status === 'canceled' ||
            result.alive_status === 'token_expired' ||
            result.alive_status === 'login_fail' ||
            result.alive_status === 'deactivated'
          ) {
            pm.recordGoodAttempt(currentNode, 'main');
          }
          // 'checking' / 'unknown' never reach this code path as terminal states.
        }
      }
    } catch {}

    result.alive_reason = clipReason(result.alive_reason);
    statusDB.setAlive(email, result);
```

### Step 3: Syntax check

```bash
node --check server/liveness/runner.js
```

Expected: no output.

### Step 4: 扩展 `mkEnv` 让 tests 可注入 proxyMgr

打开 `server/liveness/__tests__/runner.test.js`. 找到 `function mkEnv(opts = {})` 体（约 line 6-25），找到这一行（最后一个返回字段）：

```js
    codexFile: opts.codexFile || { read: async () => ({ access_token: 'cached.tok.x' }), write: async () => {} },
  };
```

替换为：

```js
    codexFile: opts.codexFile || { read: async () => ({ access_token: 'cached.tok.x' }), write: async () => {} },
    proxyMgr: opts.proxyMgr || null,
  };
```

### Step 5: 添加 3 个新测试

在 `runner.test.js` 末尾追加：

```js
test('runner: terminal network_error calls recordBadAttempt', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'n@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-99' }),
      recordBadAttempt: (tag, channel, reason) => calls.push({ kind: 'bad', tag, channel, reason }),
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
    },
  });
  const runner = createRunner(env);
  runner.start(['n@x.com']);
  // 3 retries × probe-immediate + 2 × 2s delay ≈ 4.1s. Add overhead.
  await new Promise(r => setTimeout(r, 5500));
  const bad = calls.find(c => c.kind === 'bad');
  assert.ok(bad, 'recordBadAttempt was called');
  assert.strictEqual(bad.tag, 'pro-us-99');
  assert.strictEqual(bad.channel, 'main');
  assert.match(bad.reason, /liveness_network_error/);
});

test('runner: terminal plus calls recordGoodAttempt', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'p@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-77' }),
      recordBadAttempt: (...args) => calls.push({ kind: 'bad', args }),
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
    },
  });
  const runner = createRunner(env);
  runner.start(['p@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const good = calls.find(c => c.kind === 'good');
  assert.ok(good, 'recordGoodAttempt was called');
  assert.strictEqual(good.tag, 'pro-us-77');
  assert.strictEqual(good.channel, 'main');
});

test('runner: proxy disabled skips vote', async () => {
  const calls = [];
  const env = mkEnv({
    accounts: [{ email: 'd@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: false, currentNode: 'pro-us-disabled' }),
      recordBadAttempt: (...args) => calls.push({ kind: 'bad', args }),
      recordGoodAttempt: (...args) => calls.push({ kind: 'good', args }),
    },
  });
  const runner = createRunner(env);
  runner.start(['d@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  assert.strictEqual(calls.length, 0, 'no vote when proxy disabled');
});
```

### Step 6: Run new tests

```bash
node --test server/liveness/__tests__/runner.test.js
```

Expected: `# pass 16`, `# fail 0` (was 13, +3 new). Note: the `network_error` test runs ~5.5s due to the retry loop.

If `bad.tag` assertion fails because `recordBadAttempt` wasn't called, the proxyMgr injection didn't reach `getProxyMgr()` inside dispatchOne — check that `mkEnv` passes `proxyMgr` through and that `createRunner` destructures it.

### Step 7: Full regression

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: **171** tests pass (168 baseline + 3 new).

### Step 8: Commit

```bash
git add server/liveness/runner.js server/liveness/__tests__/runner.test.js
git commit -m "feat(liveness): vote on proxy node after every dispatchOne terminal

server/liveness/ has never participated in the proxy blacklist
counter — server/engine.js and server/chatgpt-checkout.js already
call recordBadAttempt/recordGoodAttempt on network failures, but
liveness sat out, so a node that's persistently timing out only
accumulates bad attempts from the execution pipeline path. For
batches where 100+ accounts run liveness checks against one bad
node, that's a lot of evidence going to waste.

runner.dispatchOne now reads proxyMgr.getState() after the retry
loop completes and the deactivated fallback is applied:
  - network_error / proxy_error → recordBadAttempt with reason
    'liveness_<status>'
  - plus / canceled / token_expired / login_fail / deactivated →
    recordGoodAttempt (the node reached OpenAI)
  - everything else falls through silently

v2.30's 3-attempt retry loop already filters transient blips, so
a terminal network_error here is a real persistent failure and
deserves a bad vote. Gate on proxyMgr.getState().enabled — direct
mode skips the vote.

createRunner accepts an optional proxyMgr injection so tests can
assert calls; production code lazy-requires the real module
(mirrors checker.js:12-18). The mkEnv test helper passes the
injection through.

3 new tests pin behavior: network_error → bad, plus → good,
disabled → no vote. 171 total tests pass."
```

---

## Task 2: Frontend — Accounts 页下载 UI

**Files:**
- Modify: `web/src/views/Accounts.vue`

### Step 1: Toolbar 加 2 dropdown

打开 `web/src/views/Accounts.vue`. 找到 toolbar 中"测活全部"按钮所在区域（line ~44-57 已有"测活全部"+"停止测活"+ progress chip + aliveFilter）。在 `<el-tag v-if="livenessRunning" type="info" ...>{{ socketState.liveness.done }}/...</el-tag>` 后面、`<el-select v-model="aliveFilter" ...>` **之前**插入：

```vue
        <el-divider direction="vertical" />
        <el-dropdown :disabled="selected.length === 0" @command="downloadSelectedAs" split-button size="small">
          下载选中 ({{ selected.length }})
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
              <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown @command="downloadAllAs" split-button size="small" style="margin-left:8px">
          下载全部 (ZIP)
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
              <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
```

### Step 2: 操作列加 CPA / Sub 按钮

找到操作列定义（约 line 136）：

```vue
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" text type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
```

替换为（width 140 → 240、加 2 按钮 在编辑/删除前）：

```vue
      <el-table-column label="操作" width="240">
        <template #default="{ row }">
          <el-button size="small" text type="success" :disabled="!row._hasAuth" @click.stop="downloadAuth(row.email, 'cpa')">CPA</el-button>
          <el-button size="small" text type="primary" :disabled="!row._hasAuth" @click.stop="downloadAuth(row.email, 'sub2api')">Sub</el-button>
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" text type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
```

### Step 3: script 部分追加 3 个 download helper 函数

在 `Accounts.vue` `<script setup>` 末尾（在最后一个函数定义之后、但 `</script>` 之前）追加：

```js
// === Download helpers (mirror Execute.vue) ===
function downloadAuth(email, format = 'cpa') {
  window.open(`/api/results/${encodeURIComponent(email)}/auth-file?format=${format}`)
}
function downloadAllAs(format) {
  window.open(`/api/results/download-all?format=${format || 'cpa'}`)
}
async function downloadSelectedAs(format) {
  const fmt = format || 'cpa'
  const emails = selected.value.filter(r => r._hasAuth).map(r => r.email)
  if (emails.length === 0) { ElMessage.warning('选中账号都没有 auth 文件可下载'); return }
  try {
    const res = await api.post('/results/download-selected', { emails, format: fmt }, { responseType: 'blob' })
    const url = window.URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fmt}-selected-${emails.length}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    let msg = '下载失败'
    if (e?.response?.data instanceof Blob) {
      try { msg = JSON.parse(await e.response.data.text()).error || msg } catch {}
    } else {
      msg = e?.response?.data?.error || e?.message || msg
    }
    ElMessage.error(msg)
  }
}
```

Note: `api` and `ElMessage` are already imported by Accounts.vue. `selected.value` is the rows array (`ref([])` updated by `onSelectionChange(rows)`). `_hasAuth` field is set in `load()` (`_hasAuth: !!r.hasAuthFile`).

### Step 4: Build front-end

```bash
cd web && npm run build
```

Expected: `✓ built`. If Vue compile errors reference `selected`, `_hasAuth`, `api`, or `ElMessage`, recheck imports.

### Step 5: Server-side regression sanity

```bash
cd .. && node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 171 still pass (front-end changes don't touch server tests).

### Step 6: Commit

```bash
git add web/src/views/Accounts.vue
git commit -m "feat(ui): Accounts page download buttons (toolbar dropdowns + inline CPA/Sub)

Mirror the Execute.vue download UX so users can grab auth files
from the Accounts page directly — no more cross-page hopping to
Execute. Toolbar gains two dropdowns next to 测活全部:
  - 下载选中 (N) — POST /api/results/download-selected, blob ZIP
  - 下载全部 (ZIP) — GET /api/results/download-all, browser-open ZIP
Each dropdown has CPA 格式 / Sub2API 格式 commands.

The 操作 column widens from 140px to 240px and gains two text
buttons before 编辑/删除:
  - CPA  — green text, GET /api/results/<email>/auth-file?format=cpa
  - Sub  — primary text, format=sub2api
Both disabled when row._hasAuth is false (set during load() based
on hasAuthFile from /api/results).

Three helper functions (downloadAuth, downloadAllAs,
downloadSelectedAs) copy from Execute.vue:345-372 with one
adaptation: selected.value is rows-not-strings in Accounts.vue, so
the haystack becomes selected.value.filter(r => r._hasAuth).map(r =>
r.email) instead of Execute.vue's email-string version.

Backend endpoints all already exist (POST /download-selected from
v2.29.1, GET /download-all + /:email/auth-file from earlier). Zero
backend changes."
```

---

## Task 3: CHANGELOG v2.31.0 + 集成 smoke

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.31.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 行之后插入：

```markdown
# Changelog

## v2.31.0 — 2026-05-24

### Liveness Proxy Blacklist Integration + Accounts Page Download UI

**Part A — 测活集成 proxy 黑名单**

- `server/liveness/runner.js` 在 `dispatchOne` 末尾终态投票：
  - `alive_status ∈ {network_error, proxy_error}` → `proxyMgr.recordBadAttempt(currentNode, 'main', 'liveness_<status>')`
  - `alive_status ∈ {plus, canceled, token_expired, login_fail, deactivated}` → `proxyMgr.recordGoodAttempt(currentNode, 'main')`
- 依赖 v2.30 的 3-attempt retry —— 走到终态的 network_error 是节点持续不通、不是偶发抖动
- `createRunner` 接受可选 `proxyMgr` 注入用于测试 mock；production 走 lazy require
- proxy 未启用时跳过投票（gate `getState().enabled`）
- reason 字符串 `liveness_<status>` 与流水线的 `login_net_error` / `payment_unreachable` 区分，便于排查黑名单来源

**Part B — Accounts 页下载 UI**

- toolbar 在"测活全部"右侧加两个 dropdown：
  - **下载选中 (N)** — POST `/api/results/download-selected` 流式 ZIP
  - **下载全部 (ZIP)** — GET `/api/results/download-all`
  - 每个 dropdown 含 `CPA 格式` / `Sub2API 格式` 命令
- 操作列宽 140 → 240，编辑/删除前加 **CPA** / **Sub** 文字按钮，`_hasAuth=false` 时 disabled
- 三个 helper 函数 (`downloadAuth` / `downloadAllAs` / `downloadSelectedAs`) 跟 Execute.vue 套路一致
- 后端 endpoint 全沿用 v2.29.1 / 早期既有，零后端改动

**测试**：171 tests pass — runner +3 测试（network_error vote bad / plus vote good / proxy disabled skip）on 168 baseline.

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-blacklist-and-accounts-download-design.md` + `docs/superpowers/plans/2026-05-24-liveness-blacklist-and-accounts-download.md`。
```

(Keep `## v2.30.0` and everything below intact.)

### Step 2: Final regression

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 171 pass.

### Step 3: End-to-end smoke

Restart server (kill any existing `node server/index.js` + relaunch), open `http://localhost:3000/accounts`, hard refresh.

1. **Accounts download UI verification**:
   - toolbar 显示"下载选中 (0)" + "下载全部 (ZIP)" 两个 dropdown（在 "测活全部" 右边、aliveFilter 前）
   - 操作列每行多了 `CPA` + `Sub` 按钮；`_hasAuth=false` 的账号这俩按钮灰色 disabled
   - 选 2 个有 auth 的账号 → 下载选中 → CPA → 浏览器**一次性**保存 `cpa-selected-2.zip`
   - 点行内 `CPA` → 浏览器直接下载该账号的 `codex-<email>.json`
2. **Liveness blacklist vote verification**:
   - 强制当前节点 timeout：
     ```bash
     curl -X POST http://localhost:3000/api/proxy/blacklist/clear -H 'Content-Type: application/json' -d '{"channel":"main"}'
     ```
     (清空当前黑名单，准备观察增量)
   - 跑测活全部 50 个账号（任选）
   - 期间通过 `GET /api/proxy/status` 观察：
     ```bash
     curl http://localhost:3000/api/proxy/status | grep -E 'badNodes|failCounts'
     ```
   - 任何持续不通的节点应该出现在 failCounts 累加直至 FAIL_THRESHOLD → 入 badNodes

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.31.0 — liveness blacklist + Accounts download UI"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 background: informational, no task.
- Spec §2.1 dispatchOne markBad/Good block → Task 1 Step 2.
- Spec §2.2 invariants (currentNode stable, deactivated ordering, proxy gate, lazy require) → covered by Step 1 + Step 2 wiring.
- Spec §2.3 error handling → Task 1 Step 2 (try/catch around the whole block).
- Spec §2.4 3 unit tests → Task 1 Step 5.
- Spec §3.1 toolbar 2 dropdowns → Task 2 Step 1.
- Spec §3.2 inline CPA/Sub buttons → Task 2 Step 2.
- Spec §3.3 3 download helper functions → Task 2 Step 3.
- Spec §3.4 invariants (selected shape, _hasAuth field, @click.stop, empty array early return) → covered by code in Task 2.
- Spec §4 boundaries (8 cases) → covered across Tasks 1+2 implementation.
- Spec §5 testing → Task 1 (unit) + Task 3 Step 3 (integration smoke).
- Spec §6 file list → matches Task 1+2 file list above.
- Spec §7 YAGNI → nothing in plan exceeds.
- Spec §8 v2.31.0 → Task 3 Step 1.

**2. Placeholder scan:** no "TBD" / "implement later" / "fill in" — every step has exact code, paths, commands.

**3. Type/symbol consistency:**

- `proxyMgr` injection name consistent across createRunner signature (Task 1 Step 1), `getProxyMgr()` helper (Step 1), inline call in dispatchOne (Step 2), mkEnv defaults (Step 4), test fixtures (Step 5).
- `downloadAuth` / `downloadAllAs` / `downloadSelectedAs` — same identifiers in template (Task 2 Step 1, 2) and script (Step 3).
- `selected.value` shape (rows of objects with `_hasAuth` and `email`) consistent across template `:disabled="selected.length === 0"` (Step 1) and script `selected.value.filter(r => r._hasAuth).map(r => r.email)` (Step 3).
- `recordBadAttempt(tag, channel, reason)` / `recordGoodAttempt(tag, channel)` — same signatures as `server/proxy/index.js` exports and `server/engine.js` call sites.
- `liveness_${result.alive_status}` reason format — single source of truth in Task 1 Step 2, tested in Step 5 with `/liveness_network_error/` regex.

No issues. Plan ready.
