<template>
  <div class="app-stack--lg">
    <PageHeader title="仪表盘" subtitle="账号总览与最近执行结果" />

    <div class="kpi-grid">
      <button
        v-for="card in cards"
        :key="card.key"
        type="button"
        class="kpi"
        :class="`kpi--${card.tone}`"
        :title="card.hint || ''"
        @click="card.to && router.push(card.to)"
      >
        <span class="kpi__value">{{ card.value }}</span>
        <span class="kpi__label">{{ card.label }}</span>
      </button>
    </div>

    <SectionCard title="最近执行状态" flush>
      <template #extra>
        <el-button size="small" text @click="reload" :loading="loading">刷新</el-button>
      </template>
      <EmptyState
        v-if="!loading && results.length === 0"
        title="还没有执行记录"
        hint="去 执行控制 选几个账号试一下"
      />
      <el-table
        v-else
        :data="results"
        stripe
        size="small"
        max-height="420"
      >
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="email" label="邮箱" min-width="240" />
        <el-table-column label="状态" width="140">
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
        <el-table-column prop="updated_at" label="更新时间" width="180" />
      </el-table>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api'
import { statusType, statusLabel, isPlus } from '../status'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const router = useRouter()
const stats = reactive({ total: 0, plus: 0, success: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 })
const results = ref([])
const loading = ref(false)

const cards = computed(() => [
  { key: 'total',       value: stats.total,       label: '账号总数',         tone: 'neutral' },
  { key: 'plus',        value: stats.plus,        label: 'Plus（含 RT）',    tone: 'success', to: '/accounts?status=plus' },
  { key: 'success',     value: stats.success,     label: '激活成功',         tone: 'success', hint: '含 plus / plus_no_rt' },
  { key: 'error',       value: stats.error,       label: '执行错误',         tone: 'danger',  to: '/accounts?status=error' },
  { key: 'noJpProxy',   value: stats.noJpProxy,   label: 'JP 节点不可用',    tone: 'warning', to: '/accounts?status=no_jp_proxy' },
  { key: 'noPromo',     value: stats.noPromo,     label: '无 0 元资格',      tone: 'neutral', to: '/accounts?status=no_promo' },
  { key: 'verifyError', value: stats.verifyError, label: 'Stripe 验证失败', tone: 'danger',  to: '/accounts?status=verify_error' },
])

async function reload() {
  loading.value = true
  try {
    const [accountsRes, resultsRes] = await Promise.all([
      api.get('/accounts'),
      api.get('/results'),
    ])
    const accounts = accountsRes.data || []
    const statuses = resultsRes.data || []
    stats.total = accounts.length
    stats.plus = statuses.filter(r => r.status === 'plus').length
    stats.success = statuses.filter(r => isPlus(r.status)).length
    stats.error = statuses.filter(r => r.status === 'error').length
    stats.noJpProxy = statuses.filter(r => r.status === 'no_jp_proxy').length
    stats.noPromo = statuses.filter(r => r.status === 'no_promo').length
    stats.verifyError = statuses.filter(r => r.status === 'verify_error').length
    results.value = statuses
  } catch {}
  finally { loading.value = false }
}

onMounted(reload)
</script>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--sp-4);
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-4);
  background: var(--app-surface);
  border: 1px solid var(--app-border-soft);
  border-radius: var(--rad-md);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: border-color var(--tr-fast), box-shadow var(--tr-fast), transform var(--tr-fast);
}
.kpi:hover {
  border-color: var(--app-border);
  box-shadow: var(--sh-2);
  transform: translateY(-1px);
}
.kpi:focus-visible {
  outline: 2px solid var(--app-brand);
  outline-offset: 2px;
}
.kpi__value {
  font-size: var(--fs-3xl);
  font-weight: 600;
  color: var(--app-text);
  line-height: 1.1;
}
.kpi__label {
  font-size: var(--fs-md);
  color: var(--app-text-3);
}
.kpi--success .kpi__value { color: var(--app-success); }
.kpi--warning .kpi__value { color: var(--app-warning); }
.kpi--danger  .kpi__value { color: var(--app-danger); }
.kpi--neutral .kpi__value { color: var(--app-text); }
</style>
