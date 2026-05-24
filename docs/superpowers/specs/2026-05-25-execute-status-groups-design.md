# Execute 页账户列表按状态分组设计

**Date:** 2026-05-25
**Status:** Draft → 待评审
**Predecessors:** —（Execute.vue 自 v2.19 起的单表平铺布局）

## Background

`web/src/views/Execute.vue` 当前是单表 `el-table` 平铺所有账户。状态体系含 12 种（idle / running / plus / plus_no_rt / no_link / error / deactivated / no_jp_proxy / no_promo / verify_error / paypal_captcha / aborted）。运维要快速看 "Plus(有RT) / Plus(无RT) 有多少" "error 哪几个"，目前要靠 statusFilter 切换、或滚动加色块识别。

目标：按账户状态分组成 collapse 折叠面板，默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠 —— 既能"一眼看到成果资产"，又能"按需展开排查"，不丢现有 selection / log expand / lockedEmails / filter 行为。

## Goals

1. Execute 页账户列表按 `_status` 分组成可折叠 / 可展开的 collapse 面板。
2. 默认展开 `plus` + `plus_no_rt` 两组，其余折叠。
3. 0 账户的状态隐藏（不出 collapse 头）。
4. 分组顺序固定业务序：Plus(有RT) → Plus(无RT) → 运行中 → 错误类 → 空闲/其他。
5. 保留 statusFilter 与分组协同（选某状态 → 其他组被空组隐藏过滤 → 只剩选中那组并自动展开）。
6. 跨组选中、跨组运行中自动展开日志、lockedEmails 冻结视图、auth 下载、execOne 等行为全部不丢。

## Non-Goals

- 不持久化展开状态（每次重载默认展开 Plus 两组）。
- 不抽通用 `GroupedTable` 高阶组件（项目就这一处需要分组，YAGNI）。
- 不给每组加"组内全选" toolbar（el-table 表头 checkbox 已自带组内全选）。
- 不写 Vue 组件测试（项目无前端测试基础设施；改抽 `groupAccountsByStatus` 为纯函数单测）。
- 不改 `selection.js` / status 映射 / 后端 API / Socket.IO 事件。

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| UI 选型 | el-collapse + 每组独立 el-table | Element Plus 最自然组合；selection / expand-log 原生支持 |
| 分组顺序 | 固定业务序（GROUP_ORDER 数组） | 与"默认展开 Plus 两组"语义一致；可预测；新状态加入需 explicit 决定位置 |
| 空组 | 隐藏 | 减少视觉噪音；Plus(有RT) 不存在时不占位 |
| statusFilter | 保留 + 与分组协同 | 用户可走 filter 快速路径，也可走分组点击路径 |
| 折叠记忆 | 不记忆 | 行为可预测；与"默认展开 Plus 两组"一致 |
| 子组件抽取 | 抽 `AccountTableRows.vue` 持有列定义 + el-table | 列定义不重复；父组件循环极简 |
| selection 跨组聚合 | 复用 `selection.js` 全局 Set | 已有工具，零新机制 |
| `groupAccountsByStatus` 抽出 | 纯函数到 `status.js`，单独单测 | 唯一有测试 ROI 的部分 |

## Architecture

```
web/src/status.js                        ← 加 GROUP_ORDER / DEFAULT_EXPANDED_STATUSES / groupAccountsByStatus
__tests__/status-groups.test.js          ← G1-G8 单测
web/src/components/AccountTableRows.vue  ← 新建，封装 el-table 列定义 + 单组渲染
web/src/views/Execute.vue                ← 父组件改造：el-table → el-collapse v-for AccountTableRows
docs/CHANGELOG.md                        ← 追加 v2.27 节
```

**不动**：`selection.js` / status type/label 映射 / 后端 API / Socket.IO 事件 / vue-router 配置。

### 组件拆分

