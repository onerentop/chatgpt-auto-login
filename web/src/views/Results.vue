<template>
  <div class="app-stack--lg">
    <PageHeader title="执行结果" :subtitle="headerSubtitle">
      <template #actions>
        <el-button :loading="loading" @click="loadResults">刷新</el-button>
        <el-button type="primary" @click="handleDownloadAll">下载全部 ZIP</el-button>
      </template>
    </PageHeader>

    <SectionCard flush>
      <div class="rs-filter">
        <el-input v-model="search" placeholder="搜索邮箱… 按 / 聚焦" clearable style="width:240px" data-hotkey="search" />
        <el-select
          v-model="statusFilter"
          placeholder="筛选状态"
          clearable
          style="width:160px"
        >
          <el-option label="全部" value="" />
          <el-option
            v-for="opt in EXECUTE_STATUS_FILTER_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </el-select>
        <span class="app-spacer" />
        <el-tag round>{{ filteredResults.length }} / {{ results.length }}</el-tag>
      </div>

      <EmptyState
        v-if="!loading && results.length === 0"
        title="还没有执行结果"
        hint="去执行控制选几个账号试一下"
      />
      <el-table
        v-else
        :data="filteredResults"
        stripe
        style="width: 100%"
      >
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Auth 文件" width="140">
          <template #default="{ row }">
            <el-button
              v-if="row.hasAuthFile"
              type="primary"
              size="small"
              link
              @click="handleDownload(row.email)"
            >下载</el-button>
            <span v-else style="color:var(--app-text-mute)">无</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button
              type="warning"
              size="small"
              link
              @click="handleRetry(row.email)"
            >重试</el-button>
          </template>
        </el-table-column>
      </el-table>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { statusType, statusLabel, EXECUTE_STATUS_FILTER_OPTIONS, PLUS_STATUSES } from '../status'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const results = ref([])
const statusFilter = ref('')
const search = ref('')
const loading = ref(false)

const filteredResults = computed(() => {
  const q = search.value.toLowerCase()
  return results.value.filter((r) => {
    if (statusFilter.value && r.status !== statusFilter.value) return false
    if (q && !(r.email || '').toLowerCase().includes(q)) return false
    return true
  })
})

const headerSubtitle = computed(() => {
  const total = results.value.length
  const plus = results.value.filter((r) => PLUS_STATUSES.includes((r.status || '').toLowerCase())).length
  const auth = results.value.filter((r) => r.hasAuthFile).length
  if (total === 0) return '暂无执行历史'
  return `共 ${total} 条 · Plus ${plus} · 有 Auth ${auth}`
})

async function loadResults() {
  loading.value = true
  try {
    const { data } = await api.get('/results')
    results.value = data.results || data || []
  } catch (err) {
    console.error('Failed to load results:', err)
  } finally {
    loading.value = false
  }
}

onMounted(loadResults)

function handleDownload(email) {
  window.open(`/api/results/${encodeURIComponent(email)}/auth-file`)
}

function handleDownloadAll() {
  window.open('/api/results/download-all')
}

async function handleRetry(email) {
  try {
    await api.post('/execute', { emails: [email] })
    ElMessage.success(`已启动重试: ${email}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '重试失败')
  }
}
</script>

<style scoped>
.rs-filter {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--app-border-soft);
}
</style>
