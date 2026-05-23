# 主代理节点白名单 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给主代理通道复刻 JP 通道已有的白名单模式 —— `cfg.proxy.whitelist` 精确 tag 优先；空时回退 `regionFilter`；双空时用全部节点；UI 提供下拉 + 高亮 + misses 警告。

**Architecture:** 新增 pure 决策函数 `pickMainNodes(all, mainCfg)`（与 `pickJpNodes` 同构）。`refresh()` 中替换"硬编码 `filterByRegion`" 为 `pickMainNodes` 调用。`_state` 加 `whitelist` / `whitelistMisses` 两个字段。Config.vue 加 `el-select multiple filterable` 下拉 + `regionFilter` 灰显逻辑 + 状态卡 misses 行。

**Tech Stack:** Node.js / Vue 3 + Element Plus / `node:test` 内置测试。

**Spec:** `docs/superpowers/specs/2026-05-24-main-proxy-whitelist-design.md`

---

## 文件清单

**修改：**
- `server/proxy/index.js` — _state 加字段，新增 pickMainNodes，refresh 集成，module.exports
- `server/proxy/__tests__/index.test.js` — 追加 W1-W7 单测（仿现有 pickJpNodes 测试）
- `server/routes/proxy.js` — `/proxy/nodes` 端点加 `usTags` 字段
- `web/src/views/Config.vue` — UI 模板 + script setup
- `docs/CHANGELOG.md` — 追加 v2.21 节

**不动：** `server/proxy/subscription.js`（`filterByWhitelist` / `filterByRegion` / `US_PATTERNS` 已存在并已 export）；engines / blacklist.js / 其他路由。

---

## Task 1：pickMainNodes 决策函数 + _state 增量（TDD W1-W7）

**Files:**
- Modify: `server/proxy/index.js`
- Modify: `server/proxy/__tests__/index.test.js`

### Step 1：追加 W1-W7 测试

- [ ] **Step 1:** Append to `server/proxy/__tests__/index.test.js`（在文件末尾，最后一个测试之后）:

```js
// ============== W1-W7: pickMainNodes — main-channel whitelist ==============

test('W1 pickMainNodes: whitelist 非空时优先使用白名单', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'us-NY-2' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: ['nodeA'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, []);
});

test('W2 pickMainNodes: whitelist 空 → regionFilter 关键字分支', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'us-NY-2' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 2);  // us-LA-1, us-NY-2 命中 US_PATTERNS
  assert.deepStrictEqual(r.misses, []);
});

test('W3 pickMainNodes: cfg null/undefined 返回空', () => {
  assert.deepStrictEqual(proxy.pickMainNodes([{ tag: 'x' }], null),
    { filtered: [], misses: [], usedWhitelist: false });
  assert.deepStrictEqual(proxy.pickMainNodes([{ tag: 'x' }], undefined),
    { filtered: [], misses: [], usedWhitelist: false });
});

test('W4 pickMainNodes: whitelist 含不存在 tag 时收集 misses', () => {
  const all = [{ tag: 'nodeA' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: ['nodeA', 'gone-1', 'gone-2'] });
  assert.strictEqual(r.usedWhitelist, true);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'nodeA');
  assert.deepStrictEqual(r.misses, ['gone-1', 'gone-2']);
});

test('W5 pickMainNodes: whitelist 非数组（字符串误填）视为空 → fallback regionFilter', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }];
  const r = proxy.pickMainNodes(all, { regionFilter: 'US', whitelist: 'US' });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);
  assert.strictEqual(r.filtered[0].tag, 'us-LA-1');
});

test("W6 pickMainNodes: 双空 (whitelist=[], regionFilter='') → 全部节点", () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }, { tag: 'jp-1' }];
  const r = proxy.pickMainNodes(all, { regionFilter: '', whitelist: [] });
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 3);  // 全部通过
  assert.deepStrictEqual(r.misses, []);
});

test('W7 pickMainNodes: regionFilter 字段缺失 → 默认 US', () => {
  const all = [{ tag: 'nodeA' }, { tag: 'us-LA-1' }];
  const r = proxy.pickMainNodes(all, { whitelist: [] });  // regionFilter undefined
  assert.strictEqual(r.usedWhitelist, false);
  assert.strictEqual(r.filtered.length, 1);  // 默认 US 过滤
  assert.strictEqual(r.filtered[0].tag, 'us-LA-1');
});
```

