<template>
  <el-table
    ref="tableRef"
    :data="rows"
    row-key="email"
    stripe border size="small"
    :row-class-name="rowClass"
    @selection-change="onSelectionChange"
    @row-click="onRowClick"
  >
    <el-table-column type="selection" width="45" :reserve-selection="true" />
    <el-table-column type="expand">
      <template #default="{ row }">
        <!-- v2.41.5: 测活日志每账号 expand row。参照 AccountTableRows.vue 的暗色
             面板样式；数据由父组件通过 getHistoryLogs / getRealtimeLogs prop
             从 socketState.logs (全账号混合) 按 email 过滤后传入。 -->
        <div style="font-family:'Consolas','Courier New',monospace;font-size:13px;max-height:calc(100vh - 350px);overflow-y:auto;padding:12px;background:#1e1e1e;color:#d4d4d4;border-radius:4px;line-height:1.6">
          <div v-if="getHistoryLogs(row.email).length > 0">
            <div @click="row._showHistory = !row._showHistory" style="cursor:pointer;color:#569cd6;margin-bottom:6px;user-select:none">
              {{ row._showHistory ? '▼' : '▶' }} 历史日志 ({{ getHistoryLogs(row.email).length }} 条)
            </div>
            <div v-if="row._showHistory">
              <div v-for="(log, i) in getHistoryLogs(row.email)" :key="'h'+i" style="white-space:pre-wrap;word-break:break-all">
                <span style="color:#606060">{{ formatTs(log.timestamp) }}</span>
                <span :style="{ color: logLevelColor(log.level) }"> [{{ log.level }}]</span>
                <span style="color:#808080"> {{ log.message }}</span>
              </div>
              <div style="border-bottom:1px solid #404040;margin:8px 0"></div>
            </div>
          </div>
          <div v-for="(log, i) in getRealtimeLogs(row.email)" :key="'r'+i" style="white-space:pre-wrap;word-break:break-all">
            <span style="color:#808080">{{ formatTs(log.timestamp) }}</span>
            <span :style="{ color: logLevelColor(log.level) }"> [{{ log.level }}]</span>
            <span> {{ log.message }}</span>
          </div>
          <div v-if="getHistoryLogs(row.email).length === 0 && getRealtimeLogs(row.email).length === 0" style="color:#808080;padding:10px;text-align:center">暂无日志</div>
        </div>
      </template>
    </el-table-column>
    <el-table-column type="index" label="#" width="50" />
    <el-table-column prop="email" label="邮箱" min-width="220" />
    <el-table-column prop="loginType" label="类型" width="90">
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
    <el-table-column label="活性" width="120">
      <template #default="{ row }">
        <el-tooltip v-if="row._aliveReason" :content="row._aliveReason" placement="top">
          <el-tag :type="aliveStatusType(row._aliveStatus)" size="small">
            {{ aliveStatusLabel(row._aliveStatus) }}
          </el-tag>
        </el-tooltip>
        <el-tag v-else :type="aliveStatusType(row._aliveStatus)" size="small">
          {{ aliveStatusLabel(row._aliveStatus) }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="上次测活" width="120">
      <template #default="{ row }">
        <span v-if="row._aliveCheckedAt" :title="row._aliveCheckedAt" style="color:#909399">
          {{ formatRelative(row._aliveCheckedAt) }}
        </span>
        <span v-else style="color:#c0c4cc">-</span>
      </template>
    </el-table-column>
    <el-table-column label="密码" width="150">
      <template #default="{ row }">
        <span style="font-family:monospace">{{ row._showPw ? row.password : '••••••' }}</span>
        <el-button size="small" text @click.stop="row._showPw = !row._showPw">{{ row._showPw ? '隐' : '显' }}</el-button>
      </template>
    </el-table-column>
    <el-table-column label="凭证" width="120">
      <template #default="{ row }">
        <!-- 三个圆点：是否设置。绿=有 灰=空。点击 '查' 弹出 popover
             展示完整字段 + 复制按钮，避免主表挤 4 个长字段列。 -->
        <span style="display:inline-flex;gap:4px;align-items:center">
          <span title="TOTP" :style="{ display:'inline-block', width:'8px', height:'8px', borderRadius:'50%', background: row.totp_secret ? '#67c23a' : '#dcdfe6' }" />
          <span title="Client ID" :style="{ display:'inline-block', width:'8px', height:'8px', borderRadius:'50%', background: row.client_id ? '#67c23a' : '#dcdfe6' }" />
          <span title="Refresh Token" :style="{ display:'inline-block', width:'8px', height:'8px', borderRadius:'50%', background: row.refresh_token ? '#67c23a' : '#dcdfe6' }" />
          <el-popover placement="left" :width="420" trigger="click">
            <template #reference>
              <el-button size="small" text style="margin-left:4px">查</el-button>
            </template>
            <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
              <div>
                <strong style="display:block;color:#606266;font-size:12px;margin-bottom:2px">TOTP 密钥</strong>
                <div v-if="row.totp_secret" style="display:flex;gap:6px;align-items:center">
                  <code style="font-family:monospace;background:#f5f7fa;padding:2px 6px;border-radius:3px;flex:1;overflow-wrap:break-word">{{ row.totp_secret }}</code>
                  <el-button size="small" @click="emit('copy', { text: row.totp_secret, label: 'TOTP' })">复制</el-button>
                </div>
                <span v-else style="color:#c0c4cc">未设置</span>
              </div>
              <div>
                <strong style="display:block;color:#606266;font-size:12px;margin-bottom:2px">Client ID</strong>
                <div v-if="row.client_id" style="display:flex;gap:6px;align-items:center">
                  <code style="font-family:monospace;background:#f5f7fa;padding:2px 6px;border-radius:3px;flex:1;overflow-wrap:break-word">{{ row.client_id }}</code>
                  <el-button size="small" @click="emit('copy', { text: row.client_id, label: 'Client ID' })">复制</el-button>
                </div>
                <span v-else style="color:#c0c4cc">未设置</span>
              </div>
              <div>
                <strong style="display:block;color:#606266;font-size:12px;margin-bottom:2px">Refresh Token</strong>
                <div v-if="row.refresh_token" style="display:flex;gap:6px;align-items:center">
                  <code style="font-family:monospace;background:#f5f7fa;padding:2px 6px;border-radius:3px;flex:1;overflow-wrap:break-word;word-break:break-all;max-height:80px;overflow-y:auto">{{ row.refresh_token }}</code>
                  <el-button size="small" @click="emit('copy', { text: row.refresh_token, label: 'Refresh Token' })">复制</el-button>
                </div>
                <span v-else style="color:#c0c4cc">未设置</span>
              </div>
            </div>
          </el-popover>
        </span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="240">
      <template #default="{ row }">
        <el-button size="small" text type="success" :disabled="!row._hasAuth" @click.stop="emit('auth-download', { email: row.email, format: 'cpa' })">CPA</el-button>
        <el-button size="small" text type="primary" :disabled="!row._hasAuth" @click.stop="emit('auth-download', { email: row.email, format: 'sub2api' })">Sub</el-button>
        <el-button size="small" text type="primary" @click="emit('edit', row)">编辑</el-button>
        <el-popconfirm title="确定删除?" @confirm="emit('delete', row.email)">
          <template #reference><el-button size="small" text type="danger">删除</el-button></template>
        </el-popconfirm>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup>
import { ref, watch } from 'vue'
import { aliveStatusType, aliveStatusLabel, rowClassFor } from '../status'

const props = defineProps({
  rows: { type: Array, required: true },
  globalSelectedSet: { type: Set, required: true },
  // v2.41.5: 每账号测活日志 — 由父组件按 email filter 后传入。默认 () => [] 保证
  // 该 prop 未传时（其他调用方）也能渲染 expand 内的"暂无日志"占位，无报错。
  getHistoryLogs: { type: Function, default: () => () => [] },
  getRealtimeLogs: { type: Function, default: () => () => [] },
})
const emit = defineEmits(['selection-change', 'row-click', 'edit', 'delete', 'auth-download', 'copy'])

const tableRef = ref(null)

// v2.33.0: el-table :row-class-name 钩子，按 row._status 上色
function rowClass({ row }) {
  return rowClassFor(row._status)
}

function onSelectionChange(rows) {
  emit('selection-change', rows)
}

function onRowClick(row, column, event) {
  emit('row-click', { row, column, event })
}

// v2.41.5: expand row 测活日志的 timestamp 渲染（YYYY-MM-DD HH:mm:ss），
// 与 AccountTableRows.vue 同一实现。
function formatTs(ts) {
  if (!ts) return ''
  return ts.slice(0, 19).replace('T', ' ')
}

// v2.41.5: log level 文字颜色（暗色面板 + 高对比）。Accounts.vue 既有的
// .log-success/.log-warning/... CSS class 是浅色背景版本，这里 expand 内是
// 暗背景，单独走一组配色。
function logLevelColor(level) {
  if (level === 'success') return '#4ec9b0'
  if (level === 'warning') return '#d7ba7d'
  if (level === 'error')   return '#f48771'
  return '#9cdcfe'  // info / 默认
}

function formatRelative(iso) {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分钟前'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' 小时前'
  return Math.floor(ms / 86_400_000) + ' 天前'
}

// rows 变化后用 globalSelectedSet 回填选中状态。
// 与 AccountTableRows.vue 同一套机制：分组视图下多个 table 实例共享同一
// globalSelectedSet，每次 rows 重渲染时按 set 回填，避免 el-table 内置
// reserve-selection 跨表丢失。
// { flush: 'post' } 推迟到 DOM 更新后，此时 rows 已渲染。
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
  toggleRowSelection(row, selected) {
    tableRef.value?.toggleRowSelection(row, selected)
  },
})
</script>

<style scoped>
:deep(.el-table__body tr) { cursor: pointer; }

/* v2.33 row highlights — colors sourced from tokens so dark mode auto-applies */
:deep(.row-status-success td) { background-color: var(--app-row-success) !important; }
:deep(.row-status-warning td) { background-color: var(--app-row-warning) !important; }
:deep(.row-status-danger  td) { background-color: var(--app-row-danger)  !important; }
:deep(.row-status-info    td) { background-color: var(--app-row-info)    !important; }

/* v2.33.1: running 专属浅蓝 + 左边框 */
:deep(.row-status-running td) { background-color: rgba(64, 158, 255, 0.10) !important; }
:deep(.row-status-running td:first-child) { border-left: 4px solid var(--app-brand) !important; }
</style>
