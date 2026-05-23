# 主代理节点白名单设计

**Date:** 2026-05-24
**Status:** Draft → 待评审
**Predecessors:** v2.18.1 (jp-checkout-whitelist), v2.20.0 (proxy blacklist + rotation cursor)

## Background

`server/proxy/index.js` 当前对主代理通道的节点筛选只有 `cfg.proxy.regionFilter` 一个机制：默认 `'US'`，走 `filterByRegion` 内的大型 `US_PATTERNS` 正则（国旗 emoji / 中文 / 城市名）。用户想精确指定几个节点只能祈祷他们 tag 共享同一个关键字，否则要构造复杂的关键字串，且不可控。

JP-Checkout 通道（v2.18.1）已经有成熟的"白名单优先 + 关键字 fallback"模式（`pickJpNodes` + `_state.jp.whitelist` + `_state.jp.whitelistMisses` + UI `el-select multiple filterable` + 节点高亮 + misses 黄色提示 + 全不命中 throw）。

主代理通道复刻同一模式，使两个通道行为一致、UI 对称、用户读一处即理解二处。

## Goals

1. `cfg.proxy.whitelist: string[]` 支持精确 tag 列表，绕过 regionFilter 关键字筛选。
2. 白名单空时退回 regionFilter（现状行为不变）。
3. 白名单 + regionFilter **双空**时使用全部订阅节点（不过滤）。
4. 全部不命中订阅时 throw 报错，不静默退化。
5. Config.vue UI 提供与 JP 白名单同构的下拉，匹配 regionFilter 的节点视觉高亮 + 'US' 标签 + misses 黄色提示。

## Non-Goals

- 不抽象通用 `pickChannelNodes(all, cfg, fallbackFn)` —— 项目当前只有 2 个通道，过早抽象。第 3 个通道（如 SG / EU）出现时再做。
- 不交集 / 并集语义（白名单与 regionFilter 互斥独立）。
- 不持久化 whitelist 到 `data.db` —— 白名单是配置，进 `config.json`；与 v2.20 黑名单的运行时状态不同维度。
- 不为 `/proxy/nodes` 端点新增的 `usTags` 字段写自动化测试 —— 是 1 行 `allTags.filter(US_PATTERNS.test)` 的纯函数，间接被 `subscription.test.js` 覆盖。

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 白名单 vs regionFilter | 白名单优先，空时回退 regionFilter | 与 JP 通道完全同模式 |
| UI 高亮 | 匹配 regionFilter 的节点绿色加粗 + 'US' 标签 | 与 JP 的 KDDI 绿色加粗 + 'KDDI' 标签同构 |
| 全不命中 | throw 报错 | 与 JP 同；明确的"配置错误，需人为介入" |
| 白名单 + regionFilter **双空** | 用全部节点（无过滤） | 用户原意 "默认全部节点都是白名单里的" |
| `regionFilter` 默认值 | `'US'`（仅当字段缺失），显式空字符串 → 不过滤 | 兼容现有配置；空字符串透传 `filterByRegion('')` 已有的"不过滤"行为 |
| 方案选型 | 直接复刻 JP 模式（非通用抽象） | 改动小、对称美观、风险低 |

## Architecture

```
server/proxy/index.js              ← _state 加 whitelist/whitelistMisses；新增 pickMainNodes；refresh 集成
server/proxy/__tests__/index.test.js  ← 加 W1-W5 单测（仿 pickJpNodes 同号）
server/routes/proxy.js             ← /proxy/nodes 端点加 usTags 字段
web/src/views/Config.vue           ← 加白名单下拉 + regionFilter 灰显逻辑 + 代理状态卡 misses 行
```

**不动**：`server/proxy/subscription.js`（`filterByWhitelist` / `filterByRegion` 已存在）、engine / chatgpt-checkout / 黑名单代码（独立维度）。

### 语义模型

```
配置：cfg.proxy.whitelist + cfg.proxy.regionFilter
↓
pickMainNodes(all, cfg.proxy) → { filtered, misses, usedWhitelist }
↓
1. whitelist 非空        → filterByWhitelist(all, whitelist) → 精确 tag 匹配；misses 收集；全不命中 throw
2. whitelist 空, regionFilter 非空字符串 → filterByRegion(all, regionFilter)
3. whitelist 空, regionFilter '' / 'all' → 全部节点
```

### 关键不变式

1. 主通道和 JP 通道的白名单逻辑 **完全镜像**：决策函数同构、`{filtered, misses, usedWhitelist}` 同 shape、throw 行为一致、UI 高亮模式一致。
2. 黑名单逻辑 **正交**：白名单只决定节点池范围，`rotate()` 仍照常跳过 badNodes。
3. `regionFilter` 字段缺失 → 默认 'US'（向后兼容）；显式空字符串 → "不过滤"（新语义）。两种语义区分仅靠 `??` 与 `||` 的差别。

## Data Structures

