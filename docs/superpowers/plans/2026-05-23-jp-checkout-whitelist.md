# JP-Checkout Node Whitelist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 Config.vue UI 上从订阅当前所有节点里下拉勾选一组节点作为 `jp-checkout` selector 池，精确控制 7891 入口走哪些节点；不填白名单时回退到 v2.18.0 的 keyword 过滤行为。

**Architecture:** 在 `server/proxy/subscription.js` 加 `filterByWhitelist`；在 `server/proxy/index.js` 抽 `pickJpNodes(all, jpCfg)` 纯函数承载 "whitelist 优先 / keyword fallback" 决策，扩展 `_state.jp` 加 `whitelist`/`whitelistMisses` + `_state.allTags`；新增 `GET /api/proxy/nodes` 路由暴露订阅全部 tag；Config.vue 加 `el-select multiple filterable` 控件 + KDDI 高亮 + keyword 灰显逻辑。

**Tech Stack:** Node 22+ (`node:test` 内置)、sing-box 1.10.7、curl_cffi (无关本任务)、Vue 3 + Element Plus。

---

## File Structure

**新建**：无新文件（所有改动在现有 6 个文件 + CHANGELOG）

**修改**：
- `server/proxy/subscription.js` — 新增 `filterByWhitelist(outbounds, whitelist)` + 导出
- `server/proxy/__tests__/subscription.test.js` — 加 6 个 `filterByWhitelist` testcase
- `server/proxy/index.js` — `_state.jp.whitelist/whitelistMisses` + `_state.allTags`、抽 `pickJpNodes` + 导出、`refresh()` 改造、`getState()` 序列化新字段
- `server/proxy/__tests__/index.test.js` — 加 5 个 `pickJpNodes` testcase
- `server/routes/proxy.js` — 新增 `GET /nodes`
- `web/src/views/Config.vue` — `form.proxyJpWhitelist`、`allNodeTags`/`jpKddiTagSet` ref、`loadAllNodes()`、UI 新增下拉 + 灰显 keyword + misses 黄条
- `docs/CHANGELOG.md` — 加 v2.18.1 条目

**不动**：
- `server/proxy/singbox.js`、`server/proxy/clash-api.js`
- `server/chatgpt-checkout.js`、`server/engine.js`、`server/protocol-engine.js`
- `buildSingboxConfig` 函数本体（仍接收双池参数）
- `checkout_link.py`

---

## Task 1: filterByWhitelist 实现与单测

**Files:**
- Modify: `server/proxy/subscription.js`
- Modify: `server/proxy/__tests__/subscription.test.js`

- [ ] **Step 1: 在 `subscription.test.js` 末尾追加 6 个 testcase**

打开 `server/proxy/__tests__/subscription.test.js`，在文件末尾（最后一个 test 之后）追加：

```js
const { filterByWhitelist } = require('../subscription');

test('filterByWhitelist: 精确匹配指定 tag', () => {
  const input = [
    { tag: 'nodeA' }, { tag: 'nodeB' }, { tag: 'nodeC' },
  ];
  const out = filterByWhitelist(input, ['nodeA', 'nodeC']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'nodeA');
  assert.strictEqual(out[1].tag, 'nodeC');
});

test('filterByWhitelist: 空白名单返回空数组', () => {
  const input = [{ tag: 'nodeA' }, { tag: 'nodeB' }];
  assert.deepStrictEqual(filterByWhitelist(input, []), []);
});

test('filterByWhitelist: 白名单含订阅没有的 tag 时静默跳过', () => {
  const input = [{ tag: 'nodeA' }];
  const out = filterByWhitelist(input, ['nodeA', 'nodeX']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'nodeA');
});

test('filterByWhitelist: 白名单全部不命中返回空数组', () => {
  const input = [{ tag: 'nodeA' }];
  assert.deepStrictEqual(filterByWhitelist(input, ['nodeX', 'nodeY']), []);
});

test('filterByWhitelist: 含重复/null/空字符串/undefined 时去重并剔除非字符串', () => {
  const input = [{ tag: 'nodeA' }, { tag: 'nodeB' }];
  const out = filterByWhitelist(input, ['nodeA', 'nodeA', null, '', undefined, 'nodeB']);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].tag, 'nodeA');
  assert.strictEqual(out[1].tag, 'nodeB');
});

test('filterByWhitelist: tag 含中文/空格/括号特殊字符精确匹配', () => {
  const fullTag = 'jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]';
  const input = [{ tag: fullTag }, { tag: 'pro-家庭宽带-日本KDDI-2x' }];
  const out = filterByWhitelist(input, [fullTag]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, fullTag);
});
```

