# v2.34.0 — Execute 分组锁定 + 视图切换设计

## 1. 背景

v2.27.0 给 Execute.vue 引入了 `<el-collapse>` 按 `_status` 分组的折叠面板视图，外加 v2.33.x 的 row 高亮。运行起来后两个新问题：

- **跨组跳跃**：点「执行」后，账户 status 从 idle → running → 终态（plus / error / 等），row 立即跨组迁移。用户刚看了运行中那行，结果它跳到 plus 组或 error 组里去了，**视线丢失**。
- **强制分组**：当用户想看一个扁平列表（按整体业务序排，不要折叠层级），目前没办法。

## 2. 目标

- **Sticky grouping**：执行点击瞬间快照每行的 `_status` 为 `_groupStatus`，分组按 `_groupStatus` 走；row 真实 `_status` 仍随 socket 更新（驱动行高亮颜色），但**不跨组**
- **页面刷新清快照**：硬刷或重新 `load()` → row 没 `_groupStatus` → 回归真实分组
- **视图切换**：toolbar 加分组 / 平铺二选一开关；平铺时单 `<AccountTableRows>` 渲染所有 filtered rows，按 `GROUP_ORDER` 业务序排
- 不动 row 颜色逻辑（v2.33）；不动后端

## 3. 方案

### 3.1 `web/src/status.js:groupAccountsByStatus` 读 `_groupStatus || _status`

当前 line 138-164：

```js
export function groupAccountsByStatus(rows) {
  if (!Array.isArray(rows)) return []
  const buckets = new Map()
  for (const row of rows) {
    const s = row._status || 'idle'
    ...
  }
  ...
}
```

改为：

```js
export function groupAccountsByStatus(rows) {
  if (!Array.isArray(rows)) return []
  const buckets = new Map()
  for (const row of rows) {
    // v2.34.0: 分组优先看 _groupStatus（执行时快照）；未设回退 _status。
    // 这是 sticky grouping 机制：执行点击后 row._status 随 socket 更新驱动
    // 行高亮颜色，但 row 不跨组（仍按快照分组）。Accounts.vue 没 _groupStatus
    // 概念，自动 fallback 到 _status 行为不变。
    const s = row._groupStatus || row._status || 'idle'
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s).push(row)
  }
  // 排序 + 隐空组 不变
  ...
}
```

**向后兼容**：未设 `_groupStatus` 的 row（包括 Accounts.vue 的所有 row、Execute.vue 刷新后的 row）行为完全不变。

### 3.2 `Execute.vue:startExec()` 快照逻辑

找到 `startExec` 函数（约 line 324-339）。在 POST `/api/execute` 之前给 batch rows 设 `_groupStatus`：

```js
async function startExec(emails) {
  // ... 既有 lockedEmails 快照 ...

  // v2.34.0: sticky grouping — 快照当前真实 status 到 _groupStatus，
  // 之后 socket 更新只动 _status（驱动行颜色），row 不跨组。
  // 每次 startExec 都覆盖快照（"第二次执行"的快照基于"第二次开始时"
  // 的真实状态，符合直觉）。
  for (const row of filteredRows.value) {
    row._groupStatus = row._status
  }

  // 既有 POST 逻辑
  running.value = true
  await api.post('/execute', ...)
}
```

注意：`row._groupStatus` 是新加的字段，Vue 响应式自动追踪，row 已是 reactive 对象。

### 3.3 视图切换 — toolbar 开关 + flat 视图

**新增 toolbar 开关**：放在「停止」按钮之后、`<el-divider>` 之前（约 line 5-12 之间）：

```vue
<el-switch
  v-model="groupingEnabled"
  active-text="分组"
  inactive-text="平铺"
  size="default"
  style="margin-left:8px"
/>
```

**新增 ref + computed**（约 line 104 附近）：

```js
import { GROUP_ORDER } from '../status'  // 已 import 或追加

const groupingEnabled = ref(true)  // v2.34.0: 分组视图开关，默认开

const flatSortedRows = computed(() => {
  const orderIndex = new Map(GROUP_ORDER.map((s, i) => [s, i]))
  return [...filteredRows.value].sort((a, b) => {
    const ia = orderIndex.has(a._status) ? orderIndex.get(a._status) : 999
    const ib = orderIndex.has(b._status) ? orderIndex.get(b._status) : 999
    return ia - ib  // 稳定排序保留同 status 内插入序
  })
})
```

**模板分支**（替换当前 `<el-collapse>` 块）：

```vue
<!-- 分组视图（默认） -->
<el-collapse v-if="groupingEnabled" v-model="expandedKeys" style="margin-top:8px">
  <el-collapse-item ...>
    <!-- 既有内容 -->
  </el-collapse-item>
</el-collapse>

<!-- 平铺视图（v2.34.0 新增） -->
<AccountTableRows
  v-else
  :rows="flatSortedRows"
  :running="running"
  :global-selected-set="globalSelectedSet"
  :get-history-logs="getHistoryLogs"
  :get-realtime-logs="getRealtimeLogs"
  @group-selection-change="onFlatSelectionChange"
  @expand-change="onExpand"
  @row-action="onRowAction"
  @auth-download="onAuthDownload"
  @row-click="onRowClick"
  style="margin-top:8px"
/>
```