### `config.json` 增量

```jsonc
{
  "proxy": {
    "enabled": true,
    "subscriptionUrl": "https://...",
    "regionFilter": "US",                 // 现有，作 fallback
    "rotationStrategy": "sequential",
    "whitelist": [                        // 新增（可缺省 = [])
      "us-LA-residential-01",
      "us-NY-residential-02"
    ],
    "jpCheckout": { ... }                 // 现有，不变
  }
}
```

向后兼容：缺省即 `[]`，行为与现状一致（走 regionFilter）。无迁移需求。

### `_state` 增量（`server/proxy/index.js`）

在 `_state = { ... }` 主通道顶层新增两个字段（不在 `_state.jp` 里），与 JP 对称：

```js
let _state = {
  // ... 现有字段 ...
  whitelist: [],          // 用户配置的 tag 数组
  whitelistMisses: [],    // 订阅中缺失的 tag（UI 黄色提示）
  // ... 其他既有字段不变 ...
  jp: { /* 不变 */ },
};
```

### `getState()` 输出对外契约扩展

`getState()` 自动 spread `_state`，新字段直接出现在响应里：

```js
// GET /api/proxy/status 响应新增
{
  whitelist: ["us-LA-residential-01", "us-NY-residential-02"],
  whitelistMisses: ["us-LA-residential-01"],
  // ... 其他既有字段不变
}
```

非 breaking change —— Config.vue 多读两个字段，旧消费者不受影响。

## pickMainNodes 决策函数

放在 `server/proxy/index.js` 既有 `pickJpNodes` 旁边，便于对照阅读：

```js
/**
 * Decide main-channel node pool.
 * 与 pickJpNodes 同构：whitelist 非空时优先精确 tag 匹配；空时回退到 regionFilter 关键字；
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
  // 显式空字符串透传给 filterByRegion，触发其"不过滤"分支（subscription.js:174）。
  const filtered = filterByRegion(all, mainCfg.regionFilter ?? 'US');
  return { filtered, misses: [], usedWhitelist: false };
}
```

与 `pickJpNodes` 的差异：
1. fallback 函数不同（`filterByRegion` vs `filterByJpKddi`）
2. 入口 cfg 结构不同（直接传 `cfg.proxy`，JP 通道传 `cfg.proxy.jpCheckout`）
3. 没有 `enabled` 短路（主通道 enabled 判定在 `refresh()` 外层做，与 JP 调用方式一致）

导出：`module.exports = { ... }` 追加 `pickMainNodes`（与 `pickJpNodes` 同样作为可测试 pure function 暴露）+ `US_PATTERNS`（供 routes 使用）。

## refresh() 集成

### cfg 读取段（`refresh()` 顶部，约第 235-247 行）

**Find**:
```js
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter || 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
```

**Replace with**（同样 `??` 替 `||`，让显式空字符串透传到 UI 状态展示）：
```js
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter ?? 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
  _state.whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist : [];
```

### 主通道筛选块（约第 260-267 行）

**Find**:
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

**Replace with**:
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

### 日志格式

| 场景 | 日志 |
|---|---|
| 白名单全命中 | `[Proxy] Main whitelist: 3/3 matched (0 missing)` |
| 部分命中 | `[Proxy] Main whitelist: 2/3 matched (1 missing: us-old-tag)` |
| 走 regionFilter | `[Proxy] After region filter (US): 12` |
| 双空（全部节点） | `[Proxy] After region filter (): 47`（"为空" 即不过滤）|
| 白名单全不命中 → throw | `[Proxy] Main whitelist: 0/2 matched (2 missing: ...)` 然后 throw |

## REST API · `/proxy/nodes` 配合 UI 高亮

`GET /api/proxy/nodes` 当前返回 `{ nodeTags, total, jpKddiTags }`。追加 `usTags`：

```js
router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  const usTags = allTags.filter(t => proxy.US_PATTERNS.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags, usTags });
});
```

`proxy.US_PATTERNS` 需从 `subscription.js` 穿透到 `index.js` re-export（`subscription.js` 早已 export，`index.js` 加一行 destructure + 加 export 即可）。

## UI · Config.vue

### 模板改动

在"代理 / 节点轮换"分节内，**`机场订阅 URL` 之后、`区域过滤` 之前** 插入白名单下拉；同时把现有 `区域过滤` 改为在白名单非空时灰显（与 JP 现有逻辑对齐）：

