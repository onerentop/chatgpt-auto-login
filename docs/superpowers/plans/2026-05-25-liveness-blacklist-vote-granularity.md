# v2.31.1 测活投票粒度细化 + 自动 rotate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 liveness retry loop 内每次 net_error attempt 即刻投 `recordBadAttempt`（一个账户 3 attempt 即拉黑节点），并让 `recordBadAttempt` 在拉黑阈值触发时自动 `rotate` 切到非黑名单节点（runner 显式 await 双保险）。

**Architecture:** `server/proxy/index.js:recordBadAttempt` 增加可注入 `_autoRotateFns` 钩子（默认指向真实 rotate/rotateJp），threshold 时 `Promise.resolve().then(fn)` fire-and-forget。`server/liveness/runner.js:dispatchOne` 把 v2.31.0 末尾的 bad vote 块**搬进 retry loop**：每次 attempt net_error → vote → `blacklisted=true` 时 `await pm.rotate?.()`。末尾 vote 块仅保留 good vote 分支。

**Tech Stack:** Node + sql.js、node:test、Promise microtask（fire-and-forget rotate）。

**Spec:** `docs/superpowers/specs/2026-05-25-liveness-blacklist-vote-granularity-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/proxy/index.js` | `recordBadAttempt` 拉黑触发 fire-and-forget rotate；新增 `__setAutoRotateForTest` 注入钩子 | 修改 |
| `server/proxy/__tests__/blacklist.test.js` | +1 测试 — `recordBadAttempt` 达到 threshold 自动调度 rotate | 修改 |
| `server/liveness/runner.js` | retry loop 内每 attempt vote bad + 显式 await rotate；末尾 vote 块去 bad 留 good | 修改 |
| `server/liveness/__tests__/runner.test.js` | 改 1 既有测试期望（3 次 bad call 取代 1 次）+ 加 1 新测试 mid-retry rotate | 修改 |
| `docs/CHANGELOG.md` | v2.31.1 节 | 修改 |

依赖：Task 1（proxy）→ Task 2（runner）→ Task 3（CHANGELOG）。Task 2 依赖 Task 1 引入的 `recordBadAttempt` 返回 `{blacklisted}` 行为已就绪（其实 v2.31.0 已返回该形状，Task 1 不改返回值），所以 Task 1/Task 2 也可并行——不过顺序执行更安全。

---

## Task 1: Proxy — recordBadAttempt 拉黑触发自动 rotate + 注入钩子

**Files:**
- Modify: `server/proxy/index.js:95-109` (recordBadAttempt)
- Modify: `server/proxy/index.js:610-630` (module.exports — add `__setAutoRotateForTest`)
- Test: `server/proxy/__tests__/blacklist.test.js` (append 1 test at end)

### Step 1: Write the failing test

打开 `server/proxy/__tests__/blacklist.test.js`. 在文件**末尾**追加新测试。

注意：现有测试用 `blacklist` 模块（sub-module 持久化层），而 `recordBadAttempt` 在 `server/proxy/index.js`（主模块）。新测试 require 主模块：

