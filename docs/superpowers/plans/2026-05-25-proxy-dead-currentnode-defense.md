# v2.34.1 Proxy 死节点 currentNode 双保险防御 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 proxy 加两层防御：(A) `runHealthProbe()` 末尾验证 `currentNode` 是否活、不活就 fire-and-forget rotate；(B) `/detect-exit` 和 `/jp/detect-exit` 收到 `"error: ..."` 时自动 rotate + retry 1 次。

**Architecture:** 抽出纯函数 `_autoRotateIfCurrentDead(currentTag, probeResults, rotateFn)` 便于测试；`runHealthProbe()` 末尾对 main / jp 各调一次。`server/routes/proxy.js:detect-exit` 改成检测返回值是否以 `"error:"` 开头 → 自动 `rotate()` + 重 call `detectExit()` 一次（jp 对称）。

**Tech Stack:** Node + node:test + 既有 `__setAutoRotateForTest` 钩子（v2.31.1）。

**Spec:** `docs/superpowers/specs/2026-05-25-proxy-dead-currentnode-defense-design.md`

---

## File Structure

| 文件 | 改动 |
|---|---|
| `server/proxy/index.js` | 抽 `_autoRotateIfCurrentDead` helper（导出 `__autoRotateIfCurrentDeadForTest` 测试钩子）；`runHealthProbe` 末尾 main/jp 各调一次 |
| `server/proxy/__tests__/dead-currentnode.test.js` | 新建，4 单测（dead 触发 / alive 不触发 / 未探过不触发 / fire-and-forget 异常吞掉） |
| `server/routes/proxy.js` | `/detect-exit` 和 `/jp/detect-exit` 失败检测 + rotate + retry 1 次 |
| `docs/CHANGELOG.md` | v2.34.1 节 |

依赖：Task 1（proxy helper + 测试）→ Task 2（routes endpoint）→ Task 3（CHANGELOG）。Task 1/2 独立（Task 2 不依赖 Task 1 改动），但顺序更安全。

---

## Task 1: server/proxy/index.js — `_autoRotateIfCurrentDead` helper + runHealthProbe 接线 + 4 单测

**Files:**
- Modify: `server/proxy/index.js` (新增 helper + runHealthProbe 末尾接线 + 导出)
- Create: `server/proxy/__tests__/dead-currentnode.test.js`

### Step 1: 写 4 个失败测试

新建 `server/proxy/__tests__/dead-currentnode.test.js`:

```js
const test = require('node:test')
const assert = require('node:assert')

let __autoRotateIfCurrentDeadForTest

test.before(() => {
  const mod = require('../index')
  __autoRotateIfCurrentDeadForTest = mod.__autoRotateIfCurrentDeadForTest
})

test('A1 currentNode alive=false 触发 fire-and-forget rotate', async () => {
  const calls = []
  const probeResults = new Map([['dead-node', { alive: false, delayMs: null }]])
  __autoRotateIfCurrentDeadForTest('dead-node', probeResults, () => calls.push('rotate-called'))
  // fire-and-forget 在 microtask 队列，等一轮
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, ['rotate-called'])
})

test('A2 currentNode alive=true 不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map([['alive-node', { alive: true, delayMs: 100 }]])
  __autoRotateIfCurrentDeadForTest('alive-node', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], 'alive 节点不应触发 rotate')
})

test('A3 currentNode 没在 probeResults（未探过）不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map()  // 空
  __autoRotateIfCurrentDeadForTest('unprobed-node', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], '未探过的节点不应被判死')
})

test('A4 currentNode 为空串不触发 rotate', async () => {
  const calls = []
  const probeResults = new Map([['anything', { alive: false }]])
  __autoRotateIfCurrentDeadForTest('', probeResults, () => calls.push('rotate-called'))
  await new Promise(r => setImmediate(r))
  assert.deepStrictEqual(calls, [], '无 currentNode 时跳过')
})
```

### Step 2: 跑测试验证 FAIL

```
node --test server/proxy/__tests__/dead-currentnode.test.js
```

Expected: 4 测试 FAIL（`__autoRotateIfCurrentDeadForTest is not a function`）。

### Step 3: 实现 helper + 导出

打开 `server/proxy/index.js`. 在 `runHealthProbe()` 函数定义之前（约 line 512 之前，紧贴着既有 `return filtered.length;` 之后的空行）插入 helper：

