# 代理节点黑名单 + 轮换游标延续设计

**Date:** 2026-05-24
**Status:** Draft → 待评审
**Predecessors:** v2.18.0 (checkout-via-jp-kddi), v2.18.1 (jp-checkout-whitelist), v2.19.0 (reliable-jp-first-checkout)

## Background

当前 `server/proxy/index.js` 已经有黑名单 (`badNodes` Map + 30 min TTL) 和顺序/随机轮换骨架，并在三个位置调用 `markBad` / `markJpBad`：

1. `protocol-engine.js` — TLS failure
2. `server/engine.js` + `protocol-engine.js` — payment 页面 `chrome-error://` / `about:blank`
3. `server/chatgpt-checkout.js` — JP checkout timeout / parse 失败 / 空 link

但实际使用中暴露三个问题：

1. **一次失败立即拉黑过于激进** —— 网络偶发抖动会让本来可用的节点立刻进黑名单 30 分钟，整个池缩小。运维需要"连续多次失败"才拉黑的语义。
2. **没有手动管理入口** —— 进了黑名单只能等 30 min TTL 或重启服务（内存 Map 丢失）。Config.vue 不展示黑名单内容，运维盲调。
3. **`refresh()` 每次重置 `rotationIndex = 0`** —— 保存配置 / 点"应用并启动代理"都会让游标归零。顺序轮换模式下，头部节点被大量使用，尾部节点几乎不被分配，节点池利用不均。

## Goals

1. 节点连续 3 次"代理类失败"才入黑名单；中间任一次成功立刻清零计数。
2. 黑名单跨进程重启保留（写 `data.db`），TTL 30 min 行为保持（自动恢复）。
3. UI 暴露黑名单表格 + 手动移除 + 批量清空。
4. `refresh()` 不重置轮换游标；进程重启仍从 0（计数器同步）。
5. 主代理（US, 7890）与 JP 通道（KDDI, 7891）的计数器、黑名单完全独立。

## Non-Goals

- 不引入全局错误事件总线（YAGNI，方案 B 否决理由见决策记录）。
- 不让 proxy 模块"自动嗅探"代理请求错误（方案 C，被现有 Python 子进程架构挡住）。
- 不持久化错误计数器（仅黑名单条目持久化）。
- 不做"手动新增黑名单"的 UI 输入框（API 已就绪，下一迭代按需加）。
- 不接管 IMAP / Discord Gateway / PayPal 自身的网络错误 —— 这些不走 sing-box。

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 计数语义 | 连续 3 次失败（中间成功清零） | 容忍偶发抖动；最符合直观期望 |
| 触发范围 | 现有 3 个点 + 扩充 Stripe verify timeout + 协议模式网络类 catch + login 网络类 reason | 覆盖代理类错误，且明确把 IMAP / Discord 排除以避免误拉黑 |
| 持久化 | 黑名单写 DB，计数器仅内存 | 黑名单是节点级长效状态；计数器是 session 级短期窗口 |
| TTL | 30 min 自动过期保留；手动加入也吃 TTL | 付费节点多为动态家宽 IP，TTL 防止黑名单越积越多；手动统一行为简化模型 |
| 游标范围 | refresh 不重置；进程重启从 0 | 解决利用不均；进程重启仍归零是合理的全新会话默认 |
| UI | 主 + JP 各一表格，含节点 / 剩余 TTL / 来源 / 原因 / 移除 | 与运维查看 + 操作模型对齐 |
| 方案选型 | A（计数器内置 proxy 模块） | 改动最小，对齐现有 `markBad` 调用模式 |

## Architecture

```
server/proxy/index.js     ← 改 markBad 语义 + 加计数器 + 加持久化层 + 不重置游标
server/proxy/blacklist.js ← 新增，纯函数封装 DB CRUD（沿用 sql.js 风格）
server/db.js              ← 加 1 张表 proxy_blacklist + 初始化时创建
server/routes/proxy.js    ← 加 4 个 endpoint（list / add / remove / clear）

server/engine.js              ┐
protocol-engine.js            │ ← 仅扩充触发点（调 recordBadAttempt / recordGoodAttempt）
server/chatgpt-checkout.js    │
server/stripe-verify.js       ┘

web/src/views/Config.vue  ← 加 2 个黑名单表格 + 移除操作 + 批量清空
```

### 语义模型

