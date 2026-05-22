# Checkout via JP-KDDI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `chatgpt.com/backend-api/payments/checkout` 调用确定性走日本 KDDI 住宅 IP（通过新增第二个 sing-box mixed inbound :7891 + 专用 selector），同时不影响主代理 (7890) 在注册/PayPal/RT 刷新等其它流程的行为。

**Architecture:** 单 sing-box 进程双 inbound，第二入口 :7891 路由到 `jp-checkout` selector（仅 KDDI 节点）；Node 侧 `chatgpt-checkout.js` 把 proxy 字段从 `getProxyUrl()` 切到 `getJpProxyUrl() || getProxyUrl()`；JP 池为空或端口冲突时软失败、主代理不受影响。

**Tech Stack:** Node 22+ (内置 `node:test`)、sing-box 1.10.7 (`route.rules[].inbound` 支持)、curl_cffi (`checkout_link.py` 不动)、Vue 3 + Element Plus (Config.vue 添只读卡片)。

---

## File Structure

**新建**：
- `server/proxy/__tests__/subscription.test.js` — `filterByJpKddi` 单测
- `server/proxy/__tests__/index.test.js` — `buildSingboxConfig` + `_state.jp` 行为单测
- `docs/CHANGELOG.md` — v2.18.0 条目

**修改**：
- `server/proxy/subscription.js` — 新增 `filterByJpKddi(outbounds, keyword)` + 导出
- `server/proxy/index.js` — `_state.jp` 子结构、双入口配置构建、新增 `getJpProxyUrl/getJpState/rotateJp/detectJpExit/markJpBad`，`refresh()` 软失败 + 端口冲突降级
- `server/chatgpt-checkout.js` — `proxy: proxyMgr.getJpProxyUrl() || proxyMgr.getProxyUrl()`，无 JP 时 raw 附 warn
- `server/routes/proxy.js` — `/status` 响应原样透传（getState 已含 jp 字段）、新增 `/jp/rotate`、`/jp/detect-exit`、`/jp/mark-bad`
- `web/src/views/Config.vue` — `form.proxyJpEnabled` / `form.proxyJpKeyword` 字段；只读 JP 状态卡片

**不动**：
- `checkout_link.py`
- `server/proxy/singbox.js`、`server/proxy/clash-api.js`
- `server/engine.js`、`server/protocol-engine.js`、`server/discord-gateway.js`

---

## Task 1: filterByJpKddi 实现与单测

**Files:**
- Modify: `server/proxy/subscription.js`
- Create: `server/proxy/__tests__/subscription.test.js`

- [ ] **Step 1: 写失败测试 — `server/proxy/__tests__/subscription.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { filterByJpKddi } = require('../subscription');

test('filterByJpKddi: 匹配 tag 包含 KDDI (case-insensitive)', () => {
  const input = [
    { tag: 'jp-KDDI-01' },
    { tag: 'US-LA' },
    { tag: 'kddi住宅' },
    { tag: 'JP-Tokyo' },
  ];
  const out = filterByJpKddi(input);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'jp-KDDI-01');
  assert.strictEqual(out[1].tag, 'kddi住宅');
});

test('filterByJpKddi: 无匹配返回空数组', () => {
  const input = [{ tag: 'US-LA' }, { tag: 'HK-01' }];
  assert.deepStrictEqual(filterByJpKddi(input), []);
});

test('filterByJpKddi: 空输入返回空数组', () => {
  assert.deepStrictEqual(filterByJpKddi([]), []);
});

test('filterByJpKddi: 自定义 keyword', () => {
  const input = [{ tag: 'JP-Tokyo-home' }, { tag: 'US-LA' }];
  const out = filterByJpKddi(input, 'home');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'JP-Tokyo-home');
});

test('filterByJpKddi: keyword 含正则元字符不爆炸', () => {
  const input = [{ tag: 'a.b' }, { tag: 'ab' }];
  const out = filterByJpKddi(input, 'a.b');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'a.b');
});
```

- [ ] **Step 2: 跑测试验证 RED**

Run: `node --test server/proxy/__tests__/subscription.test.js`
Expected: FAIL with `filterByJpKddi is not a function` 或类似 import 错误

- [ ] **Step 3: 在 subscription.js 加 `filterByJpKddi`**

在 `server/proxy/subscription.js` 文件末尾（`module.exports` 之前）插入：

```js
function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function filterByJpKddi(outbounds, keyword = 'KDDI') {
  if (!Array.isArray(outbounds) || outbounds.length === 0) return [];
  const re = new RegExp(escapeRegex(keyword), 'i');
  return outbounds.filter(o => re.test(o.tag || ''));
}
```

然后修改最后一行的 `module.exports`：

```js
module.exports = { fetchAndParse, filterByRegion, filterByJpKddi, US_PATTERNS };
```

- [ ] **Step 4: 跑测试验证 GREEN**

Run: `node --test server/proxy/__tests__/subscription.test.js`
Expected: PASS (5 tests passed)

- [ ] **Step 5: Commit**

```bash
git add server/proxy/subscription.js server/proxy/__tests__/subscription.test.js
git commit -m "feat(proxy): add filterByJpKddi for residential JP node selection"
```

---

## Task 2: 导出 buildSingboxConfig 准备改造

把 `buildSingboxConfig` 从闭包内函数变成可测试导出。这是机械重构，先做后改。

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 在 server/proxy/index.js 把 buildSingboxConfig 加进 module.exports**

