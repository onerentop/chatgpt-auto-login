<template>
  <div class="app-stack--lg">
    <PageHeader title="执行控制" :subtitle="execSubtitle">
      <template #actions>
        <el-tag :type="engineMode.protocolMode ? 'success' : 'warning'" size="default">
          {{ engineMode.protocolMode ? '协议模式' : '浏览器模式' }}
        </el-tag>
        <el-tag type="info">link: {{ engineMode.paymentLinkSource === 'api' ? 'API' : 'Discord' }}</el-tag>
      </template>
    </PageHeader>

    <!-- Toolbar — 操作 + 筛选 -->
    <SectionCard flush>
      <div class="ex-toolbar">
        <div class="ex-toolbar__row">
          <el-button type="success" :disabled="running" @click="execSelected">
            执行选中 ({{ selectedEmails.length }})
          </el-button>
          <el-button type="primary" :disabled="running" @click="execAll">执行全部</el-button>
          <el-button type="warning" :disabled="running || failedEmails.length === 0" @click="retryFailed">
            重试失败 ({{ failedEmails.length }})
          </el-button>
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
          <el-dropdown @command="downloadAllAs" split-button size="default">
            下载全部 (ZIP)
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
                <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button :disabled="selectedEmails.length === 0" @click="clearAllSelection">取消选中</el-button>
        </div>
        <div class="ex-toolbar__row">
          <el-input v-model="search" placeholder="搜索邮箱… 按 / 聚焦" clearable style="width:240px" data-hotkey="search" />
          <el-select v-model="statusFilter" placeholder="状态" clearable style="width:140px">
            <el-option v-for="opt in EXECUTE_STATUS_FILTER_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <el-select v-model="planFilter" placeholder="Plan" clearable style="width:110px">
            <el-option label="Plus" value="plus" />
            <el-option label="Free" value="free" />
            <el-option label="未知" value="unknown" />
          </el-select>
          <el-select v-model="authFilter" placeholder="Auth" clearable style="width:110px">
            <el-option label="已生成" value="yes" />
            <el-option label="未生成" value="no" />
          </el-select>
          <span class="app-spacer" />
          <el-tag round>{{ filteredRows.length }} / {{ accounts.length }}</el-tag>
        </div>
      </div>
    </SectionCard>

    <!-- Status-grouped tables with expandable logs -->
    <el-collapse v-model="expandedKeys">
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
          @row-click="onRowClick"
        />
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, shallowRef, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel, PLUS_STATUSES, ERROR_STATUSES, DEFAULT_EXPANDED_STATUSES, groupAccountsByStatus, isFailedToRetry, EXECUTE_STATUS_FILTER_OPTIONS } from '../status'
import { getSelectionSet, clearSelection } from '../selection'
import AccountTableRows from '../components/AccountTableRows.vue'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const running = ref(false)
const accounts = ref([])
const autoExpandedEmail = ref('')
const expandedKeys = ref([...DEFAULT_EXPANDED_STATUSES])
const groupRefs = ref({})
const globalSelectedSet = getSelectionSet('execute')
const engineMode = ref({ protocolMode: false, paymentLinkSource: 'api' })

async function loadEngineMode() {
  try {
    const { data } = await api.get('/config/raw')
    const cfg = data.config || data
    engineMode.value = {
      protocolMode: !!cfg.protocolMode,
      paymentLinkSource: cfg.paymentLinkSource || 'api',
    }
  } catch {}
}

let statusPollTimer = null

function startPolling() {
  const tick = async () => {
    if (document.visibilityState !== 'visible') return
    try {
      const { data } = await api.get('/execute/status')
      running.value = data.status === 'running'
    } catch {}
  }
  statusPollTimer = setInterval(tick, 5000)
  document.addEventListener('visibilitychange', tick)
}

onBeforeUnmount(() => {
  if (statusPollTimer) {
    clearInterval(statusPollTimer)
    statusPollTimer = null
  }
})

const search = ref('')
const statusFilter = ref('')
const planFilter = ref('')
const authFilter = ref('')
// Locked email set: snapshot taken on execute, applied to the table
// until user changes any filter (or refreshes).
const lockedEmails = shallowRef(null)
const selectedEmails = computed(() => Array.from(globalSelectedSet))
const failedEmails = computed(() => accounts.value.filter(a => isFailedToRetry(a._status)).map(a => a.email))

