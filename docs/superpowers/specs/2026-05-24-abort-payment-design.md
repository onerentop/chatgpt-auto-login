# 支付阶段强行停止：AbortSignal 全栈改造

**日期：** 2026-05-24
**范围：** 两个 engine + `payment.js` + `payment-readiness.js` + `utils.js` + Web 状态显示
**目标：** 用户点"停止"后，无论当前正处在哪个支付子阶段，都能在 ~1 秒内中断 autoPayment 并把账号状态标为 'aborted'

---

## 1. 背景

当前 `protocol-engine.js` 和 `server/engine.js` 的 `stop()` 实现：
1. 设 `stopFlag = true`（boolean）
2. `_chromeProc.kill()` / `_browser.close()` / `_pyProc.kill()` / `_gw.cleanup()`
3. `status = 'idle'`

`stopFlag` 只在两个 engine 的**主 for-loop 各 stage 开头**检查。`autoPayment` 内部根本不检查 stopFlag。

`browser.close()` 触发后，所有 `page.locator` / `page.evaluate` / `page.goto` 会立即 reject ✓——但 **`setTimeout`-based 的 wait 不受影响**，仍要跑完。

### 阻塞点累计（最差路径）

| 阻塞点 | 位置 | 最差时长 |
|---|---|---|
| 各处 `randomDelay(...)` × 10+ | `payment.js` 各 handler | 30+ 秒累积 |
| SMS 轮询 30 × 3s | `payment.js::handleSmsVerification` | **90 秒** |
| `autoPayment` main loop 15 × 2-3s | `payment.js::autoPayment` | 45 秒 |
| Redirect wait 15 × 2s | `payment.js::autoPayment` 末段 | 30 秒 |
| `waitForCaptchaResolution` 人工等滑块 | `payment.js` | **90 秒** |
| `clickSubmit` 10 × 1s | `payment.js::clickSubmit` | 10 秒 |

**累加 ≈ 5 分钟。** UI 显示"已停止"后，background 仍在烧账号、打日志、可能继续推进付款。

---

## 2. 决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 修复方案 | **A：AbortSignal 全栈改造**（Node 标准、可扩展） |
| 账号状态码 | **独立状态 `'aborted'`**（中文显示「已停止」） |
| 后续重试逻辑 | aborted 不当 error 重试（与 error / no_link 区分） |

---

## 3. 架构

`AbortController` 在 engine 顶层管理取消信号，沿 call chain 一路下传到所有 sleep 点：

```
engine.start()
  ├─ this._abortController = new AbortController()
  └─ await autoPayment(page, config, { signal: this._abortController.signal })
       ├─ handleOpenAIPage / handlePayPalLogin / handlePayPalCheckout / handleSmsVerification
       │    └─ randomDelay(min, max, signal) → abortableSleep(ms, signal)
       └─ main loop / redirect wait / SMS polling / clickSubmit / waitForCaptchaResolution
            └─ 每轮开头 `if (signal?.aborted) throw abortError()`

engine.stop()
  ├─ this._abortController?.abort()  ← 所有 in-flight sleep 立即 reject AbortError
  ├─ (existing) _chromeProc.kill() / _browser.close() / _pyProc.kill() / _gw.cleanup()
  └─ status = 'idle'

  ⇒ autoPayment catch AbortError → return { success: false, status: 'aborted', reason: 'Stopped by user' }
  ⇒ engine catch → emitStatus({ status: 'aborted', reason: 'Stopped by user' }); summary.aborted++
```

---

## 4. 具体组件改动

### 4.1 `utils.js`

**新增 `abortableSleep`：**
```js
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      return reject(e);
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  });
}
```

**改造 `randomDelay`**（向后兼容；signal 是第 3 个可选参数）：
```js
async function randomDelay(min, max, signal) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return abortableSleep(ms, signal);
}
```

### 4.2 `payment.js`

**`autoPayment` 签名变更：**
```js
async function autoPayment(page, phoneConfig, opts = {}) {
  const signal = opts.signal;
  // ... main flow ...
}
```

**顶层 try/catch 把 AbortError 转结构化返回值：**
```js
async function autoPayment(page, phoneConfig, opts = {}) {
  try {
    return await _doAutoPayment(page, phoneConfig, opts);
  } catch (e) {
    if (e?.name === 'AbortError') {
      return { success: false, status: 'aborted', reason: 'Stopped by user' };
    }
    throw e;
  }
}
```

**所有 `randomDelay(a, b)` 调用** → `randomDelay(a, b, signal)`；signal 作为额外参数透传给 4 个 handler + clickSubmit + waitForCaptchaResolution。

**所有裸 `setTimeout`-based wait** → `abortableSleep(ms, signal)`。

**长 for-loop（main loop / redirect wait / SMS polling / clickSubmit / waitForCaptchaResolution）每轮开头检查：**
```js
if (signal?.aborted) {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  throw e;
}
```

**catch 块识别 AbortError 直接 re-throw**（不当 sentinel/network 错误处理，不进 retry 分支）。

### 4.3 `payment-readiness.js`

`waitForPageReady(page, profile, opts)` 的 `opts` 加 `signal`：
```js
async function waitForPageReady(page, profile, opts = {}) {
  const signal = opts.signal;
  // ... 顶部加：
  if (signal?.aborted) {
    return { ready: false, waitedMs: 0, missing: ['aborted'] };
  }
  // 把 signal 传给 elementCheck 和 waitForDomStable
}
```

