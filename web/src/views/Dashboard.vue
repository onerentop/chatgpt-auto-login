<template>
  <div class="app-stack--lg app-fade-in">
    <PageHeader title="仪表盘" :subtitle="todayLabel" />

    <!-- Hero metrics — 4 大数字卡 -->
    <div class="hero-grid">
      <div
        v-for="m in heroMetrics"
        :key="m.key"
        class="hero"
        :class="m.to ? 'hero--clickable' : ''"
        :tabindex="m.to ? 0 : -1"
        :role="m.to ? 'button' : undefined"
        @click="m.to && router.push(m.to)"
        @keydown.enter="m.to && router.push(m.to)"
      >
        <div class="hero__head">
          <span class="hero__label">{{ m.label }}</span>
          <el-icon v-if="m.icon" class="hero__icon" :class="`hero__icon--${m.tone}`">
            <component :is="m.icon" />
          </el-icon>
        </div>
        <div class="hero__value" :class="`hero__value--${m.tone}`">{{ m.value }}</div>
        <div v-if="m.delta" class="hero__delta">{{ m.delta }}</div>
      </div>
    </div>

    <!-- Two-column: tasks (left 2/3) + system health (right 1/3) -->
    <div class="dash-row">
      <SectionCard title="快捷操作" class="dash-row__main">
        <div class="task-grid">
          <button
            v-for="t in tasks"
            :key="t.key"
            type="button"
            class="task"
            :class="t.disabled ? 'task--disabled' : ''"
            :disabled="t.disabled"
            @click="t.action()"
          >
            <span class="task__icon" :class="`task__icon--${t.tone}`">
              <el-icon><component :is="t.icon" /></el-icon>
            </span>
            <span class="task__body">
              <span class="task__title">{{ t.title }}</span>
              <span class="task__hint">{{ t.hint }}</span>
            </span>
          </button>
        </div>
      </SectionCard>

      <SectionCard title="系统健康" class="dash-row__side">
        <template #extra>
          <el-button text size="small" @click="loadHealth" :loading="healthLoading">刷新</el-button>
        </template>
        <ul class="health">
          <li>
            <span class="health__dot" :class="health.engine === 'idle' || health.engine === 'running' ? 'health__dot--ok' : 'health__dot--off'" />
            <span class="health__label">执行引擎</span>
            <span class="health__value">{{ health.engine || '—' }}</span>
          </li>
          <li>
            <span class="health__dot" :class="health.proxy?.enabled ? 'health__dot--ok' : 'health__dot--off'" />
            <span class="health__label">主代理</span>
            <span class="health__value">
              {{ health.proxy?.enabled ? `${health.proxy.available || 0} 节点 · ${health.proxy.currentNode || '—'}` : '未启用' }}
            </span>
          </li>
          <li>
            <span class="health__dot" :class="health.proxy?.jpEnabled ? 'health__dot--ok' : 'health__dot--off'" />
            <span class="health__label">JP 通道</span>
            <span class="health__value">
              {{ health.proxy?.jpEnabled ? `${health.proxy.jpAvailable || 0} 节点 · ${health.proxy.jpCurrentNode || '—'}` : '未启用' }}
            </span>
          </li>
          <li>
            <span class="health__dot" :class="socketState.connected ? 'health__dot--ok' : 'health__dot--err'" />
            <span class="health__label">WebSocket</span>
            <span class="health__value">{{ socketState.connected ? '已连接' : '已断开' }}</span>
          </li>
          <li>
            <span class="health__dot health__dot--mute" />
            <span class="health__label">运行时长</span>
            <span class="health__value">{{ formatUptime(health.uptimeSec) }}</span>
          </li>
          <li>
            <span class="health__dot health__dot--mute" />
            <span class="health__label">版本</span>
            <span class="health__value">{{ health.version || '—' }}</span>
          </li>
        </ul>
      </SectionCard>
    </div>

    <!-- Recent activity -->
    <SectionCard title="近期执行" flush>
      <template #extra>
        <el-button text size="small" @click="reload" :loading="loading">刷新</el-button>
        <el-button text size="small" type="primary" @click="router.push('/results')">查看全部 →</el-button>
      </template>
      <EmptyState
        v-if="!loading && recentResults.length === 0"
        title="还没有执行记录"
        hint='点上方"跑一批"开始第一次执行'
      />
      <el-table
        v-else
        :data="recentResults"
        size="small"
        max-height="360"
      >
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="email" label="邮箱" min-width="240" />
        <el-table-column label="状态" width="160">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="阶段" width="120" />
        <el-table-column label="Auth" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.hasAuthFile" type="success" size="small">有</el-tag>
            <span v-else style="color:var(--app-text-mute)">无</span>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新" width="180" />
      </el-table>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import {
  User, VideoPlay, RefreshLeft, Download, Upload, DataLine, Aim, Monitor,
} from '@element-plus/icons-vue'
import api from '../api'
import { statusType, statusLabel, isPlus, isFailedToRetry } from '../status'
import { socketState } from '../socket'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const router = useRouter()
const stats = reactive({
  total: 0, plusToday: 0, retry: 0, running: 0,
  totalAccounts: 0,
})
const allResults = ref([])
const loading = ref(false)
const health = ref({})
const healthLoading = ref(false)