注意 `@group-selection-change` 的语义在 flat 视图下是"整张表的选择变化"。复用既有 selection 全局 Set，行为一致。如果既有 handler 名 `onGroupSelectionChange(status, ...)` 在 flat 下无 status 概念，加一个 thin wrapper `onFlatSelectionChange(rows) { ... }` —— 或直接复用 group handler 传 status='__flat__' 占位。**实现时择简方案**。

### 3.4 sticky 解锁时机：仅页面刷新

不主动清 `_groupStatus`。`load()` / `loadResults()` 重建 `accounts.value` 时新 row 没 `_groupStatus` → 自动用真实 `_status`。这是设计意图：用户硬刷 = 主动重置；不刷一直保留锁定。

### 3.5 边界 / 不变式

- **§3.5.1 行高亮独立**：`rowClassFor(row._status)` 读真实 `_status`，row 颜色随真实状态实时变化（锁组不锁色），用户能直观看到"这一行还在跑/已成功"，**但仍然停在原组里**。
- **§3.5.2 二次执行覆盖快照**：startExec 内无条件 `row._groupStatus = row._status`。第二次执行的快照基于第二次开始时的真实状态，**不保留第一次的快照**。这是设计意图。
- **§3.5.3 retryFailed 也走 startExec**：自动享受快照（line 349-350 调用同一函数）。
- **§3.5.4 平铺视图不读 `_groupStatus`**：`flatSortedRows` 直接按 `_status` 排，所以 sticky 仅在分组视图有视觉效果。切换视图不需要清 `_groupStatus` —— 切回分组立即恢复锁定状态。
- **§3.5.5 Accounts.vue 不受影响**：它的 row 没 `_groupStatus`，`groupAccountsByStatus` 回退 `_status`，行为完全保持。
- **§3.5.6 lockedEmails 仍存在**：v2.30 既有的 lockedEmails（filter 范围冻结）与本特性正交，独立工作 —— 一个锁 row 集合、一个锁分组键。
- **§3.5.7 自动展开 'running' 组失效**：当 row 进入 running 时不再跳到 running 组（被锁定在原组），所以 line 234-235 的 `groupRefs.value['running']?.toggleRowExpansion` 自动展开 running 组的逻辑实际上**找不到对象**了 —— 因为 row 不在 running 组里。这是预期行为：用户视线已在原组中能看到它（通过行颜色变成浅蓝 + 蓝边）。可以保留代码（无副作用）或删除（YAGNI）。**实现时保留代码**（修代码风险高于价值），加一条注释说明。

### 3.6 持久化

`_groupStatus` 仅 in-memory。不需要 DB 列，不需要 socketState 字段。

## 4. 测试

新增 2 个测试到 `__tests__/status-groups.test.js`：

```js
test('G11 v2.34.0 _groupStatus 优先于 _status 分组', () => {
  const rows = [
    { email: 'a', _status: 'plus', _groupStatus: 'idle' },
    { email: 'b', _status: 'running', _groupStatus: 'idle' },
    { email: 'c', _status: 'error' },  // 无 _groupStatus → 用 _status
  ]
  const groups = groupAccountsByStatus(rows)
  const idleGroup = groups.find(g => g.status === 'idle')
  const errorGroup = groups.find(g => g.status === 'error')
  assert.ok(idleGroup, 'idle 组存在')
  assert.strictEqual(idleGroup.rows.length, 2, 'a, b 锁在 idle 组')
  assert.deepStrictEqual(idleGroup.rows.map(r => r.email), ['a', 'b'])
  assert.ok(errorGroup, 'error 组存在')
  assert.strictEqual(errorGroup.rows.length, 1, 'c 按真实 _status 分')
  assert.strictEqual(errorGroup.rows[0].email, 'c')
})

test('G12 v2.34.0 _groupStatus 空串/null 退回 _status', () => {
  const rows = [
    { email: 'a', _status: 'plus', _groupStatus: '' },
    { email: 'b', _status: 'error', _groupStatus: null },
  ]
  const groups = groupAccountsByStatus(rows)
  // _groupStatus 空字符串/null 走 || fallback → 用 _status
  assert.ok(groups.find(g => g.status === 'plus'))
  assert.ok(groups.find(g => g.status === 'error'))
})
```

视图切换（`flatSortedRows`）是 Vue 组件内 computed，前端无测试基础设施 — 不写单测，依赖手动 smoke。

## 5. 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/status.js` | `groupAccountsByStatus` 改读 `_groupStatus \|\| _status` |
| `web/src/views/Execute.vue` | `startExec` 加快照 + `groupingEnabled` ref + toolbar toggle + `flatSortedRows` computed + 模板分支 |
| `__tests__/status-groups.test.js` | +2 测试（G11/G12） |
| `docs/CHANGELOG.md` | v2.34.0 节 |

后端零改动。Accounts.vue 零改动。

## 6. YAGNI / 不做的

- 不持久化 `_groupStatus` 到 DB（reset on refresh 是设计目标）
- 不引入新 status 码
- 不改 Accounts.vue（它没分组语义）
- 不动 row 高亮逻辑（v2.33）
- 平铺视图不加表头排序（按业务序定死）
- 不动 lockedEmails（与本特性正交）
- 不为 `_groupStatus` 加 socket 同步（in-memory only）

## 7. 版本

v2.34.0 — minor over v2.33.1（前端 UX 增强 + groupAccountsByStatus 签名向后兼容扩展）。
