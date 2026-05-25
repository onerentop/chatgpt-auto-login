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
