<template>
  <div>
    <!-- Toolbar -->
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
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

    <!-- Account Table -->
    <el-table
      ref="tableRef"
      :data="accountRows"
      stripe border size="small"
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="45" />
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column prop="loginType" label="类型" width="85">
        <template #default="{ row }">
          <el-tag :type="row.loginType === 'Google' ? 'danger' : 'warning'" size="small">{{ row.loginType }}</el-tag>
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
      <el-table-column type="expand">
        <template #default="{ row }">
          <div style="font-family:monospace;font-size:12px;max-height:200px;overflow-y:auto;padding:8px;background:#1e1e1e;color:#d4d4d4;border-radius:4px">
            <div v-for="(log, i) in getAccountLogs(row.email)" :key="i">
              <span style="color:#808080">{{ log.timestamp?.slice(11,19) }}</span>
              <span> {{ log.message }}</span>
            </div>
            <div v-if="getAccountLogs(row.email).length === 0" style="color:#808080">暂无日志</div>
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

const selectedEmails = computed(() => selected.value.map(r => r.email))
const failedEmails = computed(() => accounts.value.filter(a => a._status === 'failed').map(a => a.email))
const accountRows = computed(() => accounts.value)

function getAccountLogs(email) {
  return socketState.logs.filter(l => l.email === email)
}

watch(() => socketState.accountStatuses, (statuses) => {
  for (const [email, data] of Object.entries(statuses)) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = data.status || 'running'
      row._phase = data.phase || ''
      if (data.status === 'success' || data.status === 'already_plus') row._hasAuth = true
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
    accounts.value = data.map(a => ({ ...a, _status: 'idle', _phase: '', _hasAuth: false }))
    loadResults()
  } catch {}
}

async function loadResults() {
  try {
    const { data } = await api.get('/results')
    for (const r of data) {
      const row = accounts.value.find(a => a.email === r.email)
      if (row) {
        if (r.status && row._status === 'idle') row._status = r.status.toLowerCase()
        row._hasAuth = r.hasAuthFile || false
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
  return { idle: 'info', running: 'warning', success: 'success', failed: 'danger', already_plus: 'success', no_link: 'warning', error: 'danger' }[s] || 'info'
}

function statusLabel(s) {
  return { idle: '空闲', running: '运行中', success: '成功', failed: '失败', already_plus: 'Plus', no_link: '无链接', error: '错误' }[s] || s || '空闲'
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

function downloadAuth(email) { window.open(`/api/results/${encodeURIComponent(email)}/auth-file`) }
function downloadAll() { window.open('/api/results/download-all') }
function downloadSelected() {
  for (const email of selectedEmails.value) {
    const row = accounts.value.find(a => a.email === email)
    if (row?._hasAuth) downloadAuth(email)
  }
}
</script>