找到文件末尾的 `module.exports = { ... }`，把 `buildSingboxConfig` 加进去：

```js
module.exports = {
  getState,
  refresh,
  stop,
  rotate,
  switchTo,
  markBad,
  isBad,
  detectExit,
  getProxyUrl,
  buildSingboxConfig,        // ← 新增
  SELECTOR_TAG,
  HTTP_PORT,
  CLASH_API_PORT,
};
```

- [ ] **Step 2: 启动 server 冒烟验证未破坏现状**

Run: `node server/index.js` (Ctrl-C 退出)
Expected: 启动成功，无报错（不需要真启代理，只确认 require 仍然正常）

- [ ] **Step 3: Commit**

```bash
git add server/proxy/index.js
git commit -m "refactor(proxy): export buildSingboxConfig for unit testing"
```

---

## Task 3: 扩展 _state 增加 jp 子结构与常量

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 在 server/proxy/index.js 顶部常量区加 JP 相关常量**

找到现有常量区：

```js
const SELECTOR_TAG = 'auto-rotate';
const HTTP_PORT = 7890;
const CLASH_API_PORT = 9090;
```

紧随其后加入：

```js
const JP_HTTP_PORT = 7891;
const JP_SELECTOR_TAG = 'jp-checkout';
const JP_DEFAULT_KEYWORD = 'KDDI';
```

- [ ] **Step 2: 扩展 `_state` 加 `jp` 子对象**

找到 `let _state = { ... };`，在 `badNodes: new Map(),` 之后、闭合 `};` 之前加：

```js
  jp: {
    enabled: false,
    keyword: JP_DEFAULT_KEYWORD,
    outbounds: [],
    nodeTags: [],
    currentNode: '',
    rotationStrategy: 'sequential',
    rotationIndex: 0,
    badNodes: new Map(),
    exitIp: '',
    lastError: '',
  },
```

- [ ] **Step 3: 在 `getState()` 函数里附带序列化 jp.badNodes**

找到现有 `getState()` 函数，把它替换为：

```js
function getState() {
  const now = Date.now();
  const badNodes = {};
  for (const [tag, expiry] of _state.badNodes.entries()) {
    if (expiry > now) badNodes[tag] = expiry;
    else _state.badNodes.delete(tag);
  }
  const jpBadNodes = {};
  for (const [tag, expiry] of _state.jp.badNodes.entries()) {
    if (expiry > now) jpBadNodes[tag] = expiry;
    else _state.jp.badNodes.delete(tag);
  }
  return {
    ..._state,
    available: _state.nodeTags.length,
    badNodes,
    jp: {
      ..._state.jp,
      available: _state.jp.nodeTags.length,
      badNodes: jpBadNodes,
    },
  };
}
```

- [ ] **Step 4: 启动 server，确认 `/api/proxy/status` 返回 jp 字段**

Run: 启动 server 后 `curl http://localhost:<port>/api/proxy/status` (端口看 server/index.js)
Expected: 响应里含 `jp: { enabled: false, keyword: 'KDDI', available: 0, ... }`

- [ ] **Step 5: Commit**

```bash
git add server/proxy/index.js
git commit -m "feat(proxy): add _state.jp sub-structure and constants for JP-checkout channel"
```

---

## Task 4: buildSingboxConfig 改造为双入口 + 单测

**Files:**
- Modify: `server/proxy/index.js`
- Create: `server/proxy/__tests__/index.test.js`

- [ ] **Step 1: 写失败测试 — `server/proxy/__tests__/index.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const proxy = require('../index');

test('buildSingboxConfig: 仅 US 池时只有一个 inbound', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }, { type: 'shadowsocks', tag: 'us-2' }];
  const cfg = proxy.buildSingboxConfig(us, null);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.inbounds[0].listen_port, 7890);
  assert.strictEqual(cfg.route.rules.length, 0);
  assert.strictEqual(cfg.route.final, 'auto-rotate');
  const selectorTags = cfg.outbounds.filter(o => o.type === 'selector').map(o => o.tag);
  assert.deepStrictEqual(selectorTags, ['auto-rotate']);
});

test('buildSingboxConfig: us + jp 池有两个 inbound + 路由规则', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const jp = [{ type: 'shadowsocks', tag: 'jp-KDDI-01' }];
  const cfg = proxy.buildSingboxConfig(us, jp);
  assert.strictEqual(cfg.inbounds.length, 2);
  assert.strictEqual(cfg.inbounds[1].tag, 'in-jp');
  assert.strictEqual(cfg.inbounds[1].listen_port, 7891);
  assert.strictEqual(cfg.route.rules.length, 1);
  assert.deepStrictEqual(cfg.route.rules[0], { inbound: 'in-jp', outbound: 'jp-checkout' });
  const selectorTags = cfg.outbounds.filter(o => o.type === 'selector').map(o => o.tag);
  assert.deepStrictEqual(selectorTags, ['auto-rotate', 'jp-checkout']);
  const jpSelector = cfg.outbounds.find(o => o.tag === 'jp-checkout');
  assert.deepStrictEqual(jpSelector.outbounds, ['jp-KDDI-01']);
  assert.strictEqual(jpSelector.default, 'jp-KDDI-01');
});

test('buildSingboxConfig: jp 数组为空数组时视为无 JP（不加 inbound）', () => {
  const us = [{ type: 'shadowsocks', tag: 'us-1' }];
  const cfg = proxy.buildSingboxConfig(us, []);
  assert.strictEqual(cfg.inbounds.length, 1);
  assert.strictEqual(cfg.route.rules.length, 0);
});

test('buildSingboxConfig: outbounds 含 direct + block 兜底', () => {
  const cfg = proxy.buildSingboxConfig([{ type: 'shadowsocks', tag: 'us-1' }], null);
  const tags = cfg.outbounds.map(o => o.tag);
  assert.ok(tags.includes('direct'));
  assert.ok(tags.includes('block'));
});
```