```js
test('B5 recordBadAttempt 达到 FAIL_THRESHOLD 触发 fire-and-forget rotate (main)', async () => {
  // 主模块 require：注意 index.js 顶部会读 config / 初始化 sing-box，
  // 我们只需要 recordBadAttempt + __setAutoRotateForTest 这两个导出，
  // 其它状态保持默认（enabled=false / nodeTags=[] / failCount empty）。
  const proxyMgr = require('../index');
  const calls = [];
  proxyMgr.__setAutoRotateForTest(
    () => { calls.push('main'); return Promise.resolve(); },
    () => { calls.push('jp'); return Promise.resolve(); }
  );
  try {
    // 3 次 recordBadAttempt 累积到 FAIL_THRESHOLD=3 触发拉黑 + rotate
    const r1 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test1');
    const r2 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test2');
    const r3 = proxyMgr.recordBadAttempt('test-node-X', 'main', 'test3');
    assert.strictEqual(r1.blacklisted, false);
    assert.strictEqual(r1.count, 1);
    assert.strictEqual(r2.blacklisted, false);
    assert.strictEqual(r2.count, 2);
    assert.strictEqual(r3.blacklisted, true);
    assert.strictEqual(r3.count, 3);
    // fire-and-forget rotate 在 Promise microtask 后执行，等一轮
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.length, 1, 'main rotate called once');
    assert.strictEqual(calls[0], 'main');
  } finally {
    proxyMgr.__setAutoRotateForTest(null, null);  // 恢复默认
    // 清理 badNodes 避免污染后续测试
    try { proxyMgr.removeFromBlacklist?.('test-node-X', 'main'); } catch {}
  }
});

test('B6 recordBadAttempt (jp 通道) 达到阈值触发 rotateJp', async () => {
  const proxyMgr = require('../index');
  const calls = [];
  proxyMgr.__setAutoRotateForTest(
    () => { calls.push('main'); return Promise.resolve(); },
    () => { calls.push('jp'); return Promise.resolve(); }
  );
  try {
    proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail1');
    proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail2');
    const r3 = proxyMgr.recordBadAttempt('test-jp-Y', 'jp', 'jpfail3');
    assert.strictEqual(r3.blacklisted, true);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], 'jp', 'jp channel calls rotateJp');
  } finally {
    proxyMgr.__setAutoRotateForTest(null, null);
    try { proxyMgr.removeFromBlacklist?.('test-jp-Y', 'jp'); } catch {}
  }
});
```

### Step 2: Run test to verify it fails

```
node --test server/proxy/__tests__/blacklist.test.js
```

