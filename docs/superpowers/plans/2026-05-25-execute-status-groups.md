# Execute 页账户列表按状态分组 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute 页账户列表按 `_status` 分组成 `el-collapse` 折叠面板，默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠；隐藏空组；按固定业务序排序。

**Architecture:** 抽 `groupAccountsByStatus` 纯函数到 `status.js`（TDD 单测）；抽 `AccountTableRows.vue` 子组件持有原 el-table 列定义；父组件 `Execute.vue` 改用 `el-collapse v-for AccountTableRows`，通过 `selection.js` 全局 Set 跨组聚合选中、通过 `groupRefs` 把"自动展开运行中行"事件路由到对应子组件。

**Tech Stack:** Vue 3 + Element Plus / `node:test` 内置测试。

**Spec:** `docs/superpowers/specs/2026-05-25-execute-status-groups-design.md`

---

## 文件清单

**新建：**
- `web/src/components/AccountTableRows.vue` — 子组件封装 el-table 列定义
- `__tests__/status-groups.test.js` — 8 个 G 单测

**修改：**
- `web/src/status.js` — 加 `GROUP_ORDER` / `DEFAULT_EXPANDED_STATUSES` / `groupAccountsByStatus`
- `web/src/views/Execute.vue` — 父组件改造（template + script setup）
- `docs/CHANGELOG.md` — 追加 v2.27 节

**不动：** `web/src/selection.js`（已有工具）/ 后端 API / Socket.IO 事件。

---

## Task 1：`status.js` 加常量 + 纯函数（TDD G1-G8）

**Files:**
- Modify: `web/src/status.js`
- Create: `__tests__/status-groups.test.js`

### Step 1：创建测试文件 `__tests__/status-groups.test.js`

- [ ] **Step 1:** Create with this content:

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

### Step 2：跑测试确认失败

- [ ] **Step 2:**

Run: `node --test __tests__/status-groups.test.js`
Expected: 8 个用例 FAIL，错误类似 `Cannot read properties of undefined (reading 'apply')` 或 `mod.groupAccountsByStatus is undefined`。

### Step 3：在 `web/src/status.js` 末尾追加 GROUP_ORDER + DEFAULT_EXPANDED_STATUSES + groupAccountsByStatus

- [ ] **Step 3:** Find this line at the end of `web/src/status.js`：

```js
export const ALIVE_FILTER_OPTIONS = Object.entries(ALIVE_LABEL_MAP).map(([value, label]) => ({ value, label }))
```

