# JP-Checkout Node Whitelist — Design Spec

**Date**: 2026-05-23
**Status**: Draft → Pending user review
**Builds on**: `2026-05-23-checkout-via-jp-kddi-design.md` (v2.18.0)
**Target version**: v2.18.1

---

## 1. Background & Problem

v2.18.0 通过 `proxy.jpCheckout.keyword='KDDI'` 关键字过滤选 JP 节点。生产中订阅源含 2 个 KDDI 节点：
- `pro-家庭宽带-日本KDDI-2x` —— datacenter，Cloudflare 屏蔽，无法 reach OpenAI
- `jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]` —— 住宅 IP（106.161.71.221），可拿 ¥0 链接

`rotateJp()` 顺序轮换会把请求**先打到 datacenter 节点**，调用失败后才会切到住宅节点。需要人工介入或等 markJpBad 才能选对节点。

用户需求：**在 UI 上精确指定一组节点作为 checkout 通道**，绕开"关键字匹配出多个但只想用其中一个"的问题。

## 2. Goal

让用户在 Config.vue 的 UI 上从订阅当前所有节点里勾选一组节点作为 `jp-checkout` selector 的成员，精确控制 7891 入口使用哪些节点。保持向后兼容：不填白名单 → v2.18.0 原行为（按 keyword 过滤）。

**非目标**：
- 不引入"全局多 selector 体系"（白名单仅作用于 JP 通道）
- 不改 `chatgpt-checkout.js`（checkout 调用方仍只看 `getJpProxyUrl()`）
- 不改 sing-box 配置形态（`buildSingboxConfig(us, jp)` 输入/输出不变）

## 3. Architecture

### 3.1 节点选择优先级（核心）

```
refresh() 决定 jp-checkout selector 池：
  ├─ enabled === false        → jp 关闭
  ├─ else whitelist.length>0  → 白名单分支：filterByWhitelist(all, whitelist)
  └─ else                     → keyword 分支：filterByJpKddi(all, keyword) [v2.18.0]
```

**白名单优先**：whitelist 非空时**始终走白名单分支**，不再 fallback 到 keyword（避免"白名单全失败→默默切到 keyword 选了非预期节点"反直觉）。

### 3.2 模块责任表

| 模块 | 改动 |
|---|---|
| `server/proxy/subscription.js` | 新增 `filterByWhitelist(outbounds, whitelist)` |
| `server/proxy/index.js` | `_state.jp.whitelist/whitelistMisses`、`_state.allTags`、抽 `pickJpNodes(all, jpCfg)`、`refresh()` 调用它 |
| `server/proxy/__tests__/subscription.test.js` | 加 6 个 `filterByWhitelist` testcase |
| `server/proxy/__tests__/index.test.js` | 加 5 个 `pickJpNodes` testcase |
| `server/routes/proxy.js` | 新增 `GET /api/proxy/nodes` 路由 |
| `web/src/views/Config.vue` | `form.proxyJpWhitelist`、`allNodeTags`/`jpKddiTagSet` ref、`loadAllNodes()`、UI 新增下拉 + 灰显 keyword + 黄条 misses + 状态卡 |
| `docs/CHANGELOG.md` | v2.18.1 条目 |

**明确不动**：
- `buildSingboxConfig(us, jp)` — 仍接收双池，与 v2.18.0 一致
- `chatgpt-checkout.js` — checkout 调用层不感知节点选择
- `singbox.js` — 端口探测逻辑不变
- `clash-api.js` — switchSelector 复用
- `filterByJpKddi` — 保留作为 keyword 分支调用
- 主代理 `_state.outbounds/nodeTags/...` 不受影响

## 4. Configuration

### 4.1 `config.json` 的 `proxy.jpCheckout` 段

```json
{
  "proxy": {
    "subscriptionUrl": "https://sub.topren.top/...",
    "regionFilter": "US",
    "rotationStrategy": "sequential",
    "jpCheckout": {
      "enabled": true,
      "keyword": "KDDI",
      "whitelist": [],
      "rotationStrategy": "sequential"
    }
  }
}
```

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `whitelist` | `string[]` | `[]` | **新增**。节点 tag 精确数组；非空时优先使用，忽略 keyword。空数组 = v2.18.0 行为 |