```
Execute.vue (父)
├── Sticky toolbar（执行/选中/下载/...）  ← 不变
├── Filters row（search/statusFilter/planFilter/authFilter）  ← 不变
└── <el-collapse v-model="expandedKeys">
    └── <el-collapse-item v-for="g in visibleGroups" :name="g.status">
        ├── <template #title>
        │     <el-tag :type="g.type">{{ g.label }}</el-tag>
        │     共 {{ g.count }} 个
        │   </template>
        └── <AccountTableRows :rows="g.rows" :running="running"
                              :global-selected-set="globalSelectedSet"
                              :get-history-logs="getHistoryLogs"
                              :get-realtime-logs="getRealtimeLogs"
                              @group-selection-change="onGroupSel(g.status, $event)"
                              @expand-change="onExpand"
                              @row-action="onRowAction"
                              @auth-download="onAuthDownload" />
```

### 数据流

1. **Status 流**：Socket.IO → `socketState.accountStatuses` → watch → `accounts[]._status`（不变）
2. **分组流**：`accounts[]` + filter → `filteredRows` → `groupAccountsByStatus(filteredRows)` → 跳过空组 → 按 `GROUP_ORDER` 排序
3. **选中流**：每个子组件 selection-change → 父汇总到 `globalSelectedSet`（来自 `selection.js`）→ toolbar 的"执行选中 (N)"显示总数
4. **执行/下载流**：toolbar 操作 → 从 `globalSelectedSet` 读邮箱列表 → 调既有 API（无变化）

### 关键不变式

1. **selection.js 仍是单一来源**：每个子组件不持有 selection 状态，change 事件立即写入全局 Set；父组件读 Set 用于 toolbar 计数和 API 调用。
2. **过滤先于分组**：`statusFilter / search / planFilter / authFilter` 应用后才分组 —— 与"隐藏空组"协同实现"只看一组"。
3. **lockedEmails 行为保留**：执行时冻结视图（`lockedEmails.value = Set`）仍生效，分组在锁定子集上做。
4. **expand 日志行为保留**：每个子组件内部用 el-table 原生 expand，不跨表共享 expansion 状态。
5. **`autoExpandedEmail`（运行中账户自动展开日志）**：父组件检测到 running 账户后，先把 `'running'` 加进 `expandedKeys`（确保 collapse 层展开），再调对应子组件的 `tableRef.toggleRowExpansion` 展开日志行。

## Data Structures

### `web/src/status.js` 增量

```js
// === Execute page grouping ===

// 固定业务排序：成功资产优先 → 运行中 → 错误类 → 闲置/其他
export const GROUP_ORDER = [
  'plus',           // Plus(有RT)
  'plus_no_rt',     // Plus(无RT)
  'running',        // 运行中
  'error',          // 错误
  'deactivated',    // 已删除
  'no_link',        // 无链接
  'no_promo',       // 无0元资格
  'verify_error',   // Stripe验证失败
  'no_jp_proxy',    // JP节点不可用
  'paypal_captcha', // PayPal人机验证
  'aborted',        // 已停止
  'idle',           // 空闲
]

// 页面打开时默认展开的组（含数据时才生效）
export const DEFAULT_EXPANDED_STATUSES = ['plus', 'plus_no_rt']

// 纯函数：按状态分桶 + 按 GROUP_ORDER 排序 + 隐藏空组
export function groupAccountsByStatus(rows) {
  const buckets = new Map()
  for (const row of rows) {
    const s = row._status || 'idle'
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s).push(row)
  }
  const orderIndex = new Map(GROUP_ORDER.map((s, i) => [s, i]))
  const groups = []
  for (const [status, list] of buckets.entries()) {
    if (list.length === 0) continue
    groups.push({
      status,
      label: statusLabel(status),
      type: statusType(status),
      rows: list,
      count: list.length,
    })
  }
  groups.sort((a, b) => {
    const ia = orderIndex.has(a.status) ? orderIndex.get(a.status) : 999
    const ib = orderIndex.has(b.status) ? orderIndex.get(b.status) : 999
    return ia - ib
  })
  return groups
}
```

