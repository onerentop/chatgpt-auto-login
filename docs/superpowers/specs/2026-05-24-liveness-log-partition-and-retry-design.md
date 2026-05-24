# 测活日志新旧分区 + network_error 自动重试设计

> **日期**：2026-05-24
> **版本**：v2.30.0
> **目标**：
> 1. UI 测活日志面板拆成"旧日志"（页面加载从 DB 拉的历史）和"实时日志"（socket 推送的本次会话事件）两个折叠区；新日志区自动滚动到底部。
> 2. runner.dispatchOne 检测到 `alive_status='network_error'` 时自动重试最多 3 次，每次间隔 2s；重试过程通过 `liveness-log` 事件实时反馈到 UI 面板和 DB。

---

## 1. 背景

### 1.1 日志面板现状

`web/src/views/Accounts.vue` 当前有单个 `<el-collapse>` 折叠区显示所有测活日志（v2.28 加的）。`socketState.logs` 是混合源：

- `loadLivenessLogs` (onMounted) 从 `/api/liveness/logs?limit=200` 拉 DB 历史 → push 到 socketState.logs
- `pushLivenessLog` (socket realtime via `liveness-log` / `liveness-status` / `liveness-complete`) → push 到同一个 list

`livenessLogs` computed 用 `filter(l => l.source === 'liveness').slice(-200)` 选 200 条。结果：

- 页面刷新后 200 条历史 + 不能区分"本次会话产生的新事件"和"之前的"
- 滚动位置不自动跟随新事件——用户要手动 scroll
- 长时间运行后 200 条 cap 把当前会话的新事件挤掉历史

### 1.2 network_error 现状

`runner.dispatchOne` 一次性走 probe → optional verifyDeactivated → optional lightLogin → 终态 setAlive。无外层重试。

`alive_status='network_error'` 来源（v2.28/v2.29 累积）：

| 来源 | 例子 |
|---|---|
| probe HTTP 429 / 5xx | `check 503` |
| probe AbortError 超时 | `probe timeout`（12s） |
| probe spawn ENOENT | `spawn error: ENOENT` |
| probe stdout 不可解析 | `probe unparsable: <stderr tail>` |
| probe curl 异常 | `exception: Failed to perform, curl: (28) ...` |
| dispatchOne 兜底 | `unexpected: <msg>` |
| 无 probe 结果 | `no probe result` |

实测节点临时不稳（pro-美国01 EOF）时占大头——单次 timeout 就标终态 network_error，给用户错觉"测活坏了"。

### 1.3 决策摘要

| 维度 | 决策 |
|---|---|
| 日志分区 | "旧"= 来自 DB 历史；"新"= socket 实时事件。两个 `<el-collapse>` 并列 |
| 默认折叠态 | 旧折叠 / 新展开 |
| 新日志区自动滚动 | watch `newLogs.length` → nextTick → `scrollTop = scrollHeight`。不做手动滚动暂停检测 |
| 新日志 cap | 500 条（vs 旧 200，因为新事件来得快） |
| network_error 重试触发 | **任何** `alive_status === 'network_error'`（spawn ENOENT 这种也重试，但 3 次后终态、可接受） |
| 重试次数 | 最多 3 次（含首次 = 总共 3 次尝试） |
| 重试间隔 | 2s |
| 重试可见性 | 每次重试前 onLog emit `liveness-log`（warning level）+ DB 持久化 |
| 中断响应 | 每次 sleep 前 check `abortCtrl.signal.aborted`，秒级响应停止 |
| Worst case 耗时 | 3 × 12s probe + 2 × 2s = **40s/账号**（仅 network_error 触发） |

---

## 2. Part A — UI 日志面板新旧分区

### 2.1 `socketState.logs` 新增字段

每个 liveness log entry 加 `isHistorical: boolean`：

```js
// pushLivenessLog (web/src/socket.js)
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
  if (socketState.logs.length > 500) socketState.logs.splice(0, socketState.logs.length - 500);
}
```

`socket.on('liveness-log')` / `'liveness-status'` / `'liveness-complete'` 调用时不传 `isHistorical`，默认 `false`（新事件）。

`loadLivenessLogs` (Accounts.vue) push 历史时显式传 `isHistorical: true`。

### 2.2 Accounts.vue 模板：两个折叠区

```vue
<el-collapse v-model="oldLogsExpanded" style="margin-bottom: 8px">
  <el-collapse-item :title="`旧日志 (${oldLogs.length})`" name="old">
    <div class="liveness-log-list">
      <div v-for="(log, i) in oldLogs" :key="'o-'+i" :class="'log-' + log.level">
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
      <div v-for="(log, i) in newLogs" :key="'n-'+i" :class="'log-' + log.level">
        <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
        <span v-if="log.email" class="log-email">{{ log.email }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="newLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无实时日志</div>
    </div>
  </el-collapse-item>
</el-collapse>
```

