<template>
  <div>
    <!-- Toolbar (sticky) -->
    <el-row style="margin-bottom: 12px; position: sticky; top: 0; z-index: 10; background: #fff; padding: 8px 0; border-bottom: 1px solid #eee;" :gutter="12" align="middle">
      <el-col :span="24">
        <el-button type="success" :disabled="running" @click="execSelected">执行选中 ({{ selectedEmails.length }})</el-button>
        <el-button type="primary" :disabled="running" @click="execAll">执行全部</el-button>
        <el-button type="warning" :disabled="running || failedEmails.length === 0" @click="retryFailed">重试失败 ({{ failedEmails.length }})</el-button>
        <el-button type="danger" :disabled="!running" @click="handleStop">停止</el-button>
        <el-divider direction="vertical" />
        <el-dropdown :disabled="selectedEmails.length === 0" @command="downloadSelectedAs" split-button size="default">
          下载选中 ({{ selectedEmails.length }})
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
              <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown @command="downloadAllAs" split-button size="default" style="margin-left:8px">
          下载全部 (ZIP)
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
              <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-divider direction="vertical" />
        <el-tag :type="running ? 'warning' : 'info'">{{ running ? '运行中' : '空闲' }}</el-tag>
        <el-tag v-if="socketState.connected" type="success" style="margin-left: 8px">WS</el-tag>
      </el-col>
    </el-row>
    <el-row style="margin-bottom: 12px">
      <el-col :span="24">
        <el-input v-model="search" placeholder="搜索邮箱..." clearable style="width:200px" />
        <el-select v-model="statusFilter" placeholder="状态" clearable style="width:130px;margin-left:8px">
          <el-option label="Plus(有RT)" value="plus" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="错误" value="error" />
          <el-option label="已删除" value="deactivated" />
          <el-option label="无链接" value="no_link" />
          <el-option label="空闲" value="idle" />
          <el-option label="运行中" value="running" />
        </el-select>
        <el-select v-model="planFilter" placeholder="Plan" clearable style="width:110px;margin-left:8px">
          <el-option label="Plus" value="plus" />
          <el-option label="Free" value="free" />
          <el-option label="未知" value="unknown" />
        </el-select>
        <el-select v-model="authFilter" placeholder="Auth" clearable style="width:110px;margin-left:8px">
          <el-option label="已生成" value="yes" />
          <el-option label="未生成" value="no" />
        </el-select>
        <el-tag style="margin-left: 12px">{{ filteredRows.length }} / {{ accounts.length }}</el-tag>
      </el-col>
    </el-row>

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
      <el-table-column type="selection" width="45" />
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
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel, PLUS_STATUSES } from '../status'

const tableRef = ref(null)
const running = ref(false)
const accounts = ref([])
const selected = ref([])

const search = ref('')
const statusFilter = ref('')
const planFilter = ref('')
const authFilter = ref('')
// Locked email set: snapshot taken on execute, applied to the table
// until user changes any filter (or refreshes).
const lockedEmails = shallowRef(null)
const selectedEmails = computed(() => selected.value.map(r => r.email))
const failedEmails = computed(() => accounts.value.filter(a => a._status === 'error').map(a => a.email))
const filteredRows = computed(() => {
  if (lockedEmails.value) {
    // Frozen view — show only the snapshot, ignore filters
    return accounts.value.filter(a => lockedEmails.value.has(a.email))
  }
  const q = search.value.toLowerCase()
  return accounts.value.filter(a => {
    if (q && !a.email.toLowerCase().includes(q)) return false
    if (statusFilter.value && a._status !== statusFilter.value) return false
    if (planFilter.value) {
      if (planFilter.value === 'unknown' && a._plan) return false
      if (planFilter.value !== 'unknown' && a._plan !== planFilter.value) return false
    }
    if (authFilter.value === 'yes' && !a._hasAuth) return false
    if (authFilter.value === 'no' && a._hasAuth) return false
    return true
  })
})

// Any filter change unlocks the view
watch([search, statusFilter, planFilter, authFilter], () => {
  lockedEmails.value = null
})