**为什么 GROUP_ORDER 是 12 项而不是 `Object.keys(LABEL_MAP)`**：
- 显式 array 强制业务排序意图（不依赖对象插入顺序）
- 未来加新状态必须 explicit 决定它的排序位置（避免"突然在某处冒出来"）
- 不在 GROUP_ORDER 中的状态 → 视为 unknown，归到末尾（fallback 排序）

### 父组件 `groups` 计算属性的 shape

```js
[
  { status: 'plus',       label: 'Plus(有RT)',   type: 'success',  rows: [...], count: 3 },
  { status: 'plus_no_rt', label: 'Plus(无RT)',   type: 'warning',  rows: [...], count: 5 },
  { status: 'running',    label: '运行中',        type: '',         rows: [...], count: 1 },
  // ... 空组已被过滤掉
]
```

## Child Component `AccountTableRows.vue`

文件位置：`web/src/components/AccountTableRows.vue`。

### Props

| Prop | 类型 | 说明 |
|---|---|---|
| `rows` | `Array<AccountRow>` | 该组的账户行；shape 与父 `accounts[]` 完全一致 |
| `running` | `Boolean` | 流水线是否运行中（影响"重试/执行"按钮的 disabled） |
| `globalSelectedSet` | `Set<string>` | 全局选中 Set（来自 `selection.js`） |
| `getHistoryLogs` | `Function` | `(email) → []` 父组件维护的日志缓存读取器 |
| `getRealtimeLogs` | `Function` | `(email) → []` 走父组件的 socketState.logs.filter |

### Emits

| 事件 | 载荷 | 说明 |
|---|---|---|
| `group-selection-change` | `Array<AccountRow>` | 该组当前选中的行 |
| `expand-change` | `{ row, isExpanded }` | 父用于触发日志加载 |
| `row-action` | `{ email, action: 'execute' \| 'retry' }` | "执行/重试" 按钮点击 |
| `auth-download` | `{ email, format: 'cpa' \| 'sub2api' }` | "CPA / Sub" 按钮点击 |
| `row-click` | `{ row, column, event }` | 透传 el-table row-click（父可选订阅） |

### 暴露

`defineExpose({ tableRef, clearSelection(), toggleRowExpansion(row, expanded) })`：父组件做"取消选中""自动展开运行中行"时调用。

### 关键内部行为

`watch(() => props.rows)` 用 `globalSelectedSet` 回填选中状态：el-table 重渲染（rows 变化）会丢选中，必须从全局 Set 还原。`{ flush: 'post' }` 等 DOM 更新后再调 `toggleRowSelection`。

### 完整代码