### Step 2：跑测试确认失败

- [ ] **Step 2:**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: 7 个新用例 FAIL，错误 `proxy.pickMainNodes is not a function`。其余既有用例 PASS。

### Step 3：改 `server/proxy/index.js` 顶部 require

- [ ] **Step 3:** Find line 5:

```js
const { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist } = require('./subscription');
```

Replace with（追加 `US_PATTERNS`）:

```js
const { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist, US_PATTERNS } = require('./subscription');
```

### Step 4：在 `_state` 增量加 whitelist / whitelistMisses

- [ ] **Step 4:** Find the `_state` initializer block (around line 35-66). Locate the line:

```js
  allTags: [],   // 订阅里全部节点 tag (refresh 时缓存，供 /api/proxy/nodes 用)
```

Insert these two lines IMMEDIATELY BEFORE that `allTags` line (so they group with main-channel fields, mirroring `_state.jp.whitelist`/`whitelistMisses` placement inside the jp block):

```js
  whitelist: [],          // 用户配置的 tag 数组（与 _state.jp.whitelist 同语义）
  whitelistMisses: [],    // 订阅中缺失的 tag（UI 黄色提示）
```

### Step 5：新增 `pickMainNodes` 函数

- [ ] **Step 5:** Find the existing `pickJpNodes` function (around line 167-180). Insert the new function IMMEDIATELY BEFORE `pickJpNodes`:

```js
/**
 * Decide main-channel node pool.
 * 与 pickJpNodes 同构：whitelist 非空时优先精确 tag 匹配；空时回退 regionFilter 关键字；
 * 双空时（regionFilter 为空字符串/未设）返回全部节点。
 *
 * @param {Array} all                 — 订阅解析后的全部节点
 * @param {Object} mainCfg            — cfg.proxy 子对象
 * @param {Array<string>} mainCfg.whitelist
 * @param {string} mainCfg.regionFilter
 * @returns {{ filtered: Array, misses: string[], usedWhitelist: boolean }}
 */
function pickMainNodes(all, mainCfg) {
  if (!mainCfg) return { filtered: [], misses: [], usedWhitelist: false };
  const whitelist = Array.isArray(mainCfg.whitelist) ? mainCfg.whitelist : [];
  if (whitelist.length > 0) {
    const filtered = filterByWhitelist(all, whitelist);
    const presentTags = new Set(all.map(o => o.tag));
    const misses = whitelist.filter(t => typeof t === 'string' && t && !presentTags.has(t));
    return { filtered, misses, usedWhitelist: true };
  }
  // ?? 而不是 ||：仅在 regionFilter 字段缺失（undefined/null）时默认 'US'；
  // 显式空字符串透传给 filterByRegion，触发其 "不过滤" 分支（subscription.js:174）。
  const filtered = filterByRegion(all, mainCfg.regionFilter ?? 'US');
  return { filtered, misses: [], usedWhitelist: false };
}
```

### Step 6：`module.exports` 追加 `pickMainNodes` + `US_PATTERNS`

- [ ] **Step 6:** Find the `module.exports = { ... }` block (around line 559-591). Find this line:

```js
  pickJpNodes,
```

Insert IMMEDIATELY AFTER it:

```js
  pickMainNodes,
  US_PATTERNS,
```

### Step 7：跑测试确认 PASS

- [ ] **Step 7:**