**abort 时短路返回** `{ ready: false, missing: ['aborted'] }`——不再等内部 Promise 解析。原 `Promise.all([domStable, elementPromises])` 改为 `Promise.race([原 Promise.all, abortPromise])`：abort 时 abortPromise 先 reject，整个 waitForPageReady 立即返回。

### 4.4 `protocol-engine.js` / `server/engine.js`

**构造函数加 field：**
```js
this._abortController = null;
```

**`start()` 顶部初始化：**
```js
this._abortController = new AbortController();
```

**调 `autoPayment` 时传 signal：**
```js
const payResult = await autoPayment(page, { phone, smsApiUrl, email }, { signal: this._abortController.signal }) || {};
```

**`stop()` 现有 kill 之外加：**
```js
this._abortController?.abort();
```

**catch 识别 'aborted' 状态：**
```js
if (payResult.status === 'aborted') {
  this.emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
  summary.aborted = (summary.aborted || 0) + 1;
  continue;
}
```

**主 for-loop 现有 `if (this.stopFlag) break` 保留作双保险。**

### 4.5 Web 端

**`web/src/status.js`：**
```js
// statusLabel
case 'aborted': return '已停止';
// statusType
case 'aborted': return 'info';
```

**`web/src/views/Execute.vue` 状态筛选下拉加：**
```vue
<el-option label="已停止" value="aborted" />
```

### 4.6 测试

新建 `__tests__/abortable-sleep.test.js`，3 个单元测试：

```js
test('abortableSleep: 时间到自然 resolve', async () => {
  const t0 = Date.now();
  await abortableSleep(100);
  assert.ok(Date.now() - t0 >= 95);
});

test('abortableSleep: signal 已 aborted → 立即 reject AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(abortableSleep(5000, ac.signal), e => e.name === 'AbortError');
});

test('abortableSleep: abort 期间触发 → reject AbortError + clearTimeout 已调用', async () => {
  const ac = new AbortController();
  const p = abortableSleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 200, 'should not wait the full 5000ms');
});
```

不写 engine 集成测试——靠手工 dry-run 验证（运行一个账号 → 进入支付 → 点 stop → 看 ~1 秒内 UI 状态变 aborted）。

---

## 5. 错误处理

- `autoPayment` 顶层 try/catch 把 AbortError 转 `{ success: false, status: 'aborted', reason: 'Stopped by user' }` —— 调用方拿到结构化结果，不需要处理 raw throw
- `payment.js` 内部所有 catch 块识别 `e?.name === 'AbortError'` → re-throw（不进 retry / fallback 分支，不进 sentinel-token 路径）
- engine 的 outer `catch (e)` 也加 `if (e?.name === 'AbortError')` 分支，避免把 abort 错当成真 error
- abort 时**不**调 `proxyMgr.markBad`（节点没问题，是用户主动停的）

---

## 6. 完成判定

- ✅ 3 个 abortableSleep 单元测试 pass
- ✅ 现有 28 个 Node tests 不回归
- ✅ Python syntax check
- ✅ JS syntax check（两个 engine + payment.js + payment-readiness.js）
- ✅ 手工 dry-run：跑一个账号 → 进入 autoPayment（任意子阶段：waitForPageReady / SMS polling / redirect wait 都可）→ 点 stop → UI **1 秒内**显示"已停止"，server 日志不再出现新的 [Pay] 行
- ✅ Web 状态筛选下拉新增"已停止" option，能筛出 aborted 账号

---

## 7. 非目标

- **不改 `protocol_register.py`** —— Python 侧 sync HTTP 已经被 `py.kill()` 同步杀掉，足够快
- **不改 `chatgpt_register/sentinel_quickjs.py`** —— Node 子进程 SIGTERM 会被父 engine kill
- **不重写 `_RetrySession` retry 循环** —— 不在支付阶段（在 register 阶段）
- **不改 `chatgpt-checkout.js`（Phase 2 fetchCheckoutLink）** —— 它是 Python 子进程，已经被 60s timer + py.kill() 覆盖；如果未来需要，可作为后续 ticket
- **不实现 aborted 自动重试** —— 用户主动停的，下次执行如果想重跑应该走"重试失败"按钮（但失败按钮目前只匹配 `'error'` status——可在后续 ticket 加上 'aborted' 同样可重试）

---

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `utils.js` | 新增 `abortableSleep` 导出；`randomDelay` 第 3 参数 signal |
| `payment.js` | `autoPayment` opts.signal；4 个 handler + clickSubmit + waitForCaptchaResolution 接 signal；所有 randomDelay / 裸 setTimeout 改 abort-aware；3 处 for-loop 每轮加 signal check；顶层 try/catch 返回 status='aborted' |
| `payment-readiness.js` | `waitForPageReady` opts.signal；abort 短路返回 `{ ready: false, missing: ['aborted'] }` |
| `protocol-engine.js` | `_abortController` field；start 初始化；stop 调 abort；autoPayment 传 signal；catch 识别 'aborted' |
| `server/engine.js` | 同 protocol-engine.js |
| `web/src/status.js` | `'aborted'` label/type |
| `web/src/views/Execute.vue` | 状态筛选下拉加"已停止" |
| `__tests__/abortable-sleep.test.js` | **新建**，3 个单元测试 |