**向后兼容**：缺 `whitelist` 字段（v2.18.0 部署）→ 当作 `[]` 处理 → keyword 分支生效。

### 4.2 `_state.jp` 结构扩展

```js
jp: {
  enabled,
  keyword,
  whitelist: [],            // 新增：用户配置的白名单原值
  whitelistMisses: [],      // 新增：白名单中订阅里没有的 tag（诊断用）
  outbounds, nodeTags, currentNode, rotationStrategy, rotationIndex,
  badNodes, exitIp, lastError,
}
```

`_state.allTags: string[]` —— `refresh()` 时把订阅全部节点的 tag 缓存下来，供 `/api/proxy/nodes` 用，免去前端重复 HTTP 到订阅源。

## 5. Data Flow

### 5.1 refresh() 节点选择

```
refresh()
  ├─ readCfg().proxy.jpCheckout = { enabled, keyword, whitelist, rotationStrategy }
  ├─ all = fetchAndParse(subscriptionUrl)
  ├─ _state.allTags = all.map(o => o.tag)
  │
  ├─ const { filtered, misses, usedWhitelist } = pickJpNodes(all, jpCfg)
  │
  ├─ _state.jp.whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : []
  ├─ _state.jp.whitelistMisses = misses
  ├─ _state.jp.outbounds = filtered
  ├─ _state.jp.nodeTags = filtered.map(o => o.tag)
  ├─ _state.jp.currentNode = filtered[0]?.tag || ''
  ├─ _state.jp.enabled = false  // 顶部先置 false 防 leftover
  │
  ├─ if (!jpEnabledByConfig)
  │     _state.jp.lastError = 'JP 通道已被 config.jpCheckout.enabled=false 禁用'
  ├─ else if (usedWhitelist && filtered.length === 0)
  │     _state.jp.lastError = `白名单 [${whitelist.join(', ')}] 在订阅中无任何匹配`
  ├─ else if (!usedWhitelist && filtered.length === 0)
  │     _state.jp.lastError = `订阅中未找到关键字 "${keyword}" 的节点`
  ├─ else
  │     _state.jp.lastError = ''
  │
  └─ buildSingboxConfig + start sing-box + 端口冲突降级路径（v2.18.0 现有）
```

### 5.2 `pickJpNodes(all, jpCfg)` 纯函数签名

```js
function pickJpNodes(all, jpCfg) {
  if (!jpCfg || jpCfg.enabled === false) return { filtered: [], misses: [], usedWhitelist: false };

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

### 5.3 `filterByWhitelist(outbounds, whitelist)` 实现

```js
function filterByWhitelist(outbounds, whitelist) {
  if (!Array.isArray(outbounds) || outbounds.length === 0) return [];
  if (!Array.isArray(whitelist) || whitelist.length === 0) return [];
  const wantSet = new Set(whitelist.filter(t => typeof t === 'string' && t));
  return outbounds.filter(o => wantSet.has(o.tag || ''));
}
```

### 5.4 `/api/proxy/nodes` 响应

```js
router.get('/nodes', (req, res) => {
  const state = proxy.getState();
  const allTags = state.allTags || [];
  const jpKddiTags = allTags.filter(t => /KDDI/i.test(t));
  res.json({ nodeTags: allTags, total: allTags.length, jpKddiTags });
});
```

### 5.5 前端 UI 加载

```
Config.vue onMounted()
  ├─ GET /api/config/raw       → form fields（含 proxyJpWhitelist）
  ├─ GET /api/proxy/status     → proxyStatus.value（含 jp.whitelist/misses）
  └─ GET /api/proxy/nodes      → allNodeTags / jpKddiTagSet

refreshProxy() — "应用并启动代理" 按钮
  ├─ await handleSave()
  ├─ await api.post('/proxy/refresh')
  ├─ await loadProxyStatus()
  └─ await loadAllNodes()      // 节点列表可能因订阅更新而变