// PageHeader subtitle — shows current running account + phase when running,
// otherwise a static "等待开始" hint. Reactively reads socketState.accountStatuses.
const execSubtitle = computed(() => {
  if (!running.value) {
    const total = accounts.value.length
    return total ? `共 ${total} 个账号 · 等待开始` : '请先到账号管理页添加账号'
  }
  // Find the account that's currently 'running' in socketState.
  const runningEntry = Object.values(socketState.accountStatuses || {})
    .find((s) => s && s.status === 'running')
  if (runningEntry) {
    return `当前 ${runningEntry.email} · ${runningEntry.phase || 'running'}`
  }
  return '运行中…'
})
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

const visibleGroups = computed(() => groupAccountsByStatus(filteredRows.value))

// statusFilter 选中状态时自动展开该组（only-add 语义）
watch(statusFilter, (newVal) => {
  if (newVal && !expandedKeys.value.includes(newVal)) {
    expandedKeys.value.push(newVal)
  }
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

watch(() => socketState.accountStatuses, (statuses) => {
  let currentRunning = ''
  for (const [email, data] of Object.entries(statuses)) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = data.status || 'running'
      row._phase = data.phase || ''
      if (PLUS_STATUSES.includes(data.status)) { row._hasAuth = true; row._plan = 'plus'; }
      if (ERROR_STATUSES.includes(data.status)) row._plan = 'free'
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
    accounts.value = data.map(a => ({ ...a, _status: 'idle', _phase: '', _hasAuth: false, _showHistory: false, _plan: '', _reason: '', _proxyNode: '', _exitIp: '', _updatedAt: '' }))
    await loadResults()
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
        row._reason = r.reason || ''
        row._proxyNode = r.proxyNode || ''
        row._exitIp = r.exitIp || ''
        row._updatedAt = r.updatedAt || ''
        const st = (r.status || '').toLowerCase()
        row._plan = PLUS_STATUSES.includes(st) ? 'plus' : (ERROR_STATUSES.includes(st) ? 'free' : '')
      }
    }
  } catch {}
}

async function checkStatus() {
  try { const { data } = await api.get('/execute/status'); running.value = data.status === 'running' } catch {}
}

onMounted(() => { loadAccounts(); checkStatus(); loadEngineMode(); startPolling() })

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

function onRowClick({ row, column, event }) {
  // Restored from pre-refactor behavior: clicking the row body (excluding
  // selection/expand columns + el-button/el-dropdown/a children) toggles
  // that row's selection. Quick-select UX for operators.
  if (column?.type === 'selection' || column?.type === 'expand') return
  if (event?.target?.closest('.el-button, .el-dropdown, a')) return
  const status = row._status || 'idle'
  groupRefs.value[status]?.toggleRowSelection?.(row)
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
async function downloadSelectedAs(format) {
  const fmt = format || 'cpa'
  // Only include rows that actually have an auth file written — otherwise the
  // server filters them out anyway and the ZIP would be smaller than expected.
  const emails = selectedEmails.value.filter(e => {
    const row = accounts.value.find(a => a.email === e)
    return row?._hasAuth
  })
  if (emails.length === 0) { ElMessage.warning('选中账号都没有 auth 文件可下载'); return }
  try {
    const res = await api.post('/results/download-selected', { emails, format: fmt }, { responseType: 'blob' })
    // axios surfaces 4xx/5xx as throws when responseType is blob — handle in catch.
    const url = window.URL.createObjectURL(res.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fmt}-selected-${emails.length}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  } catch (e) {
    let msg = '下载失败'
    // If responseType:'blob' fails, error response is also a blob — read it as text.
    if (e?.response?.data instanceof Blob) {
      try { msg = JSON.parse(await e.response.data.text()).error || msg } catch {}
    } else {
      msg = e?.response?.data?.error || e?.message || msg
    }
    ElMessage.error(msg)
  }
}
</script>

<style scoped>
.ex-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
}
.ex-toolbar__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
</style>