- [ ] **Step 2: 跑测试验证 RED**

Run: `node --test server/proxy/__tests__/subscription.test.js`
Expected: 5 个之前的过、6 个新 testcase 全 FAIL（`filterByWhitelist is not a function`）

- [ ] **Step 3: 在 `subscription.js` 加 `filterByWhitelist` 函数**

打开 `server/proxy/subscription.js`，找到 `filterByJpKddi` 函数（应该在文件末尾 `module.exports` 之前）。**在它下方**插入：

```js
function filterByWhitelist(outbounds, whitelist) {
  if (!Array.isArray(outbounds) || outbounds.length === 0) return [];
  if (!Array.isArray(whitelist) || whitelist.length === 0) return [];
  const wantSet = new Set(whitelist.filter(t => typeof t === 'string' && t));
  return outbounds.filter(o => wantSet.has(o.tag || ''));
}
```

然后修改 `module.exports`，把 `filterByWhitelist` 加进列表：

```js
module.exports = { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist, US_PATTERNS };
```

- [ ] **Step 4: 跑测试验证 GREEN**

Run: `node --test server/proxy/__tests__/subscription.test.js`
Expected: PASS (11 tests passed: 5 旧 + 6 新)

- [ ] **Step 5: Commit**

```bash
git add server/proxy/subscription.js server/proxy/__tests__/subscription.test.js
git commit -m "feat(proxy): add filterByWhitelist for precise JP node selection"
```

---

## Task 2: pickJpNodes 决策函数 + 单测

**Files:**
- Modify: `server/proxy/index.js`
- Modify: `server/proxy/__tests__/index.test.js`

- [ ] **Step 1: 在 `index.test.js` 末尾追加 5 个 `pickJpNodes` testcase**

打开 `server/proxy/__tests__/index.test.js`，在文件末尾追加：

```js
test('pickJpNodes: whitelist 非空时优先使用白名单', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }, { tag: 'KDDI-2' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: ['nodeA'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: whitelist 空 → keyword 分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }, { tag: 'KDDI-2' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 2);
  assert.strictEqual(r.filtered[0].tag, 'KDDI-1');
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: enabled=false 返回空', () => {
  const all = [{ tag: 'KDDI-1' }];
  const r = proxy.pickJpNodes(all, { enabled: false, keyword: 'KDDI', whitelist: ['KDDI-1'] });
  assert.deepStrictEqual(r.filtered, []);
  assert.strictEqual(r.usedWhitelist, false);
  assert.deepStrictEqual(r.misses, []);
});

test('pickJpNodes: whitelist 含不存在 tag 时收集 misses', () => {
  const all = [{ tag: 'nodeA' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: ['nodeA', 'unknown1', 'unknown2'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, ['unknown1', 'unknown2']);
});

test('pickJpNodes: whitelist 非数组（字符串误填）视为空 → fallback keyword 分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'KDDI-1' }];
  const r = proxy.pickJpNodes(all, { enabled: true, keyword: 'KDDI', whitelist: 'KDDI' });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'KDDI-1');
});
```

- [ ] **Step 2: 跑测试验证 RED**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: 4 个之前的过、5 个新 FAIL（`proxy.pickJpNodes is not a function`）

- [ ] **Step 3: 在 `index.js` 的 import 区加 `filterByWhitelist`**

打开 `server/proxy/index.js`，找到顶部：

```js
const { fetchAndParse, filterByRegion, filterByJpKddi } = require('./subscription');
```

改为：

```js
const { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist } = require('./subscription');
```

- [ ] **Step 4: 加 `pickJpNodes(all, jpCfg)` 纯函数**

在 `buildSingboxConfig` 函数**之前**（顶部 helper 区）插入：

```js
function pickJpNodes(all, jpCfg) {
  if (!jpCfg || jpCfg.enabled === false) {
    return { filtered: [], misses: [], usedWhitelist: false };
  }
  const whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : [];
  if (whitelist.length > 0) {
    const filtered = filterByWhitelist(all, whitelist);
    const presentTags = new Set(all.map(o => o.tag));
    const misses = whitelist.filter(t => typeof t === 'string' && t && !presentTags.has(t));
    return { filtered, misses, usedWhitelist: true };
  }
  const filtered = filterByJpKddi(all, jpCfg.keyword || 'KDDI');
  return { filtered, misses: [], usedWhitelist: false };
}
```