```

### 5.6 状态查询响应增量

`GET /api/proxy/status` 的 `jp` 子对象新增字段：
```json
{
  "jp": {
    "enabled": true,
    "available": 1,
    "currentNode": "jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]",
    "whitelist": ["jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]"],
    "whitelistMisses": [],
    ...
  }
}
```

## 6. UI

### 6.1 Config.vue JP-Checkout 分区结构

`JP 节点关键字` 之后、`JP 通道状态` 之前新增 `JP 节点白名单` form-item：

```html
<el-form-item label="JP 节点关键字">
  <el-input v-model="form.proxyJpKeyword" placeholder="KDDI" style="width:220px"
            :disabled="form.proxyJpWhitelist?.length > 0" />
  <span v-if="form.proxyJpWhitelist?.length > 0"
        style="color:#909399;margin-left:8px;font-size:12px">已被白名单覆盖</span>
</el-form-item>

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

状态卡新增 misses 提示行（仅 `whitelistMisses.length>0` 时显示）：

```html
<div v-if="proxyStatus.jp.whitelistMisses?.length"
     style="color:#e6a23c;margin-top:4px">
  ⚠ 白名单未命中：{{ proxyStatus.jp.whitelistMisses.slice(0,3).join(', ') }}{{
    proxyStatus.jp.whitelistMisses.length > 3 ? `... 共 ${proxyStatus.jp.whitelistMisses.length} 个` : ''
  }}
</div>
```

### 6.2 script setup 改动

```js
const allNodeTags = ref([]);
const jpKddiTagSet = ref(new Set());

const form = reactive({
  // ... existing
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
  proxyJpWhitelist: [],
});

async function loadAllNodes() {
  try {
    const { data } = await api.get('/proxy/nodes');
    allNodeTags.value = data.nodeTags || [];
    jpKddiTagSet.value = new Set(data.jpKddiTags || []);
  } catch {
    allNodeTags.value = [];
    jpKddiTagSet.value = new Set();
  }
}

onMounted(async () => {
  // ... existing
  if (cfg.proxy?.jpCheckout) {
    if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled;
    if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword;
    if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist;
  }
  await loadProxyStatus();
  await loadAllNodes();
});

// handleSave 调整 payload.proxy.jpCheckout
payload.proxy.jpCheckout = {
  enabled: form.proxyJpEnabled,
  keyword: form.proxyJpKeyword,
  whitelist: form.proxyJpWhitelist || [],
};
delete payload.proxyJpWhitelist;
```

`refreshProxy()` 末尾 await `loadAllNodes()`。

### 6.3 UX 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| keyword 与 whitelist 并存 | whitelist 非空时灰显 keyword 输入框 + 提示文字 | 用户一眼看到优先级 |
| KDDI 高亮 | 绿色加粗 + 右侧 `KDDI` 标签 | 推荐节点视觉锚定 |
| 长 tag 显示 | `collapse-tags-tooltip` + 480px 宽度 | tag 含 `[VLESS-Reality]` 会爆掉 |
| 节点未加载（启动前） | placeholder + 空数组 | 不阻塞渲染 |
| 全不命中警告 | 黄色 misses 行 + 红色 lastError 行 | 双层提示，既具体又结果导向 |
| 不加单选切换 | 隐式：whitelist 非空即优先 | 减少控件，数据驱动状态 |

## 7. Error Handling

### 7.1 错误矩阵

| 场景 | 检测点 | 行为 | 用户感知 |
|---|---|---|---|
| `whitelist` 非数组 | `pickJpNodes` `Array.isArray` 守卫 | 视为 `[]`，fallback keyword | console.warn，UI 看 keyword 模式 |
| `whitelist` 含空字符串/null/非字符串 | `filterByWhitelist` 内 `t && typeof t === 'string'` | 静默剔除 | 无感知 |
| `whitelist` 全部不在订阅里 | `pickJpNodes` | `filtered=[]`、misses 列全部、`jp.enabled=false`、`lastError` 含具体 tag 列表 | UI 红色警告 |
| `whitelist` 部分不在订阅里 | `pickJpNodes` | 用命中部分，`misses` 记录缺失 | UI 黄色提示 |
| `whitelist` 含但 keyword 不含 KDDI 的节点 | 设计预期 | 白名单优先，使用该节点 | 按用户意图工作 |
| `/api/proxy/nodes` 在 sing-box 未启动时调 | `_state.allTags` 是 `[]` | 返回 `{nodeTags:[], jpKddiTags:[]}` | UI 下拉空（placeholder 提示） |
| `whitelist` 含 `"KDDI"`（误以为关键字） | 精确比较 | 不存在名为 "KDDI" 的节点 → misses=["KDDI"]、enabled=false | UI 警告，**不静默回退到 keyword** |
| `whitelist` 含重复 tag | `filterByWhitelist` 用 Set | 去重 | 无感知 |
| `whitelist` 含跨区节点（如 US tag） | 设计允许 | 白名单不强制 JP 域 | OpenAI 那边可能拿不到 ¥0（country body=JP 但 IP=US），用户自负 |

