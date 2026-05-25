<template>
  <el-table
    ref="tableRef"
    :data="rows"
    row-key="email"
    stripe border size="small"
    :row-class-name="rowClass"
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
        <span v-else style="color:var(--app-text-mute)">-</span>
      </template>
    </el-table-column>
    <el-table-column label="状态" width="110">
      <template #default="{ row }">
        <el-tag :type="statusType(row._status)" size="small">{{ statusLabel(row._status) }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column label="阶段" width="100">
      <template #default="{ row }">
        <span style="color:var(--app-text-3)">{{ row._phase || '-' }}</span>
      </template>
    </el-table-column>
    <el-table-column label="Auth" width="120">
      <template #default="{ row }">
        <template v-if="row._hasAuth">
          <el-button size="small" text type="success" @click="emit('auth-download', { email: row.email, format: 'cpa' })">CPA</el-button>
          <el-button size="small" text type="primary" @click="emit('auth-download', { email: row.email, format: 'sub2api' })">Sub</el-button>
        </template>
        <span v-else style="color:var(--app-text-mute)">-</span>
      </template>
    </el-table-column>
    <el-table-column label="原因" min-width="120" show-overflow-tooltip>
      <template #default="{ row }">
        <span v-if="row._reason" :style="row._status === 'deactivated' ? 'color:var(--app-danger)' : 'color:var(--app-text-3)'">
          {{ row._reason }}
        </span>
        <span v-else style="color:var(--app-text-mute)">-</span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="80">
      <template #default="{ row }">
        <el-button
          v-if="row._status === 'idle' || isFailedToRetry(row._status)"
          size="small" text type="primary"
          :disabled="running"
          @click="emit('row-action', { email: row.email, action: row._status === 'idle' ? 'execute' : 'retry' })"
        >{{ row._status === 'idle' ? '执行' : '重试' }}</el-button>
      </template>
    </el-table-column>
    <el-table-column type="expand">
      <template #default="{ row }">
        <!-- v2.28 #3: 顶部 banner — 本次执行的代理上下文 -->
        <div v-if="row._proxyNode || row._exitIp"
             style="display:flex;gap:var(--sp-4);padding:var(--sp-2) var(--sp-3);background:var(--app-surface-2);border:1px solid var(--app-border-soft);border-radius:var(--rad-sm);margin-bottom:var(--sp-2);font-size:var(--fs-sm);color:var(--app-text-2)">
          <span v-if="row._proxyNode"><strong>代理节点:</strong> {{ row._proxyNode }}</span>
          <span v-if="row._exitIp"><strong>出口 IP:</strong> {{ row._exitIp }}</span>
          <span v-if="row._updatedAt" style="margin-left:auto;color:var(--app-text-3)">{{ formatTs(row._updatedAt) }}</span>
        </div>
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
import { ref, watch } from 'vue'
import { statusType, statusLabel, isFailedToRetry, rowClassFor } from '../status'

const props = defineProps({
  rows: { type: Array, required: true },
  running: { type: Boolean, default: false },
  globalSelectedSet: { type: Set, required: true },
  getHistoryLogs: { type: Function, required: true },
  getRealtimeLogs: { type: Function, required: true },
})
const emit = defineEmits(['group-selection-change', 'expand-change', 'row-action', 'auth-download', 'row-click'])

// v2.33.0: el-table :row-class-name 钩子，按 row._status 上色
function rowClass({ row }) {
  return rowClassFor(row._status)
}

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

// 关键：rows 变化后（父组件 filter / 新数据进来）用 globalSelectedSet 回填选中状态。
// el-table 的 reserve-selection 只在本表内按 row-key 缓存；跨表迁移（如账户从
// plus 组 → running 组）必须靠 globalSelectedSet 重新 toggle。
//
// 为什么不 watch globalSelectedSet 自身：本组的选中变化通过 emit
// 'group-selection-change' → 父组件 onGroupSelectionChange 直接 mutate
// globalSelectedSet（add/delete）；
// 其他组的选中变化对本组无影响（不在本表的 rows 里）。watch Set 会引入
// 无穷循环（emit → Set 变 → watch 触发 → toggleRowSelection → 再 emit）。
//
// `{ flush: 'post' }` 把回调推到 DOM 更新之后，此时 el-table 已渲染新 rows，
// 可直接调 toggleRowSelection — 无需再 nextTick。
watch(() => props.rows, () => {
  if (!tableRef.value) return
  for (const row of props.rows) {
    const shouldBeSelected = props.globalSelectedSet.has(row.email)
    tableRef.value.toggleRowSelection(row, shouldBeSelected)
  }
}, { flush: 'post' })

defineExpose({
  clearSelection() {
    tableRef.value?.clearSelection()
  },
  toggleRowExpansion(row, expanded) {
    tableRef.value?.toggleRowExpansion(row, expanded)
  },
  toggleRowSelection(row) {
    tableRef.value?.toggleRowSelection(row)
  },
})
</script>

<style scoped>
:deep(.el-table__body tr) {
  cursor: pointer;
}

/* v2.33 行高亮 — v2.34 颜色源切到 token，自动跟随暗色模式 */
:deep(.row-status-success td) { background-color: var(--app-row-success) !important; }
:deep(.row-status-warning td) { background-color: var(--app-row-warning) !important; }
:deep(.row-status-danger  td) { background-color: var(--app-row-danger)  !important; }
:deep(.row-status-info    td) { background-color: var(--app-row-info)    !important; }

/* running 专属浅蓝 + 左边框，避免与多状态共用的 warning 撞色 */
:deep(.row-status-running td) { background-color: rgba(64, 158, 255, 0.10) !important; }
:deep(.row-status-running td:first-child) { border-left: 4px solid var(--app-brand) !important; }
</style>