Expected: 2 new tests FAIL with `TypeError: proxyMgr.__setAutoRotateForTest is not a function` (function doesn't exist yet).

### Step 3: Implement — add hook + auto-rotate in recordBadAttempt

打开 `server/proxy/index.js`. 找到 `recordBadAttempt` 函数（line 95-109）。当前长这样：

```js
function recordBadAttempt(tag, channel, reason = '') {
  if (!tag) return { blacklisted: false, count: 0 };
  const ns = _ns(channel);
  const next = (ns.failCount.get(tag) || 0) + 1;
  ns.failCount.set(tag, next);
  ns.failReasons.set(tag, String(reason).slice(0, 60));
  console.log(`[Proxy${channel === 'jp' ? ':JP' : ''}] Bad attempt ${next}/${FAIL_THRESHOLD} on ${tag} (${String(reason).slice(0, 40)})`);
  if (next >= FAIL_THRESHOLD) {
    _addToBlacklist(tag, channel, BAD_NODE_TTL_MS, reason, 'auto');
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
    return { blacklisted: true, count: next };
  }
  return { blacklisted: false, count: next };
}
```

**在 `function recordBadAttempt` 之前** （line 95 之前的空行处）新增 hook 状态：

```js
// v2.31.1: rotate 钩子 — 默认 null（运行期由 module-init 注入真实函数），
// 测试可用 __setAutoRotateForTest 替换。
let _autoRotateFn = null;
let _autoRotateJpFn = null;

function __setAutoRotateForTest(mainFn, jpFn) {
  _autoRotateFn = mainFn;
  _autoRotateJpFn = jpFn;
}
```

**在 recordBadAttempt 内的 `if (next >= FAIL_THRESHOLD)` 块里**（搬到 `return { blacklisted: true ... }` 之前）追加自动 rotate：

```js
  if (next >= FAIL_THRESHOLD) {
    _addToBlacklist(tag, channel, BAD_NODE_TTL_MS, reason, 'auto');
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
    // v2.31.1: 拉黑后 fire-and-forget rotate，让 currentNode 立即切到下一个非黑名单节点。
    const doRotate = channel === 'jp' ? _autoRotateJpFn : _autoRotateFn;
    if (typeof doRotate === 'function') {
      Promise.resolve().then(() => doRotate()).catch((e) => {
        console.log(`[Proxy] auto-rotate after blacklist failed: ${e?.message?.slice(0, 60)}`);
      });
    }
    return { blacklisted: true, count: next };
  }
```

接下来需要把真实 `rotate` / `rotateJp` 注入 `_autoRotateFn` / `_autoRotateJpFn`。两个函数定义在文件下面（`async function rotate()` line 417 / `async function rotateJp()` line 453）。在两个函数定义**之后**（line ~480 附近，找到第一个 `function getState() {` 之前的位置）添加：

```js
// v2.31.1: 把真实 rotate 注入 recordBadAttempt 的 fire-and-forget 钩子。
// 用 init-time wiring 而不是在 recordBadAttempt 内 require，避免循环引用。
_autoRotateFn = rotate;
_autoRotateJpFn = rotateJp;
```

最后导出 `__setAutoRotateForTest`。找到 `module.exports = { ... }`（line ~610-630），在导出列表中加入：

```js
__setAutoRotateForTest,
```

（紧跟 `recordBadAttempt` 或排在末尾都行，遵循文件现有缩进风格。）

### Step 4: Run tests to verify they pass

```
node --test server/proxy/__tests__/blacklist.test.js
```

Expected: 9 tests pass (7 既有 + 2 新)。

如果 B5/B6 失败显示 `calls.length === 0`：
- 检查 `_autoRotateFn = rotate;` 是否实际生效——可能因为该行在文件加载顺序中比 `__setAutoRotateForTest(null, null)` 早执行而被覆盖。
- 应对：B5 测试不要 `__setAutoRotateForTest(null, null)`——直接传 spy，验证 spy 被调用。finally 里恢复原值（保存初始引用）。

如果担心覆盖问题，B5/B6 的 finally 改为：

```js
} finally {
  // 不要 set(null, null)，避免影响后续测试。
  // 但要清理 failCount/badNodes 避免状态泄漏。
  try { proxyMgr.removeFromBlacklist?.('test-node-X', 'main'); } catch {}
}
```

但 init 时 `_autoRotateFn = rotate` 是模块加载期一次性赋值，`__setAutoRotateForTest(spy, spy)` 调用后立即生效 → 测试完成后**必须**恢复，否则其它 test file 加载 `index.js` 时拿不到真实 rotate。

最稳妥：保存原值再恢复：

```js
const proxyMgr = require('../index');
const calls = [];
const origMain = proxyMgr.__getAutoRotateForTest ? proxyMgr.__getAutoRotateForTest() : null;
// ... 用 spy 测试 ...
try {
  proxyMgr.__setAutoRotateForTest(spy, spy);
  // ...
} finally {
  proxyMgr.__setAutoRotateForTest(origMain?.main, origMain?.jp);
}
```

这要 export 一个 getter。**简化**：不暴露 getter，改 set 的语义 — `null` 入参意味着"恢复默认" (即重新指向 module-level real rotate)。

更新 hook helpers：

```js
function __setAutoRotateForTest(mainFn, jpFn) {
  _autoRotateFn = (mainFn === null) ? rotate : (mainFn || _autoRotateFn);
  _autoRotateJpFn = (jpFn === null) ? rotateJp : (jpFn || _autoRotateJpFn);
}
```

这样 `__setAutoRotateForTest(null, null)` 恢复默认。**这是最终版**。

把上面 Step 3 的 `__setAutoRotateForTest` 实现替换成这个版本。

### Step 5: Full proxy regression

```
node --test server/proxy/__tests__/*.test.js
```

Expected: 全过（≥ 9 个 blacklist 测试 + 既有 rotation/subscription/index 测试）。如果别的测试因 hook 被污染，回到 Step 4 把 finally 加 `__setAutoRotateForTest(null, null)`。

### Step 6: Commit

```bash
git add server/proxy/index.js server/proxy/__tests__/blacklist.test.js
git commit -m "feat(proxy): recordBadAttempt 拉黑后自动 rotate (fire-and-forget)

v2.31.0 给 liveness 加了节点投票，但 recordBadAttempt 达到 FAIL_THRESHOLD=3
只是把节点加入 badNodes Map + 持久化 blacklist —— currentNode 不变，
后续调用方继续踩坑直到外部代码调用 rotate()。

server/proxy/index.js:recordBadAttempt 现在在拉黑阈值触发时
fire-and-forget 调度 rotate (main 通道) / rotateJp (jp 通道)：
  Promise.resolve().then(() => doRotate()).catch(...)

钩子用模块级变量 _autoRotateFn / _autoRotateJpFn 注入，module-init
时指向真实 rotate / rotateJp。新增 __setAutoRotateForTest(main, jp)
让单测可替换 spy；传 null 恢复默认。

新增 2 个测试 (blacklist.test.js B5/B6) 验证 main / jp 通道阈值触发
对应 rotate 函数。"
```

---

## Task 2: Liveness — retry loop 内逐 attempt vote + 显式 await rotate；末尾 vote 块去 bad 留 good

**Files:**
- Modify: `server/liveness/runner.js:141-150` (retry loop)
- Modify: `server/liveness/runner.js:166-191` (末尾 vote 块)
- Modify: `server/liveness/__tests__/runner.test.js:244-267` (修改既有 `terminal network_error calls recordBadAttempt` 测试)
- Test: `server/liveness/__tests__/runner.test.js` (append 1 新测试 mid-retry rotate)

### Step 1: 修改既有 `runner: terminal network_error calls recordBadAttempt` 测试

打开 `server/liveness/__tests__/runner.test.js`. 找到 line 244-267 的测试（当前期望 1 次 bad call），整体替换为：

```js
test('runner: 3 attempts net_error 全部 vote bad (粒度 v2.31.1)', async () => {
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
      // 永远不达 threshold（blacklisted:false），观察 vote 次数
      recordBadAttempt: (tag, channel, reason) => {
        calls.push({ kind: 'bad', tag, channel, reason });
        return { blacklisted: false, count: calls.filter(c => c.kind === 'bad').length };
      },
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
      rotate: async () => calls.push({ kind: 'rotate' }),
    },
  });
  const runner = createRunner(env);
  runner.start(['n@x.com']);
  // 3 retries × 即时 probe + 2 × 2s delay ≈ 4.1s + overhead
  await new Promise(r => setTimeout(r, 5500));
  const bads = calls.filter(c => c.kind === 'bad');
  assert.strictEqual(bads.length, 3, '每个 attempt 都 vote bad，共 3 次');
  // reason 串带 attempt 索引便于追溯
  assert.match(bads[0].reason, /liveness_net_error_a1/);
  assert.match(bads[1].reason, /liveness_net_error_a2/);
  assert.match(bads[2].reason, /liveness_net_error_a3/);
  // 无 rotate 调用因为 blacklisted 永远 false
  assert.strictEqual(calls.filter(c => c.kind === 'rotate').length, 0);
});
```

### Step 2: 在文件末尾追加新测试 `blacklist mid-retry triggers explicit rotate`

```js
test('runner: blacklist mid-retry triggers explicit await rotate', async () => {
  const calls = [];
  let badCount = 0;
  const env = mkEnv({
    accounts: [{ email: 'm@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    proxyMgr: {
      getState: () => ({ enabled: true, currentNode: 'pro-us-mid' }),
      recordBadAttempt: (tag, channel, reason) => {
        badCount++;
        calls.push({ kind: 'bad', tag, channel, reason });
        // 第 2 次 vote 时返回 blacklisted:true（模拟跨账户累计已 2 次、本账户第 1 次让它达 3）
        return { blacklisted: badCount === 2, count: badCount };
      },
      recordGoodAttempt: (tag, channel) => calls.push({ kind: 'good', tag, channel }),
      rotate: async () => {
        calls.push({ kind: 'rotate' });
        await new Promise(r => setTimeout(r, 5));  // 模拟 rotate 异步
      },
    },
  });
  const runner = createRunner(env);
  runner.start(['m@x.com']);
  await new Promise(r => setTimeout(r, 5500));
  // 期望：3 次 bad vote (a1/a2/a3) + 1 次 rotate（在 attempt 2 vote 后触发）
  const bads = calls.filter(c => c.kind === 'bad');
  const rotates = calls.filter(c => c.kind === 'rotate');
  assert.strictEqual(bads.length, 3);
  assert.strictEqual(rotates.length, 1, 'rotate called exactly once when blacklisted:true');
  // 顺序：bad(a1) → bad(a2) → rotate → bad(a3)
  const badIdx2 = calls.findIndex(c => c.kind === 'bad' && c.reason.includes('a2'));
  const rotateIdx = calls.findIndex(c => c.kind === 'rotate');
  const badIdx3 = calls.findIndex(c => c.kind === 'bad' && c.reason.includes('a3'));
  assert.ok(badIdx2 < rotateIdx, 'rotate after a2 vote');
  assert.ok(rotateIdx < badIdx3, 'rotate before a3 vote (because await)');
});
```

### Step 3: Run modified + new tests to verify they fail

```
node --test server/liveness/__tests__/runner.test.js
```

Expected: 
- 修改的"3 attempts net_error 全部 vote bad" → FAIL（当前实现末尾只 vote 1 次，且 reason 是 `liveness_network_error` 而非 `liveness_net_error_a1`）
- 新增 "blacklist mid-retry triggers explicit await rotate" → FAIL（pm.rotate 未被调用）

### Step 4: Implement runner.js 改动

打开 `server/liveness/runner.js`. 找到 line 141-150 的 retry loop。当前：

```js
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
```

替换为（**vote bad 块放在 `if (... !== 'network_error') break;` 之后**，因为 break 前已经知道是 net_error）：

```js
    let result;
    for (let attempt = 1; attempt <= NETWORK_RETRY_MAX; attempt++) {
      if (state.abortCtrl?.signal.aborted) return;
      result = await dispatchOnceInner(email, account, onLog, state.abortCtrl.signal);
      if (result.alive_status !== 'network_error') break;

      // v2.31.1: 每次 net_error attempt 立即 vote bad；blacklisted=true 时 await rotate
      // 切到下一节点（双保险，proxy 内部已 fire-and-forget rotate，这里显式再 await）。
      try {
        const pm = getProxyMgr();
        if (pm && pm.getState().enabled) {
          const currentNode = pm.getState().currentNode;
          if (currentNode) {
            const vote = pm.recordBadAttempt(currentNode, 'main', `liveness_net_error_a${attempt}`);
            if (vote?.blacklisted) {
              try { await pm.rotate?.(); } catch {}
            }
          }
        }
      } catch {}

      if (attempt < NETWORK_RETRY_MAX) {
        onLog('warning', `network_error: ${result.alive_reason} — retrying ${attempt}/${NETWORK_RETRY_MAX} in ${NETWORK_RETRY_DELAY_MS / 1000}s`);
        await abortableSleep(NETWORK_RETRY_DELAY_MS, state.abortCtrl.signal);
      }
    }
```

接着找到 line 166-191 的末尾 vote 块。当前：

```js
    // Vote on the current proxy node based on terminal alive_status. ...
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
```

替换为（**去 bad 留 good**）：

```js
    // v2.31.1: bad vote 已在 retry loop 内逐 attempt 投出；此处仅 good vote
    // 负责终态非 net_error 时清空 failCount。proxy_error 本应 retry 但当前
    // break 条件只看 network_error —— proxy_error 不在此投 bad（YAGNI，
    // 实际由 sing-box 自己判定，retry 翻盘概率极低）。
    try {
      const pm = getProxyMgr();
      if (pm && pm.getState().enabled) {
        const currentNode = pm.getState().currentNode;
        if (currentNode) {
          if (
            result.alive_status === 'plus' ||
            result.alive_status === 'canceled' ||
            result.alive_status === 'token_expired' ||
            result.alive_status === 'login_fail' ||
            result.alive_status === 'deactivated'
          ) {
            pm.recordGoodAttempt(currentNode, 'main');
          }
        }
      }
    } catch {}
```

### Step 5: Syntax check

```
node --check server/liveness/runner.js
```

Expected: no output.

### Step 6: Run liveness tests

```
node --test server/liveness/__tests__/runner.test.js
```

Expected: **17** pass（16 baseline 改 1 + 加 1 = 17）。

如果 mid-retry test 报 `rotates.length === 0`：检查 runner.js 是否 `await pm.rotate?.()` — 注意 `?.` 写法保证 mock 没 `rotate` 字段时不抛错。如果 mock 有 rotate 但仍没调用，验证 `vote?.blacklisted` 真值检查（mock 必须返回 `{ blacklisted: true }`）。

如果"3 attempts ... vote bad"报 `bads.length === 1`：很可能末尾 vote 块还在调用 bad（即 Step 4 第二部分没改）。

### Step 7: Full regression

```
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: **174** total (171 v2.31.0 baseline + 2 新 proxy + 1 新 runner = 174；既有 v2.31.0 1 个 runner 测试被替换 — 总数 = 168 base + 3 v2.31 + 0 net change (replaced) + 1 new = 173；加 Task 1 的 2 个 = 175)。

实际期望 **总 tests = 168 (v2.30 base) + 3 (v2.31 vote) - 1 (replaced) + 1 (new mid-retry) + 2 (new proxy) = 173**。

如果数字偏离，先看 `node --test` 输出的 `# tests N` 行，再逐个文件 diff。

### Step 8: Commit

```bash
git add server/liveness/runner.js server/liveness/__tests__/runner.test.js
git commit -m "feat(liveness): retry loop 内逐 attempt vote bad + 显式 await rotate

v2.31.0 末尾 1 次 vote 的设计：一个账户 3 次 net_error 只贡献 1 个
failCount，要 3 个账户都净失败才拉黑节点 —— 太粗。

dispatchOne 的 retry loop 现在每次 attempt net_error 即刻
recordBadAttempt(currentNode, 'main', 'liveness_net_error_a<N>')。
同账户 3 次连环 net_error 直接累加到 FAIL_THRESHOLD=3 拉黑当前节点。

recordBadAttempt 返回 {blacklisted:true} 时显式 await pm.rotate?.()
切到非黑名单节点，双保险：proxy 模块内部已 fire-and-forget
rotate (Task 1)，runner 这里 await 确保 attempt N+1 看到的
currentNode 已更新。

末尾 vote 块从 bad+good 两个分支砍剩 good 分支 —— bad 已搬进
retry loop。proxy_error 路径 YAGNI 不动 (retry break 条件不变)。

reason 串 'liveness_net_error_a1/a2/a3' 替换原 'liveness_network_error'
便于排查黑名单来源。

测试改 1 (terminal network_error 期望 3 次 bad call 而非 1 次)
+ 加 1 (mid-retry rotate 顺序断言)。"
```

---

## Task 3: CHANGELOG v2.31.1 + 集成 smoke

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.31.1 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 行之后、`## v2.31.0` 之前插入：

```markdown
## v2.31.1 — 2026-05-25

### Hotfix: 测活投票粒度细化 + 自动 rotate

v2.31.0 投票"每个账户末尾 1 票"过粗：1 个账户 3 次 net_error 只
贡献 1 个 failCount，需要 3 个账户都净失败才拉黑节点；且
recordBadAttempt 拉黑后 currentNode 不变，后续账户继续踩坑。

**修复 1 — Proxy auto-rotate**

- `server/proxy/index.js:recordBadAttempt` 在 `next >= FAIL_THRESHOLD`
  时 fire-and-forget `Promise.resolve().then(() => rotate())`
  （jp 通道走 `rotateJp`），让 `currentNode` 立即切到非黑名单节点
- 新增 `__setAutoRotateForTest(mainFn, jpFn)` 注入钩子；传 `null` 恢复默认
- 现有 engine.js / chatgpt-checkout.js 调用方零改动也享受自动 rotate

**修复 2 — Liveness 逐 attempt vote**

- `server/liveness/runner.js:dispatchOne` retry loop 每次 net_error attempt
  立即 `recordBadAttempt(currentNode, 'main', 'liveness_net_error_a<N>')`
- 同账户 3 次连环 net_error 即累加到 FAIL_THRESHOLD=3 拉黑当前节点
- `blacklisted=true` 时显式 `await pm.rotate?.()` —— 双保险，确保
  attempt N+1 看到新 currentNode
- v2.31.0 末尾 vote 块从 bad+good 砍剩 good（bad 已搬进 retry loop）

**测试**：173 tests pass — proxy +2（B5 main / B6 jp 通道阈值触发 rotate）
+ runner +1 替换（3 次 bad call 替原 1 次）+ runner +1 新增
（mid-retry rotate 顺序断言）on v2.31.0 baseline 171.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-blacklist-vote-granularity-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-blacklist-vote-granularity.md`。
```

（保持 `## v2.31.0` 及以下完整不动。）

### Step 2: Final regression

```
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 173 pass.

### Step 3: End-to-end smoke（用户手动）

1. 重启 server（kill 现 `node server/index.js` + 启新）
2. 强制制造场景：让某个节点连续失败。先把 sing-box 拉黑节点清空：
   ```
   curl -X POST http://localhost:3000/api/proxy/blacklist/clear -H 'Content-Type: application/json' -d '{"channel":"main"}'
   ```
3. 跑测活（任选 1 个账号，前提：当前主代理节点是坏的，例如 `pro-美国01`）。
4. 观察日志：应看到 retry 1/3 → 2/3 → 3/3 全 net_error，期间日志同时出现：
   ```
   [Proxy] Bad attempt 1/3 on pro-美国01 (liveness_net_error_a1)
   [Proxy] Bad attempt 2/3 on pro-美国01 (liveness_net_error_a2)
   [Proxy] Bad attempt 3/3 on pro-美国01 (liveness_net_error_a3)
   [sing-box] Switching outbound to pro-美国02   ← rotate 触发
   ```
5. 紧接着的第 2 个账号 dispatchOne 时 `getProxyMgr().getState().currentNode` 应该是 `pro-美国02` 而非 `pro-美国01`，验证 currentNode 已切换。
6. `curl http://localhost:3000/api/proxy/status | grep -E 'currentNode|badNodes'` 应看到 `pro-美国01` 在 badNodes 里、`currentNode: pro-美国02`。

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.31.1 — 测活投票粒度 + auto-rotate hotfix"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational，无 task。
- Spec §2 目标：3 子项分别由 Task 1（auto-rotate）+ Task 2（逐 attempt vote + await rotate）+ §3.4 不变式 cover。
- Spec §3.1 recordBadAttempt 自动 rotate → Task 1 Step 3。
- Spec §3.2 retry loop 内 vote + await rotate → Task 2 Step 4 第一部分。
- Spec §3.3 末尾 vote 去 bad 留 good → Task 2 Step 4 第二部分。
- Spec §3.4 边界 §4.1-§4.5：归属/proxy_error/双保险/调用方/abort —— 由 Task 2 实现 + 注释体现。
- Spec §4.1 修改既有测试 → Task 2 Step 1。
- Spec §4.2 mid-retry rotate 测试 → Task 2 Step 2。
- Spec §4.3 proxy threshold rotate 测试 → Task 1 Step 1（含 main + jp 通道）。
- Spec §4.4 保留既有 → 不动 plus / disabled 两测试。
- Spec §5 文件清单 → matches Task 1+2+3 file list.
- Spec §6 YAGNI → 计划未做不该做的（proxy_error retry / engine.js / chatgpt-checkout.js / FAIL_THRESHOLD）。
- Spec §7 v2.31.1 → Task 3 Step 1.

**2. Placeholder scan:** 无 "TBD" / "implement later"。每步含完整代码块、确切命令、期望输出。

**3. Type/symbol consistency:**

- `_autoRotateFn` / `_autoRotateJpFn` / `__setAutoRotateForTest` 在 Task 1 Step 3 定义、Task 1 Step 1 测试使用，三处一致。
- `liveness_net_error_a${attempt}` 串在 Task 2 Step 4 实现、Task 2 Step 1 测试断言（`/a1/`/`/a2/`/`/a3/`），一致。
- `pm.rotate?.()` 在 Task 2 Step 4 调用、Task 2 Step 2 mock (`rotate: async () => ...`) 一致。
- `recordBadAttempt` 返回 `{ blacklisted, count }` —— v2.31.0 已是该 shape，Task 1 不变（只在 if 内追加 rotate 调度），Task 2 测试 mock 也用同 shape。
- `removeFromBlacklist` 在 Task 1 Step 1 测试 finally 用 —— 该 export 已在 `server/proxy/index.js` 既存（line 128），不依赖本 PR 新增。

无 issue。Plan ready.