```vue
<template>
  <el-table
    ref="tableRef"
    :data="rows"
    row-key="email"
    stripe border size="small"
    @selection-change="onSelectionChange"
    @expand-change="onExpandChange"
    @row-click="onRowClick"
  >
    <el-table-column type="selection" width="45" :reserve-selection="true" />
    <el-table-column type="index" label="#" width="50" />
    <el-table-column prop="email" label="邮箱" min-width="220" />
    <el-table-column prop="loginType" label="类型" width="85">
      <template #default="{ row }">
        <el-tag :type="row.loginType === 'Google' ? 'danger' : 'warning'" size="small">{{ row.loginType }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="计划" width="80">
      <template #default="{ row }">
        <el-tag v-if="row._plan === 'plus'" type="success" size="small">Plus</el-tag>
        <el-tag v-else-if="row._plan === 'free'" size="small">Free</el-tag>
        <span v-else style="color:#c0c4cc">-</span>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="110">
      <template #default="{ row }">
        <el-tag :type="statusType(row._status)" size="small">{{ statusLabel(row._status) }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="阶段" width="100">
      <template #default="{ row }">
        <span style="color:#909399">{{ row._phase || '-' }}</span>
      </template>
    </el-table-column>
    <el-table-column label="Auth" width="120">
      <template #default="{ row }">
        <template v-if="row._hasAuth">
          <el-button size="small" text type="success" @click="emit('auth-download', { email: row.email, format: 'cpa' })">CPA</el-button>
          <el-button size="small" text type="primary" @click="emit('auth-download', { email: row.email, format: 'sub2api' })">Sub</el-button>
        </template>
        <span v-else style="color:#c0c4cc">-</span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="80">
      <template #default="{ row }">
        <el-button
          v-if="row._status === 'error' || row._status === 'idle'"
          size="small" text type="primary"
          :disabled="running"
          @click="emit('row-action', { email: row.email, action: row._status === 'error' ? 'retry' : 'execute' })"
        >{{ row._status === 'error' ? '重试' : '执行' }}</el-button>
      </template>
    </el-table-column>
    <el-table-column type="expand">
      <template #default="{ row }">
        <div style="font-family:'Consolas','Courier New',monospace;font-size:13px;max-height:calc(100vh - 350px);overflow-y:auto;padding:12px;background:#1e1e1e;color:#d4d4d4;border-radius:4px;line-height:1.6">
          <div v-if="getHistoryLogs(row.email).length > 0">
            <div @click="row._showHistory = !row._showHistory" style="cursor:pointer;color:#569cd6;margin-bottom:6px;user-select:none">
              {{ row._showHistory ? '▼' : '▶' }} 历史日志 ({{ getHistoryLogs(row.email).length }} 条)
            </div>
            <div v-if="row._showHistory">
              <div v-for="(log, i) in getHistoryLogs(row.email)" :key="'h'+i" style="white-space:pre-wrap;word-break:break-all">
                <span style="color:#606060">{{ formatTs(log.timestamp) }}</span>
                <span style="color:#808080"> {{ log.message }}</span>
              </div>
              <div style="border-bottom:1px solid #404040;margin:8px 0"></div>
            </div>
          </div>
          <div v-for="(log, i) in getRealtimeLogs(row.email)" :key="'r'+i" style="white-space:pre-wrap;word-break:break-all">
            <span style="color:#808080">{{ formatTs(log.timestamp) }}</span>
            <span> {{ log.message }}</span>
          </div>
          <div v-if="getHistoryLogs(row.email).length === 0 && getRealtimeLogs(row.email).length === 0 && !row._logsLoading" style="color:#808080;padding:10px;text-align:center">暂无日志</div>
          <div v-if="row._logsLoading" style="color:#808080;padding:10px;text-align:center">加载中...</div>
        </div>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { statusType, statusLabel } from '../status'

const props = defineProps({
  rows: { type: Array, required: true },
  running: { type: Boolean, default: false },
  globalSelectedSet: { type: Set, required: true },
  getHistoryLogs: { type: Function, required: true },
  getRealtimeLogs: { type: Function, required: true },
})
const emit = defineEmits(['group-selection-change', 'expand-change', 'row-action', 'auth-download', 'row-click'])

const tableRef = ref(null)

function onSelectionChange(rows) {
  emit('group-selection-change', rows)
}

function onExpandChange(row, expandedRows) {
  const isExpanded = expandedRows.some(r => r.email === row.email)
  emit('expand-change', { row, isExpanded })
}

function onRowClick(row, column, event) {
  emit('row-click', { row, column, event })
}

function formatTs(ts) {
  if (!ts) return ''
  return ts.slice(0, 19).replace('T', ' ')
}

// 关键：rows 变化后（如父组件 filter / 新数据进来），用 globalSelectedSet 回填选中状态
watch(() => props.rows, () => {
  nextTick(() => {
    if (!tableRef.value) return
    for (const row of props.rows) {
      const shouldBeSelected = props.globalSelectedSet.has(row.email)
      tableRef.value.toggleRowSelection(row, shouldBeSelected)
    }
  })
}, { flush: 'post' })

defineExpose({
  tableRef,
  clearSelection() {
    tableRef.value?.clearSelection()
  },
  toggleRowExpansion(row, expanded) {
    tableRef.value?.toggleRowExpansion(row, expanded)
  },
})
</script>
```

