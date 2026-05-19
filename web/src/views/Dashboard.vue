<template>
  <div>
    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="6">
        <el-card shadow="hover">
          <div style="font-size:32px;font-weight:bold;color:#409EFF">{{ stats.total }}</div>
          <div style="color:#909399;margin-top:8px">总账号数</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div style="font-size:32px;font-weight:bold;color:#67c23a">{{ stats.plus }}</div>
          <div style="color:#909399;margin-top:8px">Plus 账号</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div style="font-size:32px;font-weight:bold;color:#e6a23c">{{ stats.success }}</div>
          <div style="color:#909399;margin-top:8px">执行成功</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <div style="font-size:32px;font-weight:bold;color:#f56c6c">{{ stats.error }}</div>
          <div style="color:#909399;margin-top:8px">执行失败</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <template #header>最近执行状态</template>
      <el-table :data="results" stripe size="small" max-height="400">
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phase" label="阶段" width="120" />
        <el-table-column label="Auth" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.hasAuthFile" type="success" size="small">有</el-tag>
            <span v-else style="color:#c0c4cc">无</span>
          </template>
        </el-table-column>
        <el-table-column prop="updated_at" label="更新时间" width="170" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import api from '../api'

const stats = reactive({ total: 0, plus: 0, success: 0, error: 0 })
const results = ref([])

function statusType(s) {
  if (!s) return 'info'
  const sl = s.toLowerCase()
  if (sl === 'success' || sl === 'already_plus') return 'success'
  if (sl === 'error' || sl === 'failed') return 'danger'
  if (sl === 'no_link') return 'warning'
  if (sl === 'running') return ''
  return 'info'
}

onMounted(async () => {
  try {
    const [accountsRes, resultsRes] = await Promise.all([
      api.get('/accounts'),
      api.get('/results'),
    ])
    const accounts = accountsRes.data || []
    const statuses = resultsRes.data || []

    stats.total = accounts.length
    stats.plus = statuses.filter(r => ['success', 'already_plus'].includes((r.status || '').toLowerCase())).length
    stats.success = statuses.filter(r => ['success', 'already_plus'].includes((r.status || '').toLowerCase())).length
    stats.error = statuses.filter(r => ['error', 'failed'].includes((r.status || '').toLowerCase())).length
    results.value = statuses
  } catch {}
})
</script>