把 `pickJpNodes` 加进 `module.exports`：

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
  pickJpNodes,                  // ← 新增
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

- [ ] **Step 5: 跑测试验证 GREEN**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: PASS (9 tests passed: 4 旧 + 5 新)

- [ ] **Step 6: Commit**

```bash
git add server/proxy/index.js server/proxy/__tests__/index.test.js
git commit -m "feat(proxy): add pickJpNodes (whitelist > keyword priority decision)"
```

---

## Task 3: _state 扩展 whitelist / allTags + getState 序列化

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 扩展 `_state.jp` 加 `whitelist` 与 `whitelistMisses` 字段**

打开 `server/proxy/index.js`，找到 `let _state = { ... };` 块中的 `jp:` 子对象。在 `keyword: JP_DEFAULT_KEYWORD,` 之后插入：

```js
    whitelist: [],
    whitelistMisses: [],
```

最终 `jp` 子对象应该是：

```js
  jp: {
    enabled: false,
    keyword: JP_DEFAULT_KEYWORD,
    whitelist: [],
    whitelistMisses: [],
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

- [ ] **Step 2: 在 `_state` 顶层加 `allTags` 字段**

在 `let _state = { ... }` 的 `badNodes: new Map(),` 之后、`jp:` 子对象之前插入：

```js
  allTags: [],   // 订阅里全部节点 tag (refresh 时缓存，供 /api/proxy/nodes 用)