Run: `node --test server/proxy/__tests__/index.test.js`
Expected: ALL PASS — 既有用例（24+）+ 新 W1-W7（7 个） = 31+ 个。

### Step 8：跑全 proxy 套件确认无回归

- [ ] **Step 8:**

Run: `node --test server/proxy/__tests__/blacklist.test.js server/proxy/__tests__/index.test.js server/proxy/__tests__/rotation.test.js server/proxy/__tests__/subscription.test.js`
Expected: ALL PASS（之前 45 + 7 新 = 52 个）。

### Step 9：Commit

- [ ] **Step 9:**

```bash
git add server/proxy/index.js server/proxy/__tests__/index.test.js
git commit -m "$(cat <<'EOF'
feat(proxy): pickMainNodes — main-channel whitelist (mirrors pickJpNodes)

新增 pickMainNodes 决策函数（whitelist 优先 → regionFilter fallback →
双空 fallback all），_state 加 whitelist/whitelistMisses 字段。
regionFilter 用 ?? 而不是 || 默认，让显式空字符串透传到 filterByRegion
的 "不过滤" 分支。7 个新单测（W1-W7）覆盖 5 种正常路径 + 双空 + 字段缺失
两个边界。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：refresh() 集成 pickMainNodes

**Files:**
- Modify: `server/proxy/index.js`

### Step 1：修改 cfg 读取段 + 加 whitelist 行

- [ ] **Step 1:** Find this block in `refresh()`（around lines 236-238）:

```js
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter || 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
```

Replace with（`??` 替 `||` + 追加 `whitelist` 行）:

```js
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter ?? 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
  _state.whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist : [];
```

### Step 2：替换主通道筛选块

- [ ] **Step 2:** Find this block in `refresh()`（around lines 259-267）:

```js
  // Main channel filtering — strict only when enabled by config.
  let filtered = [];
  if (mainEnabledByConfig) {
    filtered = filterByRegion(all, _state.rotationKeyword);
    console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
    if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);
  } else {
    console.log(`[Proxy] Main channel disabled by config`);
  }
```

Replace with:

```js
  // Main channel filtering — strict only when enabled by config.
  let filtered = [];
  let mainPick = { filtered: [], misses: [], usedWhitelist: false };
  if (mainEnabledByConfig) {
    mainPick = pickMainNodes(all, cfg);
    filtered = mainPick.filtered;
    if (mainPick.usedWhitelist) {
      console.log(`[Proxy] Main whitelist: ${filtered.length}/${_state.whitelist.length} matched (${mainPick.misses.length} missing${mainPick.misses.length > 0 ? ': ' + mainPick.misses.join(', ') : ''})`);
    } else {
      console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
    }
    if (mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`主代理白名单 [${_state.whitelist.join(', ')}] 在订阅中无任何匹配`);
    }
    if (!mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);
    }
  } else {
    console.log(`[Proxy] Main channel disabled by config`);
  }
  _state.whitelistMisses = mainPick.misses;
```

### Step 3：跑全 proxy 套件确认无回归

- [ ] **Step 3:**

`rotation.test.js` 中现有的 R1-R5 测试已 mock 了 `subscription.filterByRegion`，refresh 集成后行为同构 —— 验证不会破：

Run: `node --test server/proxy/__tests__/blacklist.test.js server/proxy/__tests__/index.test.js server/proxy/__tests__/rotation.test.js server/proxy/__tests__/subscription.test.js`
Expected: ALL PASS（52 个全部通过）。

### Step 4：Commit

- [ ] **Step 4:**

```bash
git add server/proxy/index.js
git commit -m "$(cat <<'EOF'
feat(proxy): refresh() 集成 pickMainNodes（含 whitelist + ?? 改 ||）