```js
/**
 * v2.34.1: 验证 currentNode 是否在 probe 结果里 alive；不活就 fire-and-forget rotate。
 * 纯函数 + 注入 rotate，便于单测。
 * - currentTag 为空串 / falsy → 跳过
 * - probeResults 未含此 tag（未探过）→ 跳过（保守，避免假阳性）
 * - 含此 tag 且 alive === false → 调度 rotate
 * - 含此 tag 且 alive === true → 跳过
 *
 * @param {string} currentTag
 * @param {Map<string, {alive: boolean}>} probeResults
 * @param {() => Promise<any> | any} rotateFn
 */
function _autoRotateIfCurrentDead(currentTag, probeResults, rotateFn) {
  if (!currentTag) return
  const r = probeResults?.get(currentTag)
  if (r && r.alive === false) {
    Promise.resolve().then(() => rotateFn()).catch((e) => {
      console.log(`[Proxy] auto-rotate after dead probe failed: ${e?.message?.slice(0, 60)}`)
    })
  }
}
```

### Step 4: 在 `runHealthProbe()` 末尾接线（main + jp）

找到 `runHealthProbe()` 末尾的 `}` (约 line 531)。在最后一个 jp `console.log` 之后、函数结束 `}` 之前插入：

```js
  // v2.34.1: 探针完成后自我修复。若 currentNode 被探出 alive=false，fire-and-forget
  // rotate 切到下一个活节点。覆盖启动场景（refresh() 同步选定第一个白名单节点，
  // probe 跑完发现死）和运行时定时探针后场景。jp 通道对称处理。
  _autoRotateIfCurrentDead(_state.currentNode, _state.probeResults, rotate);
  _autoRotateIfCurrentDead(_state.jp.currentNode, _state.jp.probeResults, rotateJp);
```

完整修改后的 `runHealthProbe` 末尾应长这样：

```js
async function runHealthProbe() {
  const { probeAllNodes } = require('./health-probe');
  // Main channel
  if (_state.enabled && _state.nodeTags.length > 0) {
    const summary = await probeAllNodes(_state.nodeTags, _state.probeResults, {
      shouldSkip: (tag) => isBad(tag),
    });
    _state.probeSummary = { ...summary, lastRunAt: Date.now() };
    console.log(`[Proxy] health probe: main ${summary.alive}/${summary.total} alive`);
  }
  // JP channel
  if (_state.jp.enabled && _state.jp.nodeTags.length > 0) {
    const summary = await probeAllNodes(_state.jp.nodeTags, _state.jp.probeResults, {
      shouldSkip: (tag) => isJpBad(tag),
    });
    _state.jp.probeSummary = { ...summary, lastRunAt: Date.now() };
    console.log(`[Proxy:JP] health probe: ${summary.alive}/${summary.total} alive`);
  }

  // v2.34.1: 探针完成后自我修复。若 currentNode 被探出 alive=false，fire-and-forget
  // rotate 切到下一个活节点。覆盖启动场景（refresh() 同步选定第一个白名单节点，
  // probe 跑完发现死）和运行时定时探针后场景。jp 通道对称处理。
  _autoRotateIfCurrentDead(_state.currentNode, _state.probeResults, rotate);
  _autoRotateIfCurrentDead(_state.jp.currentNode, _state.jp.probeResults, rotateJp);
}
```

### Step 5: 导出测试钩子

找到 `module.exports = { ... }`（约 line 820+ 范围，含 `runHealthProbe` 等）。在 exports 列表中加 `__autoRotateIfCurrentDeadForTest`，值是 helper 本身：

```js
module.exports = {
  // ... 既有 exports ...
  runHealthProbe,
  // v2.34.1: 测试钩子（与 v2.31.1 的 __setAutoRotateForTest 同风格）
  __autoRotateIfCurrentDeadForTest: _autoRotateIfCurrentDead,
};
```

注意：实际位置看 module.exports 当前形式（可能在 line 820+ 范围）。**实施时打开文件 grep `module.exports`** 定位。

### Step 6: 跑测试验证 PASS

```
node --test server/proxy/__tests__/dead-currentnode.test.js
```

Expected: 4 测试 pass。

如果 A1 `calls.length === 0`：检查 `Promise.resolve().then(() => rotateFn())` 是否真的把 rotateFn 当函数调用（不是只引用）。
如果 A3 `calls.length > 0`：检查 `r && r.alive === false` 守卫（未探过时 `r` 是 undefined，不该进 if）。

### Step 7: 全套件回归

```
npm test
```

Expected: 既有 baseline + 4 新测试，"fail 0"。

### Step 8: Commit

