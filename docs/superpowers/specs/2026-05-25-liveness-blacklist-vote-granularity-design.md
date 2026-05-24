# v2.31.1 — 测活投票粒度细化 + 自动 rotate 设计

## 1. 背景

v2.31.0 给 `server/liveness/runner.js` 加了「dispatchOne 末尾按 alive_status 终态投票」机制：

- `network_error` / `proxy_error` → `recordBadAttempt(currentNode, 'main', 'liveness_<status>')`
- `plus` / `canceled` / `token_expired` / `login_fail` / `deactivated` → `recordGoodAttempt(currentNode, 'main')`

但实测发现：

1. **投票粒度太粗**：v2.30 retry loop 一个账户跑 3 次 attempt 都 net_error 时，末尾只投 **1 次** `recordBadAttempt`，所以 `failCount` 只 +1。`FAIL_THRESHOLD=3` 意味着需要 **3 个不同账户**都 net_error 才拉黑节点。
2. **拉黑后不自动 rotate**：`recordBadAttempt` 达到 threshold 后只是把 tag 加进 `badNodes` Map + 持久化 blacklist，但不调 `rotate()`。`currentNode` 一直指向已拉黑节点，后续账户继续踩坑——直到外部代码调用 `rotate()` 才会换。

直接现象：用户跑测活，多个账户连环 `curl: (35) Recv failure` (TLS reset)，黑名单逻辑没真正起作用。

## 2. 目标

- 同一账户在同节点 **3 次 attempt 全 net_error** → 立即拉黑该节点
- 拉黑后 `currentNode` 自动切到下一个非黑名单节点（双保险：proxy 模块内部 fire-and-forget + runner 显式 await）
- 不影响 v2.31.0 已有的 good vote（清 failCount）行为
- 不影响 `server/engine.js` / `server/chatgpt-checkout.js` 现有调用方——它们零改动也享受自动 rotate

## 3. 方案

### 3.1 `server/proxy/index.js` — recordBadAttempt 拉黑后自动 rotate

