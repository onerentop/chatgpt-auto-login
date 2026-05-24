# 测活集成 proxy 黑名单 + Accounts 页下载按钮设计

> **日期**：2026-05-24
> **版本**：v2.31.0
> **目标**：
> 1. 测活模块（`server/liveness/runner.js`）接入现有 `proxyMgr.recordBadAttempt` / `recordGoodAttempt` —— 测活终态明确给节点投票（"通"或"不通"），跟 `server/engine.js` 已有的流水线投票合流到同一计数器和 30min 黑名单。
> 2. Accounts 页加"下载选中"+ "下载全部" 顶部 dropdown 和行内 CPA/Sub 按钮，跟 Execute 页一致体验。后端 endpoint 全现成、零后端改动。

---

## 1. 背景

### 1.1 proxy 黑名单现状

`server/proxy/index.js` 暴露：

- `recordBadAttempt(tag, channel, reason)` —— 累加节点失败计数；达到 `FAIL_THRESHOLD` 时入黑名单（30min TTL）
- `recordGoodAttempt(tag, channel)` —— 清零失败计数
- 由 `server/proxy/__tests__/` 的现有套件覆盖。

调用现状（grep 验证）：

| 模块 | 调用 | reason |
|---|---|---|
| `server/engine.js` | recordBadAttempt | `login_net_error`, `payment_unreachable` |
| `server/engine.js` | recordGoodAttempt | 在 G1/G2/G3 关卡 |
| `server/chatgpt-checkout.js` | recordBadAttempt/Good | `checkout_timeout` / `checkout_empty_link` / `checkout_parse_failed` |
| **`server/liveness/`** | **完全未接入** | — |

测活模块 (`runner.js` / `checker.js` / `light-login.js`) 只通过 `proxyMgr.getProxyUrl()` 读代理 URL 给 Python 子进程用，不投票。后果：节点持续 timeout 时执行流水线会标 bad、但测活不会。测活批量跑 100 个账号、20 个 network_error 都来自同一坏节点的情况，测活没贡献给黑名单累加。

### 1.2 Accounts 页下载现状

Execute 页 (`web/src/views/Execute.vue`) 已有：

- 顶部 dropdown："下载选中" + "下载全部"（各支持 CPA / Sub2API 格式）
- 行内按钮："CPA" / "Sub"（每个账号一对）

Accounts 页（`web/src/views/Accounts.vue`）只有"批量导入"/"导出全部"/"添加单个"/"删除选中"/各种 filter ... **缺所有 auth 文件下载入口**。要拿账号 codex-*.json / sub2api-*.json 必须跳到 Execute 页操作。

后端 endpoint 全现成（`POST /api/results/download-selected`、`GET /api/results/download-all`、`GET /api/results/:email/auth-file`），零改动需要。

### 1.3 决策摘要

| 维度 | 决策 |
|---|---|
| 测活 markBad 触发 | 终态 `alive_status ∈ {network_error, proxy_error}` 后 recordBadAttempt |
| 测活 markGood 触发 | 终态 `alive_status ∈ {plus, canceled, token_expired, login_fail, deactivated}` 后 recordGoodAttempt |
| markBad 时机 | 在 v2.30 retry 循环**全部**耗尽后、setAlive 之前。3 次 retry 已过滤偶发抖动 |
| reason 字符串 | `liveness_${alive_status}`（如 `liveness_network_error`、`liveness_proxy_error`） |
| 当前节点读取 | `proxyMgr.getState().currentNode` 在 runner 末尾读 |
| proxy 未启用 | 直接 skip（同 `server/engine.js` 套路）|
| Accounts toolbar 下载 | 紧挨"测活全部"右侧加 `<el-divider>` + 2 dropdown |
| Accounts 行内下载 | 操作列编辑/删除前面加 CPA/Sub 文字按钮（`:disabled="!row._hasAuth"`）|
| script 函数 | 三个函数 (`downloadAuth` / `downloadAllAs` / `downloadSelectedAs`) 直接搬 Execute.vue:345-372 |

---

## 2. Part A — 测活集成 proxy 黑名单

### 2.1 `runner.dispatchOne` 末尾 patch