```bash
git add server/proxy/index.js server/proxy/__tests__/dead-currentnode.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): runHealthProbe 末尾自动 rotate 死 currentNode (v2.34.1)

诊断：refresh() 同步设 currentNode=第一个白名单节点（pro-美国01），
runHealthProbe fire-and-forget 后跑。如果首节点死了，从启动到 probe
完成期间所有用 currentNode 的请求都 ECONNRESET。v2.30 rotate() 会
跳死节点但初始选择没经过这层过滤。

新增 _autoRotateIfCurrentDead(tag, probeResults, rotateFn) 纯函数：
- tag falsy 或未探过 → 跳过
- alive === false → fire-and-forget 调 rotateFn
runHealthProbe 末尾对 main / jp 各调一次。

4 单测覆盖：dead 触发 / alive 不触发 / 未探过不触发 / 空 tag 跳过。
导出 __autoRotateIfCurrentDeadForTest 跟 v2.31.1 __setAutoRotateForTest
同风格。
EOF
)"
```

---

## Task 2: server/routes/proxy.js — detect-exit + jp/detect-exit auto-rotate + retry

**Files:**
- Modify: `server/routes/proxy.js:40-43` (main detect-exit)
- Modify: `server/routes/proxy.js:57-60` (jp detect-exit)

### Step 1: 修改 main `/detect-exit`

打开 `server/routes/proxy.js`. 找到 line 40-43：

