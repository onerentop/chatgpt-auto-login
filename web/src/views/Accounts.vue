<template>
  <div class="app-stack--lg">
    <PageHeader title="账号管理" :subtitle="headerSubtitle">
      <template #actions>
        <el-button @click="exportAccounts">导出全部</el-button>
        <el-button type="primary" @click="showImport = true">批量导入</el-button>
        <el-button type="success" data-hotkey="submit" @click="openAdd">添加单个</el-button>
      </template>
    </PageHeader>

    <!-- Toolbar — 单行筛选 + 单行测活控制 -->
    <SectionCard flush>
      <div class="ac-toolbar">
        <div class="ac-toolbar__row">
          <el-input v-model="search" placeholder="搜索邮箱 / RT / Client ID / TOTP / 密码  按 / 聚焦" clearable
                    style="flex:1;max-width:380px" data-hotkey="search" />
          <el-select v-model="statusFilter" placeholder="状态" clearable multiple collapse-tags collapse-tags-tooltip style="width:170px">
            <el-option v-for="opt in EXECUTE_STATUS_FILTER_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <el-popover placement="bottom-end" :width="320" trigger="click">
            <template #reference>
              <el-button>
                更多筛选
                <el-tag v-if="advancedFilterCount > 0" type="primary" size="small" round style="margin-left:6px">
                  {{ advancedFilterCount }}
                </el-tag>
              </el-button>
            </template>
            <div class="ac-advanced">
              <div class="ac-advanced__row">
                <label class="ac-advanced__label">Plan</label>
                <el-select v-model="planFilter" placeholder="不限" clearable style="flex:1">
                  <el-option label="Plus" value="plus" />
                  <el-option label="Free" value="free" />
                  <el-option label="未知" value="unknown" />
                </el-select>
              </div>
              <div class="ac-advanced__row">
                <label class="ac-advanced__label">Auth 文件</label>
                <el-select v-model="authFilter" placeholder="不限" clearable style="flex:1">
                  <el-option label="已生成" value="yes" />
                  <el-option label="未生成" value="no" />
                </el-select>
              </div>
              <div class="ac-advanced__row">
                <label class="ac-advanced__label">活性</label>
                <el-select v-model="aliveFilter" placeholder="不限" clearable multiple collapse-tags style="flex:1">
                  <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
                </el-select>
              </div>
              <div class="ac-advanced__row">
                <el-button size="small" text @click="aliveFilter = ['unknown']">仅看未测试</el-button>
                <el-button size="small" :type="staleOnly ? 'primary' : ''" text @click="staleOnly = !staleOnly">7 天未测</el-button>
                <span style="flex:1" />
                <el-button size="small" text :disabled="!hasAnyFilter" @click="resetFilters">重置全部</el-button>
              </div>
            </div>
          </el-popover>
          <el-divider direction="vertical" />
          <!-- v2.41.2: 分组/平铺切换 + 分组维度选择（参照 Execute v2.34.0） -->
          <el-switch
            v-model="groupingEnabled"
            active-text="分组"
            inactive-text="平铺"
            inline-prompt
          />
          <el-select
            v-if="groupingEnabled"
            v-model="groupBy"
            placeholder="分组方式"
            style="width:130px"
          >
            <el-option label="按 Plan" value="plan" />
            <el-option label="按 活性" value="alive_status" />
            <el-option label="按 登录类型" value="loginType" />
          </el-select>
          <span class="app-spacer" />
          <el-tag round>{{ filteredAccounts.length }} / {{ accounts.length }}</el-tag>
        </div>
        <!-- Row 2: 测活全局控制（与选中无关；选中相关的操作走底部 ContextActionBar） -->
        <div class="ac-toolbar__row ac-toolbar__row--liveness">
          <span class="ac-toolbar__group-label">测活</span>
          <el-button type="primary" :disabled="livenessRunning" @click="checkAllWithConfirm">测活全部</el-button>
          <el-button v-if="livenessRunning" type="danger" @click="stopLiveness">停止测活</el-button>
          <el-tag v-if="livenessRunning" type="info" size="small">
            {{ socketState.liveness.done }}/{{ socketState.liveness.total }} (✗{{ socketState.liveness.failed }})
          </el-tag>
          <span class="app-spacer" />
          <el-dropdown @command="downloadAllAs" split-button size="default">
            下载全部 (ZIP)
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
                <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </SectionCard>

    <!-- v2.35 ContextActionBar — bulk operations slide-in at bottom when selected > 0 -->
    <ContextActionBar :count="selected.length" label="个账号" @clear="clearAllSelection">
      <el-button @click="exportSelected">导出</el-button>
      <el-dropdown @command="downloadSelectedAs" split-button size="default">
        下载
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
            <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button type="primary" :disabled="livenessRunning" @click="startLiveness('selected')">测活</el-button>
      <el-button type="danger" :loading="batchDeleting" @click="confirmDelSelected">
        {{ batchDeleting ? '删除中…' : '删除' }}
      </el-button>
    </ContextActionBar>

    <!-- v2.41.5: 底部集中"测活日志"面板已删除；改成每账号 expand row 单独
         渲染该账号的历史 + 实时日志（getHistoryLogs / getRealtimeLogs prop 走
         AccountsTable.vue 的 expand 列）。socketState.logs 仍是数据源，filter
         逻辑见下方 script。 -->

    <!-- v2.41.2: 分组视图（collapse 多 table）/ 平铺视图（单 table）切换 -->
    <SectionCard flush>
      <el-collapse v-if="groupingEnabled" v-model="expandedKeys" style="margin-top:0">
        <el-collapse-item v-for="g in visibleGroups" :key="g.key" :name="g.key">
          <template #title>
            <div style="display:flex;align-items:center;gap:8px;padding:0 8px">
              <el-tag size="small" :type="g.tagType || ''">{{ g.label }}</el-tag>
              <span style="color:#909399;font-size:13px">共 {{ g.rows.length }} 个</span>
            </div>
          </template>
          <AccountsTable
            :ref="el => { if (el) groupRefs[g.key] = el }"
            :rows="g.rows"
            :global-selected-set="globalSelectedSet"
            :get-history-logs="getHistoryLogs"
            :get-realtime-logs="getRealtimeLogs"
            @selection-change="onGroupSelectionChange(g.key, $event)"
            @row-click="onRowClick"
            @edit="openEdit"
            @delete="del"
            @auth-download="onAuthDownload"
            @copy="onCopy"
          />
        </el-collapse-item>
      </el-collapse>
      <AccountsTable
        v-else
        ref="flatTableRef"
        :rows="filteredAccounts"
        :global-selected-set="globalSelectedSet"
        :get-history-logs="getHistoryLogs"
        :get-realtime-logs="getRealtimeLogs"
        @selection-change="onFlatSelectionChange"
        @row-click="onRowClick"
        @edit="openEdit"
        @delete="del"
        @auth-download="onAuthDownload"
        @copy="onCopy"
      />
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
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentCopy } from '@element-plus/icons-vue'
import api from '../api'
import { PLUS_STATUSES, ERROR_STATUSES, aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS, EXECUTE_STATUS_FILTER_OPTIONS } from '../status'
import { socketState } from '../socket'
import { getSelectionSet, clearSelection } from '../selection'
import { useUrlSyncedFilters } from '../composables/useUrlSyncedFilters'
import { confirmDanger } from '../composables/useConfirmDanger'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import ContextActionBar from '../components/ui/ContextActionBar.vue'
import AccountsTable from '../components/AccountsTable.vue'