## Parent Component `Execute.vue` 改造

### 模板替换

**Find**（约 64-145 行，整个 `<el-table>` 块）→ **Replace with**：

```vue
    <!-- Status-grouped tables with expandable logs -->
    <el-collapse v-model="expandedKeys" style="margin-top:8px">
      <el-collapse-item
        v-for="g in visibleGroups"
        :key="g.status"
        :name="g.status"
      >
        <template #title>
          <div style="display:flex;align-items:center;gap:8px;padding:0 8px">
            <el-tag :type="statusType(g.status)" size="small">{{ statusLabel(g.status) }}</el-tag>
            <span style="color:#909399;font-size:13px">共 {{ g.count }} 个</span>
          </div>
        </template>
        <AccountTableRows
          :ref="el => { if (el) groupRefs[g.status] = el }"
          :rows="g.rows"
          :running="running"
          :global-selected-set="globalSelectedSet"
          :get-history-logs="getHistoryLogs"
          :get-realtime-logs="getRealtimeLogs"
          @group-selection-change="onGroupSelectionChange(g.status, $event)"
          @expand-change="onExpand"
          @row-action="onRowAction"
          @auth-download="onAuthDownload"
        />
      </el-collapse-item>
    </el-collapse>
```

### `<script setup>` 改动

**(a) 新 imports**：

```js
import AccountTableRows from '../components/AccountTableRows.vue'
import { GROUP_ORDER, DEFAULT_EXPANDED_STATUSES, groupAccountsByStatus, statusType, statusLabel, PLUS_STATUSES } from '../status'
import { getSelectionSet, setSelectionFromRows, clearSelection } from '../selection'
```

**(b) 删除原顶层 ref**：删 `const tableRef = ref(null)`、`const selected = ref([])`。

**(c) 新增 state**：

```js
const expandedKeys = ref([...DEFAULT_EXPANDED_STATUSES])
const groupRefs = ref({})
const globalSelectedSet = getSelectionSet('execute')
const groupSelected = ref({})
```

**(d) 替换 `selectedEmails`**：

```js
const selectedEmails = computed(() => Array.from(globalSelectedSet))
```

**(e) 新增 `visibleGroups`**：

```js
const visibleGroups = computed(() => groupAccountsByStatus(filteredRows.value))
```

**(f) 替换 `onSelectionChange` 为 `onGroupSelectionChange`**：

```js
function onGroupSelectionChange(status, rows) {
  groupSelected.value[status] = rows
  // 把本组的选中变化合并到全局 Set
  const groupEmails = new Set((visibleGroups.value.find(g => g.status === status)?.rows || []).map(r => r.email))
  for (const email of Array.from(globalSelectedSet)) {
    if (groupEmails.has(email)) globalSelectedSet.delete(email)
  }
  for (const r of rows) globalSelectedSet.add(r.email)
}
```

**(g) `clearAllSelection` 适配**：

```js
function clearAllSelection() {
  clearSelection('execute')
  for (const ref of Object.values(groupRefs.value)) {
    ref?.clearSelection?.()
  }
}
```

**(h) `onExpand` 适配**（参数 shape `{ row, isExpanded }`）：

```js
async function onExpand({ row, isExpanded }) {
  if (isExpanded) {
    row._logsLoading = true
    try {
      const { data } = await api.get(`/results/${encodeURIComponent(row.email)}/logs`)
      historyLogs.value[row.email] = data
    } catch {}
    row._logsLoading = false
  }
}
```

**(i) 新增 `onRowAction` / `onAuthDownload`**：