当前 `recordBadAttempt` 在 `next >= FAIL_THRESHOLD` 时仅 `_addToBlacklist` + 清 failCount。修改为达到 threshold 后**额外 fire-and-forget 触发 channel 对应的 rotate**：

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
    // v2.31.1: 拉黑后 fire-and-forget rotate，让 currentNode 立刻切到下一个非黑名单节点。
    // 现有 engine.js / chatgpt-checkout.js 调用方零改动也能受益；
    // liveness runner 另外有显式 await rotate 作为双保险（见 §3.2）。
    const doRotate = channel === 'jp' ? rotateJp : rotate;
    Promise.resolve().then(() => doRotate()).catch((e) => {
      console.log(`[Proxy] auto-rotate after blacklist failed: ${e?.message?.slice(0, 60)}`);
    });
    return { blacklisted: true, count: next };
  }
  return { blacklisted: false, count: next };
}
```

**保持现有签名** `(tag, channel, reason)` → `{blacklisted, count}` 返回值不变，外部调用方原有逻辑不变。

### 3.2 `server/liveness/runner.js` — retry loop 内每次 attempt 失败即刻投票 + 显式 await rotate

替换 `dispatchOne` 内当前的 retry loop：

```js
for (let attempt = 1; attempt <= NETWORK_RETRY_MAX; attempt++) {
  if (state.abortCtrl?.signal.aborted) return;
  result = await dispatchOnceInner(email, account, onLog, state.abortCtrl.signal);
  if (result.alive_status !== 'network_error') break;

  // v2.31.1: 每次 attempt net_error 立刻 vote。一个账户 3 次连环 net_error
  // 即可累加 failCount 到 3 拉黑当前节点。若 recordBadAttempt 返回
  // {blacklisted:true}，await rotate 切到下一个节点 —— attempt N+1 立即走新节点。
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

**关键不变式**：
- 每个 attempt 投票时 `getProxyMgr().getState().currentNode` 读取**当前节点**——attempt 1 之后内部 rotate fire-and-forget 完成、attempt 2 vote 时已可能读到新节点，信号正确归属。
- `reason` 串改为 `liveness_net_error_a${attempt}` （a1/a2/a3），便于追溯。

### 3.3 `server/liveness/runner.js` — dispatchOne 末尾 vote 块去 bad 留 good

当前 v2.31.0 末尾的 `if/else` 块（line 172-191）含 bad 分支与 good 分支。**bad 分支已搬到 retry loop 内**，末尾保留 good 分支并移除 bad：

```js
// v2.31.1: bad vote 已在 retry loop 内逐 attempt 投出，此处仅 good vote
// 负责终态非 net_error 时清空 failCount（mirrors v2.31.0 behavior）。
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
      // network_error / proxy_error / checking / unknown 都不到这；
      // network_error 已在 retry loop 内 vote bad，
      // proxy_error 也复用 retry loop 路径 —— 见 §4.2 边界。
    }
  }
} catch {}
```

### 3.4 边界与设计不变式

**§4.1 节点切换归属**：retry loop 第 N 个 attempt 的 vote 永远归属当前 attempt 进入时的 `getProxyMgr().getState().currentNode`。如果 attempt N-1 拉黑触发 rotate、attempt N 读到新节点，则 attempt N 的 vote 归新节点。这是设计意图。

**§4.2 `proxy_error` 路径**：当前 retry loop 仅在 `alive_status === 'network_error'` 时继续 retry。如果想让 `proxy_error` 也参与 retry + 投票，需要修改 break 条件——**本次不改**，保持 v2.30 retry 行为不变（YAGNI：proxy_error 是 sing-box 自己上报，不会在 retry 中翻盘）。`proxy_error` 走到末尾时也不投 bad（不在 good 分支白名单），就是不投。

**§4.3 双保险冗余**：runner.js 显式 `await pm.rotate?.()` 与 proxy.js 内部 fire-and-forget rotate 都会触发。两次 rotate 调用结果幂等：第一次推进 `rotationIndex`，第二次跳过黑名单又推进一次——可能跳过 1~2 个节点，无害。代价是 liveness 在拉黑边界比预期多换 1 个节点，可以接受。

**§4.4 不影响其它调用方**：`server/engine.js` 与 `server/chatgpt-checkout.js` 的 `recordBadAttempt` 调用签名 / 返回不变，但拉黑触发后会自动 rotate。这是设计意图——之前它们也希望拉黑后切换、只是依赖外部机制；现在自动化了。

**§4.5 abort 中途**：retry loop 内每次 vote 后才检查 abort？不——当前实现是 attempt 开始前检查 abort、attempt 末尾 vote 后才睡眠的开头检查 abort。投票本身是同步 Map 操作 + fire-and-forget Promise，不可中断也无需中断。

## 4. 测试覆盖

### 4.1 修改既有测试 `runner: terminal network_error calls recordBadAttempt`

旧期望：retry 3 次全 net_error 后末尾 vote bad 1 次。
新期望：retry loop 内每次 net_error 都 vote bad，共 3 次；reason 串 `liveness_net_error_a1` / `a2` / `a3`。

### 4.2 新增 `runner: blacklist mid-retry triggers explicit rotate`

mock proxyMgr：
- `getState().enabled = true`
- `recordBadAttempt` 返回 `{ blacklisted: true, count: 3 }` （模拟第 1 次 attempt 就达到 threshold，跨账户累计）
- `rotate` spy

期望：runner 收到 `blacklisted:true` 后 `await pm.rotate()` 至少 1 次。

### 4.3 新增 `proxy: recordBadAttempt at threshold triggers internal rotate`

直接 unit test `server/proxy/__tests__/proxy.test.js`（或新建 `recordBadAttempt.test.js`）：
- 注入或 mock `rotate` 函数（拿 `Object.defineProperty` 替换 module export 不易，可用一个 hook 接口或直接观察 `Promise.resolve().then(...)` 调用后的副作用）
- 触发 3 次 `recordBadAttempt(tag, 'main')` → 期望 `rotate` 被异步调度（用 setImmediate 等待一轮 microtask）

可行做法：把 `recordBadAttempt` 内部的 `Promise.resolve().then(() => doRotate())` 重构为读取 module 局部变量 `_autoRotateFn`，初始 = `rotate` / `rotateJp`，测试时可注入。

### 4.4 保留既有测试

- `runner: terminal plus calls recordGoodAttempt` — 不变
- `runner: proxy disabled skips vote` — 不变（loop 内 + 末尾 vote 都 gate enabled）

## 5. 文件清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/proxy/index.js` | `recordBadAttempt` 拉黑触发 fire-and-forget rotate；导出可注入 `_autoRotateFn` for tests | 修改 |
| `server/liveness/runner.js` | retry loop 内逐 attempt vote + 显式 await rotate；末尾 vote 块去 bad 留 good | 修改 |
| `server/liveness/__tests__/runner.test.js` | 改 1 测试 + 加 1 测试 | 修改 |
| `server/proxy/__tests__/recordBadAttempt.test.js` | 新建 / 或扩展已有 proxy.test.js | 新建/修改 |
| `docs/CHANGELOG.md` | v2.31.1 节 | 修改 |

## 6. YAGNI / 不做的

- 不改 `proxy_error` 的 retry 行为（保持 v2.30 break 条件）
- 不改 `server/engine.js` / `server/chatgpt-checkout.js` 任何代码
- 不暴露 rotate 配置（同步 vs fire-and-forget 写死 fire-and-forget）
- 不改 FAIL_THRESHOLD（保持 3）

## 7. 版本

v2.31.1（patch over v2.31.0）— hotfix for blacklist vote granularity.
