<template>
  <!--
    v2.42 Task 13: 代理节点状态 panel
    - 显示 main / jp 通道当前 active 节点 + 各节点 active/banned/idle 状态
    - 解禁时间（如 banned 节点有 expires_at）
    - 10s 自动刷新（GET /api/proxy/status）
  -->
  <SectionCard title="代理节点状态">
    <template #extra>
      <div class="px-tabs">
        <el-tag v-if="status.enabled" type="success" size="small">主代理: {{ status.available || 0 }} 节点</el-tag>
        <el-tag v-else type="info" size="small">主代理未启用</el-tag>
        <el-tag v-if="status.jp?.enabled" type="success" size="small" style="margin-left:6px">
          JP 通道: {{ status.jp?.available || 0 }} 节点
        </el-tag>
        <el-tag v-else type="info" size="small" style="margin-left:6px">JP 未启用</el-tag>
        <el-button text size="small" @click="refresh" :loading="loading" style="margin-left:8px">刷新</el-button>
      </div>
    </template>

    <div v-if="!status.enabled && !status.jp?.enabled" class="px-empty">代理未启用</div>
    <div v-else class="px-stack">
      <!-- 主代理 -->
      <div v-if="status.enabled" class="px-section">
        <div class="px-section__title">
          主代理 — 当前活跃：
          <span class="px-active">{{ status.mainActiveNode || '— (urltest 选择中)' }}</span>
        </div>
        <el-table
          :data="mainRows"
          size="small"
          stripe
          :default-sort="{ prop: 'active', order: 'descending' }"
          max-height="240"
        >
          <el-table-column prop="name" label="节点" min-width="280" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="tagType(row)" size="small">{{ tagLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="解禁时间" width="160">
            <template #default="{ row }">
              <span v-if="row.banned">{{ formatTime(row.banned) }}</span>
              <span v-else class="px-muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- JP 通道 -->
      <div v-if="status.jp?.enabled" class="px-section">
        <div class="px-section__title">
          JP 通道 — 当前活跃：
          <span class="px-active">{{ status.jpActiveNode || '— (urltest 选择中)' }}</span>
        </div>
        <el-table
          :data="jpRows"
          size="small"
          stripe
          :default-sort="{ prop: 'active', order: 'descending' }"
          max-height="240"
        >
          <el-table-column prop="name" label="节点" min-width="280" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="tagType(row)" size="small">{{ tagLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="解禁时间" width="160">
            <template #default="{ row }">
              <span v-if="row.banned">{{ formatTime(row.banned) }}</span>
              <span v-else class="px-muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 最近 ban 记录（如 DB 有持久化） -->
      <div v-if="(status.bannedHistory || []).length > 0" class="px-section">
        <div class="px-section__title">最近 ban 记录（共 {{ status.bannedHistory.length }} 条）</div>
        <el-table :data="status.bannedHistory.slice(0, 10)" size="small" max-height="200">
          <el-table-column prop="tag" label="节点" min-width="240" show-overflow-tooltip />
          <el-table-column prop="channel" label="通道" width="80" />
          <el-table-column prop="reason" label="原因" width="160" show-overflow-tooltip />
          <el-table-column label="解禁时间" width="160">
            <template #default="{ row }">{{ formatTime(row.until) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </SectionCard>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import api from '../api'
import SectionCard from './ui/SectionCard.vue'

const status = ref({
  enabled: false,
  jp: { enabled: false },
  mainActiveNode: '',
  jpActiveNode: '',
  nodeTags: [],
  mainNodes: [],
  jpNodes: [],
  bannedHistory: [],
})
const loading = ref(false)

// 优先用后端补的 mainNodes / jpNodes（带 active/banned/alive flag）；
// fallback 到 nodeTags + bannedNodes map 自行拼接，保兼容老 server。
const mainRows = computed(() => {
  if (Array.isArray(status.value.mainNodes) && status.value.mainNodes.length > 0) {
    return status.value.mainNodes
  }
  const banned = status.value.bannedNodes || {}
  const active = status.value.mainActiveNode || status.value.currentNode
  return (status.value.nodeTags || []).map(name => ({
    name,
    active: name === active,
    banned: banned[name] ? new Date(banned[name].expiresAt).toISOString() : null,
    alive: !banned[name],
  }))
})

const jpRows = computed(() => {
  if (Array.isArray(status.value.jpNodes) && status.value.jpNodes.length > 0) {
    return status.value.jpNodes
  }
  const banned = status.value.bannedNodes || {}
  const active = status.value.jpActiveNode || status.value.jp?.currentNode
  return (status.value.jp?.nodeTags || []).map(name => ({
    name,
    active: name === active,
    banned: banned[name] ? new Date(banned[name].expiresAt).toISOString() : null,
    alive: !banned[name],
  }))
})

function tagType(row) {
  if (row.banned) return 'danger'
  if (row.active) return 'success'
  return 'info'
}
function tagLabel(row) {
  if (row.banned) return 'banned'
  if (row.active) return 'active'
  return 'idle'
}
function formatTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + d.toLocaleDateString('zh-CN')
  } catch { return iso }
}

async function refresh() {
  loading.value = true
  try {
    const r = await api.get('/proxy/status')
    status.value = r.data || {}
  } catch (e) {
    // api.js 拦截器已处理 5xx / 网络错误的全局通知，这里静默即可。
  } finally {
    loading.value = false
  }
}

let timer = null
onMounted(() => {
  refresh()
  timer = setInterval(refresh, 10000)
})
onBeforeUnmount(() => {
  if (timer) { clearInterval(timer); timer = null }
})
</script>

<style scoped>
.px-tabs { display: flex; align-items: center; }
.px-empty {
  color: var(--app-text-mute);
  padding: var(--sp-4) 0;
  text-align: center;
  font-size: var(--fs-md);
}
.px-stack {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.px-section__title {
  font-size: var(--fs-md);
  color: var(--app-text-2);
  margin-bottom: var(--sp-2);
  font-weight: 500;
}
.px-active {
  color: var(--app-success);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.px-muted { color: var(--app-text-mute); }
</style>