const historyLogs = ref({})

function getHistoryLogs(email) {
  return historyLogs.value[email] || []
}

function getRealtimeLogs(email) {
  return socketState.logs.filter(l => l.email === email)
}

function formatTs(ts) {
  if (!ts) return ''
  return ts.slice(0, 19).replace('T', ' ')
}

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

watch(() => socketState.accountStatuses, (statuses) => {
  for (const [email, data] of Object.entries(statuses)) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = data.status || 'running'
      row._phase = data.phase || ''
      if (PLUS_STATUSES.includes(data.status)) { row._hasAuth = true; row._plan = 'plus'; }
      if (['error', 'no_link'].includes(data.status)) row._plan = 'free'
    }
  }
}, { deep: true })

watch(() => socketState.logs.length, () => {
  const last = socketState.logs[socketState.logs.length - 1]
  if (last?.message?.includes('Execution complete')) {
    running.value = false
    loadResults()
  }
})

async function loadAccounts() {
  try {
    const { data } = await api.get('/accounts')
    accounts.value = data.map(a => ({ ...a, _status: 'idle', _phase: '', _hasAuth: false, _showHistory: false, _plan: '' }))
    loadResults()
  } catch {}
}

async function loadResults() {
  try {
    const { data } = await api.get('/results')
    for (const r of data) {
      const row = accounts.value.find(a => a.email === r.email)
      if (row) {
        if (r.status && r.status !== 'idle') row._status = r.status
        if (r.phase) row._phase = r.phase
        row._hasAuth = r.hasAuthFile || false
        const st = (r.status || '').toLowerCase()
        row._plan = PLUS_STATUSES.includes(st) ? 'plus' : (['error', 'no_link'].includes(st) ? 'free' : '')
      }
    }
  } catch {}
}

async function checkStatus() {
  try { const { data } = await api.get('/execute/status'); running.value = data.status === 'running' } catch {}
}

onMounted(() => { loadAccounts(); checkStatus() })

function onSelectionChange(rows) { selected.value = rows }

function onRowClick(row, column, event) {
  if (column?.type === 'selection' || column?.type === 'expand') return
  if (event?.target?.closest('.el-button, .el-dropdown, a')) return
  tableRef.value?.toggleRowSelection(row)
}

async function startExec(emails) {
  try {
    // Snapshot current filtered list → freeze view until user changes a filter
    lockedEmails.value = new Set(filteredRows.value.map(r => r.email))
    socketState.logs.splice(0)
    socketState.accountStatuses = {}
    // Preset selected accounts to 'running'/'queued' for immediate visual feedback.
    // Engine will overwrite with real status as each one progresses.
    for (const a of accounts.value) {
      if (!emails || emails.includes(a.email)) { a._status = 'running'; a._phase = 'queued' }
    }
    await api.post('/execute', { emails: emails || undefined })
    running.value = true
    ElMessage.success('执行已启动')
  } catch (e) { ElMessage.error(e.response?.data?.error || '启动失败') }
}

function execSelected() {
  if (selectedEmails.value.length === 0) return ElMessage.warning('请先选择账号')
  startExec(selectedEmails.value)
}
function execAll() { startExec(null) }
function retryFailed() { startExec(failedEmails.value) }
function execOne(email) { startExec([email]) }

async function handleStop() {
  try { await api.post('/execute/stop'); ElMessage.info('正在停止...') }
  catch { ElMessage.error('停止失败') }
}

function downloadAuth(email, format = 'cpa') { window.open(`/api/results/${encodeURIComponent(email)}/auth-file?format=${format}`) }
function downloadAllAs(format) { window.open(`/api/results/download-all?format=${format || 'cpa'}`) }
function downloadSelectedAs(format) {
  for (const email of selectedEmails.value) {
    const row = accounts.value.find(a => a.email === email)
    if (row?._hasAuth) downloadAuth(email, format || 'cpa')
  }
}
</script>

<style scoped>
:deep(.el-table__body tr) {
  cursor: pointer;
}
</style>
