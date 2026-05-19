<template>
  <div>
    <!-- Toolbar -->
    <el-row style="margin-bottom: 12px" :gutter="12" align="middle">
      <el-col :span="24">
        <el-button type="success" :disabled="running" @click="execSelected">执行选中 ({{ selectedEmails.length }})</el-button>
        <el-button type="primary" :disabled="running" @click="execAll">执行全部</el-button>
        <el-button type="warning" :disabled="running || failedEmails.length === 0" @click="retryFailed">重试失败 ({{ failedEmails.length }})</el-button>
        <el-button type="danger" :disabled="!running" @click="handleStop">停止</el-button>
        <el-divider direction="vertical" />
        <el-button :disabled="selectedEmails.length === 0" @click="downloadSelected">下载选中 Auth</el-button>
        <el-button @click="downloadAll">下载全部 Auth (ZIP)</el-button>
        <el-divider direction="vertical" />
        <el-tag :type="running ? 'warning' : 'info'">{{ running ? '运行中' : '空闲' }}</el-tag>
        <el-tag v-if="socketState.connected" type="success" style="margin-left: 8px">WS</el-tag>
      </el-col>
    </el-row>
    <el-row style="margin-bottom: 12px">
      <el-col :span="24">
        <el-input v-model="search" placeholder="搜索邮箱..." clearable style="width:220px" />
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
      <el-table-column label="Auth" width="70">
        <template #default="{ row }">
          <el-button v-if="row._hasAuth" size="small" text type="success" @click="downloadAuth(row.email)">下载</el-button>
          <span v-else style="color:#c0c4cc">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80">
        <template #default="{ row }">
          <el-button
            v-if="row._status === 'failed' || row._status === 'idle'"
            size="small" text type="primary"
            :disabled="running"
            @click="execOne(row.email)"
          >{{ row._status === 'failed' ? '重试' : '执行' }}</el-button>
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
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'

const tableRef = ref(null)
const running = ref(false)
const accounts = ref([])
const selected = ref([])

const search = ref('')
const selectedEmails = computed(() => selected.value.map(r => r.email))
const failedEmails = computed(() => accounts.value.filter(a => a._status === 'failed').map(a => a.email))
const filteredRows = computed(() => {
  if (!search.value) return accounts.value
  const q = search.value.toLowerCase()
  return accounts.value.filter(a => a.email.toLowerCase().includes(q))
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
      if (data.status === 'success' || data.status === 'already_plus' || data.status === 'needs_phone') { row._hasAuth = true; row._plan = 'plus'; }
      if (data.status === 'error' || data.status === 'failed' || data.status === 'no_link') row._plan = 'free'
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
        row._plan = ['success', 'already_plus', 'needs_phone'].includes(st) ? 'plus' : (['error', 'failed', 'no_link', 'pending'].includes(st) ? 'free' : '')
      }
    }
  } catch {}
}

async function checkStatus() {
  try { const { data } = await api.get('/execute/status'); running.value = data.status === 'running' } catch {}
}

onMounted(() => { loadAccounts(); checkStatus() })

function onSelectionChange(rows) { selected.value = rows }

function statusType(s) {
  return { idle: 'info', running: 'warning', success: 'success', failed: 'danger', already_plus: 'success', no_link: 'warning', error: 'danger', pending: '', needs_phone: 'warning' }[s] || 'info'
}

function statusLabel(s) {
  return { idle: '空闲', running: '运行中', success: '成功', failed: '失败', already_plus: '已完成', no_link: '无链接', error: '错误', pending: '待确认', needs_phone: '需手机验证' }[s] || s || '空闲'
}

async function startExec(emails) {
  try {
    socketState.logs.splice(0)
    socketState.accountStatuses = {}
    for (const a of accounts.value) {
      if (!emails || emails.includes(a.email)) { a._status = 'idle'; a._phase = '' }
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

function getToken() { return localStorage.getItem('token') || '' }
function downloadAuth(email) { window.open(`/api/results/${encodeURIComponent(email)}/auth-file?token=${getToken()}`) }
function downloadAll() { window.open(`/api/results/download-all?token=${getToken()}`) }
function downloadSelected() {
  for (const email of selectedEmails.value) {
    const row = accounts.value.find(a => a.email === email)
    if (row?._hasAuth) downloadAuth(email)
  }
}
</script>