// 平铺视图下指向单个 AccountsTable；分组视图下指向 ref map（每组一个）。
const flatTableRef = ref(null)
const groupRefs = ref({})
const accounts = ref([])
// selected 数组用于既有按钮逻辑（导出/下载/测活/删除）；其底层来源已迁移到
// globalSelectedSet（跨组跨视图的真实选中集），两者通过 syncSelectedFromGlobal
// 单向保持同步。保留 ref 形态以最小化对其他函数的改动。
const selected = ref([])
const globalSelectedSet = getSelectionSet('accounts')
const search = ref('')
const statusFilter = ref([])
const planFilter = ref('')
const authFilter = ref('')
const aliveFilter = ref([])
const staleOnly = ref(false)

// v2.41.2: 分组开关 + 分组维度（参照 Execute v2.34.0 分组模式）
const groupingEnabled = ref(false)  // 默认平铺，保持兼容
const groupBy = ref('plan')  // 默认按 plan 分组
const expandedKeys = ref([])  // 分组视图默认全展开（在 visibleGroups 变化时同步）

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

// v2.35 — count of advanced (popover-hidden) filters that are active.
// Used as a badge on the "更多筛选" button so users can see at a glance
// when filters are applied behind the popover.
const advancedFilterCount = computed(() => {
  let n = 0
  if (planFilter.value) n++
  if (authFilter.value) n++
  if (aliveFilter.value.length > 0) n++
  if (staleOnly.value) n++
  return n
})