- [ ] **Step 2: 跑测试验证 RED**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: FAIL（第二个 test 失败，因为当前 buildSingboxConfig 只接受一个参数）

- [ ] **Step 3: 改造 `buildSingboxConfig`**

把 `server/proxy/index.js` 里的 `buildSingboxConfig` 函数整体替换为：

```js
function buildSingboxConfig(us, jp /* nullable */) {
  const inbounds = [
    { type: 'mixed', tag: 'in-mixed', listen: '127.0.0.1', listen_port: HTTP_PORT, sniff: true },
  ];
  const outbounds = [
    { type: 'selector', tag: SELECTOR_TAG, outbounds: us.map(o => o.tag), default: us[0]?.tag },
    ...us,
  ];
  const rules = [];

  if (Array.isArray(jp) && jp.length > 0) {
    inbounds.push({ type: 'mixed', tag: 'in-jp', listen: '127.0.0.1', listen_port: JP_HTTP_PORT, sniff: true });
    outbounds.push({ type: 'selector', tag: JP_SELECTOR_TAG, outbounds: jp.map(o => o.tag), default: jp[0].tag });
    outbounds.push(...jp);
    rules.push({ inbound: 'in-jp', outbound: JP_SELECTOR_TAG });
  }

  outbounds.push({ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' });

  return {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${CLASH_API_PORT}`,
        default_mode: 'rule',
      },
    },
    route: {
      final: SELECTOR_TAG,
      rules,
    },
  };
}
```

- [ ] **Step 4: 跑测试验证 GREEN**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: PASS (4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add server/proxy/index.js server/proxy/__tests__/index.test.js
git commit -m "feat(proxy): buildSingboxConfig supports dual-inbound (7890 main + 7891 jp-checkout)"
```

---

## Task 5: refresh() 加 JP 过滤与软失败

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 在文件顶部 import 区加 `filterByJpKddi`**

找到：

```js
const { fetchAndParse, filterByRegion } = require('./subscription');
```

改为：

```js
const { fetchAndParse, filterByRegion, filterByJpKddi } = require('./subscription');
```

- [ ] **Step 2: 改造 `refresh()` 加 JP 过滤**

把 `refresh()` 函数整体替换为：

```js
async function refresh() {
  const cfg = readCfg().proxy || {};
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter || 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';

  const jpCfg = cfg.jpCheckout || {};
  const jpEnabledByConfig = jpCfg.enabled !== false;
  _state.jp.keyword = jpCfg.keyword || JP_DEFAULT_KEYWORD;
  _state.jp.rotationStrategy = jpCfg.rotationStrategy || 'sequential';

  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  const filtered = filterByRegion(all, _state.rotationKeyword);
  console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
  if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);

  let jpFiltered = [];
  if (jpEnabledByConfig) {
    jpFiltered = filterByJpKddi(all, _state.jp.keyword);
    console.log(`[Proxy] JP-KDDI filter (keyword=${_state.jp.keyword}): ${jpFiltered.length}`);
  } else {
    console.log(`[Proxy] JP-Checkout channel disabled by config`);
  }

  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  _state.rotationIndex = 0;

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  _state.jp.rotationIndex = 0;
  _state.jp.currentNode = jpFiltered[0]?.tag || '';
  _state.jp.enabled = false;
  _state.jp.lastError = '';
  if (!jpEnabledByConfig) {
    _state.jp.lastError = 'JP 通道已被 config.jpCheckout.enabled=false 禁用';
  } else if (jpFiltered.length === 0) {
    _state.jp.lastError = `订阅中未找到关键字 "${_state.jp.keyword}" 的节点`;
  }

  const useJp = jpEnabledByConfig && jpFiltered.length > 0;
  const sbConfig = buildSingboxConfig(filtered, useJp ? jpFiltered : null);

  try {
    await singbox.start(sbConfig);
    _state.jp.enabled = useJp;
  } catch (err) {
    if (useJp && /7891|address already in use|bind/i.test(err.message || '')) {
      console.log(`[Proxy] 7891 端口被占用或绑定失败，降级关闭 JP 通道: ${err.message}`);
      _state.jp.enabled = false;
      _state.jp.lastError = `端口 7891 被占用，JP 通道已禁用: ${(err.message || '').slice(0, 120)}`;
      const fallbackConfig = buildSingboxConfig(filtered, null);
      await singbox.start(fallbackConfig);
    } else {
      throw err;
    }
  }

  _state.enabled = true;
  _state.currentNode = filtered[0].tag;
  _state.lastError = '';
  console.log(`[Proxy] sing-box running: main=:${HTTP_PORT}(${filtered.length}) jp=${_state.jp.enabled ? `:${JP_HTTP_PORT}(${jpFiltered.length})` : 'disabled'}`);
  return filtered.length;
}
```

- [ ] **Step 3: 手工验证 — 用真订阅启动**

Run: `node server/index.js`，前端触发 `应用并启动代理`，看 console 输出
Expected: 出现 `[Proxy] JP-KDDI filter (keyword=KDDI): N` 且 N>=1；`sing-box running: main=:7890(N) jp=:7891(M)`