```js
function onRowAction({ email, action }) {
  execOne(email)
}

function onAuthDownload({ email, format }) {
  downloadAuth(email, format)
}
```

**(j) Auto-expand 运行中账户跨子组件**：

```js
watch(() => socketState.accountStatuses, (statuses) => {
  let currentRunning = ''
  for (const [email, data] of Object.entries(statuses)) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = data.status || 'running'
      row._phase = data.phase || ''
      if (PLUS_STATUSES.includes(data.status)) { row._hasAuth = true; row._plan = 'plus'; }
      if (['error', 'no_link'].includes(data.status)) row._plan = 'free'
      if (data.status === 'running') currentRunning = email
    }
  }
  if (currentRunning && currentRunning !== autoExpandedEmail.value) {
    nextTick(() => {
      // 先合上上次自动展开的行（可能在另一个子组件里）
      if (autoExpandedEmail.value) {
        const prev = accounts.value.find(a => a.email === autoExpandedEmail.value)
        if (prev) {
          const prevStatus = prev._status || 'idle'
          groupRefs.value[prevStatus]?.toggleRowExpansion?.(prev, false)
        }
      }
      // 展开新的运行中行
      const next = accounts.value.find(a => a.email === currentRunning)
      if (next) {
        if (!expandedKeys.value.includes('running')) {
          expandedKeys.value.push('running')
        }
        nextTick(() => {
          groupRefs.value['running']?.toggleRowExpansion?.(next, true)
          autoExpandedEmail.value = currentRunning
        })
      }
    })
  }
}, { deep: true })
```

**(k) statusFilter 自动展开对应组**：

```js
watch(statusFilter, (newVal) => {
  if (newVal && !expandedKeys.value.includes(newVal)) {
    expandedKeys.value.push(newVal)
  }
})
```

清除 statusFilter 时不主动折叠，保留用户当前展开状态。

## expandedKeys 协调规则

三个 watch + 一个初始默认，都 **only ever add**，不 remove。用户手动折叠是唯一 remove 操作。

| 优先级 | 触发 | 行为 |
|---|---|---|
| 1 | 初始 | `expandedKeys = [...DEFAULT_EXPANDED_STATUSES]` |
| 2 | watch statusFilter | 选中状态 push 进 expandedKeys |
| 3 | watch socketState | 有 running 账户时把 'running' push 进 expandedKeys |
| 4 | 用户手动 toggle | el-collapse 自动同步 v-model（可 add 可 remove） |

"只加不减"避免互相覆盖（如：autoExpand 把 running 加进来，statusFilter 不应把它弹出）。

## 边界用例

| 场景 | 行为 | 实现位置 |
|---|---|---|
| 启动时无任何账户 | `visibleGroups = []`，el-collapse 渲染空 div，无报错 | computed natural |
| Plus 两组都 0 个 | `expandedKeys` 含 'plus'/'plus_no_rt' 但 collapse-item 不存在 → el-collapse 忽略 | el-collapse 容错 |
| GROUP_ORDER 不含的新状态 | 归到末尾（orderIndex.get(undef)→999） | sort fallback |
| 用户折叠 running 组，新账户进 running | autoExpand watch 把 'running' 再加进 expandedKeys → 展开 | watch only-add 语义 |
| 用户手动展开 idle，刷新页面 | 丢失 → 回到 default `['plus', 'plus_no_rt']` | 不持久化决策 |
| 选中跨组迁移：a 从 plus → running | a 仍在 globalSelectedSet 中；running 组子组件 watch 回填 highlight；toolbar 计数不变 | 子组件 watch `(() => props.rows)` |
| lockedEmails 冻结视图 | `filteredRows` 优先返回锁定子集；分组在锁定子集上做 | filteredRows computed |

## REST API / Backend

**无变化**。所有 API 调用（`/results/{email}/logs` / `/execute` / `/auth/download` 等）通过既有 emit 桥接到父组件，由父组件调既有 api 客户端。