### 7.2 边界条件

| # | 边界 | 处理 |
|---|---|---|
| B1 | 用户保存 `whitelist=[]` | 走 keyword 分支（向后兼容） |
| B2 | 旧 config 没有 `whitelist` 字段 | `Array.isArray(...)? ... : []` → `[]` |
| B3 | 订阅源动态变化（141 vs 147） | 每次 refresh 重算 misses，UI 实时刷新 |
| B4 | tag 含中文/空格/`[]`/特殊字符 | Set 精确字符串比较，无 regex 风险 |
| B5 | `whitelistMisses` 数组很长 | UI `slice(0,3)` 展示 + 计数 |
| B6 | sing-box 重启时白名单全失效 | UI 警告，用户改白名单或清空 |
| B7 | `_state.allTags` 在 `stop()` 后 | `stop()` 不清 allTags，下次 refresh 覆盖；UI 下拉显示上一次的列表（可接受） |

### 7.3 安全

| 项 | 处理 |
|---|---|
| `whitelist` tag 注入到 sing-box config | tag 只放进 selector outbounds 数组，无 shell/regex 注入面 |
| `/api/proxy/nodes` 暴露节点 tag | tag 本身已在 `/status` 暴露，无新增暴露面 |
| 前端 form 传入异常 payload | `pickJpNodes` 类型守卫；`express.json()` 限制 body 大小 |

### 7.4 日志

白名单分支：
```
[Proxy] JP whitelist: 1/2 matched (1 missing: pro-家庭宽带-日本KDDI-2x)
[Proxy] sing-box running: main=:7890(35) jp=:7891(1)
```

keyword 分支（不变）：
```
[Proxy] JP-KDDI filter (keyword=KDDI): 2
```

## 8. Testing

### 8.1 单元测试

#### `filterByWhitelist` × 6 testcases

| # | 输入 | 期望 |
|---|---|---|
| 1 | outbounds=[A,B,C], whitelist=['A','C'] | [A, C] |
| 2 | outbounds=[A,B], whitelist=[] | `[]` |
| 3 | outbounds=[A], whitelist=['A','X'] | [A]（X 静默） |
| 4 | outbounds=[A], whitelist=['X','Y'] | `[]` |
| 5 | whitelist=['A','A',null,'',undefined,'B'] | [A, B]（去重+剔除非字符串） |
| 6 | tag 含 `(topren) [VLESS-Reality]`+中文 | 精确匹配返回 1 个 |

#### `pickJpNodes` × 5 testcases

| # | jpCfg | 期望 |
|---|---|---|
| 1 | `{enabled:true, keyword:'KDDI', whitelist:['nodeA']}` | filtered=[nodeA], usedWhitelist=true |
| 2 | `{enabled:true, keyword:'KDDI', whitelist:[]}` | filtered=keyword 过滤结果, usedWhitelist=false |
| 3 | `{enabled:false}` | filtered=[], usedWhitelist=false |
| 4 | `{enabled:true, whitelist:['unknown']}` | filtered=[], misses=['unknown'], usedWhitelist=true |
| 5 | `{enabled:true, whitelist:'KDDI'}`（字符串误填） | 视为空 → keyword 分支, usedWhitelist=false |

### 8.2 集成测试

**T8 白名单生效（核心）**：config.json 设 whitelist=[住宅节点] → refresh → `jp.available=1, jp.currentNode=住宅, exitIp=106.x`

**T9 部分命中**：whitelist=[住宅, 下线节点X] → refresh → `jp.available=1, jp.whitelistMisses=['下线节点X']`，UI 黄色提示