- **"尝试"** = 一次明确归因到当前节点的代理类网络操作。
- 每个尝试结束时调一次：
  - 成功 → `recordGoodAttempt(tag, channel)` —— 把计数清零
  - 失败 → `recordBadAttempt(tag, channel, reason)` —— +1 计数；达到 3 才真的写入黑名单（DB + 内存 Map）
- 黑名单内的节点在 `rotate()` 中被跳过（行为不变）；TTL 过期或手动移除则恢复。
- **`channel`** = `'main'` | `'jp'`，两个通道完全独立的计数器 + 黑名单。

### 关键不变式

1. `markBad` / `markJpBad`（被外部调用的旧名字）= `recordBadAttempt(_, 'main'|'jp', 'legacy')` 的别名，保留向后兼容。**外部触发点的"成功"路径必须新增 `recordGoodAttempt` 调用**，否则计数永远只升不降，3 次会越积越快。
2. `refresh()` 中删除 `_state.rotationIndex = 0` 这两行；但若新订阅节点数 < 旧 `rotationIndex`，要做 `rotationIndex = rotationIndex % nodeTags.length` 防越界；`currentNode` 跟随新 `rotationIndex` 而不是固定 `filtered[0]`。
3. JP checkout 中现有的 `spawn` error（Python 缺失/权限）**不**算代理错误（已有注释明确禁止 `markJpBad`），保持。

## Data Structures

### 内存层（`server/proxy/index.js` `_state` 增量）

```js
// 主代理通道
_state.failCount   = new Map();  // tag → 0..2，达 3 时立刻入黑名单并清零
_state.failReasons = new Map();  // tag → 最近一次失败原因 (string, 60 字截断)

// JP 通道
_state.jp.failCount   = new Map();
_state.jp.failReasons = new Map();

// 现有 _state.badNodes / _state.jp.badNodes 保留，但 value 从 number 升级为 object：
//   { expiresAt, reason, source }
// 启动时从 DB 重建（见 hydrate 流程）
```

`failCount` / `failReasons` 不持久化，进程重启清零。

### 持久化层（`server/db.js` 新表）

```sql
CREATE TABLE IF NOT EXISTS proxy_blacklist (
  tag        TEXT NOT NULL,
  channel    TEXT NOT NULL,            -- 'main' | 'jp'
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL,         -- Unix ms；与内存 expiresAt 同语义
  reason     TEXT DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'auto',  -- 'auto'(3 次累计) | 'manual'(API)
  PRIMARY KEY (tag, channel)
);
CREATE INDEX IF NOT EXISTS idx_proxy_blacklist_expires ON proxy_blacklist(expires_at);
```

复合主键 `(tag, channel)` 允许同一 tag 同时存在两个通道的黑名单。

### `server/proxy/blacklist.js`（新模块）

```js
module.exports = {
  loadAll(channel),           // → [{ tag, expiresAt, reason, source }]；跳过已过期
  add(tag, channel, ttlMs, reason, source),
  remove(tag, channel),
  removeAll(channel),
  pruneExpired(),             // DELETE WHERE expires_at <= now
};
```

风格严格对齐 `server/db.js` 现有的 `accountsDB` / `statusDB`（`db.prepare` / `db.run` + `save()`），不引入新的访问层抽象。

### 重启时恢复流程

1. `initDB()` 创建表
2. `proxy/index.js` 首次 `refresh()`（且 `_state.badNodes.size === 0`）时调 `blacklist.pruneExpired()` + `blacklist.loadAll('main'|'jp')`，灌回内存 Map
3. `getState()` 现有"清过期"逻辑保留，但额外同步 `blacklist.remove()` 落盘

### `getState()` 对外契约变化（breaking, 但无消费者）

`badNodes` 从 `{tag: expiryMs}` 升级为 `{tag: {expiresAt, reason, source}}`。唯一旧消费者是 Config.vue 自己的 `proxyStatus.value`，当前 UI 没有读取 `badNodes`，所以无破坏。

## proxy 模块 API