## 测试策略

延续 `node:test` + `node --test` 惯例。**不写**前端组件测试（项目无基础设施）。抽 `groupAccountsByStatus` 为纯函数到 `web/src/status.js` 后单测。

### `__tests__/status-groups.test.js` 新增 G1-G8

| # | 用例 |
|---|---|
| G1 | 空数组返回空数组 |
| G2 | 按 GROUP_ORDER 排序（plus → running → error 三组的 status 顺序）|
| G3 | 隐藏空组（无 plus_no_rt 行时 groups 不含 plus_no_rt）|
| G4 | 同状态行聚到同一组（plus 2 个，count=2，rows 顺序保持插入序）|
| G5 | `_status` 缺失视为 idle |
| G6 | GROUP_ORDER 之外的 status 排到末尾 |
| G7 | `group.label` / `type` 用 statusLabel / statusType 派生 |
| G8 | `DEFAULT_EXPANDED_STATUSES === ['plus', 'plus_no_rt']` |

完整代码：

```js
const test = require('node:test')
const assert = require('node:assert')

let groupAccountsByStatus, GROUP_ORDER, DEFAULT_EXPANDED_STATUSES

test.before(async () => {
  const mod = await import('../web/src/status.js')
  groupAccountsByStatus = mod.groupAccountsByStatus
  GROUP_ORDER = mod.GROUP_ORDER
  DEFAULT_EXPANDED_STATUSES = mod.DEFAULT_EXPANDED_STATUSES
})

test('G1 空数组返回空数组', () => {
  assert.deepStrictEqual(groupAccountsByStatus([]), [])
})

test('G2 按 GROUP_ORDER 排序', () => {
  const rows = [
    { email: 'a', _status: 'error' },
    { email: 'b', _status: 'plus' },
    { email: 'c', _status: 'running' },
  ]
  const groups = groupAccountsByStatus(rows)
  assert.deepStrictEqual(groups.map(g => g.status), ['plus', 'running', 'error'])
})

test('G3 隐藏空组', () => {
  const rows = [{ email: 'a', _status: 'plus' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].status, 'plus')
})

test('G4 同状态行聚到同一组', () => {
  const rows = [
    { email: 'a', _status: 'plus' },
    { email: 'b', _status: 'plus' },
    { email: 'c', _status: 'error' },
  ]
  const groups = groupAccountsByStatus(rows)
  const plus = groups.find(g => g.status === 'plus')
  assert.strictEqual(plus.count, 2)
  assert.deepStrictEqual(plus.rows.map(r => r.email), ['a', 'b'])
})

test('G5 _status 缺失视为 idle', () => {
  const rows = [{ email: 'a' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups[0].status, 'idle')
})

test('G6 GROUP_ORDER 之外的 status 排到末尾', () => {
  const rows = [
    { email: 'a', _status: 'plus' },
    { email: 'b', _status: 'unknown_new_status' },
    { email: 'c', _status: 'error' },
  ]
  const groups = groupAccountsByStatus(rows)
  assert.deepStrictEqual(groups.map(g => g.status), ['plus', 'error', 'unknown_new_status'])
})

test('G7 group.label / type 用 statusLabel / statusType 派生', () => {
  const rows = [{ email: 'a', _status: 'plus_no_rt' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups[0].label, 'Plus(无RT)')
  assert.strictEqual(groups[0].type, 'warning')
})

test('G8 DEFAULT_EXPANDED_STATUSES 是 [plus, plus_no_rt]', () => {
  assert.deepStrictEqual(DEFAULT_EXPANDED_STATUSES, ['plus', 'plus_no_rt'])
})
```

### 人工验证清单（PR 评审 checklist）