cfg 读取段 _state.rotationKeyword 用 ?? 替 ||（保留显式空字符串"不过滤"语义），
追加 _state.whitelist = ... 行。主通道筛选块从硬编码 filterByRegion 改为
调用 pickMainNodes(all, cfg)，按 usedWhitelist 分流日志格式 + throw 文案，
末尾写 _state.whitelistMisses。与 JP 通道 refresh 段同结构。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：`/proxy/nodes` 端点加 `usTags`

**Files:**
- Modify: `server/routes/proxy.js`

### Step 1：修改 endpoint

- [ ] **Step 1:** Find this block in `server/routes/proxy.js`（around line 69-74）:

```js
router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags });
});
```

Replace with:

```js
router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  const usTags = allTags.filter(t => proxy.US_PATTERNS.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags, usTags });
});
```

### Step 2：跑既有路由测试确认无回归

- [ ] **Step 2:**

Run: `node --test server/__tests__/proxy-route-blacklist.test.js`
Expected: PASS（4 个用例不受影响，因为它们 mock 了 proxy 模块；新加的 usTags 字段在 mock 里没用到）。

### Step 3：手动 smoke test（可选但推荐）

- [ ] **Step 3:** Manual smoke（如果 `node server/index.js` 已启动）:

```bash
curl -s http://localhost:3000/api/proxy/nodes | head -c 200
```

Expected: 响应 JSON 含 `usTags: [...]` 字段。如果代理未启用，`usTags` 是空数组。

### Step 4：Commit

- [ ] **Step 4:**

```bash
git add server/routes/proxy.js
git commit -m "$(cat <<'EOF'
feat(api): GET /proxy/nodes 加 usTags 字段（供 UI 主白名单下拉高亮）

usTags = allTags.filter(US_PATTERNS.test)，与 jpKddiTags 同模式。
proxy.US_PATTERNS 已在前一 commit 从 subscription.js re-export。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：Config.vue UI

**Files:**
- Modify: `web/src/views/Config.vue`

### Step 1：模板 —— 加白名单下拉 + regionFilter 灰显

- [ ] **Step 1:** Find this block in `web/src/views/Config.vue` template（around lines 73-78）:

```vue
      <el-form-item label="机场订阅 URL">
        <el-input v-model="form.proxySubscriptionUrl" placeholder="https://.../subscribe?token=..." />
      </el-form-item>
      <el-form-item label="区域过滤">
        <el-input v-model="form.proxyRegionFilter" placeholder="留空=不过滤；US=仅美国" />
      </el-form-item>
```

Replace with（中间插入"节点白名单"，并把"区域过滤"加 disabled + 提示）:

```vue
      <el-form-item label="机场订阅 URL">
        <el-input v-model="form.proxySubscriptionUrl" placeholder="https://.../subscribe?token=..." />
      </el-form-item>
      <el-form-item label="节点白名单">
        <el-select v-model="form.proxyWhitelist" multiple filterable clearable
                   collapse-tags collapse-tags-tooltip
                   placeholder="留空 = 按区域关键字过滤；选中 = 精确指定节点"
                   style="width: 480px">
          <el-option v-for="tag in allNodeTags" :key="tag" :label="tag" :value="tag">
            <span :style="usTagSet.has(tag) ? 'font-weight:600;color:#67c23a' : ''">
              {{ tag }}
            </span>
            <span v-if="usTagSet.has(tag)" style="float:right;color:#67c23a;font-size:11px">US</span>
          </el-option>
        </el-select>
        <div style="font-size:12px;color:#909399;margin-top:4px">
          匹配 regionFilter 的节点已绿色高亮。空 = 关键字过滤模式（默认）。
        </div>
      </el-form-item>
      <el-form-item label="区域过滤">
        <el-input v-model="form.proxyRegionFilter" placeholder="留空=不过滤；US=仅美国"
                  :disabled="form.proxyWhitelist?.length > 0" />
        <span v-if="form.proxyWhitelist?.length > 0"
              style="color:#909399;margin-left:8px;font-size:12px">已被白名单覆盖</span>
      </el-form-item>