```

- [ ] **Step 3: 静态检查模块加载正常**

Run: `node -e "const p=require('./server/proxy'); const s=p.getState(); console.log('jp.whitelist:', s.jp.whitelist, '| allTags:', s.allTags)"`
Expected: 输出 `jp.whitelist: [] | allTags: []`

- [ ] **Step 4: 单元测试仍 pass（结构改了没破坏测试）**

Run: `node --test server/proxy/__tests__/index.test.js server/proxy/__tests__/subscription.test.js`
Expected: 20 tests passed（11 + 9）

- [ ] **Step 5: Commit**

```bash
git add server/proxy/index.js
git commit -m "feat(proxy): add _state.jp.whitelist/whitelistMisses and _state.allTags"
```

---

## Task 4: refresh() 调用 pickJpNodes + 缓存 allTags

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 改造 `refresh()` 使用 `pickJpNodes`**

打开 `server/proxy/index.js`，找到 `async function refresh() { ... }`。**整体替换** `refresh` 函数为：

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
  _state.jp.whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : [];

  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  _state.allTags = all.map(o => o.tag);

  const filtered = filterByRegion(all, _state.rotationKeyword);
  console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
  if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);

  const jpPick = pickJpNodes(all, { ...jpCfg, enabled: jpEnabledByConfig });
  const jpFiltered = jpPick.filtered;
  _state.jp.whitelistMisses = jpPick.misses;
  if (jpPick.usedWhitelist) {
    console.log(`[Proxy] JP whitelist: ${jpFiltered.length}/${_state.jp.whitelist.length} matched (${jpPick.misses.length} missing${jpPick.misses.length > 0 ? ': ' + jpPick.misses.join(', ') : ''})`);
  } else if (jpEnabledByConfig) {
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
  } else if (jpPick.usedWhitelist && jpFiltered.length === 0) {
    _state.jp.lastError = `白名单 [${_state.jp.whitelist.join(', ')}] 在订阅中无任何匹配`;
  } else if (!jpPick.usedWhitelist && jpFiltered.length === 0) {
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

关键改动：
1. 顶部解析 `jpCfg.whitelist` 写入 `_state.jp.whitelist`
2. `fetchAndParse` 之后立刻 `_state.allTags = all.map(o => o.tag)`
3. `filterByJpKddi` 调用换成 `pickJpNodes(all, {...jpCfg, enabled: jpEnabledByConfig})`
4. `_state.jp.whitelistMisses` 接 `jpPick.misses`
5. `lastError` 三分支：disabled / whitelist 全空 / keyword 全空

- [ ] **Step 2: 静态检查 - 模块仍 require OK**

Run: `node -e "require('./server/proxy')"`
Expected: 无 SyntaxError 输出

- [ ] **Step 3: 单元测试仍 pass**

Run: `node --test server/proxy/__tests__/index.test.js server/proxy/__tests__/subscription.test.js`
Expected: 20 tests passed

- [ ] **Step 4: 手工验证 - 启 server 看日志**

杀掉残留 node 进程后启动：
```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"
node server/index.js > server.task4.log 2>&1 &
sleep 8
tail -15 server.task4.log
```

Expected: 看到日志含 `[Proxy] JP-KDDI filter (keyword=KDDI): 2`（因为 config.json 的 jpCheckout.whitelist 仍是 []，走 keyword 分支）

```bash
curl -s http://localhost:3000/api/proxy/status | node -e "const s=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('allTags count:', s.allTags?.length || 0); console.log('jp.whitelist:', s.jp.whitelist); console.log('jp.whitelistMisses:', s.jp.whitelistMisses); console.log('jp.lastError:', s.jp.lastError);"
```

Expected: allTags count: 147, jp.whitelist: [], jp.whitelistMisses: [], jp.lastError: ''

清理：
```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
rm -f server.task4.log
```

- [ ] **Step 5: Commit**

```bash
git add server/proxy/index.js
git commit -m "feat(proxy): refresh() uses pickJpNodes + caches allTags"
```

---

## Task 5: getState 序列化 allTags 与 whitelistMisses

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 检查 getState 是否需要修改**

打开 `server/proxy/index.js`，找到 `getState()` 函数。当前实现用 `...stateSpread` 应该已经自动包含新字段 `allTags` 和 `jp.whitelist`/`jp.whitelistMisses`，但要验证。

具体 `getState` 应该是：

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

由于 `..._state` 和 `..._state.jp` 已经 spread 全部字段，`allTags`/`whitelist`/`whitelistMisses` 已经自动在响应里。**无需修改**。

- [ ] **Step 2: 验证 getState 返回新字段**

Run:
```bash
node -e "const p=require('./server/proxy'); const s=p.getState(); console.log(JSON.stringify({allTags: s.allTags, 'jp.whitelist': s.jp.whitelist, 'jp.whitelistMisses': s.jp.whitelistMisses}, null, 2))"
```

Expected:
```json
{
  "allTags": [],
  "jp.whitelist": [],
  "jp.whitelistMisses": []
}
```

如果输出含上面三个字段（值都是空数组），本任务完成，无代码改动。

- [ ] **Step 3: 没有代码改动，无 commit**

本任务是验证步骤，确认 `getState()` 已自动 spread 新字段。如果验证步骤通过，直接进入 Task 6；如果发现字段缺失（spread 没生效），需要在 `getState()` 的 return 里显式列出 `allTags: _state.allTags`，然后单独 commit。

---

## Task 6: GET /api/proxy/nodes 路由

**Files:**
- Modify: `server/routes/proxy.js`

- [ ] **Step 1: 在 `routes/proxy.js` 加 `/nodes` 路由**

打开 `server/routes/proxy.js`，找到 `module.exports = router;`。**在它之前**插入：

```js
router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags });
});
```

- [ ] **Step 2: 静态检查 require 正常**

Run: `node -e "require('./server/routes/proxy')"`
Expected: 无报错

- [ ] **Step 3: 启 server，curl 验证 /nodes**

```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"
node server/index.js > server.task6.log 2>&1 &
sleep 8
curl -s http://localhost:3000/api/proxy/nodes | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('total:', r.total); console.log('jpKddiTags:', r.jpKddiTags); console.log('first 3 nodeTags:', r.nodeTags.slice(0,3));"
```

Expected: 
- `total: 147`
- `jpKddiTags: [ 'pro-家庭宽带-日本KDDI-2x', 'jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]' ]`
- `first 3 nodeTags: [...3 US 节点 tag...]`

清理：
```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
rm -f server.task6.log
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/proxy.js
git commit -m "feat(proxy): add GET /api/proxy/nodes endpoint for UI dropdown"
```

---

## Task 7: Config.vue form 字段 + loadAllNodes + handleSave

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: 加 `allNodeTags` / `jpKddiTagSet` ref 与 form 字段**

打开 `web/src/views/Config.vue`，在 `<script setup>` 的现有 ref 区附近（紧跟 `const proxyStatus = ref(null)` 之后）插入：

```js
const allNodeTags = ref([])
const jpKddiTagSet = ref(new Set())
```

在 `const form = reactive({...})` 中，于现有 `proxyJpKeyword: 'KDDI',` 之后追加：

```js
  proxyJpWhitelist: [],