```vue
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

在"代理状态"卡片里增加 misses 黄色提示行（与 JP 状态卡同模式）。**Find**：

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

**Replace with**:

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

### Script setup 改动

**(a)** 加 `usTagSet` ref（在 `const jpKddiTagSet = ref(new Set())` 旁边）：

```js
const usTagSet = ref(new Set())
```

**(b)** `form` reactive 加 `proxyWhitelist: []` 字段。

**(c)** `loadAllNodes()` 同时取 `usTags`：

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

**(d)** `onMounted` 中 `cfg.proxy` 解析段加 1 行：
```js
if (Array.isArray(cfg.proxy.whitelist)) form.proxyWhitelist = cfg.proxy.whitelist
```

**(e)** `handleSave` 的 `payload.proxy = {...}` 加 1 字段：
```js
whitelist: form.proxyWhitelist || [],
```

## 测试策略

延续 `node:test` + `node --test` 惯例。新增的都是 pure function 单测。

### `server/proxy/__tests__/index.test.js` 追加 W1-W5

完全镜像 `pickJpNodes` 现有 5 个测试（`index.test.js:74-115`）：

| # | 用例 | 关键断言 |
|---|---|---|
| W1 | whitelist 非空时优先使用白名单 | `usedWhitelist === true`，filtered 只含白名单 tag |
| W2 | whitelist 空 → fallback 到 regionFilter 关键字 | `usedWhitelist === false`，filtered 走 `filterByRegion('US')` |
| W3 | cfg 为 null/undefined 返回空 | `{ filtered: [], misses: [], usedWhitelist: false }` |
| W4 | whitelist 含订阅缺失 tag 时收集 misses | `misses` 数组包含未匹配 tag |
| W5 | whitelist 非数组（字符串误填）视为空 → fallback regionFilter | `usedWhitelist === false`，按 regionFilter 走 |

完整代码：

```js
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
  assert.strictEqual(r.filtered.length, 2);
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

W6 + W7 是 spec 决策"`'US'` 默认仅当字段缺失，显式空字符串 → 不过滤"的精准 pin。

### 不写自动化测试

- `routes/proxy.js` 的 `usTags` 字段（1 行 filter，间接被 `subscription.test.js` 覆盖）
- `refresh()` 集成（既有 `rotation.test.js` 已 mock 了 `filterByRegion`，行为同构）
- UI 组件（项目无前端测试基础设施）

### 人工验证清单

- [ ] `config.json` 写入 `proxy.whitelist: ["us-LA-1", "us-NY-2"]`，重启服务，控制台 log 显示 `Main whitelist: 2/2 matched (0 missing)`
- [ ] 清空 whitelist（或删除字段），重启，控制台回到 `After region filter (US): N`
- [ ] whitelist 写 3 个全是错的 tag，重启 → 服务启动 throw `主代理白名单 [...] 在订阅中无任何匹配`
- [ ] whitelist 写 2 对 1 错，重启 → 正常启动，状态卡显示"⚠ 白名单未命中：xxx"黄色行
- [ ] UI Config 页：白名单下拉里 US 节点绿色加粗 + 'US' 标签；选中节点后"区域过滤"输入框灰显 + "已被白名单覆盖"
- [ ] 主白名单 + JP 白名单同时生效，两通道互不影响
- [ ] `regionFilter` 设为空字符串 + 白名单空 → 节点池等于订阅全部节点

## 实施顺序建议（供 writing-plans 参考）

1. **`server/proxy/index.js`** —— 顶部 `require` 加 `US_PATTERNS`；`_state` 加 `whitelist` / `whitelistMisses`；新增 `pickMainNodes`；`refresh()` cfg 读取段 `??` 替 `||` + 加 whitelist 行；筛选块替换；`module.exports` 加 `pickMainNodes` + `US_PATTERNS`
2. **`server/proxy/__tests__/index.test.js`** —— TDD 加 W1-W7 单测
3. **`server/routes/proxy.js`** —— `/proxy/nodes` 端点加 `usTags` 字段
4. **`web/src/views/Config.vue`** —— 模板 + 6 个 script setup 改动 + `npm run build`
5. **`docs/CHANGELOG.md`** —— 追加 v2.21 节

## 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 用户已有 config 没 `whitelist` 字段 | `Array.isArray` 守护；缺省 `[]` 即现状行为 |
| R2 | `cfg.whitelist` 是 string（用户填错） | W5 测试覆盖，视为空 → fallback |
| R3 | 主白名单 + JP 白名单同选了同一 tag | 合法用法（同节点跨双端口转发），sing-box 不冲突 |
| R4 | 用户在主白名单选了 JP-KDDI 节点 → 主代理出口变 JP IP | 用户配置意图，UI 视觉引导（US 高亮）已足够，不做代码层拦截 |
| R5 | 订阅 tag 含特殊字符（中文/空格/括号） | `filterByWhitelist` 用 Set 精确匹配，已有测试覆盖 |
| R6 | `US_PATTERNS` 导出导致循环引用 | `subscription.js` 不 require `index.js`，单向无环 |
| R7 | 现有 `regionFilter: ""` 配置语义变化 | 当前 config.json 唯一显式设置是 `'US'`；显式空字符串场景之前不可能进入（`|| 'US'` 直接转 'US'），所以是**新增**语义而非破坏 |

## 实施估算

~120 行净增（不含 CHANGELOG），1 个工作日内 ship。