```

### Step 2：模板 —— 代理状态卡加 misses 黄色行

- [ ] **Step 2:** Find the existing "代理状态" form-item block（around lines 206-214）:

```vue
      <el-form-item label="代理状态" v-if="proxyStatus">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.enabled ? '运行中' : '未运行' }} ({{ proxyStatus.nodeTags?.length || 0 }} 节点)</div>
          <div v-if="proxyStatus.currentNode">当前节点：{{ proxyStatus.currentNode }}</div>
          <div v-if="proxyStatus.exitIp">出口 IP：{{ proxyStatus.exitIp }}</div>
          <div v-if="proxyStatus.lastError" style="color:#f56c6c">错误：{{ proxyStatus.lastError }}</div>
        </div>
      </el-form-item>
```

Replace with（加 whitelist 计数 + misses 行）:

```vue
      <el-form-item label="代理状态" v-if="proxyStatus">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.enabled ? '运行中' : '未运行' }}
               ({{ proxyStatus.nodeTags?.length || 0 }} 节点<span
                  v-if="proxyStatus.whitelist?.length"> / 白名单 {{ proxyStatus.whitelist.length }} 个</span>)</div>
          <div v-if="proxyStatus.currentNode">当前节点：{{ proxyStatus.currentNode }}</div>
          <div v-if="proxyStatus.exitIp">出口 IP：{{ proxyStatus.exitIp }}</div>
          <div v-if="proxyStatus.whitelistMisses?.length"
               style="color:#e6a23c;margin-top:4px">
            ⚠ 白名单未命中：{{ proxyStatus.whitelistMisses.slice(0,3).join(', ') }}{{
              proxyStatus.whitelistMisses.length > 3 ? `... 共 ${proxyStatus.whitelistMisses.length} 个` : ''
            }}
          </div>
          <div v-if="proxyStatus.lastError" style="color:#f56c6c">错误：{{ proxyStatus.lastError }}</div>
        </div>
      </el-form-item>
```

### Step 3：Script setup —— 加 `usTagSet` ref

- [ ] **Step 3:** Find this line in `<script setup>`（around line 159）:

```js
const jpKddiTagSet = ref(new Set())
```

Insert IMMEDIATELY AFTER it:

```js
const usTagSet = ref(new Set())
```

### Step 4：Script setup —— form 加 `proxyWhitelist`

- [ ] **Step 4:** Find this block in `form = reactive({ ... })`（around lines 175-182）:

```js
  proxyEnabled: false,
  proxySubscriptionUrl: '',
  proxyRegionFilter: 'US',
  proxyRotationStrategy: 'sequential',
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
  proxyJpWhitelist: [],
```

Replace with（在 proxyRotationStrategy 之后追加 proxyWhitelist 字段）:

```js
  proxyEnabled: false,
  proxySubscriptionUrl: '',
  proxyRegionFilter: 'US',
  proxyRotationStrategy: 'sequential',
  proxyWhitelist: [],
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
  proxyJpWhitelist: [],
```

### Step 5：Script setup —— `loadAllNodes` 加 usTags 解析

- [ ] **Step 5:** Find this function（around lines 221-229）:

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

Replace with:

```js
async function loadAllNodes() {
  try {
    const { data } = await api.get('/proxy/nodes')
    allNodeTags.value = data.nodeTags || []
    jpKddiTagSet.value = new Set(data.jpKddiTags || [])
    usTagSet.value = new Set(data.usTags || [])
  } catch {
    allNodeTags.value = []
    jpKddiTagSet.value = new Set()
    usTagSet.value = new Set()
  }
}
```

### Step 6：Script setup —— onMounted cfg.proxy 解析加 1 行

- [ ] **Step 6:** Find this block in `onMounted`（around lines 195-203）:

```js
    if (cfg.proxy) {
      if (cfg.proxy.enabled !== undefined) form.proxyEnabled = cfg.proxy.enabled
      if (cfg.proxy.subscriptionUrl !== undefined) form.proxySubscriptionUrl = cfg.proxy.subscriptionUrl
      if (cfg.proxy.regionFilter !== undefined) form.proxyRegionFilter = cfg.proxy.regionFilter
      if (cfg.proxy.rotationStrategy !== undefined) form.proxyRotationStrategy = cfg.proxy.rotationStrategy
      if (cfg.proxy.jpCheckout) {
        if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
        if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
        if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist
      }
    }