**T10 全不命中**：whitelist=[不存在A, 不存在B] → refresh → `jp.enabled=false, jp.lastError 含白名单未命中`，主代理 enabled=true

**T11 清空回退**：whitelist=[] → refresh → v2.18.0 行为，`jp.available=2`（KDDI 过滤）

**T12 UI 下拉**：浏览器开配置页 → "JP 节点白名单"下拉 → 含 147 节点 + KDDI 绿色高亮 + 搜索 "KDDI" 过滤出 2 个 + 搜索 "softbank" 过滤出 1 个

**T13 keyword 灰显**：UI 同时填 keyword 和 whitelist → 保存 → keyword 输入框灰显 + 提示文字"已被白名单覆盖"；状态卡显示"白名单 N 个"

### 8.3 验收清单

- [ ] `filterByWhitelist` 6/6 单测过
- [ ] `pickJpNodes` 5/5 单测过
- [ ] T8: 白名单选住宅，出口 106.x
- [ ] T9: 部分命中正确显示 misses
- [ ] T10: 全不命中软失败，主代理不受影响
- [ ] T11: 清空回退到 keyword 模式
- [ ] T12: UI 下拉含全部节点 + KDDI 高亮 + 搜索
- [ ] T13: UI keyword 灰显逻辑正确
- [ ] 现有 9/9 单测仍 pass（无回归）

## 9. Implementation Order

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 1 | `filterByWhitelist` + 6 单测 | `subscription.js`、`__tests__/subscription.test.js` | 单测 11/11 |
| 2 | 抽 `pickJpNodes(all, jpCfg)` + 5 单测 | `proxy/index.js`、`__tests__/index.test.js` | 单测 16/16 |
| 3 | `_state.jp.whitelist/whitelistMisses` + `_state.allTags` + `getState()` 序列化 | `proxy/index.js` | `getState()` 含新字段 |
| 4 | `refresh()` 调用 `pickJpNodes` + 缓存 allTags | `proxy/index.js` | 启动 server 看日志 "JP whitelist: X/Y matched" |
| 5 | 新增 `GET /api/proxy/nodes` 路由 | `routes/proxy.js` | curl 返回 nodeTags + jpKddiTags |
| 6 | Config.vue: form 字段 + `loadAllNodes()` + onMounted + handleSave | `views/Config.vue` | 配置页能看下拉、能搜、能勾选 |
| 7 | Config.vue: keyword 灰显 + KDDI 高亮 + misses 黄条 UX | `views/Config.vue` | T12 + T13 |
| 8 | 集成验证 T8–T13 | （手工） | 全过 |
| 9 | CHANGELOG v2.18.1 + commit + tag | `docs/CHANGELOG.md` | git tag v2.18.1 |

## 10. Out of Scope

- 不引入"全局多 selector 体系"（白名单只作用 JP 通道）
- 不改 `chatgpt-checkout.js`、`buildSingboxConfig` 接口
- 不为 PayPal 流程引入白名单（仅 checkout 阶段）
- 不暴露"按 ASN/IP 段过滤"等更复杂条件（YAGNI）
- 不做"自动屏蔽 datacenter 节点"启发式（用户白名单已能精确控制）

## 11. Risks

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 用户白名单选了所有 datacenter KDDI 节点（误选） | 中 | 拿不到 ¥0 链接 | UI KDDI 高亮 + 状态卡显示出口 IP（106.x 才是住宅段） |
| 订阅源 tag 变更（运营商重命名节点）| 低 | 白名单失效 | UI 显示 whitelistMisses，用户重新勾选 |
| 节点列表很长导致 UI 卡 | 低 | 下拉响应慢 | filterable 自带搜索；147 节点对 el-select 是小数据 |
| `pickJpNodes` 抽离改变 refresh 行为 | 低 | 既有 v2.18.0 测试失败 | 保留 `filterByJpKddi` 调用语义，单测覆盖优先级 |

## 12. References

- 前一版 spec: `docs/superpowers/specs/2026-05-23-checkout-via-jp-kddi-design.md` (v2.18.0)
- v2.18.0 实现 commits: 8328403 → 6a6d697
- T3 验收证据: `Total due today: ¥0` from `jp-KDDI-动态家宽-108.4 (topren) [VLESS-Reality]` via 106.161.71.221