```

- [ ] **Step 2: 加 `loadAllNodes()` 函数**

在 `async function loadProxyStatus() { ... }` 函数**下方**插入：

```js
async function loadAllNodes() {
  try {
    const { data } = await api.get('/proxy/nodes')
    allNodeTags.value = data.nodeTags || []
    jpKddiTagSet.value = new Set(data.jpKddiTags || [])
  } catch {
    allNodeTags.value = []
    jpKddiTagSet.value = new Set()
  }
}
```

- [ ] **Step 3: onMounted 末尾加载 nodes**

找到 onMounted 末尾的 `loadProxyStatus()` 调用。改为：

```js
  await loadProxyStatus()
  await loadAllNodes()
```

注意：原文件可能是 `loadProxyStatus()`（不带 await）。把它改成 `await loadProxyStatus()` 然后加 `await loadAllNodes()`。

- [ ] **Step 4: onMounted 内 cfg 加载部分接 whitelist 字段**

找到 onMounted 内的 `if (cfg.proxy.jpCheckout) { ... }` 块（在 Task 9 of v2.18.0 加过的）。在该块内追加第三个 if：

```js
      if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
      if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
      if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist
```

- [ ] **Step 5: handleSave 写回 whitelist**

找到 `handleSave()` 函数中的 `payload.proxy = { ... }` 块。**整体替换 `jpCheckout` 子对象**为：

```js
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
        whitelist: form.proxyJpWhitelist || [],
      },
```

然后在 `handleSave` 内 `delete payload.proxyRotationStrategy` 等几行之后追加一行：

```js
    delete payload.proxyJpWhitelist
```

最终 `handleSave` 内删除列表应该含 6 条：

```js
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyRotationStrategy
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
    delete payload.proxyJpWhitelist
```

- [ ] **Step 6: refreshProxy 末尾加载 nodes**

找到 `async function refreshProxy() { ... }`，在 `await loadProxyStatus()` 之后追加：

```js
    await loadAllNodes()
```

- [ ] **Step 7: 静态检查 - Vue 文件语法**

Run: 不必启 vite dev，做 Node 解析校验：
```bash
node -e "require('fs').readFileSync('web/src/views/Config.vue', 'utf8'); console.log('file readable')"
```

Expected: `file readable`

- [ ] **Step 8: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat(ui): wire proxyJpWhitelist form field + loadAllNodes"
```

---

## Task 8: Config.vue UI 控件 + KDDI 高亮 + keyword 灰显

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: 修改 keyword 输入框，加 disabled 绑定**

打开 `web/src/views/Config.vue`，找到 `<el-form-item label="JP 节点关键字">` 整段。**整体替换**为：

```html
      <el-form-item label="JP 节点关键字">
        <el-input v-model="form.proxyJpKeyword" placeholder="KDDI" style="width:220px"
                  :disabled="form.proxyJpWhitelist?.length > 0" />
        <span v-if="form.proxyJpWhitelist?.length > 0"
              style="color:#909399;margin-left:8px;font-size:12px">已被白名单覆盖</span>
      </el-form-item>
```

- [ ] **Step 2: 在 keyword form-item 之后、JP 通道状态 form-item 之前插入白名单下拉**

找到 `<el-form-item label="JP 节点关键字">...</el-form-item>` 整段（已经在 Step 1 改过）。在它**之后**、`<el-form-item label="JP 通道状态" v-if="proxyStatus?.jp">` **之前**插入：

```html
      <el-form-item label="JP 节点白名单">
        <el-select v-model="form.proxyJpWhitelist" multiple filterable clearable
                   collapse-tags collapse-tags-tooltip
                   placeholder="留空 = 按关键字过滤；选中 = 精确指定节点"
                   style="width: 480px">
          <el-option v-for="tag in allNodeTags" :key="tag" :label="tag" :value="tag">
            <span :style="jpKddiTagSet.has(tag) ? 'font-weight:600;color:#67c23a' : ''">
              {{ tag }}
            </span>
            <span v-if="jpKddiTagSet.has(tag)" style="float:right;color:#67c23a;font-size:11px">KDDI</span>
          </el-option>
        </el-select>
        <div style="font-size:12px;color:#909399;margin-top:4px">
          含 KDDI 的节点已绿色高亮。空 = 关键字过滤模式（默认）。
        </div>
      </el-form-item>
```