const todayLabel = computed(() => {
  const d = new Date()
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `今日 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 周${w}`
})

// Today helpers — uses local Date to compare YYYY-MM-DD prefix.
function todayPrefix() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const recentResults = computed(() => allResults.value.slice(0, 8))

const heroMetrics = computed(() => [
  {
    key: 'total',
    label: '账号总数',
    value: stats.totalAccounts,
    icon: User,
    tone: 'neutral',
    to: '/accounts',
  },
  {
    key: 'plusToday',
    label: '今日激活',
    value: stats.plusToday,
    delta: stats.plusToday > 0 ? `共 ${allResults.value.filter(r => isPlus(r.status)).length} 累计成功` : '',
    icon: VideoPlay,
    tone: 'success',
    to: '/accounts?status=plus',
  },
  {
    key: 'retry',
    label: '待重试',
    value: stats.retry,
    delta: stats.retry > 0 ? '点击查看可重试列表' : '当前无失败',
    icon: RefreshLeft,
    tone: stats.retry > 0 ? 'warning' : 'neutral',
    to: stats.retry > 0 ? '/execute' : null,
  },
  {
    key: 'running',
    label: '运行中',
    value: stats.running,
    delta: stats.running > 0 ? '查看 Pipeline' : '空闲',
    icon: Aim,
    tone: stats.running > 0 ? 'brand' : 'neutral',
    to: stats.running > 0 ? '/execute' : null,
  },
])

const tasks = computed(() => [
  {
    key: 'import',
    title: '导入新账号',
    hint: '按 ---- 格式批量粘贴邮箱',
    icon: Upload,
    tone: 'brand',
    action: () => router.push('/accounts?action=import'),
  },
  {
    key: 'run',
    title: '跑一批新账号',
    hint: stats.totalAccounts > 0 ? '到执行控制选号开始' : '先导入账号',
    icon: VideoPlay,
    tone: 'success',
    disabled: stats.totalAccounts === 0,
    action: () => router.push('/execute'),
  },
  {
    key: 'retry',
    title: '重试失败',
    hint: stats.retry > 0 ? `${stats.retry} 个账号可重试` : '当前无失败账号',
    icon: RefreshLeft,
    tone: 'warning',
    disabled: stats.retry === 0,
    action: () => router.push('/execute'),
  },
  {
    key: 'liveness',
    title: '测活老账号',
    hint: '检查 Plus 是否仍有效',
    icon: Monitor,
    tone: 'neutral',
    action: () => router.push('/accounts'),
  },
  {
    key: 'download',
    title: '下载凭证',
    hint: '导出 CPA / Sub2API 格式 ZIP',
    icon: Download,
    tone: 'neutral',
    action: () => window.open('/api/results/download-all'),
  },
  {
    key: 'config',
    title: '调代理 / 配置',
    hint: '订阅、白名单、模式开关',
    icon: DataLine,
    tone: 'neutral',
    action: () => router.push('/config'),
  },
])