### 2.3 Accounts.vue script：computed + 自动滚动

```js
const oldLogsExpanded = ref([])                // 默认折叠
const newLogsExpanded = ref(['new'])           // 默认展开
const newLogsContainer = ref(null)             // DOM ref for scroll

const oldLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && l.isHistorical).slice(-200)
)
const newLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && !l.isHistorical).slice(-500)
)

// Auto-scroll new logs container to bottom whenever new entries arrive.
watch(() => newLogs.value.length, () => {
  nextTick(() => {
    const el = newLogsContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

// Auto-expand new logs panel when liveness starts (replace v2.28 hotfix
// 4d5a4d6's watch on socketState.liveness.running — same target, new var name).
watch(() => socketState.liveness.running, (now) => {
  if (now && !newLogsExpanded.value.includes('new')) {
    newLogsExpanded.value = ['new']
  }
})
```

### 2.4 不变式

- 已有的 v2.28 `<style scoped>` log-list 样式两个区共用，无需重复 CSS。
- `loadLivenessLogs` 现有去重逻辑（`existing` Set）保留——避免历史日志在 hot-reload 时重复 push。
- 旧的 `logsExpanded` / `livenessLogs` 名字废弃，改成新名字（统一 grep + replace）。

---

## 3. Part B — network_error 自动重试

### 3.1 重构 `runner.dispatchOne`

抽出"单次尝试"为 `dispatchOnceInner(email, account, onLog, abortSignal)`，返回 `result = { alive_status, alive_reason }` 但不写 DB / 不 emit 终态。外层 `dispatchOne` 包重试 + 终态写入。