`server/liveness/runner.js` 在 v2.30 retry 循环结束 + deactivated fallback 应用后、`statusDB.setAlive` 之前插入：

```js
    // Vote on the current proxy node based on terminal alive_status. Mirrors
    // server/engine.js:276/281 pattern. The runner has at this point exhausted
    // up to 3 retries (v2.30); a terminal network_error / proxy_error means
    // the node is persistently unreachable, not a transient blip — record
    // it as a bad attempt so the existing FAIL_THRESHOLD logic in
    // server/proxy/index.js can eventually blacklist the node.
    try {
      const proxyMgr = require('../proxy');
      if (proxyMgr.getState().enabled) {
        const currentNode = proxyMgr.getState().currentNode;
        if (currentNode) {
          if (result.alive_status === 'network_error' || result.alive_status === 'proxy_error') {
            proxyMgr.recordBadAttempt(currentNode, 'main', `liveness_${result.alive_status}`);
          } else if (
            result.alive_status === 'plus' ||
            result.alive_status === 'canceled' ||
            result.alive_status === 'token_expired' ||
            result.alive_status === 'login_fail' ||
            result.alive_status === 'deactivated'
          ) {
            proxyMgr.recordGoodAttempt(currentNode, 'main');
          }
          // 'checking' / 'unknown' never reach this code path (they're not
          // terminal results), so no case needed.
        }
      }
    } catch {}
```

### 2.2 不变式

- **`currentNode` 在 dispatchOne 期间不变**：liveness 模块不调 `proxyMgr.rotate()`，所以 v2.30 的 3 次 retry 都走同一节点。终态 `currentNode` 等于尝试期间的节点 ✓
- **不污染 deactivated 兜底**：deactivated fallback（v2.28 hotfix `3f9c437`）在 markBad/Good 块**之前**已应用 —— deactivated 账号最终被映射成 markGood（节点能到 OpenAI、只是账号封了）✓
- **跟流水线 currentNode 共享语义**：流水线和测活并发跑同一节点时（v2.26 spec 明确允许），两者投票合流到同一计数器，FAIL_THRESHOLD 触发更快 —— 这是好事 ✓
- **proxy 模块的 lazy require** 避免 module 加载期循环依赖（同 `checker.js:12-18` 套路）

### 2.3 错误处理

| 场景 | 处理 |
|---|---|
| proxy 模块 require 失败（罕见） | `try/catch` 兜底，测活继续 |
| recordBadAttempt/recordGoodAttempt 内部抛 | 同上 try/catch |
| `currentNode` 为空字符串 / undefined | `if (currentNode)` 跳过投票 |
| 测活被 abort 提前退出 | dispatchOne 早返 `if (state.abortCtrl?.signal.aborted) return;` 已在该 patch 之前 → 不会执行投票 ✓ |

### 2.4 测试

`server/liveness/__tests__/runner.test.js` +3 测试：

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
  await new Promise(r => setTimeout(r, 5500));  // 3 retries + 2*2s delays
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

注意：`mkEnv` 当前没接受 `proxyMgr` 参数 — Task 1 实施时需先扩展 `createRunner` 的依赖注入（接受 `proxyMgr` 可选参数，缺省时 lazy require）。

---

## 3. Part B — Accounts 页下载 UI

### 3.1 Toolbar：紧挨"测活全部"右侧加 dropdown

在 `web/src/views/Accounts.vue` template 的"测活全部"按钮和"测活停止"按钮之后（紧挨 `livenessRunning` 进度 chip 或者 aliveFilter dropdown 前），插入：

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

### 3.2 行内：操作列前加 CPA/Sub 按钮

找到现有的操作列（`<el-table-column label="操作" width="140">`），把 width 改大点（180）+ 在编辑/删除按钮**前**插入：

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

### 3.3 Script：搬 Execute.vue 的三个函数

在 `Accounts.vue` `<script setup>` 末尾（其他 helper 后），追加：

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

### 3.4 不变式