```js
const FAIL_THRESHOLD = 3;  // 顶层常量，便于单测注入

function recordBadAttempt(tag, channel, reason = '') {
  if (!tag) return { blacklisted: false, count: 0 };
  const ns = channel === 'jp' ? _state.jp : _state;
  const next = (ns.failCount.get(tag) || 0) + 1;
  ns.failCount.set(tag, next);
  ns.failReasons.set(tag, String(reason).slice(0, 60));
  console.log(`[Proxy${channel === 'jp' ? ':JP' : ''}] Bad attempt ${next}/${FAIL_THRESHOLD} on ${tag} (${reason.slice(0, 40)})`);
  if (next >= FAIL_THRESHOLD) {
    _addToBlacklist(tag, channel, BAD_NODE_TTL_MS, reason, 'auto');
    ns.failCount.delete(tag);
    return { blacklisted: true, count: next };
  }
  return { blacklisted: false, count: next };
}

function recordGoodAttempt(tag, channel) {
  if (!tag) return;
  const ns = channel === 'jp' ? _state.jp : _state;
  if (ns.failCount.has(tag)) {
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
  }
}

function blacklistManually(tag, channel, ttlMs = BAD_NODE_TTL_MS, reason = 'manual') {
  if (!tag) throw new Error('tag required');
  _addToBlacklist(tag, channel, ttlMs, reason, 'manual');
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.failCount.delete(tag);
  ns.failReasons.delete(tag);
}

function removeFromBlacklist(tag, channel) {
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.delete(tag);
  blacklist.remove(tag, channel);
}

function clearBlacklist(channel) {
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.clear();
  blacklist.removeAll(channel);
}

// 旧名字保留作别名（向后兼容）
function markBad(tag) { return recordBadAttempt(tag, 'main', 'legacy markBad'); }
function markJpBad(tag) { return recordBadAttempt(tag, 'jp', 'legacy markJpBad'); }

// 共用网络错误识别（供 engine 层判定 catch 中的 e.message）
function isProxyNetError(msg) {
  return /ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|ECONNREFUSED|tunneling socket|net::ERR_(PROXY|TUNNEL|CONNECTION_RESET|TIMED_OUT|EMPTY_RESPONSE)/i.test(String(msg || ''));
}

// 内部 helper
function _addToBlacklist(tag, channel, ttlMs, reason, source) {
  const expiresAt = Date.now() + ttlMs;
  const ns = channel === 'jp' ? _state.jp : _state;
  ns.badNodes.set(tag, { expiresAt, reason: String(reason).slice(0, 60), source });
  blacklist.add(tag, channel, ttlMs, reason, source);
}

function _hydrateBlacklistFromDB() {
  blacklist.pruneExpired();
  for (const row of blacklist.loadAll('main')) {
    _state.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
  }
  for (const row of blacklist.loadAll('jp')) {
    _state.jp.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
  }
}
```

### `isBad` / `isJpBad` 适配（值从 number → object）

```js
function isBad(tag) {
  const entry = _state.badNodes.get(tag);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    _state.badNodes.delete(tag);
    blacklist.remove(tag, 'main');
    return false;
  }
  return true;
}
// isJpBad 对称
```

`rotate()` / `rotateJp()` 逻辑不变（只关心布尔返回）。

### `refresh()` 游标处理

```js
// 删除原 _state.rotationIndex = 0;
if (filtered.length === 0) {
  _state.rotationIndex = 0;
} else if (_state.rotationIndex >= filtered.length) {
  _state.rotationIndex = _state.rotationIndex % filtered.length;
}
_state.currentNode = filtered[_state.rotationIndex] || '';

// JP 通道对称处理
```

### 首次 refresh 时 hydrate

```js
if (_state.badNodes.size === 0 && _state.jp.badNodes.size === 0) {
  _hydrateBlacklistFromDB();
}
```

`size === 0` 守卫只是为了避免**热重启**（同进程多次 `refresh()`）时重复读 DB；冷启动时内存 Map 必为空 → 加载一次。运行时手动加入的黑名单不会受影响（它们走 `_addToBlacklist` 同步落盘）。

## 触发点矩阵

按"哪个通道走什么代理"分清归属。

### 现有触发点（仅改语义，调用名字保持 `markBad` 别名兼容；建议同步改为显式 `recordBadAttempt` + 加成功路径）

| # | 文件 / 行 | 通道 | 触发条件 | 行为 |
|---|---|---|---|---|
| T1 | `protocol-engine.js:241-262` | main | `result.status === 'tls_failure'` | 失败：`recordBadAttempt(node, 'main', 'tls_failure')`；retry 成功后 `recordGoodAttempt` |
| T2 | `protocol-engine.js:380-388` | main | `pageUrl` 是 `chrome-error://` / `about:blank` | 失败：`recordBadAttempt(node, 'main', 'payment_unreachable')` |
| T3 | `server/engine.js:380-400` | main | 同 T2 | 同 T2 |
| T4 | `server/chatgpt-checkout.js:43` | jp | Python timeout | 失败：`recordBadAttempt(node, 'jp', 'checkout_timeout')` |
| T5 | `server/chatgpt-checkout.js:78` | jp | `link === ''` | 失败：`recordBadAttempt(node, 'jp', 'checkout_empty_link')` |
| T6 | `server/chatgpt-checkout.js:82` | jp | JSON parse 失败 | 失败：`recordBadAttempt(node, 'jp', 'checkout_parse_failed')` |

