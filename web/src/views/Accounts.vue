<template>
  <div class="app-stack--lg">
    <PageHeader title="账号管理" :subtitle="headerSubtitle">
      <template #actions>
        <el-button @click="exportAccounts">导出全部</el-button>
        <el-button type="primary" @click="showImport = true">批量导入</el-button>
        <el-button type="success" data-hotkey="submit" @click="openAdd">添加单个</el-button>
      </template>
    </PageHeader>

    <!-- Toolbar — 筛选 + 选中操作两行 -->
    <SectionCard flush>
      <div class="ac-toolbar">
        <div class="ac-toolbar__row">
          <el-input v-model="search" placeholder="搜索 (邮箱/RT/Client ID/TOTP/密码) — 按 / 聚焦" clearable
                    style="width:300px" data-hotkey="search" />
          <el-select v-model="statusFilter" placeholder="状态" clearable multiple collapse-tags collapse-tags-tooltip style="width:170px">
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
          <el-select v-model="aliveFilter" placeholder="活性" clearable multiple collapse-tags collapse-tags-tooltip size="small" style="width:170px">
            <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-button size="small" text @click="aliveFilter = ['unknown']">仅看未测试</el-button>
          <el-button size="small" :type="staleOnly ? 'primary' : ''" text @click="staleOnly = !staleOnly">7 天未测</el-button>
          <el-button size="small" text :disabled="!hasAnyFilter" @click="resetFilters">重置</el-button>
          <span class="app-spacer" />
          <el-tag round>{{ filteredAccounts.length }} / {{ accounts.length }}</el-tag>
        </div>
        <div class="ac-toolbar__row">
          <el-button :disabled="selected.length === 0" @click="exportSelected">导出选中 ({{ selected.length }})</el-button>
          <el-dropdown :disabled="selected.length === 0" @command="downloadSelectedAs" split-button size="default">
            下载选中 ({{ selected.length }})
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
          <el-button :disabled="selected.length === 0" @click="clearAllSelection">取消选中</el-button>
          <el-button v-if="selected.length > 0" type="danger" :loading="batchDeleting" @click="confirmDelSelected">
            {{ batchDeleting ? '删除中…' : `删除选中 (${selected.length})` }}
          </el-button>
          <span class="app-spacer" />
          <el-divider direction="vertical" />
          <el-button type="primary" :disabled="selected.length === 0 || livenessRunning" @click="startLiveness('selected')">
            测活选中 ({{ selected.length }})
          </el-button>
          <el-button type="primary" :disabled="livenessRunning" @click="checkAllWithConfirm">测活全部</el-button>
          <el-button v-if="livenessRunning" type="danger" @click="stopLiveness">停止测活</el-button>
          <el-tag v-if="livenessRunning" type="info" size="small">
            {{ socketState.liveness.done }}/{{ socketState.liveness.total }} (✗{{ socketState.liveness.failed }})
          </el-tag>
        </div>
      </div>
    </SectionCard>

    <SectionCard v-if="oldLogs.length > 0 || newLogs.length > 0" title="测活日志" flush>
      <el-collapse v-model="oldLogsExpanded">
        <el-collapse-item :title="`旧日志 (${oldLogs.length})`" name="old">
          <div class="liveness-log-list">
            <div v-for="(log, i) in oldLogs" :key="'o-' + i" :class="'log-' + log.level">
              <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
              <span v-if="log.email" class="log-email">{{ log.email }}</span>
              <span class="log-msg">{{ log.message }}</span>
            </div>
            <div v-if="oldLogs.length === 0" style="color:var(--app-text-mute);padding:var(--sp-2)">暂无历史日志</div>
          </div>
        </el-collapse-item>
      </el-collapse>
      <el-collapse v-model="newLogsExpanded">
        <el-collapse-item :title="`实时日志 (${newLogs.length})`" name="new">
          <div ref="newLogsContainer" class="liveness-log-list">
            <div v-for="(log, i) in newLogs" :key="'n-' + i" :class="'log-' + log.level">
              <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
              <span v-if="log.email" class="log-email">{{ log.email }}</span>
              <span class="log-msg">{{ log.message }}</span>
            </div>
            <div v-if="newLogs.length === 0" style="color:var(--app-text-mute);padding:var(--sp-2)">暂无实时日志</div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </SectionCard>

    <SectionCard flush>
    <el-table ref="tableRef" :data="filteredAccounts" stripe border size="small" row-key="email" :row-class-name="rowClass" @selection-change="onSelectionChange" @row-click="onRowClick">
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
                    <el-button size="small" @click="copyToClipboard(row.totp_secret, 'TOTP')">复制</el-button>
                  </div>
                  <span v-else style="color:#c0c4cc">未设置</span>
                </div>
                <div>
                  <strong style="display:block;color:#606266;font-size:12px;margin-bottom:2px">Client ID</strong>
                  <div v-if="row.client_id" style="display:flex;gap:6px;align-items:center">
                    <code style="font-family:monospace;background:#f5f7fa;padding:2px 6px;border-radius:3px;flex:1;overflow-wrap:break-word">{{ row.client_id }}</code>
                    <el-button size="small" @click="copyToClipboard(row.client_id, 'Client ID')">复制</el-button>
                  </div>
                  <span v-else style="color:#c0c4cc">未设置</span>
                </div>
                <div>
                  <strong style="display:block;color:#606266;font-size:12px;margin-bottom:2px">Refresh Token</strong>
                  <div v-if="row.refresh_token" style="display:flex;gap:6px;align-items:center">
                    <code style="font-family:monospace;background:#f5f7fa;padding:2px 6px;border-radius:3px;flex:1;overflow-wrap:break-word;word-break:break-all;max-height:80px;overflow-y:auto">{{ row.refresh_token }}</code>
                    <el-button size="small" @click="copyToClipboard(row.refresh_token, 'Refresh Token')">复制</el-button>
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
          <el-button size="small" text type="success" :disabled="!row._hasAuth" @click.stop="downloadAuth(row.email, 'cpa')">CPA</el-button>
          <el-button size="small" text type="primary" :disabled="!row._hasAuth" @click.stop="downloadAuth(row.email, 'sub2api')">Sub</el-button>
          <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" text type="danger">删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>
    </SectionCard>

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
        <el-button type="primary" data-hotkey="submit" @click="saveEdit">{{ editMode ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentCopy } from '@element-plus/icons-vue'
import api from '../api'
import { PLUS_STATUSES, ERROR_STATUSES, aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS, EXECUTE_STATUS_FILTER_OPTIONS, rowClassFor } from '../status'
import { socketState } from '../socket'
import { getSelectionSet, setSelectionFromRows, clearSelection } from '../selection'
import { useUrlSyncedFilters } from '../composables/useUrlSyncedFilters'
import { confirmDanger } from '../composables/useConfirmDanger'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const tableRef = ref(null)
const accounts = ref([])
const selected = ref([])
const search = ref('')
const statusFilter = ref([])
const planFilter = ref('')
const authFilter = ref('')
const aliveFilter = ref([])
const staleOnly = ref(false)

// FX-8: persist all 6 filter refs in the URL so reloading the page (or
// pasting the URL to a colleague) keeps the filter state.
useUrlSyncedFilters({
  search,
  status: statusFilter,
  plan: planFilter,
  auth: authFilter,
  alive: aliveFilter,
  stale: staleOnly,
})

// PageHeader subtitle — live tally of account groups; updates as the
// underlying accounts list mutates (import / delete / edit).
const headerSubtitle = computed(() => {
  const total = accounts.value.length
  const plus = accounts.value.filter((a) => PLUS_STATUSES.includes((a._status || '').toLowerCase())).length
  const err = accounts.value.filter((a) => ERROR_STATUSES.includes((a._status || '').toLowerCase())).length
  return `共 ${total} 个 · Plus ${plus} · 失败 ${err}`
})

const hasAnyFilter = computed(() =>
  !!search.value || statusFilter.value.length > 0 || !!planFilter.value
  || !!authFilter.value || aliveFilter.value.length > 0 || staleOnly.value
)

function resetFilters() {
  search.value = ''
  statusFilter.value = []
  planFilter.value = ''
  authFilter.value = ''
  aliveFilter.value = []
  staleOnly.value = false
}

const aliveFilterOptions = ALIVE_FILTER_OPTIONS
const oldLogsExpanded = ref([])                // 默认折叠
const newLogsExpanded = ref(['new'])           // 默认展开
const newLogsContainer = ref(null)             // DOM ref for auto-scroll

const oldLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && l.isHistorical).slice(-200)
)
const newLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && !l.isHistorical).slice(-500)
)

