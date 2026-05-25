# v2.34.1 — Proxy 死节点 currentNode 双保险防御设计

## 1. 背景

v2.30 给 `server/proxy/` 加了主动健康探测 + `rotate()` 时按 `probeResults` 跳过死节点。但有两个**时序**漏洞：

1. **初始 currentNode 不看 probe**：`refresh()` 在 `server/proxy/index.js:417` **同步**设 `currentNode = filtered[rotationIndex]`（第一个白名单节点，默认 `pro-美国01`）。`runHealthProbe()` 在 line 505 **fire-and-forget** 启动，8 秒以上才完成。如果第一个白名单节点死了（例如订阅刚推但节点真的失效），从启动到 probe 完成之间所有用 `currentNode` 的请求都会撞 ECONNRESET。
2. **detect-exit endpoint 不抛错，返回值带毒**：`server/proxy/index.js:detectExit()` 网络失败时把 `"error: read ECONNRESET"` 这种字符串写入 `_state.exitIp` 并直接 return（line 739）。但 `server/routes/proxy.js:40` 的 try/catch 不会触发（没抛错），endpoint 直接回 `{ok:true, exitIp:"error: ..."}`，前端 UI 拿这个当报错弹出来。用户体验差。

v2.31.1 给执行/测活路径的高频请求加了 `recordBadAttempt` → fire-and-forget rotate，需要累积 3 次 fail 才拉黑节点。但 **detect-exit / startup 是用户可见的低频路径**，单次失败就要让用户看到错误，等不到第 3 次累积。

## 2. 目标

双保险防御（与 v2.31.1 设计风格一致）：

- **A 修复**：`runHealthProbe()` 完成后立刻验证 `currentNode` 是否在 alive 集合；不在 → fire-and-forget rotate。覆盖**启动场景** + **运行时定时刷探针后的场景**。
- **B 修复**：`/api/proxy/detect-exit` 和 `/api/proxy/jp/detect-exit` 收到 `"error: ..."` 形式的失败值时，自动 rotate + 重试 1 次。覆盖 **endpoint 即点即用** 场景，给用户即时反馈而非"再点一次"。

## 3. 方案

### 3.1 修复 A —— `runHealthProbe()` 末尾自动 rotate

打开 `server/proxy/index.js`. 找到 `runHealthProbe()` 函数（约 line 480-510 区域）。在 probe 完成后（写入 `_state.probeResults` 之后），插入：

```js
// v2.34.1: 探针完成后自我修复 —— 若 currentNode 在 probe 结果里 alive=false，
// fire-and-forget rotate 到下一个活节点。覆盖以下场景：
//   - 启动：refresh() 同步选定第一个白名单节点（probe 没跑过），probe 跑完
//     发现是死节点 → 自动切换
//   - 运行：定时探针重跑后，原 currentNode 中途死亡 → 自动切换
// jp 通道同处理。fire-and-forget 避免 probe 函数本身被 rotate 的 await 阻塞。
try {
  const mainNode = _state.currentNode
  if (mainNode) {
    const r = _state.probeResults.get(mainNode)
    if (r && r.alive === false) {
      console.log(`[Proxy] currentNode ${mainNode} 探针 dead → 自动 rotate`)
      Promise.resolve().then(() => rotate()).catch((e) => {
        console.log(`[Proxy] auto-rotate after dead probe failed: ${e?.message?.slice(0, 60)}`)
      })
    }
  }
} catch {}

try {
  const jpNode = _state.jp.currentNode
  if (jpNode) {
    const r = _state.jp.probeResults.get(jpNode)
    if (r && r.alive === false) {
      console.log(`[Proxy:JP] currentNode ${jpNode} 探针 dead → 自动 rotateJp`)
      Promise.resolve().then(() => rotateJp()).catch((e) => {
        console.log(`[Proxy:JP] auto-rotate after dead probe failed: ${e?.message?.slice(0, 60)}`)
      })
    }
  }
} catch {}
```

`probeResults` 字段 shape 来自 `server/proxy/health-probe.js`（约 line 54-59）：`Map<tag, { alive: bool, delayMs, lastTested, reason? }>`。检查 `r && r.alive === false`（严格 false，排除 undefined 的"未探过"情况）。

### 3.2 修复 B —— `detect-exit` 失败自动 rotate + retry

打开 `server/routes/proxy.js`. 找到 line 40-43（main detect-exit）和 line 57 附近（jp detect-exit）。

**Main**：

```js
router.post('/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectExit(); res.json({ ok: true, exitIp: ip }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
```

改为：

```js
router.post('/detect-exit', async (req, res) => {
  let ip
  try { ip = await proxy.detectExit() } catch (e) { return res.status(500).json({ error: e.message }) }
  // v2.34.1: detectExit 网络失败时返回 "error: ..." 字符串（不抛错），
  // 这里检测到 → 自动 rotate + 重试 1 次。给 UI 即时反馈而不是让用户再点。
  if (typeof ip === 'string' && ip.startsWith('error:')) {
    console.log(`[Proxy] detect-exit failed (${ip.slice(0, 50)}) → rotate + retry`)
    try { await proxy.rotate() } catch {}
    try { ip = await proxy.detectExit() } catch (e) { return res.status(500).json({ error: e.message }) }
  }
  res.json({ ok: true, exitIp: ip })
})
```

**JP**：找到 `/jp/detect-exit` endpoint。同样的改法，用 `proxy.detectJpExit()` + `proxy.rotateJp()`。如果 jp endpoint 当前没有 try/catch 防御层（仅返回值），用同样的"return value sniff + retry"模式：