```

Replace with（在 rotationStrategy 行之后追加 whitelist 解析）:

```js
    if (cfg.proxy) {
      if (cfg.proxy.enabled !== undefined) form.proxyEnabled = cfg.proxy.enabled
      if (cfg.proxy.subscriptionUrl !== undefined) form.proxySubscriptionUrl = cfg.proxy.subscriptionUrl
      if (cfg.proxy.regionFilter !== undefined) form.proxyRegionFilter = cfg.proxy.regionFilter
      if (cfg.proxy.rotationStrategy !== undefined) form.proxyRotationStrategy = cfg.proxy.rotationStrategy
      if (Array.isArray(cfg.proxy.whitelist)) form.proxyWhitelist = cfg.proxy.whitelist
      if (cfg.proxy.jpCheckout) {
        if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
        if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
        if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist
      }
    }
```

### Step 7：Script setup —— handleSave 序列化加 whitelist 字段

- [ ] **Step 7:** Find this block in `handleSave`（around lines 235-253）:

```js
    const payload = { ...form }
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyRotationStrategy
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
    delete payload.proxyJpWhitelist
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
        whitelist: form.proxyJpWhitelist || [],
      },
    }
```

Replace with（追加 `delete payload.proxyWhitelist` + `payload.proxy.whitelist: ...`）:

```js
    const payload = { ...form }
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyRotationStrategy
    delete payload.proxyWhitelist
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
    delete payload.proxyJpWhitelist
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
      whitelist: form.proxyWhitelist || [],
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
        whitelist: form.proxyJpWhitelist || [],
      },
    }
```

### Step 8：前端 build

- [ ] **Step 8:**

```bash
cd web && npm run build
```

Expected: Vite build 成功，`web/dist/index.html` 更新，无 Vue 编译错误。

### Step 9：Grep 验证

- [ ] **Step 9:**

```bash
grep -c "proxyWhitelist" web/src/views/Config.vue   # 期望 >= 5（form 字段 1 + onMounted 1 + handleSave 2 + template 2 处 disabled + 模板 v-model 1 = 应该 >= 5）
grep -c "usTagSet" web/src/views/Config.vue         # 期望 >= 4
grep -c "节点白名单" web/src/views/Config.vue        # 期望 1
grep -c "已被白名单覆盖" web/src/views/Config.vue    # 期望 1
grep -c "白名单未命中" web/src/views/Config.vue      # 期望 1
```

### Step 10：Commit

- [ ] **Step 10:**

```bash
git add web/src/views/Config.vue
git commit -m "$(cat <<'EOF'
feat(web/config): 主代理节点白名单下拉 + US 高亮 + misses 警告

模板：在订阅 URL 与区域过滤之间插入"节点白名单" el-select multiple filterable，
匹配 regionFilter 的节点绿色加粗 + 'US' 标签；区域过滤在白名单非空时灰显 + 提示。
代理状态卡加 whitelist 计数 + misses 黄色行。

Script setup：usTagSet ref；form 加 proxyWhitelist；loadAllNodes 解析
data.usTags；onMounted 解析 cfg.proxy.whitelist；handleSave 序列化 whitelist。

与 JP 通道 UI 完全同模式（KDDI 绿色 → US 绿色；jpKddiTagSet → usTagSet）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：CHANGELOG v2.21 节

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1：插入 v2.21 节

- [ ] **Step 1:** Insert at the top of `docs/CHANGELOG.md`（在最顶层 `# Changelog` 标题下，最新一节之前）:

```markdown
## v2.21.0 — 2026-05-24

### Main Proxy Node Whitelist

主代理通道之前只有 `regionFilter` 关键字筛选（默认 `'US'`，走大型正则）。用户想精确指定几个节点只能祈祷它们 tag 共享同一关键字。复刻 JP-Checkout 通道（v2.18.1）的成熟白名单模式，主通道获得对称能力。

**核心改动：**

- **新字段** `cfg.proxy.whitelist: string[]` —— 精确 tag 列表。
- **新决策函数** `pickMainNodes(all, mainCfg)` —— 与 `pickJpNodes` 同构：whitelist 非空时精确匹配（`filterByWhitelist`），空时回退 `regionFilter` 关键字（`filterByRegion`），**双空** 时（regionFilter 为空字符串/未设）返回全部节点。
- **`refresh()` 集成** —— 主通道筛选块改用 `pickMainNodes`，按 `usedWhitelist` 分流日志格式；全不命中订阅时 throw 不静默退化（与 JP 同）。
- **`regionFilter` 默认 `'US'` 仅当字段缺失**：显式空字符串现在被识别为"不过滤"，统一规则用 `??` 替原 `||`。
- **`GET /api/proxy/nodes` 加 `usTags`** —— UI 主白名单下拉据此高亮匹配 regionFilter 的节点。
- **Config.vue 节点白名单分节** —— `el-select multiple filterable` + US 节点绿色加粗 + 'US' 标签；区域过滤输入框在白名单非空时灰显 + "已被白名单覆盖" 提示；代理状态卡加 whitelist 计数 + misses 黄色行。

**对外契约扩展（无破坏）**：`getState()` 返回多两个字段 `whitelist` / `whitelistMisses`（与 `_state.jp.whitelist` 同语义）。Config.vue 是唯一消费者，新增渲染逻辑兼容旧响应（undefined 时不渲染）。

**单测**：`server/proxy/__tests__/index.test.js` +7（W1-W7：5 个仿 pickJpNodes 同号 + W6 双空边界 + W7 字段缺失边界）。proxy 套件总 45→52 用例，无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-main-proxy-whitelist-design.md` + `docs/superpowers/plans/2026-05-24-main-proxy-whitelist.md`。

```

### Step 2：跑全套测试做最终冒烟

- [ ] **Step 2:**

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js
```

Expected: 全 PASS（含 W1-W7 共 89+ 个）。

Run Python 套件：

```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: 4/4 PASS。

### Step 3：人工验证清单（运维侧，PR 评审 checklist）

- [ ] **Step 3:** 启动服务后逐条跑：
  - [ ] `config.json` 写 `proxy.whitelist: ["us-LA-1", "us-NY-2"]`，重启，控制台显示 `Main whitelist: 2/2 matched (0 missing)`
  - [ ] 清空 whitelist 字段，重启 → 控制台回到 `After region filter (US): N`
  - [ ] whitelist 写 3 个全错 tag，重启 → 服务 throw `主代理白名单 [...] 在订阅中无任何匹配`
  - [ ] whitelist 写 2 对 1 错，重启 → 正常启动，状态卡显示"⚠ 白名单未命中：xxx"黄色行
  - [ ] UI Config 页：白名单下拉 US 节点绿色加粗 + 'US' 标签；选中节点后"区域过滤"输入框灰显 + "已被白名单覆盖"
  - [ ] 主白名单 + JP 白名单同时生效，两通道互不影响
  - [ ] `regionFilter` 设为空字符串 + 白名单空 → 节点池等于订阅全部节点

### Step 4：Commit

- [ ] **Step 4:**

```bash
git add docs/CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: v2.21.0 main-proxy node whitelist

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 全套测试一遍（实施完成后最终冒烟）

- [ ] 所有 5 个任务完成后：

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js
py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: 全 PASS。