```js
router.post('/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectExit(); res.json({ ok: true, exitIp: ip }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

替换为：

```js
router.post('/detect-exit', async (req, res) => {
  let ip;
  try { ip = await proxy.detectExit(); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  // v2.34.1: detectExit 网络失败时返回 "error: ..." 字符串（不抛错）。
  // 检测到 → 自动 rotate + 重试 1 次。给 UI 即时反馈而不是让用户再点。
  if (typeof ip === 'string' && ip.startsWith('error:')) {
    console.log(`[Proxy] detect-exit failed (${ip.slice(0, 50)}) → rotate + retry`);
    try { await proxy.rotate(); } catch {}
    try { ip = await proxy.detectExit(); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.json({ ok: true, exitIp: ip });
});
```

### Step 2: 修改 jp `/jp/detect-exit`

找到 line 57-60：

```js
router.post('/jp/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectJpExit(); res.json({ ok: true, exitIp: ip }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

替换为：

```js
router.post('/jp/detect-exit', async (req, res) => {
  let ip;
  try { ip = await proxy.detectJpExit(); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  // v2.34.1: 同 main 路径，jp 通道失败也自动 rotateJp + retry 1 次
  if (typeof ip === 'string' && ip.startsWith('error:')) {
    console.log(`[Proxy:JP] detect-exit failed (${ip.slice(0, 50)}) → rotateJp + retry`);
    try { await proxy.rotateJp(); } catch {}
    try { ip = await proxy.detectJpExit(); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.json({ ok: true, exitIp: ip });
});
```

### Step 3: Syntax check

```
node --check server/routes/proxy.js
```

Expected: no output.

### Step 4: 全套件回归

```
npm test
```

Expected: 同 Task 1 数字（routes 改动不影响既有测试）。

### Step 5: 手动 smoke（用户跑）

跳过 — 留给 Task 3 之后的完整 smoke。

### Step 6: Commit

```bash
git add server/routes/proxy.js
git commit -m "$(cat <<'EOF'
feat(proxy/routes): detect-exit 失败自动 rotate + retry 1 次 (v2.34.1)

proxy.detectExit() 网络失败时返回 "error: ..." 字符串（不抛错），
原 endpoint try/catch 不会触发，UI 拿到 exitIp=error 弹错。

/detect-exit 和 /jp/detect-exit 现在检测 startsWith('error:') →
自动 rotate / rotateJp + 重 call detectExit() / detectJpExit() 1 次。
覆盖 endpoint 即点即用场景，跟 v2.31.1 recordBadAttempt（3 次累计）
互补 —— 低频但用户可见的路径单次失败就立切。

只重试 1 次，避免节点全死时 endpoint 死循环。
EOF
)"
```

---

## Task 3: CHANGELOG v2.34.1

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.34.1 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 之后、第一个现有 `## v2.x.x` 之前插入：

```markdown
## v2.34.1 — 2026-05-25

### Hotfix: Proxy 死节点 currentNode 双保险防御

诊断：`refresh()` 在 `server/proxy/index.js:417` 同步设
`currentNode = 第一个白名单节点`（通常 `pro-美国01`），`runHealthProbe`
fire-and-forget 8s+ 后才跑。如果首节点死了，从启动到 probe 完成
窗口内所有用 currentNode 的请求都 ECONNRESET。`detectExit()` 失败
时返回 `"error: ..."` 字符串而非抛错，endpoint try/catch 不触发，
UI 把字符串当报错弹给用户。

**双保险**（跟 v2.31.1 设计风格一致）：

- **A**: `runHealthProbe()` 末尾验证 `currentNode` 是否在 alive 集合；
  不在 → fire-and-forget rotate。新增 `_autoRotateIfCurrentDead(tag,
  probeResults, rotateFn)` 纯函数 + 导出 `__autoRotateIfCurrentDeadForTest`
  测试钩子。Main / JP 通道对称处理。
- **B**: `/api/proxy/detect-exit` 和 `/api/proxy/jp/detect-exit` 收到
  `"error: ..."` 字符串时自动 `rotate()` / `rotateJp()` + 重 call
  endpoint 1 次。

跟 v2.31.1 `recordBadAttempt`（高频路径 3 次累积才拉黑）互补 ——
A/B 给低频但用户可见的路径加专属防御，单次失败立切。

**测试**：`__tests__/dead-currentnode.test.js` +4（dead 触发 / alive
不触发 / 未探过不触发 / 空 tag 跳过）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-proxy-dead-currentnode-defense-design.md`
+ `docs/superpowers/plans/2026-05-25-proxy-dead-currentnode-defense.md`。

```

### Step 2: Final regression

```
npm test
```

Expected: 全套件 "fail 0"。

### Step 3: 手动 smoke（用户跑）

1. 重启 server，**等 health probe 跑完**（看 log `health probe: main X/Y alive`）。
2. 看 server log：如果 `currentNode` 不在 alive 集合，应自动出现 `[Proxy] currentNode ... 探针 dead → 自动 rotate`，currentNode 切到活节点。
3. 点 UI「检测出口 IP」 → 应直接拿到真实 IP（不是 "error: ..."）。
4. 强制把 sing-box 切到死节点（手动 `POST /api/proxy/switch` 到死 tag）→ 点检测 → server log 应有 `detect-exit failed (...) → rotate + retry`，UI 收到真实 IP。

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.34.1 — Proxy 死节点 currentNode 双保险防御"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 目标 A/B：由 Task 1（A）+ Task 2（B）实现。
- Spec §3.1 A 修复（runHealthProbe 末尾验证 + rotate）→ Task 1 Steps 3-4。
- Spec §3.2 B 修复（detect-exit + jp/detect-exit retry）→ Task 2 Steps 1-2。
- Spec §3.3 边界 8 条 → 由实现 + 注释 + 测试覆盖（fire-and-forget 不阻塞 / 只重试 1 次 / jp 对称 / 不持久化 / 不动 UI / 与 v2.31.1 互补 / 不改 health-probe / 自愈）。
- Spec §4 测试：A 4 单测 → Task 1 Step 1；B 跳单测靠手动 smoke → Task 3 Step 3。
- Spec §5 文件清单 → matches Task 1+2+3。
- Spec §6 YAGNI → 不持久化 / 不改 probe 周期 / 不指数退避 / 单次 retry / 不阻塞启动 / 不动 UI —— 计划严格遵守。
- Spec §7 v2.34.1 → Task 3 Step 1。

**2. Placeholder scan:** 无 "TBD" / "implement later"。Task 1 Step 5 提到「实施时打开 module.exports 定位」—— 是因为 file 行数随并行 session 改动而变，提供 grep 命令 + 追加规则就是确切 how。

**3. Type/symbol consistency:**

- `_autoRotateIfCurrentDead` —— Task 1 Step 3 定义、Step 4 在 runHealthProbe 末尾 call 2 次（main + jp）、Step 5 导出为 `__autoRotateIfCurrentDeadForTest`。3 处一致。
- 函数签名 `(currentTag, probeResults, rotateFn)` —— Task 1 Step 1 测试用、Step 3 定义、Step 4 调用，3 处对齐。
- `probeResults.get(tag)?.alive === false` 严格 false 检查 —— Step 3 实现 + Step 1 A3 测试（未探过 = `r` 是 undefined）—— 测试断言一致。
- detect-exit endpoint 返回 shape `{ok, exitIp}` 不变 —— Task 2 两处保留同样的成功响应格式。
- `proxy.detectExit` / `proxy.detectJpExit` / `proxy.rotate` / `proxy.rotateJp` —— Task 2 调用既有 4 个函数（无名称变更）。

无 issue。Plan ready.