### 新增触发点

| # | 文件 | 通道 | 触发条件 | 行为 |
|---|---|---|---|---|
| T7 | `server/stripe-verify.js` | main | timeout / spawn error / parse fail | 失败：`recordBadAttempt(node, 'main', reason)` —— Stripe verify 走主代理 |
| T8 | `protocol-engine.js`（`runProtocolRegister` catch） | main | `e.message` 经 `isProxyNetError` 命中 | 失败：`recordBadAttempt(node, 'main', 'protocol_net_error')` |
| T9 | `server/engine.js` login 失败分支 | main | `loginResult.reason` 经 `isProxyNetError` 命中 | 失败：同 T8 |

### 新增成功路径（recordGoodAttempt） —— 关键不变式 1

| # | 文件 / 节点 | 通道 |
|---|---|---|
| G1 | `protocol-engine.js` `runProtocolRegister` **正常返回**（result.status 是任何业务值——`success` / `deactivated` 都算节点工作正常；只有 `tls_failure` 或 catch 块捕获的网络错误才算节点失败） | main |
| G2 | `server/engine.js` `loginResult.status === 'success'` | main |
| G3 | `server/engine.js` / `protocol-engine.js` payment 页面 `pageUrl` 为真实 URL | main |
| G4 | `server/chatgpt-checkout.js` `link` 非空 | jp |
| G5 | `server/stripe-verify.js` 成功返回 `{ ok: true }` | main |

### 明确不计入（避免误拉黑）

| 场景 | 原因 |
|---|---|
| IMAP 超时 / OTP 拉取失败 | IMAP 直连邮箱服务器，不走 sing-box |
| Discord Gateway WebSocket 断 | Discord 走自己的内部代理（commit `f48d554`），与主/JP 池无关 |
| `loginResult.status === 'deactivated'` | 账号问题 |
| `chatgpt-checkout.js` 的 `spawn` error（`py.on('error')`） | 本地 Python 二进制缺失/权限拒；已有注释明确禁止 markJpBad，保持 |
| PayPal genericError / 12 字段填充失败 | 业务侧问题；payment 进入 PayPal 域名后离开 OpenAI/Stripe 网络层 |

### 改动惯例 —— 可选的小帮手（不强制）

`server/engine.js` 和 `protocol-engine.js` 只关心主通道（JP 通道仅在 `chatgpt-checkout.js` 里用到一次），可抽：

```js
// server/engine.js / protocol-engine.js 顶部 —— 可选
function reportProxyResult(ok, reason = '') {
  const node = proxyMgr.getState().currentNode;
  if (!node) return;
  if (ok) proxyMgr.recordGoodAttempt(node, 'main');
  else proxyMgr.recordBadAttempt(node, 'main', reason);
}
```

`chatgpt-checkout.js` 中各分支清晰，直接 inline 调 `recordBadAttempt(currentJpNode, 'jp', reason)` / `recordGoodAttempt(currentJpNode, 'jp')` 即可，不必抽帮手。

## REST API

### `GET /api/proxy/blacklist`

```json
{
  "main": [
    { "tag": "us-LA-1", "expiresAt": 1748090123456, "ttlRemainingMs": 1234567,
      "reason": "tls_failure", "source": "auto" }
  ],
  "jp": [
    { "tag": "jp-KDDI-...", "expiresAt": ..., "ttlRemainingMs": ...,
      "reason": "checkout_empty_link", "source": "auto" }
  ]
}
```

### `POST /api/proxy/blacklist/add`

请求：`{ "tag": "...", "channel": "main" | "jp", "ttlMs"?, "reason"? }`
响应：同 list shape，便于前端直接替换状态。

### `POST /api/proxy/blacklist/remove`

请求：`{ "tag": "...", "channel": "main" | "jp" }`
响应：同 list shape。

### `POST /api/proxy/blacklist/clear`

请求：`{ "channel": "main" | "jp" }`
响应：同 list shape（只清对应通道）。