- **`selected.value` 字段名**：Accounts.vue 用 `selected`（数组 of rows，每个 row 是 `{ email, _hasAuth, ... }`），Execute.vue 用 `selectedEmails`（数组 of email 字符串）—— 注意 downloadSelectedAs 里 `selected.value.filter(r => r._hasAuth).map(r => r.email)` 是 Accounts 风格，区别 Execute 的 `selectedEmails.value.filter(e => accounts.value.find(...)._hasAuth)`。
- **`_hasAuth` 字段**：Accounts.vue 已有 `_hasAuth: !!r.hasAuthFile` 在 `load()` 里设置（v2.26 加的），可直接用
- **行内按钮加 `@click.stop`**：防止冒泡到行点击事件（如果 Accounts 有 row click handler）—— 同 Execute 套路
- **空数组 / 无 auth 的早返**：ElMessage.warning 后直接 return，不向后端发空 POST

---

## 4. 错误处理 + 边界

| # | 场景 | 处理 |
|---|---|---|
| 1 | 测活时 proxy 模块本身 require fail（罕见） | `try/catch` 兜底，测活继续 |
| 2 | 测活终态是 `unknown` / `checking`（不应出现） | if/else if 分支未覆盖 → 不投票（保守）|
| 3 | Accounts 选中 0 个账号点"下载选中" | dropdown 按 `disabled="selected.length === 0"` 自然禁用 |
| 4 | 选中 N 个、其中 0 个有 auth | ElMessage.warning('选中账号都没有 auth 文件可下载')，不发 POST |
| 5 | 选中 N 个、其中 M 个有 auth | 只下载 M 个，ZIP 文件名 `cpa-selected-M.zip` |
| 6 | 行内 CPA/Sub 点击时账号还在 running | `:disabled="!row._hasAuth"` 兜底（_hasAuth 是 socket 实时刷新的）|
| 7 | downloadAllAs 返 404（无 auth 文件） | window.open 直接打开会显示 404 JSON —— UX 一般，但 v2.29.1 已有同样行为，不改 |
| 8 | 服务器后端流式 ZIP 中断 | axios responseType:'blob' 自然抛错，被 catch 转 ElMessage.error |

---

## 5. 测试策略

### 5.1 单元测试

`server/liveness/__tests__/runner.test.js` +3 测试（在 §2.4 已给出代码）：

- terminal network_error → recordBadAttempt
- terminal plus → recordGoodAttempt
- proxy disabled → no vote

### 5.2 集成 smoke

1. 启动 server + 强刷 Accounts 页
2. **Accounts 下载 UI**:
   - toolbar 出现"下载选中 (0)" + "下载全部 (ZIP)" 两个 dropdown
   - 操作列每行加 CPA / Sub 按钮（`_hasAuth=false` 的 disabled）
   - 选中 2 个有 auth 账号 → 下载选中 → CPA → 应弹一次保存对话框，文件名 `cpa-selected-2.zip`
   - 点行内 CPA → 浏览器直接下载 codex-{email}.json
3. **测活黑名单投票**（手动观察）：
   - 临时 stop 主代理某节点（curl mark-bad），跑测活 → 看 `/api/proxy/blacklist` 返回有新 entry / failCount 增加
   - 跑测活活账号 → recordGoodAttempt 清零计数

### 5.3 回归

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

预期 **171** 测试通过（168 baseline + 3 新）。

---

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `server/liveness/runner.js` | createRunner 接受 `proxyMgr` 可选注入；dispatchOne 末尾 markBad/Good 块 |
| `server/liveness/__tests__/runner.test.js` | +3 测试 |
| `web/src/views/Accounts.vue` | toolbar +2 dropdown；操作列 +2 按钮，width 140→240；script +3 函数 |
| `docs/CHANGELOG.md` | v2.31.0 节 |

预算 **~80 行新代码 + 3 测试**。

---

## 7. YAGNI 边界

- ❌ 不投票 `unknown` / `checking`（不该出现在终态）
- ❌ 不让测活 rotate proxy（v2.26 spec 明确 liveness 旁观）
- ❌ 不区分 cloudflare 403 vs 真 proxy_error —— `proxy_error` 一律 markBad
- ❌ Accounts.vue 不加批量删除 cpa-auth 文件（YAGNI）
- ❌ 不改 download endpoint 命名（v2.29.1 套路保留）
- ❌ 不加下载历史 / 日志（每次都是即时 ZIP）

---

## 8. 版本号

v2.31.0。DB schema 不变；纯应用层改动。