function formatUptime(sec) {
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分`
}

async function reload() {
  loading.value = true
  try {
    const [accountsRes, resultsRes] = await Promise.all([
      api.get('/accounts'),
      api.get('/results'),
    ])
    const accounts = accountsRes.data || []
    const statuses = resultsRes.data || []
    const today = todayPrefix()
    stats.totalAccounts = accounts.length
    stats.plusToday = statuses.filter((r) => isPlus(r.status) && (r.updated_at || '').startsWith(today)).length
    stats.retry = statuses.filter((r) => isFailedToRetry(r.status)).length
    stats.running = statuses.filter((r) => r.status === 'running').length
    // Sort by updated_at desc for recent table
    allResults.value = [...statuses].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  } catch {}
  finally { loading.value = false }
}

async function loadHealth() {
  healthLoading.value = true
  try {
    const { data } = await api.get('/health')
    health.value = data || {}
  } catch {}
  finally { healthLoading.value = false }
}

let healthTimer = null
onMounted(() => {
  reload()
  loadHealth()
  healthTimer = setInterval(loadHealth, 10000)
})
onBeforeUnmount(() => {
  if (healthTimer) clearInterval(healthTimer)
})
</script>

<style scoped>
/* === Hero metrics === */
.hero-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--sp-4);
}
.hero {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-5);
  background: var(--app-surface);
  border-radius: var(--rad-md);
  box-shadow: var(--sh-1);
  border: 1px solid transparent;
  transition: box-shadow var(--tr-fast), transform var(--tr-fast), border-color var(--tr-fast);
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: default;
}
.hero--clickable { cursor: pointer; }
.hero--clickable:hover {
  box-shadow: var(--sh-2);
  transform: translateY(-1px);
  border-color: var(--app-border);
}
.hero__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.hero__label {
  font-size: var(--fs-md);
  color: var(--app-text-3);
  font-weight: 500;
}
.hero__icon {
  font-size: 18px;
  padding: 6px;
  border-radius: var(--rad-sm);
  color: var(--app-text-3);
  background: var(--app-surface-2);
}
.hero__icon--success { color: var(--app-success); background: var(--app-row-success); }
.hero__icon--warning { color: var(--app-warning); background: var(--app-row-warning); }
.hero__icon--danger  { color: var(--app-danger);  background: var(--app-row-danger); }
.hero__icon--brand   { color: var(--app-brand);   background: var(--el-color-primary-light-9); }
.hero__value {
  font-size: var(--fs-3xl);
  font-weight: 600;
  line-height: 1.1;
  color: var(--app-text);
  letter-spacing: -0.02em;
}
.hero__value--success { color: var(--app-success); }
.hero__value--warning { color: var(--app-warning); }
.hero__value--danger  { color: var(--app-danger); }
.hero__value--brand   { color: var(--app-brand); }
.hero__delta {
  font-size: var(--fs-sm);
  color: var(--app-text-mute);
}

/* === Two-column row (tasks + health) === */
.dash-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--sp-5);
}
@media (max-width: 1100px) {
  .dash-row { grid-template-columns: 1fr; }
}

/* === Task cards === */
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--sp-3);
}
.task {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--app-surface);
  border: 1px solid var(--app-border-soft);
  border-radius: var(--rad-md);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: border-color var(--tr-fast), background var(--tr-fast),
              box-shadow var(--tr-fast), transform var(--tr-fast);
}
.task:hover:not(.task--disabled) {
  border-color: var(--app-border);
  background: var(--app-surface-2);
  box-shadow: var(--sh-2);
  transform: translateY(-1px);
}
.task--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.task__icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--rad-sm);
  background: var(--app-surface-2);
  color: var(--app-text-3);
  font-size: 18px;
  flex-shrink: 0;
}
.task__icon--brand   { color: var(--app-brand);   background: var(--el-color-primary-light-9); }
.task__icon--success { color: var(--app-success); background: var(--app-row-success); }
.task__icon--warning { color: var(--app-warning); background: var(--app-row-warning); }
.task__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.task__title {
  font-size: var(--fs-lg);
  font-weight: 500;
  color: var(--app-text);
}
.task__hint {
  font-size: var(--fs-sm);
  color: var(--app-text-3);
}

/* === Health list === */
.health {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.health li {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  font-size: var(--fs-md);
}
.health__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--app-text-mute);
}
.health__dot--ok { background: var(--app-success); box-shadow: 0 0 0 3px rgba(103, 194, 58, 0.15); }
.health__dot--off { background: var(--app-text-mute); }
.health__dot--err { background: var(--app-danger); box-shadow: 0 0 0 3px rgba(245, 108, 108, 0.15); }
.health__dot--mute { background: var(--app-border); }
.health__label {
  color: var(--app-text-3);
  min-width: 80px;
}
.health__value {
  color: var(--app-text);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
</style>