// Auto-scroll the realtime log container to the bottom whenever a new entry
// arrives. nextTick lets Vue re-render the v-for before we read scrollHeight.
watch(() => newLogs.value.length, () => {
  nextTick(() => {
    const el = newLogsContainer.value
    if (el) el.scrollTop = el.scrollHeight
  })
})
const filteredAccounts = computed(() => {
  const q = search.value.toLowerCase()
  return accounts.value.filter(a => {
    if (q) {
      const haystack = [a.email, a.refresh_token, a.client_id, a.totp_secret, a.password]
        .map(s => (s || '').toLowerCase()).join(' ')
      if (!haystack.includes(q)) return false
    }
    if (a._status === 'running') return true
    if (statusFilter.value.length && !statusFilter.value.includes(a._status)) return false
    if (planFilter.value) {
      if (planFilter.value === 'unknown' && a._plan) return false
      if (planFilter.value !== 'unknown' && a._plan !== planFilter.value) return false
    }
    if (authFilter.value === 'yes' && !a._hasAuth) return false
    if (authFilter.value === 'no' && a._hasAuth) return false
    if (aliveFilter.value.length && !aliveFilter.value.includes(a._aliveStatus || 'unknown')) return false
    if (staleOnly.value) {
      const cutoff = Date.now() - 7 * 86400_000
      const checkedAt = a._aliveCheckedAt ? Date.parse(a._aliveCheckedAt) : 0
      if (checkedAt && checkedAt > cutoff) return false  // tested within 7d → out
    }
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
// Hydrate the liveness log panel from DB so panel survives a page refresh.
// Backend persists every onLog call from runner.dispatchOne; we replay the
// last 200 entries here in chronological order. Avoid duplicating entries
// that are already in socketState.logs (e.g. if connectSocket pushed a few
// before this load fires) by checking timestamps already present.
async function loadLivenessLogs() {
  try {
    const r = await api.get('/liveness/logs?limit=200')
    const existing = new Set(socketState.logs.filter(l => l.source === 'liveness').map(l => l.timestamp + '|' + l.message))
    for (const log of (r.data || [])) {
      const key = log.timestamp + '|' + log.message
      if (existing.has(key)) continue
      socketState.logs.push({
        timestamp: log.timestamp,
        email: log.email || '',
        level: log.level || 'info',
        message: (log.message?.startsWith('[') ? log.message : `[liveness] ${log.message}`),
        source: 'liveness',
        isHistorical: true,
      })
    }
    if (socketState.logs.length > 500) socketState.logs.splice(0, socketState.logs.length - 500)
  } catch {}
}
onMounted(() => { load(); loadLivenessLogs() })
// Auto-expand log panel when liveness starts; user controls collapsing afterwards.
watch(() => socketState.liveness.running, (now) => {
  if (now && !newLogsExpanded.value.includes('new')) {
    newLogsExpanded.value = ['new']
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

// v2.33.0: Execute 流水线运行时，账号管理也实时反馈 row 状态变化
watch(() => socketState.accountStatuses, (statuses) => {
  for (const email in statuses) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = statuses[email].status || row._status
      row._phase = statuses[email].phase || row._phase || ''
    }
  }
}, { deep: true })

// v2.33.0: el-table :row-class-name 钩子，按 row._status 上色
function rowClass({ row }) {
  return rowClassFor(row._status)
}

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

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`${label} 已复制`)
  } catch {
    ElMessage.error('复制失败（浏览器可能阻止）')
  }
}

async function checkAllWithConfirm() {
  const n = accounts.value.length
  try {
    await ElMessageBox.confirm(
      `将对 ${n} 个账户发起活性检测，可能耗时较长且消耗代理请求配额。继续？`,
      '确认测活全部',
      { type: 'warning', confirmButtonText: '开始测活', cancelButtonText: '取消' },
    )
  } catch { return }
  startLiveness('all')
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

async function confirmDelSelected() {
  const n = selected.value.length
  if (n === 0) return
  // n > 5 时要求输入数字 N，防止误点批量删除；少量删除走普通确认。
  const opts = n > 5
    ? { requireText: String(n), title: `批量删除 ${n} 个账号` }
    : { title: `删除 ${n} 个账号` }
  const ok = await confirmDanger(
    `即将删除 ${n} 个账号，此操作不可恢复。`,
    opts,
  )
  if (!ok) return
  await delSelected()
}

const batchDeleting = ref(false)

async function delSelected() {
  const emails = selected.value.map(r => r.email)
  if (emails.length === 0) return
  batchDeleting.value = true
  try {
    // Single-request batch — one transactional sweep + one disk flush on
    // the backend; previously this was N HTTP round-trips that took ~150ms
    // each (200 accounts = 30s of UI stutter).
    const { data } = await api.post('/accounts/batch-delete', { emails })
    const deleted = (data.deleted || []).length
    const notFound = (data.notFound || []).length
    if (notFound > 0) {
      ElMessage.warning(`删除 ${deleted} 个，${notFound} 个未找到（可能已删）`)
    } else {
      ElMessage.success(`删除 ${deleted} 个`)
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '批量删除失败')
  } finally {
    batchDeleting.value = false
  }
  await load()
}

// === Download helpers (mirror Execute.vue) ===
function downloadAuth(email, format = 'cpa') {
  window.open(`/api/results/${encodeURIComponent(email)}/auth-file?format=${format}`)
}
function downloadAllAs(format) {
  window.open(`/api/results/download-all?format=${format || 'cpa'}`)
}
async function downloadSelectedAs(format) {
  const fmt = format || 'cpa'
  const emails = selected.value.filter(r => r._hasAuth).map(r => r.email)
  if (emails.length === 0) { ElMessage.warning('选中账号都没有 auth 文件可下载'); return }
  try {
    const res = await api.post('/results/download-selected', { emails, format: fmt }, { responseType: 'blob' })
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
:deep(.el-table__body tr) { cursor: pointer; }

/* Toolbar — two rows of filters + actions; gap pulled from token scale. */
.ac-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
}
.ac-toolbar__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.liveness-log-list {
  max-height: 300px;
  overflow-y: auto;
  font-family: var(--ff-mono);
  font-size: var(--fs-sm);
  padding: var(--sp-1) var(--sp-2);
  background: var(--app-surface-2);
  border-radius: var(--rad-sm);
}
.liveness-log-list > div { padding: 2px 0; }
.log-time  { color: var(--app-text-mute); margin-right: var(--sp-2); }
.log-email { color: var(--app-brand);     margin-right: var(--sp-2); }
.log-msg   { color: var(--app-text); }
.log-success .log-msg { color: var(--app-success); }
.log-warning .log-msg { color: var(--app-warning); }
.log-error   .log-msg { color: var(--app-danger); }
.log-info    .log-msg { color: var(--app-text-3); }

/* v2.33 row highlights — colors now sourced from tokens so dark mode auto-applies */
:deep(.row-status-success td) { background-color: var(--app-row-success) !important; }
:deep(.row-status-warning td) { background-color: var(--app-row-warning) !important; }
:deep(.row-status-danger  td) { background-color: var(--app-row-danger)  !important; }
:deep(.row-status-info    td) { background-color: var(--app-row-info)    !important; }

/* v2.33.1: running 专属浅蓝 + 左边框 */
:deep(.row-status-running td) { background-color: rgba(64, 158, 255, 0.10) !important; }
:deep(.row-status-running td:first-child) { border-left: 4px solid var(--app-brand) !important; }
</style>
