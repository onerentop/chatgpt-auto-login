<template>
  <div>
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
      <el-col :span="24">
        <el-button type="primary" @click="showImport = true">批量导入</el-button>
        <el-button @click="exportAccounts">导出全部</el-button>
        <el-button :disabled="selected.length === 0" @click="exportSelected">导出选中 ({{ selected.length }})</el-button>
        <el-button type="success" @click="openAdd">添加单个</el-button>
        <el-popconfirm :title="`确定删除选中的 ${selected.length} 个账号？`" @confirm="delSelected" v-if="selected.length > 0">
          <template #reference><el-button type="danger" size="small">删除选中 ({{ selected.length }})</el-button></template>
        </el-popconfirm>
        <el-input v-model="search" placeholder="搜索邮箱..." clearable style="width:200px;margin-left:12px" />
        <el-select v-model="statusFilter" placeholder="状态" clearable style="width:130px;margin-left:8px">
          <el-option label="Plus(有RT)" value="plus" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="错误" value="error" />
          <el-option label="已删除" value="deactivated" />
          <el-option label="无链接" value="no_link" />
          <el-option label="空闲" value="idle" />
          <el-option label="运行中" value="running" />
          <el-option label="已停止" value="aborted" />
          <el-option label="JP节点不可用" value="no_jp_proxy" />
          <el-option label="无0元资格" value="no_promo" />
          <el-option label="Stripe验证失败" value="verify_error" />
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
        <el-tag style="margin-left: 12px">{{ filteredAccounts.length }} / {{ accounts.length }}</el-tag>
        <el-button size="small" style="margin-left: 8px" @click="clearAllSelection">取消选中</el-button>
        <el-divider direction="vertical" />
        <el-button size="small" type="primary" :disabled="selected.length === 0 || livenessRunning" @click="startLiveness('selected')">
          测活选中 ({{ selected.length }})
        </el-button>
        <el-button size="small" type="primary" :disabled="livenessRunning" @click="startLiveness('all')">
          测活全部
        </el-button>
        <el-button v-if="livenessRunning" size="small" type="danger" @click="stopLiveness">
          停止测活
        </el-button>
        <el-tag v-if="livenessRunning" type="info" size="small" style="margin-left: 8px">
          {{ socketState.liveness.done }}/{{ socketState.liveness.total }} (✗{{ socketState.liveness.failed }})
        </el-tag>
        <el-select v-model="aliveFilter" placeholder="活性" clearable size="small" style="width:130px;margin-left:8px">
          <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </el-col>
    </el-row>

    <el-table ref="tableRef" :data="filteredAccounts" stripe border size="small" row-key="email" @selection-change="onSelectionChange" @row-click="onRowClick">
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
      <el-table-column prop="totp_secret" label="TOTP" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.totp_secret || '-' }}</template>
      </el-table-column>
      <el-table-column prop="client_id" label="Client ID" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.client_id || '-' }}</template>
      </el-table-column>
      <el-table-column label="Refresh Token" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ row.refresh_token ? row.refresh_token.slice(0, 20) + '...' : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" text type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <el-collapse v-model="logsExpanded" style="margin-top: 12px">
      <el-collapse-item :title="`测活日志 (${livenessLogs.length})`" name="liveness-logs">
        <div class="liveness-log-list">
          <div v-for="(log, i) in livenessLogs" :key="i" :class="'log-' + log.level">
            <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
            <span v-if="log.email" class="log-email">{{ log.email }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="livenessLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无测活日志</div>
        </div>
      </el-collapse-item>
    </el-collapse>

    <!-- Import Dialog -->
    <el-dialog v-model="showImport" title="批量导入" width="650">
      <p style="color:#909399;margin-bottom:12px">每行一个账号，格式：<code>邮箱----密码----2FA/ClientID----RefreshToken</code><br>空白符会自动去除</p>
      <el-input v-model="importText" type="textarea" :rows="12" placeholder="email----password----2fa----token&#10;email2----password2----clientId----refreshToken" />
      <template #footer>
        <el-button @click="showImport = false">取消</el-button>
        <el-button type="primary" @click="doImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- Add / Edit Dialog -->
    <el-dialog v-model="showEdit" :title="editMode ? '编辑账号' : '添加账号'" width="520">
      <el-form label-width="120px">
        <el-form-item label="邮箱"><el-input v-model="form.email" :disabled="editMode" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" /></el-form-item>
        <el-form-item label="TOTP 密钥"><el-input v-model="form.totp_secret" placeholder="Gmail 账号填写" /></el-form-item>
        <el-form-item label="Client ID"><el-input v-model="form.client_id" placeholder="Outlook 账号填写" /></el-form-item>
        <el-form-item label="Refresh Token"><el-input v-model="form.refresh_token" type="textarea" :rows="3" placeholder="Outlook 账号填写" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">{{ editMode ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { PLUS_STATUSES, ERROR_STATUSES, aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS } from '../status'
import { socketState } from '../socket'
import { getSelectionSet, setSelectionFromRows, clearSelection } from '../selection'

const tableRef = ref(null)
const accounts = ref([])
const selected = ref([])
const search = ref('')
const statusFilter = ref('')
const planFilter = ref('')
const authFilter = ref('')
const aliveFilter = ref('')
const aliveFilterOptions = ALIVE_FILTER_OPTIONS
const logsExpanded = ref([])
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.message?.startsWith('[liveness]')).slice(-200)
)
const filteredAccounts = computed(() => {
  const q = search.value.toLowerCase()
  return accounts.value.filter(a => {
    if (q && !a.email.toLowerCase().includes(q)) return false
    // Running accounts always shown (don't disappear during execution)
    if (a._status === 'running') return true
    if (statusFilter.value && a._status !== statusFilter.value) return false
    if (planFilter.value) {
      if (planFilter.value === 'unknown' && a._plan) return false
      if (planFilter.value !== 'unknown' && a._plan !== planFilter.value) return false
    }
    if (authFilter.value === 'yes' && !a._hasAuth) return false
    if (authFilter.value === 'no' && a._hasAuth) return false
    if (aliveFilter.value && (a._aliveStatus || 'unknown') !== aliveFilter.value) return false
    return true
  })
})
const showImport = ref(false)
const showEdit = ref(false)
const editMode = ref(false)
const importText = ref('')
const form = ref({ email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' })
const editOrigEmail = ref('')

async function load() {
  try {
    const [acctRes, statusRes] = await Promise.all([api.get('/accounts/raw'), api.get('/results').catch(() => ({ data: [] }))])
    const resultMap = {}
    for (const s of (statusRes.data || [])) {
      resultMap[s.email] = s
    }
    accounts.value = acctRes.data.map(a => {
      const r = resultMap[a.email] || {}
      const st = (r.status || '').toLowerCase()
      const plan = PLUS_STATUSES.includes(st) ? 'plus' : (ERROR_STATUSES.includes(st) ? 'free' : '')
      return {
        ...a, _showPw: false, _status: st || 'idle', _plan: plan, _hasAuth: !!r.hasAuthFile,
        _aliveStatus: r.alive_status || 'unknown',
        _aliveReason: r.alive_reason || '',
        _aliveCheckedAt: r.alive_checked_at || '',
      }
    })
    restoreSelection()
  } catch {}
}
onMounted(load)
// Auto-expand log panel when liveness starts; user controls collapsing afterwards.
watch(() => socketState.liveness.running, (now) => {
  if (now && !logsExpanded.value.includes('liveness-logs')) {
    logsExpanded.value = ['liveness-logs']
  }
})

watch(() => socketState.aliveStatuses, (val) => {
  for (const row of accounts.value) {
    const s = val[row.email]
    if (s) {
      row._aliveStatus = s.alive_status
      row._aliveReason = s.alive_reason
      if (s.alive_checked_at) row._aliveCheckedAt = s.alive_checked_at
    }
  }
}, { deep: true })

function openAdd() {
  editMode.value = false
  form.value = { email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' }
  showEdit.value = true
}

function openEdit(row) {
  editMode.value = true
  editOrigEmail.value = row.email
  form.value = { email: row.email, password: row.password, totp_secret: row.totp_secret || '', client_id: row.client_id || '', refresh_token: row.refresh_token || '' }
  showEdit.value = true
}

async function saveEdit() {
  try {
    if (editMode.value) {
      await api.put(`/accounts/${encodeURIComponent(editOrigEmail.value)}`, form.value)
      ElMessage.success('已更新')
    } else {
      await api.post('/accounts', form.value)
      ElMessage.success('已添加')
    }
    showEdit.value = false
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '操作失败') }
}

async function doImport() {
  try {
    const { data } = await api.post('/accounts/import', { text: importText.value })
    ElMessage.success(`导入 ${data.added} 个，跳过 ${data.skipped} 个`)
    showImport.value = false
    importText.value = ''
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '导入失败') }
}

async function del(email) {
  try { await api.delete(`/accounts/${encodeURIComponent(email)}`); ElMessage.success('已删除'); load() }
  catch { ElMessage.error('删除失败') }
}

function onSelectionChange(rows) {
  selected.value = rows
  setSelectionFromRows('accounts', rows)
}

function clearAllSelection() {
  tableRef.value?.clearSelection()
  clearSelection('accounts')
  selected.value = []
}

function restoreSelection() {
  const saved = getSelectionSet('accounts')
  if (saved.size === 0 || !tableRef.value) return
  nextTick(() => {
    for (const row of accounts.value) {
      if (saved.has(row.email)) tableRef.value.toggleRowSelection(row, true)
    }
  })
}

const livenessRunning = computed(() => socketState.liveness.running)

function formatRelative(iso) {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return '刚刚'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分钟前'
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' 小时前'
  return Math.floor(ms / 86_400_000) + ' 天前'
}

async function startLiveness(scope) {
  const body = scope === 'selected'
    ? { emails: selected.value.map((r) => r.email) }
    : {}
  try {
    await api.post('/liveness/start', body)
    socketState.liveness.running = true
    socketState.liveness.done = 0
    socketState.liveness.failed = 0
  } catch (e) {
    ElMessage.error(`测活启动失败: ${e?.response?.data?.error || e.message}`)
  }
}

async function stopLiveness() {
  try { await api.post('/liveness/stop') }
  catch (e) { ElMessage.error(`停止失败: ${e.message}`) }
}

function onRowClick(row, column, event) {
  if (column?.type === 'selection') return
  if (event?.target?.closest('.el-button, .el-dropdown, .el-popconfirm, a')) return
  tableRef.value?.toggleRowSelection(row)
}

function exportAccounts() { window.open('/api/accounts/export') }

function exportSelected() {
  if (selected.value.length === 0) return ElMessage.warning('请先选择账号')
  const lines = selected.value.map(a => {
    const isOutlook = (a.loginType || '').toLowerCase() === 'outlook'
    const third = isOutlook ? (a.client_id || '') : (a.totp_secret || '')
    const fourth = isOutlook ? (a.refresh_token || '') : ''
    return [a.email, a.password, third, fourth].filter(Boolean).join('----')
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `accounts-selected-${selected.value.length}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

async function delSelected() {
  let ok = 0, fail = 0
  for (const row of selected.value) {
    try { await api.delete(`/accounts/${encodeURIComponent(row.email)}`); ok++ } catch { fail++ }
  }
  ElMessage.success(`删除 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`)
  load()
}
</script>

<style scoped>
:deep(.el-table__body tr) {
  cursor: pointer;
}
.liveness-log-list { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; padding: 4px 8px; background: #fafafa; border-radius: 4px; }
.liveness-log-list > div { padding: 2px 0; }
.log-time { color: #909399; margin-right: 8px; }
.log-email { color: #409EFF; margin-right: 8px; }
.log-msg { color: #303133; }
.log-success .log-msg { color: #67C23A; }
.log-warning .log-msg { color: #E6A23C; }
.log-error .log-msg { color: #F56C6C; }
.log-info .log-msg { color: #909399; }
</style>