### 现有端点的语义变化

| 端点 | 旧行为 | 新行为 |
|---|---|---|
| `POST /api/proxy/mark-bad` | 一次拉黑 30 min | +1 计数，达 3 才拉黑（跟着 `markBad` alias 走），返回值多 `count` / `blacklisted` |
| `POST /api/proxy/jp/mark-bad` | 同上（JP） | 同上 |
| `GET /api/proxy/status` | `badNodes: {tag: expiryMs}` | `badNodes: {tag: {expiresAt, reason, source}}`；UI 不读这个字段（专门走 `/blacklist`） |

### 取舍

- list 单独立 endpoint 不并入 `/status`：UI 5s 轮询 `/status` 是常态，黑名单数据只在打开表格时才需要，避免每次序列化。
- `add` 与 `mark-bad` 分开：意图不同（`mark-bad` = 通知失败，`add` = 直接禁用）；用 `source` 字段区分自动/手动来源。
- 删除按钮不做二次确认（低风险）；批量清空在 UI 层加 `ElMessageBox.confirm`。

## UI（Config.vue）

在 `<el-divider content-position="left">JP-Checkout 通道</el-divider>` 之后、`代理状态` 之前插入"**节点黑名单**"分节，主代理 + JP 各一个表格。

### 模板骨架

```vue
<el-divider content-position="left">节点黑名单</el-divider>

<el-form-item label="主代理黑名单">
  <div style="width: 600px">
    <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
      <span style="font-size:12px; color:#909399">
        共 {{ blacklist.main.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
      </span>
      <el-button size="small" :disabled="!blacklist.main.length" @click="clearChannel('main')">
        清空主代理黑名单
      </el-button>
      <el-button size="small" @click="loadBlacklist">刷新</el-button>
    </div>
    <el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
      <el-table-column prop="tag" label="节点" min-width="220" show-overflow-tooltip />
      <el-table-column label="剩余时间" width="110">
        <template #default="{ row }">{{ formatTtl(row.ttlRemainingMs) }}</template>
      </el-table-column>
      <el-table-column label="来源" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="row.source === 'manual' ? 'warning' : 'info'">
            {{ row.source === 'manual' ? '手动' : '自动' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="80">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="removeNode(row.tag, 'main')">移除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</el-form-item>

<el-form-item label="JP 通道黑名单">
  <!-- 与上同构，绑定 blacklist.jp + clearChannel('jp') + removeNode(tag,'jp') -->
</el-form-item>
```

### Script setup 增量

```js
const FAIL_THRESHOLD = 3
const blacklist = ref({ main: [], jp: [] })
let blacklistTimer = null

async function loadBlacklist() {
  try {
    const { data } = await api.get('/proxy/blacklist')
    blacklist.value = data
  } catch {
    blacklist.value = { main: [], jp: [] }
  }
}

async function removeNode(tag, channel) {
  try {
    const { data } = await api.post('/proxy/blacklist/remove', { tag, channel })
    blacklist.value = data
    ElMessage.success(`已移除 ${tag}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '移除失败')
  }
}

async function clearChannel(channel) {
  try {
    await ElMessageBox.confirm(
      `确认清空${channel === 'main' ? '主代理' : 'JP 通道'}黑名单？`,
      '确认操作',
      { type: 'warning' },
    )
  } catch { return }
  try {
    const { data } = await api.post('/proxy/blacklist/clear', { channel })
    blacklist.value = data
    ElMessage.success('已清空')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '清空失败')
  }
}