- [ ] **Step 4: 手工验证 — config 改 `jpCheckout.enabled=false` 时的软禁用**

修改 `config.json` 的 `proxy.jpCheckout.enabled` 为 `false`，重启代理
Expected: `[Proxy] JP-Checkout channel disabled by config`；getState().jp.enabled===false；getState().jp.lastError 含 "被 config.jpCheckout.enabled=false 禁用"

- [ ] **Step 5: 手工验证 — keyword 改成不存在的关键字**

把 `jpCheckout.enabled` 改回 `true`，把 `jpCheckout.keyword` 设为 `"NotExistKeyword"`
Expected: `JP-KDDI filter (...) : 0`；getState().jp.enabled===false；lastError 含 "未找到关键字"；主代理仍正常启动

- [ ] **Step 6: Commit**

```bash
git add server/proxy/index.js
git commit -m "feat(proxy): refresh() filters KDDI nodes and soft-fails when JP pool empty"
```

---

## Task 6: 新增 getJpProxyUrl / rotateJp / detectJpExit / markJpBad

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 在 `getProxyUrl` 下方加 `getJpProxyUrl` 与 `markJpBad`/`isJpBad`**

找到 `function getProxyUrl()`，在它下方加：

```js
function getJpProxyUrl() {
  return _state.jp.enabled ? `http://127.0.0.1:${JP_HTTP_PORT}` : '';
}

function isJpBad(tag) {
  const expiry = _state.jp.badNodes.get(tag);
  if (!expiry) return false;
  if (Date.now() > expiry) { _state.jp.badNodes.delete(tag); return false; }
  return true;
}

function markJpBad(tag, ttlMs = BAD_NODE_TTL_MS) {
  if (!tag) return;
  _state.jp.badNodes.set(tag, Date.now() + ttlMs);
  console.log(`[Proxy:JP] Marked bad: ${tag} (TTL ${Math.round(ttlMs / 60000)}min)`);
}
```

- [ ] **Step 2: 在 `rotate()` 下方加 `rotateJp()`**

```js
async function rotateJp() {
  if (!_state.jp.enabled || _state.jp.nodeTags.length === 0) throw new Error('JP 通道未启用');

  let nextTag = null;
  for (let i = 0; i < _state.jp.nodeTags.length; i++) {
    let candidate;
    if (_state.jp.rotationStrategy === 'random') {
      candidate = _state.jp.nodeTags[Math.floor(Math.random() * _state.jp.nodeTags.length)];
    } else {
      _state.jp.rotationIndex = (_state.jp.rotationIndex + 1) % _state.jp.nodeTags.length;
      candidate = _state.jp.nodeTags[_state.jp.rotationIndex];
    }
    if (!isJpBad(candidate)) { nextTag = candidate; break; }
  }

  if (!nextTag) {
    console.log(`[Proxy:JP] All ${_state.jp.nodeTags.length} KDDI nodes are blacklisted; clearing and rotating fresh`);
    _state.jp.badNodes.clear();
    if (_state.jp.rotationStrategy === 'random') {
      nextTag = _state.jp.nodeTags[Math.floor(Math.random() * _state.jp.nodeTags.length)];
    } else {
      _state.jp.rotationIndex = (_state.jp.rotationIndex + 1) % _state.jp.nodeTags.length;
      nextTag = _state.jp.nodeTags[_state.jp.rotationIndex];
    }
  }

  await clashApi.switchSelector(JP_SELECTOR_TAG, nextTag);
  _state.jp.currentNode = nextTag;
  return nextTag;
}
```

- [ ] **Step 3: 在 `detectExit()` 下方加 `detectJpExit()`**

```js
async function detectJpExit() {
  if (!_state.jp.enabled) return '';
  try {
    const net = require('net');
    const tls = require('tls');
    const host = 'api.ipify.org';
    const exitIp = await new Promise((resolve, reject) => {
      const sock = net.connect(JP_HTTP_PORT, '127.0.0.1', () => {
        sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      });
      let preamble = '';
      sock.once('error', reject);
      sock.setTimeout(15000, () => { sock.destroy(new Error('timeout')); });
      sock.on('data', function onData(chunk) {
        preamble += chunk.toString('binary');
        const headerEnd = preamble.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        sock.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(preamble)) {
          return reject(new Error(`CONNECT failed: ${preamble.split('\r\n')[0]}`));
        }
        const tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
          tlsSock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`);
        });
        let resp = '';
        tlsSock.on('data', c => resp += c.toString('utf-8'));
        tlsSock.on('end', () => {
          const bodyIdx = resp.indexOf('\r\n\r\n');
          const body = bodyIdx > -1 ? resp.slice(bodyIdx + 4).trim() : resp.trim();
          const m = body.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          resolve(m ? m[1] : body.slice(0, 60));
        });
        tlsSock.on('error', reject);
      });
    });
    _state.jp.exitIp = exitIp;
    return exitIp;
  } catch (e) {
    _state.jp.exitIp = `error: ${(e.message || '').slice(0, 60)}`;
    return _state.jp.exitIp;
  }
}
```

- [ ] **Step 4: 在 `module.exports` 加入新导出**

把现有 module.exports 的列表扩展为：

```js
module.exports = {
  getState,
  refresh,
  stop,
  rotate,
  switchTo,
  markBad,
  isBad,
  detectExit,
  getProxyUrl,
  buildSingboxConfig,
  // JP-Checkout channel
  getJpProxyUrl,
  rotateJp,
  detectJpExit,
  markJpBad,
  isJpBad,
  // constants
  SELECTOR_TAG,
  JP_SELECTOR_TAG,
  HTTP_PORT,
  JP_HTTP_PORT,
  CLASH_API_PORT,
};
```

- [ ] **Step 5: 启动 server，手工验证 JP 出口探测**

启动后通过浏览器（或 curl）触发：
```
curl -X POST http://localhost:<port>/api/proxy/jp/detect-exit   (路由要等 Task 8 加上)
```
或直接在 server 端起个临时 REPL 测试：
```
node -e "(async()=>{const p=require('./server/proxy'); const ip=await p.detectJpExit(); console.log('JP exit IP:', ip);})()"
```
**注意此 step 仅在 sing-box 已经运行（JP 入口已起）时有意义。** 如果暂时跑不通跳过这一步，等 Task 8 路由加好后做 T2。

- [ ] **Step 6: Commit**

```bash
git add server/proxy/index.js
git commit -m "feat(proxy): add getJpProxyUrl / rotateJp / detectJpExit / markJpBad helpers"
```

---

## Task 7: chatgpt-checkout.js 切到 JP 入口

**Files:**
- Modify: `server/chatgpt-checkout.js`

- [ ] **Step 1: 把 spawn 之前的 proxy 选择改为 JP 优先**

找到 `chatgpt-checkout.js` 里 `const input = JSON.stringify({` 这一段。**整段**改为：

```js
    const jpUrl = proxyMgr.getJpProxyUrl();
    const mainUrl = proxyMgr.getProxyUrl();
    const proxy = jpUrl || mainUrl;
    const usingJp = !!jpUrl;
    const currentJpNode = usingJp ? (proxyMgr.getState().jp?.currentNode || '') : '';

    const input = JSON.stringify({
      access_token: accessToken,
      country: opts.country || 'JP',
      currency: opts.currency || 'JPY',
      promo_id: opts.promoCampaignId || 'plus-1-month-free',
      proxy,
    });
```

- [ ] **Step 2: 在 close 回调里加 JP fallback warn 与 markJpBad**

找到 `py.on('close', () => { ... })`，整体替换为：

```js
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        const link = r.link || '';
        let raw = r.raw || r.error || '';
        if (!usingJp && link === '') {
          raw = `WARN: jp_channel_disabled, fallback to main proxy. ${raw}`;
        } else if (!usingJp) {
          raw = `WARN: jp_channel_disabled, fallback to main proxy (link still obtained). ${raw}`;
        }
        if (usingJp && link === '' && currentJpNode) {
          proxyMgr.markJpBad(currentJpNode);
        }
        resolve({ link, title: '', raw });
      } catch {
        if (usingJp && currentJpNode) proxyMgr.markJpBad(currentJpNode);
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}` });
      }
    });