function resetFilters() {
  search.value = ''
  statusFilter.value = []
  planFilter.value = ''
  authFilter.value = ''
  aliveFilter.value = []
  staleOnly.value = false
}

const aliveFilterOptions = ALIVE_FILTER_OPTIONS

// v2.41.5: 集中"测活日志"面板已删除，但 socketState.logs 仍是测活日志真源
// （loadLivenessLogs 从 DB 回放，socket.on('liveness-log') 实时推送）。
// 这两个 computed 保留作为按 email filter 的输入；新的 expand row 渲染
// 直接调 getHistoryLogs(email) / getRealtimeLogs(email) 在子组件 template 用。
const oldLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && l.isHistorical).slice(-200)
)
const newLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness' && !l.isHistorical).slice(-500)
)

// v2.41.5: 按 email 分桶 — AccountsTable expand 列通过 prop 调用。
// 数据为全账号混合的 oldLogs/newLogs computed，按 email 字段 filter。
function getHistoryLogs(email) {
  return oldLogs.value.filter(l => l.email === email)
}
function getRealtimeLogs(email) {
  return newLogs.value.filter(l => l.email === email)
}
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
// v2.41.2: 分组维度计算 —— 三个维度（plan / alive_status / loginType）
// 每个维度都把空 / 未知值归到独立 key，避免被丢弃。组按 count 倒序展示，
// 让数量最多的组排前。
function groupKeyOf(row) {
  if (groupBy.value === 'plan') {
    return row._plan || 'unknown'
  } else if (groupBy.value === 'alive_status') {
    return row._aliveStatus || 'unknown'
  } else {  // loginType
    return (row.loginType || 'other').toLowerCase()
  }
}

function groupLabelOf(key) {
  if (groupBy.value === 'plan') {
    if (key === 'plus') return 'Plus'
    if (key === 'free') return 'Free'
    return '未知'
  } else if (groupBy.value === 'alive_status') {
    // 复用 status.js 的活性标签（Plus / 已取消 / 已删除 / Token过期 / ...
    // 未测试 / 检测中 等），保持单一来源
    return aliveStatusLabel(key)
  } else {  // loginType
    if (key === 'outlook') return 'Outlook'
    if (key === 'google') return 'Google'
    return '其它'
  }
}

function groupTagTypeOf(key) {
  if (groupBy.value === 'plan') {
    if (key === 'plus') return 'success'
    if (key === 'free') return ''
    return 'info'
  } else if (groupBy.value === 'alive_status') {
    return aliveStatusType(key)
  } else {  // loginType
    if (key === 'outlook') return 'warning'
    if (key === 'google') return 'danger'
    return 'info'
  }
}

const visibleGroups = computed(() => {
  const groups = new Map()
  for (const a of filteredAccounts.value) {
    const key = groupKeyOf(a)
    if (!groups.has(key)) {
      groups.set(key, { key, label: groupLabelOf(key), tagType: groupTagTypeOf(key), rows: [] })
    }
    groups.get(key).rows.push(a)
  }
  return Array.from(groups.values()).sort((a, b) => b.rows.length - a.rows.length)
})

// 分组视图默认全展开 —— visibleGroups 变化（或切换 groupBy）时把所有
// key 灌进 expandedKeys；用户手动收起的状态会在下一次重算时被覆盖，
// 与 Execute 的 expandedKeys 行为一致（页面级 DEFAULT_EXPANDED_STATUSES）。
watch(visibleGroups, (groups) => {
  expandedKeys.value = groups.map(g => g.key)
}, { immediate: true })