- [ ] **Step 3: 修改 JP 通道状态卡，加 whitelistMisses 黄条**

找到 `<el-form-item label="JP 通道状态" v-if="proxyStatus?.jp">` 整段。**整体替换**为：

```html
      <el-form-item label="JP 通道状态" v-if="proxyStatus?.jp">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.jp.enabled ? '运行中' : '未启用' }}
               ({{ proxyStatus.jp.available || 0 }} 节点<span
                  v-if="proxyStatus.jp.whitelist?.length"> / 白名单 {{ proxyStatus.jp.whitelist.length }} 个</span>)</div>
          <div v-if="proxyStatus.jp.currentNode">当前节点：{{ proxyStatus.jp.currentNode }}</div>
          <div v-if="proxyStatus.jp.exitIp">JP 出口 IP：{{ proxyStatus.jp.exitIp }}</div>
          <div v-if="proxyStatus.jp.whitelistMisses?.length"
               style="color:#e6a23c;margin-top:4px">
            ⚠ 白名单未命中：{{ proxyStatus.jp.whitelistMisses.slice(0,3).join(', ') }}{{
              proxyStatus.jp.whitelistMisses.length > 3 ? `... 共 ${proxyStatus.jp.whitelistMisses.length} 个` : ''
            }}
          </div>
          <div v-if="proxyStatus.jp.lastError" style="color:#f56c6c">{{ proxyStatus.jp.lastError }}</div>
          <div style="margin-top:6px">
            <el-button size="small" @click="detectJpExit">检测 JP 出口 IP</el-button>
            <el-button size="small" @click="rotateJp">切换 JP 节点</el-button>
          </div>
        </div>
      </el-form-item>
```

- [ ] **Step 4: 静态检查 Vue 文件可读**

Run:
```bash
node -e "require('fs').readFileSync('web/src/views/Config.vue', 'utf8'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 5: 启 server 跑前端 dev 看 UI（可选，建议做）**

```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"
node server/index.js > server.task8.log 2>&1 &
sleep 8
cd web && npm run dev > vite.task8.log 2>&1 &
sleep 5
```

浏览器开 vite 显示的地址（通常 `http://localhost:5173`），进配置页：
- 看到"JP 节点白名单"下拉
- 点开下拉，能搜索
- KDDI 节点是绿色加粗 + 右侧 "KDDI" 标签
- 勾选 1 个节点后，"JP 节点关键字"输入框灰显，旁边提示"已被白名单覆盖"