- [ ] 打开 Execute 页：默认 Plus(有RT) + Plus(无RT) 两组展开，其余折叠
- [ ] 0 账户的状态不出 collapse 头（验证"隐藏空组"）
- [ ] 按 GROUP_ORDER 顺序：plus → plus_no_rt → running → error → 其他
- [ ] 选中 plus 组 1 个 + plus_no_rt 组 1 个 → toolbar 显示"执行选中 (2)"
- [ ] 启动执行 → running 组自动出现并展开 + 当前账户日志行自动展开
- [ ] 账户从 running 变 plus → 自动从 running 组迁移到 plus 组 + 旧的展开行合上
- [ ] 选中跨组迁移：选中的 a 从 plus → running，仍保持选中标记（toolbar 计数不变）
- [ ] 顶部 statusFilter 选 `error` → 只看到 error 组（且自动展开）
- [ ] 清除 statusFilter → 其他组重新出现（plus 两组仍展开，其他保持折叠）
- [ ] "取消选中" 按钮 → 所有组的 selection 都清空
- [ ] 执行中冻结视图（lockedEmails）下，分组仍按锁定子集分桶
- [ ] 刷新页面 → 展开状态回到默认（plus 两组），手动展开的状态丢失

### 不写自动化测试的部分

- `AccountTableRows.vue` 组件渲染 / props / emit —— 无前端测试基础设施
- `Execute.vue` 父组件整合 —— 集成测试范畴，靠人工 dev server 验证
- el-collapse / el-table 行为 —— 第三方组件

## 实施顺序建议

1. **`web/src/status.js`** —— 加 `GROUP_ORDER` / `DEFAULT_EXPANDED_STATUSES` / `groupAccountsByStatus` 纯函数
2. **`__tests__/status-groups.test.js`** —— TDD 加 G1-G8
3. **`web/src/components/AccountTableRows.vue`** —— 新建子组件
4. **`web/src/views/Execute.vue`** —— 父组件改造（模板 + script setup）+ `cd web && npm run build`
5. **`docs/CHANGELOG.md`** —— 追加 v2.27 节

## 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `watch(() => props.rows)` 回填 selection 时引起 el-table 闪动 | `{ flush: 'post' }` 等 DOM 更新；toggleRowSelection 内部 diff，不会全表重绘 |
| R2 | 多个 el-table 启用 `reserve-selection` 与全局 Set 双重 source-of-truth → 漂移 | globalSelectedSet 是唯一真相；reserve-selection 仅作为表内 reserve，watch 回填强制对齐 |
| R3 | autoExpand 把 'running' 加进 expandedKeys 但 running 组即将出现 | nextTick + nextTick 双层延迟（先等 collapse 展开，再 toggleRowExpansion）|
| R4 | `groupRefs[g.status] = el` 在 v-for 中赋值，组 unmount 时不会自动清理 | 旧 ref 指向 unmounted 实例，调用 `?.toggleRowExpansion?.(...)` 时 `?.` 短路；非必要不主动清理 |
| R5 | 子组件抽出后丢失 row-click 等隐式行为 | row-click 透传 emit，父不订阅 = noop（与原状一致）|
| R6 | `groupAccountsByStatus` 测试用 ESM 动态 import 在 Node 22 是否能跑 | `await import(...)` 是 Node 22 原生支持，无需 babel |
| R7 | `expandedKeys.value.push(...)` 直接 mutate 数组 | Vue 3 ref 数组 push 是反应式的（Proxy 拦截）|

## 估算

| 节 | 行数 |
|---|---|
| `status.js` 增量（GROUP_ORDER + DEFAULT_EXPANDED + groupAccountsByStatus） | ~30 |
| `__tests__/status-groups.test.js` | ~50 |
| `AccountTableRows.vue` | ~110 |
| `Execute.vue` 改造（净增） | ~60 |
| `CHANGELOG.md` v2.27 节 | ~15 |
| **合计** | **~265 行净增** |

实施总耗时预估：**1 个工作日内 ship**（含 PR 审阅 + 人工验证清单跑完）。
