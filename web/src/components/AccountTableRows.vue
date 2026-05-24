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