清理：
```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
rm -f server.task8.log vite.task8.log
```

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat(ui): add JP whitelist multi-select + KDDI highlight + keyword disabled"
```

---

## Task 9: 集成验证 T8 - T13

**Files:** （手工运行验证，无代码改动）

- [ ] **Step 1: T8 - 白名单选住宅节点拿 ¥0**

Setup：
```bash
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('config.json','utf8'));
c.proxy.jpCheckout.whitelist = ['jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]'];
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
console.log('config whitelist set');
"
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2"
node server/index.js > server.t8.log 2>&1 &
sleep 8
curl -s http://localhost:3000/api/proxy/status | node -e "
const s = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('jp.enabled:', s.jp.enabled);
console.log('jp.available:', s.jp.available);
console.log('jp.currentNode:', s.jp.currentNode);
console.log('jp.whitelist:', s.jp.whitelist);
console.log('jp.whitelistMisses:', s.jp.whitelistMisses);
"
curl -s -X POST http://localhost:3000/api/proxy/jp/detect-exit
```

Expected:
- `jp.enabled: true`
- `jp.available: 1`
- `jp.currentNode: jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]`
- `jp.whitelist: [ '...' ]`
- `jp.whitelistMisses: []`
- detect-exit 返回 `106.x.x.x`（KDDI 住宅段）

- [ ] **Step 2: T9 - 白名单部分命中**

```bash
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('config.json','utf8'));
c.proxy.jpCheckout.whitelist = ['jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]', '下线节点X'];
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
"
curl -s -X POST http://localhost:3000/api/proxy/refresh > /dev/null
sleep 2
curl -s http://localhost:3000/api/proxy/status | node -e "
const s = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('jp.enabled:', s.jp.enabled, '| jp.available:', s.jp.available);
console.log('jp.whitelistMisses:', s.jp.whitelistMisses);
"
```

Expected:
- `jp.enabled: true, jp.available: 1`
- `jp.whitelistMisses: [ '下线节点X' ]`

- [ ] **Step 3: T10 - 白名单全不命中（软失败）**

```bash
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('config.json','utf8'));
c.proxy.jpCheckout.whitelist = ['不存在节点A', '不存在节点B'];
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
"
curl -s -X POST http://localhost:3000/api/proxy/refresh > /dev/null
sleep 2
curl -s http://localhost:3000/api/proxy/status | node -e "
const s = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('main.enabled:', s.enabled, '| main.available:', s.available);
console.log('jp.enabled:', s.jp.enabled);
console.log('jp.lastError:', s.jp.lastError);
"
```

Expected:
- `main.enabled: true, main.available: 35`（主代理不受影响）
- `jp.enabled: false`
- `jp.lastError: 白名单 [不存在节点A, 不存在节点B] 在订阅中无任何匹配`

- [ ] **Step 4: T11 - 清空白名单回退到 keyword 模式**

```bash
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('config.json','utf8'));
c.proxy.jpCheckout.whitelist = [];
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
"
curl -s -X POST http://localhost:3000/api/proxy/refresh > /dev/null
sleep 2
curl -s http://localhost:3000/api/proxy/status | node -e "
const s = JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log('jp.enabled:', s.jp.enabled, '| jp.available:', s.jp.available);
console.log('jp.whitelist:', s.jp.whitelist, '| jp.whitelistMisses:', s.jp.whitelistMisses);
"
```

Expected:
- `jp.enabled: true, jp.available: 2`
- `jp.whitelist: [], jp.whitelistMisses: []`

- [ ] **Step 5: T12 - UI 下拉列表数据源（手工浏览器验证）**

启动前端 dev（如果 npm run dev 没在跑）：
```bash
cd web && npm run dev &
sleep 5
```

浏览器打开 vite 显示的地址（如 `http://localhost:5173`），进配置页：
- 点开"JP 节点白名单"下拉
- 期望：含全部 147 个节点
- 期望：搜索 "KDDI" 过滤出 2 个，搜索 "softbank" 过滤出 1 个
- 期望：含 KDDI 的两个节点绿色加粗 + 右侧 "KDDI" 标签

- [ ] **Step 6: T13 - keyword 灰显 + 白名单 1 个**

接 T12 UI 验证：
- 在下拉里勾选 `jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]`
- 期望：上方"JP 节点关键字"输入框立即灰显
- 期望：旁边出现灰色文字 "已被白名单覆盖"
- 点"保存配置"
- 点"应用并启动代理"
- 期望：状态卡显示 "状态：运行中 (1 节点 / 白名单 1 个)"

- [ ] **Step 7: 清理 + 关 server / vite**

```bash
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"
rm -f server.t8.log
# 把白名单清空回 default
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('config.json','utf8'));
c.proxy.jpCheckout.whitelist = [];
fs.writeFileSync('config.json', JSON.stringify(c, null, 2));
"
```

- [ ] **Step 8: 无 commit（纯验证步骤）**

记录验证结果，作为 Task 10 的前置确认。

---

## Task 10: CHANGELOG v2.18.1 + tag

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 在 `docs/CHANGELOG.md` 顶部（# Changelog 之后、第一个 ## 之前）插入 v2.18.1 条目**

打开 `docs/CHANGELOG.md`，在 `# Changelog` 标题行之后、`## v2.18.0` 之前插入：