```js
router.post('/jp/detect-exit', async (req, res) => {
  let ip
  try { ip = await proxy.detectJpExit() } catch (e) { return res.status(500).json({ error: e.message }) }
  if (typeof ip === 'string' && ip.startsWith('error:')) {
    console.log(`[Proxy:JP] detect-exit failed (${ip.slice(0, 50)}) → rotateJp + retry`)
    try { await proxy.rotateJp() } catch {}
    try { ip = await proxy.detectJpExit() } catch (e) { return res.status(500).json({ error: e.message }) }
  }
  res.json({ ok: true, exitIp: ip })
})
```

**注意**：`proxy.detectJpExit()` 函数名是假设；实施时打开 server/routes/proxy.js 看实际既有 jp endpoint 用哪个 method（可能就是 `detectExit('jp')` 或类似）。

### 3.3 边界 / 不变式

- **§3.3.1 不阻塞启动**：A 仍是 fire-and-forget；refresh() 本身不 await probe 完成。启动横幅 / `/api/health` 在 probe 跑完前的窗口期 currentNode 仍可能指向死节点，但用户**只能**通过 detect-exit 等 endpoint 触达，而 B 修复给了 endpoint 自愈能力。
- **§3.3.2 不无限循环**：B 只重试 1 次。如果 rotate 后还失败，原样返回 `"error: ..."`（让 UI 用户感知）。避免节点全死时 endpoint 永久 hang。
- **§3.3.3 v2.31.1 互补**：v2.31.1 `recordBadAttempt` 服务高频路径（执行 / 测活），需要累积 3 次 fail 才拉黑 + rotate。A/B 给低频但用户可见的路径（startup / detect-exit）加专属防御 —— 单次失败立刻切换。两者各管一摊不冲突。
- **§3.3.4 不改 health-probe.js**：A 只在 `runHealthProbe()` 末尾加 hook，probe 内部算法 / 周期 / 并发不变。
- **§3.3.5 jp 与 main 对称处理**：两个通道独立各自验证，互不影响。
- **§3.3.6 不持久化**：probeResults 仍 in-memory，跟 v2.30 一致。
- **§3.3.7 fire-and-forget 风险**：A 在 probe 完成后调度 rotate，rotate 内部又**调** clashApi 切 selector + 写 _state.currentNode。如果 rotate 失败（网络抖动），catch 吞了，下次 probe 再来一遍 —— 自愈。
- **§3.3.8 不动 UI**：v2.34.1 是后端 hotfix；UI 拿到的 detect-exit 响应 shape 不变（`{ok, exitIp}`），只是 exitIp 更可能是真 IP 而不是 "error: ..."。

## 4. 测试

### 4.1 修复 A —— 2 单测

`server/proxy/__tests__/dead-currentnode.test.js`（新建）或扩展既有 health-probe.test.js（如有）：

```js
const test = require('node:test')
const assert = require('node:assert')

test('A1 探针完成 currentNode dead 触发 rotate', async () => {
  const proxyMgr = require('../index')
  const calls = []
  // 注入 main rotate spy（用 v2.31.1 既有钩子）
  proxyMgr.__setAutoRotateForTest(
    () => { calls.push('main'); return Promise.resolve() },
    () => { calls.push('jp'); return Promise.resolve() }
  )
  try {
    // 模拟探针写入 dead 结果 + 调用末尾的验证逻辑
    // 具体 setup 需 access _state；可暴露 __setStateForTest 或在 helper 里 mock
    // ... 实施时按 health-probe.test.js 既有模式
    // 期望：calls 含 'main' 且不含 'jp'（仅 main currentNode dead）
  } finally {
    proxyMgr.__setAutoRotateForTest(null, null)
  }
})

test('A2 探针完成所有节点 alive 不触发 rotate', async () => {
  // 同上，但 probeResults 所有 alive=true → calls 应为 []
})
```

**注意**：A 测试需访问 `_state` 内部 — 如果当前没有 `__setStateForTest` 类钩子，简单做法是把 A 的"验证 + rotate 调度"逻辑抽到一个**导出的纯函数** `validateCurrentNodeAlive(state, rotateFn, rotateJpFn)`，单测它。**实施时择简方案**。

### 4.2 修复 B —— 跳单测，依赖手动 smoke

B 的 endpoint glue 逻辑简单（typeof string + startsWith + rotate + 重 call），抽 helper 单测得不偿失。**手动 smoke**：
- 制造死节点 currentNode（如本次发现的场景：sing-box 启动后 pro-美国01 死）
- 点 UI「检测出口 IP」→ 应自动 rotate 后给出真实 IP（而不是 "error: ..."）
- server log 应有 `[Proxy] detect-exit failed (...) → rotate + retry`

## 5. 文件清单

| 文件 | 改动 |
|---|---|
| `server/proxy/index.js` | `runHealthProbe()` 末尾加 currentNode 死检测 + fire-and-forget rotate（main + jp） |
| `server/routes/proxy.js` | `/detect-exit` 和 `/jp/detect-exit` 失败后 rotate + retry 1 次 |
| `server/proxy/__tests__/dead-currentnode.test.js`（新建） | +2 单测（A1 / A2） |
| `docs/CHANGELOG.md` | v2.34.1 节 |

后端 only。无前端改动。

## 6. YAGNI / 不做的

- 不持久化死节点统计（v2.31.1 recordBadAttempt 已够用）
- 不改 health probe 周期 / 并发度
- 不为 retry 加指数退避（单次足够）
- 不在 detect-exit 加 N 次重试（只 1 次）
- 不为 currentNode 加"启动时 await probe 完成再选"路径（会增加 8s+ 启动延迟，划不来）
- 不动 UI（端口的响应 shape 不变）

## 7. 版本

v2.34.1 — patch over v2.34.0 (本次特性 + 并行 session 的 v2.34 前端重设计已 ship)。避免与并行 session 的 v2.35.x 前端任务流碰撞。