Append (don't replace — keep that line) these new exports IMMEDIATELY AFTER it:

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

/**
 * 按状态分桶 + 按 GROUP_ORDER 排序 + 隐藏空组
 * @param {Array} rows — 账户行（需含 _status 字段，缺失视为 'idle'）
 * @returns {Array<{ status, label, type, rows, count }>}
 */
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

### Step 4：跑测试确认全 PASS

- [ ] **Step 4:**

Run: `node --test __tests__/status-groups.test.js`
Expected: 8 cases PASS.

### Step 5：跑全套 JS 测试无回归

- [ ] **Step 5:**

Run: `node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js`
Expected: ALL PASS（既有 141 + 新 8 = 149 个）。

### Step 6：Commit

- [ ] **Step 6:**

```bash
git add web/src/status.js __tests__/status-groups.test.js
git commit -m "$(cat <<'EOF'
feat(status): groupAccountsByStatus + GROUP_ORDER constants (TDD)

新增 web/src/status.js 三个导出：
- GROUP_ORDER：12 个状态的固定业务排序数组
- DEFAULT_EXPANDED_STATUSES：['plus', 'plus_no_rt']
- groupAccountsByStatus(rows)：纯函数，按状态分桶 + 按 GROUP_ORDER
  排序 + 隐藏空组，返回 [{status, label, type, rows, count}]

8 单测覆盖空输入 / 业务序 / 空组过滤 / 同状态聚合 / 缺失 _status /
未知状态 fallback / label-type 派生 / DEFAULT_EXPANDED 常量。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：新建 `AccountTableRows.vue` 子组件

**Files:**
- Create: `web/src/components/AccountTableRows.vue`

### Step 1：创建子组件文件

- [ ] **Step 1:** Create `web/src/components/AccountTableRows.vue` with:

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
// el-table 的 reserve-selection 只在本表内 reserve；globalSelectedSet 是跨表共享真相。
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

<style scoped>
:deep(.el-table__body tr) {
  cursor: pointer;
}
</style>
```

### Step 2：临时 build smoke（仅 compile-check，组件还未被父引用）

- [ ] **Step 2:**

Run: `cd web && npm run build`
Expected: build PASS（虽然组件还没被引用，Vite 仍会编译它，确认 SFC 语法无误）。

### Step 3：Commit

- [ ] **Step 3:**

```bash
git add web/src/components/AccountTableRows.vue
git commit -m "$(cat <<'EOF'
feat(web/components): AccountTableRows extracted from Execute table

新建子组件 web/src/components/AccountTableRows.vue（145 行），
封装原 Execute.vue 的 el-table 列定义 + 展开日志行模板。

Props: rows / running / globalSelectedSet / getHistoryLogs / getRealtimeLogs
Emits: group-selection-change / expand-change / row-action / auth-download / row-click
Exposes: tableRef / clearSelection / toggleRowExpansion

关键不变式：watch(() => props.rows) 在 rows 变化后用 globalSelectedSet
回填选中状态 — el-table 重渲染会丢选中，必须从全局 Set 还原以支持跨组
selection 迁移。scoped style 加 :deep(.el-table__body tr) cursor pointer
与父组件原 style 保持一致。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：`Execute.vue` 父组件改造

**Files:**
- Modify: `web/src/views/Execute.vue`

### Step 1：替换 imports

- [ ] **Step 1:** Find lines 150-155 in `web/src/views/Execute.vue`:

```js
import { ref, computed, watch, onMounted, shallowRef, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel, PLUS_STATUSES } from '../status'
import { getSelectionSet, setSelectionFromRows, clearSelection } from '../selection'
```

Replace with（加 `AccountTableRows` + `GROUP_ORDER / DEFAULT_EXPANDED_STATUSES / groupAccountsByStatus`）:

```js
import { ref, computed, watch, onMounted, shallowRef, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel, PLUS_STATUSES, DEFAULT_EXPANDED_STATUSES, groupAccountsByStatus } from '../status'
import { getSelectionSet, setSelectionFromRows, clearSelection } from '../selection'
import AccountTableRows from '../components/AccountTableRows.vue'
```

### Step 2：替换顶层 state

- [ ] **Step 2:** Find lines 157-161:

```js
const tableRef = ref(null)
const running = ref(false)
const accounts = ref([])
const selected = ref([])
const autoExpandedEmail = ref('')
```

Replace with（移除 `tableRef` / `selected`，加 `expandedKeys` / `groupRefs` / `globalSelectedSet`）:

```js
const running = ref(false)
const accounts = ref([])
const autoExpandedEmail = ref('')
const expandedKeys = ref([...DEFAULT_EXPANDED_STATUSES])
const groupRefs = ref({})
const globalSelectedSet = getSelectionSet('execute')
```

### Step 3：替换 `selectedEmails` computed

- [ ] **Step 3:** Find line 170:

```js
const selectedEmails = computed(() => selected.value.map(r => r.email))
```

Replace with:

```js
const selectedEmails = computed(() => Array.from(globalSelectedSet))
```

### Step 4：新增 `visibleGroups` computed + statusFilter watch

- [ ] **Step 4:** Find this block (around lines 191-194):

```js
// Any filter change unlocks the view
watch([search, statusFilter, planFilter, authFilter], () => {
  lockedEmails.value = null
})
```

INSERT IMMEDIATELY BEFORE that block:

```js
const visibleGroups = computed(() => groupAccountsByStatus(filteredRows.value))

// statusFilter 选中状态时自动展开该组（only-add 语义）
watch(statusFilter, (newVal) => {
  if (newVal && !expandedKeys.value.includes(newVal)) {
    expandedKeys.value.push(newVal)
  }
})

```

### Step 5：替换 `onExpand` 签名

- [ ] **Step 5:** Find this function (lines 211-221):

```js
async function onExpand(row, expandedRows) {
  const isExpanded = expandedRows.some(r => r.email === row.email)
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

Replace with（参数 shape 改为 `{ row, isExpanded }`，匹配子组件 emit 载荷）:

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

### Step 6：替换 socketState watch 中 autoExpand 部分

- [ ] **Step 6:** Find this block (around lines 235-246):

```js
  if (currentRunning && currentRunning !== autoExpandedEmail.value) {
    nextTick(() => {
      if (autoExpandedEmail.value) {
        const prev = accounts.value.find(a => a.email === autoExpandedEmail.value)
        if (prev) tableRef.value?.toggleRowExpansion(prev, false)
      }
      const cur = accounts.value.find(a => a.email === currentRunning)
      if (cur) tableRef.value?.toggleRowExpansion(cur, true)
      autoExpandedEmail.value = currentRunning
    })
  }
}, { deep: true })
```

Replace with（路由到对应子组件 + 自动展开 running collapse 组）:

```js
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
      // 展开新的运行中行 — 先确保 running 组本身展开
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

### Step 7：替换 selection + click 相关函数

- [ ] **Step 7:** Find this block (lines 287-313):

```js
function onSelectionChange(rows) {
  selected.value = rows
  setSelectionFromRows('execute', rows)
}

function clearAllSelection() {
  tableRef.value?.clearSelection()
  clearSelection('execute')
  selected.value = []
}

// Restore selection after data is loaded (Element Plus needs toggleRowSelection on actual row refs)
function restoreSelection() {
  const saved = getSelectionSet('execute')
  if (saved.size === 0 || !tableRef.value) return
  nextTick(() => {
    for (const row of accounts.value) {
      if (saved.has(row.email)) tableRef.value.toggleRowSelection(row, true)
    }
  })
}

function onRowClick(row, column, event) {
  if (column?.type === 'selection' || column?.type === 'expand') return
  if (event?.target?.closest('.el-button, .el-dropdown, a')) return
  tableRef.value?.toggleRowSelection(row)
}
```

Replace with:

```js
function onGroupSelectionChange(status, rows) {
  // 把本组的选中变化合并到全局 Set：先移除本组 emails，再加入本次选中
  const group = visibleGroups.value.find(g => g.status === status)
  const groupEmails = new Set((group?.rows || []).map(r => r.email))
  for (const email of Array.from(globalSelectedSet)) {
    if (groupEmails.has(email)) globalSelectedSet.delete(email)
  }
  for (const r of rows) globalSelectedSet.add(r.email)
}

function clearAllSelection() {
  clearSelection('execute')
  for (const ref of Object.values(groupRefs.value)) {
    ref?.clearSelection?.()
  }
}

function onRowAction({ email, action }) {
  // action 是 'retry' 或 'execute'，两者后端流程相同（execOne 单账户启动）
  execOne(email)
}

function onAuthDownload({ email, format }) {
  downloadAuth(email, format)
}
```

注意：删除了 `restoreSelection` 函数 —— 子组件 `watch(() => props.rows)` 自动用 `globalSelectedSet` 回填，替代了原 restore 逻辑。

### Step 8：在 `loadAccounts` 末尾移除 `restoreSelection()` 调用

- [ ] **Step 8:** Find this line (around line 261):

```js
    restoreSelection()
```

Delete that single line. The 子组件 `watch(() => props.rows)` handles it now.

### Step 9：替换 template 中整个表格块

- [ ] **Step 9:** Find this block (lines 64-145):

```vue
    <!-- Account Table with expandable logs -->
    <el-table
      ref="tableRef"
      :data="filteredRows"
      row-key="email"
      stripe border size="small"
      @selection-change="onSelectionChange"
      @expand-change="onExpand"
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
            <el-button size="small" text type="success" @click="downloadAuth(row.email, 'cpa')">CPA</el-button>
            <el-button size="small" text type="primary" @click="downloadAuth(row.email, 'sub2api')">Sub</el-button>
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
            @click="execOne(row.email)"
          >{{ row._status === 'error' ? '重试' : '执行' }}</el-button>
        </template>
      </el-table-column>
      <!-- Expandable log per account -->
      <el-table-column type="expand">
        <template #default="{ row }">
          <div style="font-family:'Consolas','Courier New',monospace;font-size:13px;max-height:calc(100vh - 350px);overflow-y:auto;padding:12px;background:#1e1e1e;color:#d4d4d4;border-radius:4px;line-height:1.6">
            <!-- Historical logs — click to toggle -->
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
            <!-- Realtime logs — always visible -->
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
```

Replace with（el-collapse v-for AccountTableRows）:

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

### Step 10：删除父组件 scoped style（cursor 已移到子组件）

- [ ] **Step 10:** Find this block at the end of file (lines 380-384):

```vue
<style scoped>
:deep(.el-table__body tr) {
  cursor: pointer;
}
</style>
```

Delete the entire block. The cursor style is now in `AccountTableRows.vue` (Task 2).

### Step 11：前端 build

- [ ] **Step 11:**

```bash
cd web && npm run build
```

Expected: Vite build success, no Vue compile errors. `web/dist/index.html` updated.

### Step 12：Grep 验证

- [ ] **Step 12:** Run these checks:

```bash
grep -c "AccountTableRows" web/src/views/Execute.vue          # 期望 3 (import + el-collapse-item 内 + 标签关闭)
grep -c "visibleGroups" web/src/views/Execute.vue             # 期望 2 (computed + template v-for)
grep -c "onGroupSelectionChange" web/src/views/Execute.vue    # 期望 2 (定义 + template emit handler)
grep -c "groupRefs" web/src/views/Execute.vue                 # 期望 4+ (ref + el => + clearAllSelection + autoExpand x2)
grep -c "tableRef" web/src/views/Execute.vue                  # 期望 0 (已全部替换为 groupRefs)
grep -c "restoreSelection" web/src/views/Execute.vue          # 期望 0 (已删除)
```

### Step 13：Commit

- [ ] **Step 13:**

```bash
git add web/src/views/Execute.vue
git commit -m "$(cat <<'EOF'
feat(web/execute): collapse-grouped account list by status

Execute.vue 账户列表由单 el-table 改为 el-collapse v-for AccountTableRows
按 _status 分组，默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠。

关键改动：
- imports 加 GROUP_ORDER / DEFAULT_EXPANDED_STATUSES / groupAccountsByStatus /
  AccountTableRows
- 删 tableRef / selected，加 expandedKeys / groupRefs / globalSelectedSet
- visibleGroups computed = groupAccountsByStatus(filteredRows)
- onGroupSelectionChange 把本组选中变化合并到全局 Set
- autoExpand 跨子组件接线：先 push 'running' 进 expandedKeys，
  nextTick 后调对应子组件 toggleRowExpansion
- statusFilter watch only-add 进 expandedKeys（自动展开选中状态的组）
- restoreSelection 函数删除：子组件 watch (() => props.rows) + globalSelectedSet
  回填替代之

子组件抽取后父组件 scoped style 也移到子组件中（el-table cursor:pointer）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：CHANGELOG v2.27 节 + 全量测试

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1：插入 v2.27 节

- [ ] **Step 1:** Insert IMMEDIATELY AFTER the `# Changelog` heading (line 1) and BEFORE the existing top version section:

```markdown
## v2.27.0 — 2026-05-25

### Execute Page Status-Grouped Account List

Execute 页账户列表由单表平铺改为按 `_status` 分组成 `el-collapse` 折叠面板。默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠 —— 运维一眼能看到"成功资产"，错误账号按需展开排查。

**核心改动：**

- **`groupAccountsByStatus` 纯函数** 加到 `web/src/status.js`：按 `_status` 分桶 + 按固定业务序 `GROUP_ORDER`（12 个状态）排序 + 隐藏空组。`DEFAULT_EXPANDED_STATUSES = ['plus', 'plus_no_rt']` 同 status.js 导出。
- **`AccountTableRows.vue` 子组件**：从 Execute.vue 抽出 el-table 列定义 + 展开日志行模板（145 行）。Props 含 `rows / running / globalSelectedSet / getHistoryLogs / getRealtimeLogs`。Emits `group-selection-change / expand-change / row-action / auth-download / row-click`。Exposes `tableRef / clearSelection / toggleRowExpansion`。
- **`Execute.vue` 改造**：`<el-collapse v-model="expandedKeys">` v-for `<AccountTableRows>`；selection 由 `selection.js` 全局 Set 跨组聚合；`autoExpand` 跨子组件接线（先 push `'running'` 进 expandedKeys，nextTick 后调对应子组件 `toggleRowExpansion`）。
- **`statusFilter` 与分组协同**：选某状态 → watch only-add 进 expandedKeys → 该组自动展开；空组隐藏后效果等同于"只看那一组"。

**关键不变式**：`selection.js` 仍是单一来源 —— 子组件 `watch(() => props.rows) + globalSelectedSet` 在 rows 变化（如跨组迁移）时自动回填选中标记。替代了原 `restoreSelection()` 函数。

**单测**：`__tests__/status-groups.test.js` +8（G1-G8：空输入 / 业务序 / 空组过滤 / 同状态聚合 / 缺失 _status / 未知状态 fallback / label-type 派生 / DEFAULT_EXPANDED 常量）。全量 149 passing，无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-status-groups-design.md` + `docs/superpowers/plans/2026-05-25-execute-status-groups.md`。

```

### Step 2：跑全套 JS + Python 测试

- [ ] **Step 2:**

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: ALL PASS（既有 141 + 新 8 G = 149 个 JS + 4 个 Python）。

### Step 3：人工验证清单（运维侧，PR 评审 checklist）

- [ ] **Step 3:** 启动 `node server/index.js` 后逐条验证：
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

### Step 4：Commit CHANGELOG

- [ ] **Step 4:**

```bash
git add docs/CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: v2.27.0 execute page status-grouped account list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 全套测试一遍（实施完成后最终冒烟）

- [ ] 4 任务完成后跑：

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
py -3 -m unittest tests.test_protocol_register_h1_fallback
```

Expected: 149/149 JS PASS + 4/4 Python PASS。