function formatTtl(ms) {
  if (ms <= 0) return '已过期'
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

onMounted(async () => {
  // ... 现有 loadProxyStatus / loadAllNodes 调用之后 ...
  await loadBlacklist()
  blacklistTimer = setInterval(loadBlacklist, 10000)
})

onBeforeUnmount(() => {
  if (blacklistTimer) clearInterval(blacklistTimer)
})
```

需要在 import 处新增 `ElMessageBox`、`onBeforeUnmount`。

### YAGNI 清单

| 想法 | 不做的理由 |
|---|---|
| "手动加入黑名单"输入框 | 用户没明确要；API 已就绪供下一迭代 |
| TTL 实时秒级倒计时 | 视觉抖动；10s 服务端轮询足以 |
| 节点池下拉里加"已黑名单"视觉标记 | JP 白名单下拉已经够拥挤 |

## 测试策略

延续项目 `node:test` + `node --test` 惯例。

### `server/proxy/__tests__/index.test.js` 扩展

| # | 用例 |
|---|---|
| U1 | `recordBadAttempt` 第 1、2 次：返回 `{blacklisted:false, count:N}`，节点未进 badNodes |
| U2 | `recordBadAttempt` 连续 3 次：第 3 次返回 `{blacklisted:true}`，badNodes 含 tag，`failCount` 清零 |
| U3 | 2 次 bad + 1 次 good + 1 次 bad：不入黑名单（"中间成功清零"） |
| U4 | main 与 jp 通道独立计数：同 tag 在两个通道互不影响 |
| U5 | `blacklistManually`：直接入黑名单，且清掉 `failCount` 残值 |
| U6 | `removeFromBlacklist`：内存 + 持久化层联动（mock 验证） |
| U7 | `isBad` 过期 entry：删除内存 + 调 `blacklist.remove`，返回 false |
| U8 | `getState().badNodes` shape 为 `{tag: {expiresAt, reason, source}}` |
| U9 | `isProxyNetError`：6+ 个网络关键字命中；业务关键字不命中 |
| U10 | `FAIL_THRESHOLD` 可通过 module export 读取 |

### `server/proxy/__tests__/rotation.test.js` 新增

| # | 用例 |
|---|---|
| R1 | `refresh()` 调用前 `rotationIndex = 5`，调用后仍为 5（节点池不变） |
| R2 | refresh 后节点列表变短（10 → 3），`rotationIndex` 取模到合法范围 |
| R3 | refresh 后节点列表为空，`rotationIndex` reset 为 0 |
| R4 | refresh 后 `currentNode` 跟随 `rotationIndex` 而不是固定 `nodeTags[0]` |

### `server/proxy/__tests__/blacklist.test.js` 新增（持久化层）

走真实 sql.js 内存数据库：

| # | 用例 |
|---|---|
| B1 | `add` + `loadAll` 往返；main / jp 表互不混入 |
| B2 | 同 (tag, channel) 重复 add：INSERT OR REPLACE，新 expires_at 覆盖 |
| B3 | `pruneExpired` 只删 `expires_at <= now` |
| B4 | `removeAll(channel)` 只删对应通道 |

### `server/__tests__/proxy-route-blacklist.test.js` 新增（REST 层）

mock `proxy` 模块，验证 4 个 endpoint：
- 输入校验（channel 非法 → 400、tag 缺失 → 400）
- 桩函数调用入参对齐
- 响应 shape 含 `main` / `jp` 数组

### 人工验证清单（PR 评审 checklist）

- [ ] 节点连续 3 次失败入黑名单（控制台 `1/3 → 2/3 → 3/3`），UI 表格出现
- [ ] 2 次失败 + 1 次成功后计数归零；下次失败重新从 1/3 开始
- [ ] 重启 `node server/index.js`，黑名单条目仍在，剩余 TTL 接续衰减
- [ ] 重启后内存计数器归零（控制台首次失败仍是 `1/3`）
- [ ] UI 点"移除"：节点立刻从表中消失，下一轮 `rotate()` 能调度到它
- [ ] 修改订阅 URL 后点"应用并启动代理"：`rotationIndex` 不归零
- [ ] 订阅节点数从 10 减到 3：`rotationIndex = 7` 取模为 1，无异常
- [ ] `curl -X POST /api/proxy/blacklist/add` 加入不存在的 tag：成功入表，rotate 自然跳过

### 不写自动化测试的部分（明确）

- engine 文件中 `recordBadAttempt` 调用编排（工作流胶水，覆盖收益低）
- UI 组件渲染（项目无前端测试基础设施）

## 实施顺序建议（供 writing-plans 参考）

1. `server/db.js` 加表 + `server/proxy/blacklist.js` 持久化模块 + 单测（B1-B4）
2. `server/proxy/index.js` 内存层：`recordBadAttempt` / `recordGoodAttempt` / `blacklistManually` / `removeFromBlacklist` / `clearBlacklist` + alias + `isProxyNetError` + getState shape 升级 + 单测（U1-U10）
3. `server/proxy/index.js` `refresh()` 游标处理 + hydrate + 单测（R1-R4）
4. `server/routes/proxy.js` 4 个 endpoint + 单测
5. 三个 engine 触发点改造（T1-T9 + G1-G5）
6. Config.vue UI
7. 人工验证清单跑完，更新 `docs/CHANGELOG.md`（追加 v2.20 节）