// 切换分组维度时清空 groupRefs（旧 key 已无意义；新的 ref 由模板渲染时填充）
watch(groupBy, () => {
  groupRefs.value = {}
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
onMounted(() => {
  load()
  loadLivenessLogs()
  // v2.35 — react to ?action=import / ?action=add from Dashboard task cards
  // or Command Palette navigations. Clear the query after opening so a refresh
  // doesn't keep re-opening the modal.
  const route = useRoute()
  const router = useRouter()
  if (route.query.action === 'import') {
    showImport.value = true
    router.replace({ query: { ...route.query, action: undefined } })
  } else if (route.query.action === 'add') {
    openAdd()
    router.replace({ query: { ...route.query, action: undefined } })
  }
})
// v2.41.5: 旧的"测活开始时自动展开实时日志 collapse"逻辑已删除（集中面板
// 不存在了）。每账号 expand row 由用户点击 el-table expand 列 toggle，不在
// liveness 开始时自动展开 — 一次测活动则上百行，全展开反而无法定位。

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

// 平铺视图：单 table 管理全部行，全局选择即所选 rows
function onFlatSelectionChange(rows) {
  clearSelection('accounts')
  for (const r of rows) globalSelectedSet.add(r.email)
  syncSelectedFromGlobal()
}

// 分组视图：本组的选中变化合并到全局 Set（参照 Execute.onGroupSelectionChange）。
// 先移除本组所有 emails，再加入本次 rows 的 emails。
function onGroupSelectionChange(groupKey, rows) {
  const group = visibleGroups.value.find(g => g.key === groupKey)
  const groupEmails = new Set((group?.rows || []).map(r => r.email))
  for (const email of Array.from(globalSelectedSet)) {
    if (groupEmails.has(email)) globalSelectedSet.delete(email)
  }
  for (const r of rows) globalSelectedSet.add(r.email)
  syncSelectedFromGlobal()
}

// 把 globalSelectedSet 投影回 selected 数组（既有按钮逻辑读取 selected）。
function syncSelectedFromGlobal() {
  const set = globalSelectedSet
  selected.value = accounts.value.filter(a => set.has(a.email))
}

function clearAllSelection() {
  clearSelection('accounts')
  // 平铺和分组各自的 table 都得 clear（确保 el-table 内置 selection 同步）
  flatTableRef.value?.clearSelection?.()
  for (const ref of Object.values(groupRefs.value)) {
    ref?.clearSelection?.()
  }
  selected.value = []
}

// 页面 load 后回填选中：globalSelectedSet 已是源；AccountsTable 内部 watch
// rows 时会按 Set 自动 toggle，因此只需要把 selected 数组同步出来即可。
function restoreSelection() {
  const saved = globalSelectedSet
  if (saved.size === 0) return
  nextTick(() => {
    syncSelectedFromGlobal()
  })
}

const livenessRunning = computed(() => socketState.liveness.running)

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

// AccountsTable 子组件 emit 包装成 { row, column, event } 对象，
// 平铺视图和分组视图共用同一 handler；toggleRowSelection 走到对应的 table
// 实例（平铺用 flatTableRef；分组按 row 当前所属组 key 路由）。
function onRowClick({ row, column, event }) {
  if (column?.type === 'selection') return
  if (event?.target?.closest('.el-button, .el-dropdown, .el-popconfirm, a')) return
  if (groupingEnabled.value) {
    const key = groupKeyOf(row)
    groupRefs.value[key]?.toggleRowSelection?.(row)
  } else {
    flatTableRef.value?.toggleRowSelection?.(row)
  }
}

// 复制 / 下载 / row-action emit 透传
async function onCopy({ text, label }) {
  await copyToClipboard(text, label)
}
function onAuthDownload({ email, format }) {
  downloadAuth(email, format)
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
/* Toolbar — v2.35: one filter row + one liveness/global-action row.
 * Bulk per-selection actions moved to ContextActionBar (bottom slide-in).
 * v2.41.2: el-table 相关样式（cursor / 行高亮）已迁到 AccountsTable.vue。 */
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
.ac-toolbar__row--liveness {
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--app-border-soft);
}
.ac-toolbar__group-label {
  font-size: var(--fs-sm);
  color: var(--app-text-mute);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  margin-right: var(--sp-1);
}

/* Advanced filters popover */
.ac-advanced {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ac-advanced__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.ac-advanced__label {
  width: 72px;
  flex-shrink: 0;
  font-size: var(--fs-md);
  color: var(--app-text-2);
}

/* v2.41.5: .liveness-log-list / .log-* 旧集中面板样式已删除（面板下沉到
   每账号 expand row，由 AccountsTable.vue 内联样式渲染）。 */
</style>