```

- [ ] **Step 3: 在 timeout 回调里也补 markJpBad**

找到 `const timer = setTimeout(() => { ... })`，把里面替换为：

```js
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      if (typeof currentJpNode !== 'undefined' && currentJpNode) {
        try { proxyMgr.markJpBad(currentJpNode); } catch {}
      }
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)' });
    }, 60000);
```

**注意作用域**：`currentJpNode` 必须在 setTimeout 闭包里可见。把 timer 的声明**移到** `const input = JSON.stringify(...)` **之后**（确保 `currentJpNode` 已定义）。最终 `fetchCheckoutLink` 函数体顺序应为：

```
1. const jpUrl/mainUrl/proxy/usingJp/currentJpNode 声明
2. const input = JSON.stringify({...})
3. const py = spawn(...)
4. let settled / let stdout / let stderr
5. const timer = setTimeout(...)
6. py.stdout.on / py.stderr.on / py.on('close')
7. py.stdin.write(input); py.stdin.end();
```

- [ ] **Step 4: 启动 server，触发一次 checkout（任意一个 access_token），看日志**

Run: 在 web UI 跑一个账号到支付环节，或直接调内部 API
Expected: 控制台出现 `[Checkout] Attempt 1/3 with impersonate=...`，最终返回 `link=https://pay.openai.com/...`；`getState().jp.currentNode` 不为空

- [ ] **Step 5: Commit**

```bash
git add server/chatgpt-checkout.js
git commit -m "feat(checkout): route checkout link fetch through JP-KDDI inbound (7891)"
```

---

## Task 8: routes/proxy.js 加 JP 子路由

**Files:**
- Modify: `server/routes/proxy.js`

- [ ] **Step 1: 在文件末尾的 `module.exports` 之前加 JP 路由**

把以下路由在 `module.exports = router;` 之前插入：

```js
router.post('/jp/rotate', async (req, res) => {
  try { const node = await proxy.rotateJp(); res.json({ ok: true, currentNode: node }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/jp/detect-exit', async (req, res) => {
  try { const ip = await proxy.detectJpExit(); res.json({ ok: true, exitIp: ip }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/jp/mark-bad', (req, res) => {
  const { node, ttlMs } = req.body || {};
  if (!node || typeof node !== 'string') return res.status(400).json({ error: 'node required' });
  proxy.markJpBad(node, ttlMs);
  res.json({ ok: true, node, jpBadNodes: proxy.getState().jp.badNodes });
});
```

- [ ] **Step 2: 启动 server，验证路由生效**