```js
const NETWORK_RETRY_MAX = 3;
const NETWORK_RETRY_DELAY_MS = 2000;

async function dispatchOne(email) {
  if (state.abortCtrl?.signal.aborted) return;
  const account = accountsDB.get(email);
  if (!account) {
    state.done++; state.failed++;
    io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed });
    return;
  }

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
      await new Promise(r => setTimeout(r, NETWORK_RETRY_DELAY_MS));
    }
  }

  if (state.abortCtrl?.signal.aborted) return;

  // Existing deactivated fallback (v2.28 hotfix 3f9c437) stays here.
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

### 3.2 `dispatchOnceInner` 函数体

把当前 dispatchOne 里**除了** "checking emit + setAlive('checking')" 和 "terminal emit + setAlive(result)" **外的所有逻辑**放进 `dispatchOnceInner`：

```js
async function dispatchOnceInner(email, account, onLog, abortSignal) {
  let result = null;
  try {
    const existing = await codexFile.read(email);
    const tok = existing?.access_token || '';

    let probeRes = null;
    if (tok) probeRes = await checker.probe(tok, { signal: abortSignal, onLog });

    if (probeRes && probeRes.alive_status === 'token_expired') {
      const verifyRes = await checker.verifyDeactivated(account, { signal: abortSignal, onLog });
      if (verifyRes.status === 'deactivated') {
        probeRes = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
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
```

### 3.3 重试日志样例

UI 用户在面板看到：

```
13:50:14 alice@x.com [liveness] checking
13:50:14 alice@x.com [liveness] [Liveness] GET /accounts/check attempt 1/3 via chrome142, proxy=on
13:50:26 alice@x.com [liveness] [Liveness] exception: curl: (28) timeout
13:50:26 alice@x.com [liveness] network_error: exception: curl: (28) timeout — retrying 1/3 in 2s
13:50:28 alice@x.com [liveness] [Liveness] GET /accounts/check attempt 1/3 via chrome136, proxy=on
13:50:30 alice@x.com [liveness] plus: check ok
```

第二次尝试节点恢复 → 成功。第二次也失败时：

```
13:50:30 alice@x.com [liveness] network_error: ... — retrying 2/3 in 2s
13:50:32 alice@x.com [liveness] [Liveness] GET /accounts/check attempt 1/3 via chrome131, proxy=on
13:50:44 alice@x.com [liveness] [Liveness] exception: curl: (28) timeout
13:50:44 alice@x.com [liveness] network_error: exception: curl: (28) timeout  ← 终态（无 retrying 后缀）
```

### 3.4 中断响应

每次 `await new Promise(r => setTimeout(r, NETWORK_RETRY_DELAY_MS))` **不可** 自然检查 abortSignal。改用：

```js
await new Promise(r => {
  const t = setTimeout(r, NETWORK_RETRY_DELAY_MS);
  abortSignal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
```

并在 retry 循环开始的 `if (state.abortCtrl?.signal.aborted) return;` 跳出。

---

## 4. 错误处理 + 边界

| # | 场景 | 处理 |
|---|---|---|
| 1 | 第 1 次 plus / canceled / token_expired / login_fail / proxy_error / deactivated | 直接跳出循环、不重试 |
| 2 | 第 1 次 network_error → 第 2 次 plus | 终态 plus（重试成功）|
| 3 | 3 次全 network_error | 终态保留最后一次的 network_error reason（一般是相同的 curl 28） |
| 4 | 重试期间用户点"停止测活" | sleep 提前唤醒 + 循环顶部 abort 检查 → 跳出，跳过终态 setAlive |
| 5 | 重试触发的 onLog 日志 | 跟所有 liveness-log 一样存 DB + 实时推 UI；刷新页面历史里能看到"retrying 1/3" |
| 6 | UI 新日志区滚到底部时用户向上 scroll 看历史 | 下次新日志进来仍 scroll bottom（不做手动检测） |
| 7 | 200 旧日志 + 500 新日志同时存在 → socketState.logs 截断 | 现有 cap 500 不变；旧日志可能被挤出（因为旧 push 在前）→ 历史区会从 200 慢慢减到更少。**建议把 socketState.logs cap 提到 1000** 留 buffer |

---

## 5. 测试策略

### 5.1 单元测试

`server/liveness/__tests__/runner.test.js` +3 测试：

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
  await new Promise(r => setTimeout(r, 8000));  // 3 attempts + 2*2s delays = ~6s + overhead
  assert.strictEqual(attempts, 3, 'probe called 3 times');
  const final = env.dbCalls.find(c => c.email === 'flaky@x.com' && c.alive_status !== 'checking');
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
  await new Promise(r => setTimeout(r, 4000));
  assert.strictEqual(attempts, 2, 'probe called 2 times');
  const final = env.dbCalls.find(c => c.email === 'recovery@x.com' && c.alive_status !== 'checking');
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
  await new Promise(r => setTimeout(r, 2000));
  assert.strictEqual(attempts, 1);
});
```

### 5.2 集成 smoke

启动 server → Accounts 页强刷 → 期望：

1. 页面顶部立刻看到两个折叠区：**旧日志 (200)** 折叠 + **实时日志 (0)** 展开
2. 点"测活全部" → 实时日志区开始流入，每条新日志自动滚到底部
3. 模拟 network_error: 临时关掉 sing-box (`POST /api/proxy/stop`)，跑测活 → 看到 `retrying 1/3` `retrying 2/3` 日志，最终 network_error 终态
4. 重启 sing-box → 重新跑测活，第 1 次就 plus，不显示 retrying 日志

### 5.3 回归

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

预期 **168** 测试（165 baseline + 3 retry tests）。

---

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/socket.js` | `pushLivenessLog` 加 `isHistorical=false` 默认参数 |
| `web/src/views/Accounts.vue` | template 一个 `<el-collapse>` 改两个；script `oldLogs/newLogs` computed、`newLogsContainer` ref、auto-scroll watch、loadLivenessLogs 标 `isHistorical: true`；废弃 `logsExpanded` / `livenessLogs` 旧名 |
| `server/liveness/runner.js` | `dispatchOne` 重构 + 抽 `dispatchOnceInner`、retry loop、abort-aware sleep |
| `server/liveness/__tests__/runner.test.js` | +3 测试（3 次 retry / 1 次 retry 成功 / plus 不 retry） |
| `docs/CHANGELOG.md` | v2.30.0 节 |

预算 **~140 行新代码 + 3 测试**。

---

## 7. YAGNI 边界

- ❌ 不做"手动 scroll 暂停自动 scroll"——KISS，用户位置不被检测
- ❌ 不按"测活 batch"分组——分区粒度就两个（历史/实时），多 batch 都在实时里
- ❌ 不让 retry 时联动 proxy rotate——liveness 不该改流水线节点状态
- ❌ 不区分"真网络层" vs "spawn ENOENT"，所有 network_error 一视同仁重试（spawn ENOENT 也试 3 次浪费 4s，可接受）
- ❌ 不加可配置重试次数 / 间隔——hardcoded 3/2s 够用
- ❌ 不持久化"本次会话"标记——刷新页面后所有 socketState.logs 都按 DB 拉回时设的 `isHistorical: true` 算"旧"

---

## 8. 版本号

v2.30.0。DB schema 不变。