```markdown

## v2.18.1 — 2026-05-23

### Added
- `config.proxy.jpCheckout.whitelist: string[]` —— 精确指定 JP-Checkout 通道使用的节点 tag 数组。非空时优先，空时回退到 v2.18.0 的 `keyword` 过滤行为（向后兼容）。
- `GET /api/proxy/nodes` —— 返回订阅当前全部节点 tag + KDDI 子集，供 UI 下拉选项使用。
- `server/proxy/subscription.js` 新增 `filterByWhitelist(outbounds, whitelist)` —— 用 Set 精确匹配 tag，自动去重 + 剔除非字符串项。
- `server/proxy/index.js` 新增 `pickJpNodes(all, jpCfg)` —— 纯函数承载"whitelist > keyword"决策；导出供单测使用。
- `_state.jp.whitelist` / `_state.jp.whitelistMisses` —— 跟踪用户配置的白名单与订阅中缺失的 tag。
- `_state.allTags` —— refresh 时缓存全部节点 tag，供 `/nodes` 接口快速返回。
- `Config.vue` 加 `JP 节点白名单` 下拉多选 (el-select multiple filterable)：含 147 节点 + 搜索框，KDDI 节点绿色加粗高亮 + 右侧 "KDDI" 标签。
- `Config.vue` 状态卡新增 `whitelistMisses` 黄色提示行（白名单中订阅缺失的 tag）。

### Changed
- `refresh()` 改用 `pickJpNodes()` 做节点选择决策，原 `filterByJpKddi` 直接调用降为 `pickJpNodes` 内部回退分支。
- `Config.vue` `JP 节点关键字` 输入框在白名单非空时自动灰显 + 提示 "已被白名单覆盖"。

### Robustness
- 白名单含订阅没有的 tag → 静默跳过，`whitelistMisses` 记录，UI 黄色提示。
- 白名单**全部**不命中 → `jp.enabled=false`，`lastError` 含未匹配的 tag 列表（**不**静默回退到 keyword，避免反直觉行为）。
- 白名单非数组（字符串误填）→ `pickJpNodes` 类型守卫，视为空 → fallback keyword 分支。

### Tests
- 单元测试 20/20 通过：
  - `filterByJpKddi` × 5 (v2.18.0)
  - `filterByWhitelist` × 6 (新增)
  - `buildSingboxConfig` × 4 (v2.18.0)
  - `pickJpNodes` × 5 (新增)
- 集成验证 T8-T13 全过（白名单生效、部分命中、全不命中、清空回退、UI 下拉、KDDI 高亮、keyword 灰显）。

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-jp-checkout-whitelist-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-jp-checkout-whitelist.md`

```

- [ ] **Step 2: 提交 + 打 tag**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.18.1 — JP-checkout node whitelist"
git tag -a v2.18.1 -m "v2.18.1: precise JP node whitelist for checkout channel"
```

- [ ] **Step 3: 验证 tag**

```bash
git tag | grep v2.18.1
git log --oneline -12
```

Expected:
- tag `v2.18.1` 出现
- 最近 12 个 commit 链覆盖 Task 1-8 + Task 10

---

## Self-Review

**1. Spec coverage**:

| Spec 章节 | 对应 Task |
|---|---|
| §3 架构（filterByWhitelist + pickJpNodes + state 字段 + nodes 路由 + Config.vue） | Task 1, 2, 3, 6, 7, 8 |
| §4 配置 schema（jpCheckout.whitelist） | Task 4 (refresh 解析) + Task 7 (UI form) |
| §5 数据流（refresh / pickJpNodes / /nodes / UI 加载 / status 响应） | Task 2, 4, 5, 6, 7 |
| §6 UI（form、loadAllNodes、keyword 灰显、KDDI 高亮、misses 黄条） | Task 7, 8 |
| §7 错误处理（whitelist 非数组守卫、全不命中报错、部分命中静默） | Task 2 (pickJpNodes 守卫) + Task 4 (lastError 文案) |
| §8 测试 11 个 testcase + 6 个集成 T8-T13 | Task 1, 2, 9 |
| §9 实施顺序 9 步 | Task 1-10（合并为 10 个 task） |

无 spec 要求缺漏。

**2. Placeholder scan**: 无 TBD / TODO / FIXME / "适当处理"。所有代码块完整。

**3. Type consistency**:
- `pickJpNodes` 返回 `{ filtered, misses, usedWhitelist }` — Task 2 定义、Task 4 调用一致
- `_state.jp.whitelist: string[]` — Task 3 定义、Task 4 写入、Task 7 UI 读出
- `_state.jp.whitelistMisses: string[]` — Task 3 定义、Task 4 写入、Task 8 UI 显示
- `_state.allTags: string[]` — Task 3 定义、Task 4 写入、Task 6 读出
- `form.proxyJpWhitelist: string[]` — Task 7 定义、Task 7 写回 payload.jpCheckout.whitelist
- UI 字段名 `allNodeTags` / `jpKddiTagSet` — Task 7 定义、Task 8 在 template 引用
- `/api/proxy/nodes` 响应 `{ nodeTags, total, jpKddiTags }` — Task 6 定义、Task 7 loadAllNodes 解构

跨 task 字段名/类型一致。