Run: 假设 server 监听 3000，已 refresh 过代理且 jp.enabled=true
```bash
curl -X POST http://localhost:3000/api/proxy/jp/detect-exit
```
Expected: `{"ok":true,"exitIp":"126.x.x.x"}` 或类似日本 IP

```bash
curl -X POST http://localhost:3000/api/proxy/jp/rotate
```
Expected: `{"ok":true,"currentNode":"jp-KDDI-..."}` (单节点时返回该节点本身)

- [ ] **Step 3: Commit**

```bash
git add server/routes/proxy.js
git commit -m "feat(proxy): add /jp/rotate /jp/detect-exit /jp/mark-bad endpoints"
```

---

## Task 9: Config.vue 加只读 JP 通道卡片与配置字段

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: 在 `form` reactive 对象里加两个字段**

找到 `const form = reactive({` 内的 `proxyRotationStrategy: 'sequential',`，在它下面（闭合 `})` 之前）加：

```js
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
```

- [ ] **Step 2: 在 `onMounted` 的 `if (cfg.proxy) { ... }` 块加 JP 字段加载**

在现有 4 个 `if (cfg.proxy.xxx !== undefined)` 之后追加：

```js
      if (cfg.proxy.jpCheckout) {
        if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
        if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
      }
```

- [ ] **Step 3: 在 `handleSave()` 里把 JP 字段写回**

找到 `handleSave()` 内 `payload.proxy = { ... }`，把它替换为：

```js
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
      },
    }
```

并在它之前（也就是 4 个 `delete payload.xxx` 之后）追加：

```js
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
```

- [ ] **Step 4: 在 template 的 `<el-divider content-position="left">代理 / 节点轮换</el-divider>` 段尾加 JP 配置 + 卡片**

找到现有 `<el-form-item label="代理状态" v-if="proxyStatus">` 这一项**之前**，插入：

```html
      <el-divider content-position="left">JP-Checkout 通道</el-divider>
      <el-form-item label="启用 JP 通道">
        <el-switch v-model="form.proxyJpEnabled" />
        <span style="color:#909399;margin-left:8px;font-size:12px">checkout API 走日本住宅 IP（7891）</span>
      </el-form-item>
      <el-form-item label="JP 节点关键字">
        <el-input v-model="form.proxyJpKeyword" placeholder="KDDI" style="width:220px" />
      </el-form-item>
      <el-form-item label="JP 通道状态" v-if="proxyStatus?.jp">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.jp.enabled ? '运行中' : '未启用' }} ({{ proxyStatus.jp.available || 0 }} KDDI 节点)</div>
          <div v-if="proxyStatus.jp.currentNode">当前节点：{{ proxyStatus.jp.currentNode }}</div>
          <div v-if="proxyStatus.jp.exitIp">JP 出口 IP：{{ proxyStatus.jp.exitIp }}</div>
          <div v-if="proxyStatus.jp.lastError" style="color:#e6a23c">{{ proxyStatus.jp.lastError }}</div>
          <div style="margin-top:6px">
            <el-button size="small" @click="detectJpExit">检测 JP 出口 IP</el-button>
            <el-button size="small" @click="rotateJp">切换 JP 节点</el-button>
          </div>
        </div>
      </el-form-item>
```

- [ ] **Step 5: 在 `<script setup>` 末尾 `</script>` 之前加 detectJpExit / rotateJp 方法**

在 `async function detectExit()` 函数下面加：

```js
async function detectJpExit() {
  try {
    const { data } = await api.post('/proxy/jp/detect-exit')
    ElMessage.success(`JP 出口 IP: ${data.exitIp || '未知'}`)
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'JP 检测失败')
  }
}

async function rotateJp() {
  try {
    const { data } = await api.post('/proxy/jp/rotate')
    ElMessage.success(`已切换到: ${data.currentNode}`)
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '切换失败')
  }
}
```

- [ ] **Step 6: 启动前端 dev，肉眼验证 UI**

Run: `cd web && npm run dev`
Expected: 配置页出现 `JP-Checkout 通道` 分区，有开关、关键字输入、状态卡片；点 "检测 JP 出口 IP" 弹出日本 IP

- [ ] **Step 7: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat(ui): add JP-Checkout channel config + read-only status card"
```

---

## Task 10: 集成验证 T1 + T2

**Files:** （无代码修改，纯运行验证）

- [ ] **Step 1: T1 — 启动 + 状态字段验证**

1. 确保 `config.json` 的 `proxy.subscriptionUrl` 是 `https://sub.topren.top/share/col/svpn?token=P9qtIrMvVggF3rbq3kqND`
2. 启动 server: `node server/index.js`
3. Web UI 点 "应用并启动代理"
4. 终端跑：

```bash
curl http://localhost:3000/api/proxy/status
```

Expected 响应包含：
- `"enabled": true`，`"available": N`（N >= 1）
- `"jp": { "enabled": true, "available": >=1, "currentNode": "<含 KDDI>", ... }`

5. 跑：

```bash
netstat -ano | findstr ":7890"
netstat -ano | findstr ":7891"
```

Expected: 两个端口都有 LISTENING

- [ ] **Step 2: T2 — JP 出口 IP 与 US 出口 IP 各自独立**

```bash
curl --proxy http://127.0.0.1:7890 https://api.ipify.org
curl --proxy http://127.0.0.1:7891 https://api.ipify.org
```

Expected: 7890 返回 US IP（与现有 regionFilter 一致），7891 返回日本 IP（KDDI ASN 通常在 `126.x` 段）。两者不同。

如失败：检查 sing-box 日志输出，确认 in-jp inbound 绑定成功 + route.rules 写对。

- [ ] **Step 3: T5 — JP 池为空软失败**

1. 修改 `config.json` 的 `proxy.jpCheckout.keyword` 改成 `"ImpossibleKeyword"`
2. Web UI 点 "应用并启动代理"
3. `curl http://localhost:3000/api/proxy/status`

Expected: 主代理 `enabled: true`；`jp.enabled: false`；`jp.lastError` 含 `'订阅中未找到关键字 "ImpossibleKeyword" 的节点'`。

4. 触发一次 checkout（任意账号），看日志

Expected: chatgpt-checkout.js 用 `mainUrl`（7890），返回结果的 raw 字段含 `'WARN: jp_channel_disabled'`。

5. 恢复 `keyword: "KDDI"`，重新 refresh，确认 jp.enabled 回到 true。

- [ ] **Step 4: T6 — 端口冲突降级**

1. 启动一个占 7891 的进程：

PowerShell: `python -m http.server 7891`

2. Web UI 点 "应用并启动代理"

Expected: 出现 `[Proxy] 7891 端口被占用或绑定失败，降级关闭 JP 通道`；`jp.enabled: false`；`jp.lastError` 含 `'端口 7891 被占用'`；主代理 enabled: true 正常工作（7890 可用）。

3. 杀掉 7891 占用进程，重新 refresh，确认 jp.enabled 回到 true。

- [ ] **Step 5: T7 — 并发不互踩**

如果有 2+ worker / 2+ 账号并发跑：同时跑 2 个账号到 checkout 环节，确认：
- 主代理 currentNode 不被 checkout 切换影响（注册阶段用的 US 节点保持稳定）
- 两个 checkout 都走 7891 出口 IP（日本）
- `getState().jp.currentNode` 不会被反复切（单节点时）

如果项目当前无 worker pool，跳过此步。

- [ ] **Step 6: 没有 git commit（纯验证步骤）**

记录验证结果到本任务的对话或临时笔记，作为后续 T3 验证的前置确认。

---

## Task 11: CHANGELOG + 打 tag

**Files:**
- Create: `docs/CHANGELOG.md`（如不存在）

- [ ] **Step 1: 检查 CHANGELOG.md 是否存在**

Run:
```bash
ls docs/CHANGELOG.md 2>$null || echo "not exists"
```

- [ ] **Step 2: 创建（或追加到）`docs/CHANGELOG.md` 顶部**

如果不存在，新建文件，内容：

```markdown
# Changelog

## v2.18.0 — 2026-05-23

### Added
- 新增 `JP-Checkout` 通道：sing-box 增加第二个 mixed inbound (`:7891`)，专用 `jp-checkout` selector 仅选 KDDI 节点。
- `server/proxy/subscription.js` 新增 `filterByJpKddi(outbounds, keyword='KDDI')`，按 tag 关键字（不区分大小写正则）过滤。
- `server/proxy/index.js` 扩展 `_state.jp` 子结构与 `getJpProxyUrl / getJpState / rotateJp / detectJpExit / markJpBad`。
- `/api/proxy/jp/{rotate,detect-exit,mark-bad}` 三个新端点。
- `Config.vue` 加 `JP-Checkout 通道` 分区：启用开关、关键字输入、只读状态卡片（节点数、当前节点、出口 IP、错误）。

### Changed
- `server/chatgpt-checkout.js` 把 proxy 优先级改为 `getJpProxyUrl() || getProxyUrl()`；JP 通道未启用时 raw 字段附 `WARN: jp_channel_disabled`。
- `buildSingboxConfig(us, jp)` 改为接收双池参数；`jp` 为空数组/null 时 `route.rules` 退回单入口形态。

### Robustness
- 订阅中无 KDDI 节点时**软失败**：主代理正常启动，`jp.enabled=false`，UI 显示提示。
- 7891 端口被占时**降级**：catch sing-box 启动错误后用无 jp 配置重启 sing-box；主代理不受影响。

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-checkout-via-jp-kddi-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-checkout-via-jp-kddi.md`

### 关键验收待项
- **T3 ¥0 试用链接验证**：需要一个全新、未用过试用的 OpenAI 账号通过 checkout 拿链接，Chrome+CDP 渲染验证显示 `Free trial / ¥0 / Total due today: ¥0`。这是 v2.17.0 从未验证到的核心目标。
```

如果已存在，把上面这段 `## v2.18.0` 整段插入到第一个 `## ` 之前（紧随顶部 `# Changelog` 标题）。

- [ ] **Step 3: 提交 + 打 tag**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.18.0 — checkout via JP-KDDI residential proxy"
git tag -a v2.18.0 -m "v2.18.0: checkout link via JP-KDDI inbound (7891)"
```

- [ ] **Step 4: 验证 tag**

```bash
git tag | findstr v2.18.0
git log --oneline -8
```

Expected: tag `v2.18.0` 出现；最近 commit 链覆盖 Task 1-9 + 本任务。

---

## Task 12: T3 核心验收（注册全新账号 + ¥0 链接渲染）

**Files:** （手工流程，无代码改动）

这是本次设计的核心验收——v2.17.0 没验证到的关键证据。

- [ ] **Step 1: 注册一个全新 OpenAI 账号**

走项目自身的 `protocol_register.py` 流程（或 Web UI "执行" 入口），用一个**全新的 outlook 邮箱**（catch-all 或新创建），跑通注册后确认：
- DB `registered_accounts` 表里该 email 的 `last_plan_type` 为空（NULL）或 'free'
- 没有任何 `plus_no_rt` / `team` / `pro` 标记

- [ ] **Step 2: 拿该账号的 access_token**

从 DB 查：
```sql
SELECT email, access_token, last_plan_type FROM registered_accounts ORDER BY id DESC LIMIT 1;
```
确认 access_token 非空、last_plan_type 是空或 free。

- [ ] **Step 3: 直接调 checkout API 拿链接**

写一个临时脚本（`test-t3-fresh-account.js`，**临时文件，验证完删**）：

```js
const fs = require('fs');
const { fetchCheckoutLink } = require('./server/chatgpt-checkout');
const proxy = require('./server/proxy');

(async () => {
  await proxy.refresh();
  const token = process.env.TEST_TOKEN;
  if (!token) { console.error('Set TEST_TOKEN env'); process.exit(1); }
  console.log('JP proxy URL:', proxy.getJpProxyUrl());
  const r = await fetchCheckoutLink(token);
  console.log('Result:', JSON.stringify(r, null, 2));
  await proxy.stop();
})();
```

Run（PowerShell）：
```
$env:TEST_TOKEN = "<新账号 access_token>"
node test-t3-fresh-account.js
```

Expected: 返回 `link: "https://pay.openai.com/c/pay/cs_live_..."`，raw 不含 'WARN'。

- [ ] **Step 4: 用 Chrome+CDP 渲染该链接，验证显示 ¥0 / Free trial**

写一个临时渲染脚本 `test-t3-render.js`（参考已存在的 `test-checkout-render.js`，但走 7891 代理）：

```js
const { launchChrome, waitForCDP } = require('./server/chrome');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PROXY = 'http://127.0.0.1:7891';
const URL = process.env.TEST_URL;

(async () => {
  if (!URL) { console.error('Set TEST_URL env'); process.exit(1); }
  const port = 19888;
  const tempDir = path.join(os.tmpdir(), 'inspect-t3-' + Date.now());
  const proc = launchChrome(port, tempDir, { proxyServer: PROXY });
  try {
    const browser = await waitForCDP(port);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      () => document.body && /[¥$0]|Free trial|Total due today/i.test(document.body.innerText || ''),
      { timeout: 25000 }
    ).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText || '');
    console.log('=== First 2000 chars ===');
    console.log(text.slice(0, 2000));
    const hits = [];
    for (const [re, label] of [
      [/free trial/i, 'free trial'],
      [/¥\s*0\b/i, '¥0'],
      [/\$0\b/i, '$0'],
      [/Total due today/i, 'Total due today'],
      [/¥\s*\d/i, '¥ amount (non-zero)'],
    ]) {
      const m = text.match(re); if (m) hits.push(`HIT ${label}: "${m[0]}"`);
    }
    console.log('\n=== Markers ===');
    hits.forEach(h => console.log(h));
    await browser.close();
  } finally {
    try { proc.kill(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
})();
```

Run：
```
$env:TEST_URL = "<Step 3 拿到的 link>"
node test-t3-render.js
```

Expected: 渲染出来含 `Free trial` 或 `¥0` 或 `Total due today: ¥0`，**且不含**非零 `¥\d+` 价格。截图保留作为证据。

- [ ] **Step 5: 清理临时验证文件**

```bash
rm test-t3-fresh-account.js test-t3-render.js
# 把 v2.17 调试期遗留的临时文件也一并清理
rm test-checkout.js test-checkout-curl.py test-checkout-inspect.py test-checkout-inspect2.py test-checkout-render.js 2>$null
```

- [ ] **Step 6: 提交清理 commit**

```bash
git add -A
git status   # 确认只删了临时文件
git commit -m "chore: remove temporary checkout debug scripts after v2.18.0 acceptance"
```

如果 T3 失败（页面显示 ¥2,727 而非 ¥0），不要 commit；分析原因——可能是新账号也已被 OpenAI 标记为 post-trial，或 promo_campaign 在 JP 区已失效。回到 spec 的 §10 Risks 第三条排查。

---

## Self-Review

跑完上面 12 个 Task 之后做一次最终审视：

**Spec 覆盖**：
- §3 架构 → Task 2 (导出) + Task 4 (双入口实现)
- §4 配置 → Task 5 (refresh 读 jpCheckout) + Task 9 (UI 字段)
- §5 数据流 → Task 5 启动 + Task 7 调用 + Task 8 状态 + Task 6 失败时序
- §6 错误处理 → Task 5 (软失败) + Task 5 (端口冲突 catch) + Task 7 (markJpBad)
- §7 测试 → Task 1, 4 (单测) + Task 10 (T1/T2/T5/T6/T7) + Task 12 (T3 核心)
- §8 实施顺序 → Task 1-11 对应 spec 的 1-10
- §9 Out of scope → Task 12 后确实没有引入 withCheckoutNode、未在 Python 改代理逻辑

**类型一致**：
- `getJpProxyUrl` 始终返回 string（`'http://127.0.0.1:7891'` 或 `''`），不返 null
- `_state.jp.badNodes` 始终是 `Map`，序列化时 `getState()` 转 plain object
- `buildSingboxConfig(us, jp)` 的 `jp` 参数可以是 `null` 或 `Array`，统一用 `Array.isArray(jp) && jp.length > 0` 判定
- `currentJpNode` 在 chatgpt-checkout.js 内是 string（空字符串或节点名），timer 闭包正确捕获
