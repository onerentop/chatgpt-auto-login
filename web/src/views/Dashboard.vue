<template>
  <div>
    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="总账号数" :value="stats.total" />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="Plus 账号" :value="stats.plus">
            <template #suffix>
              <span style="font-size: 14px; color: #67c23a"> / {{ stats.total }}</span>
            </template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="成功数" :value="stats.success" />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="错误数" :value="stats.error" />
        </el-card>
      </el-col>
    </el-row>

    <el-card>
      <template #header>
        <span>最近执行结果</span>
      </template>
      <el-table :data="recentResults" stripe style="width: 100%">
        <el-table-column prop="email" label="邮箱" min-width="200" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="信息" min-width="250" show-overflow-tooltip />
        <el-table-column prop="timestamp" label="时间" width="180">
          <template #default="{ row }">
            {{ formatTime(row.timestamp) }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import api from '../api'

const stats = reactive({
  total: 0,
  plus: 0,
  success: 0,
  error: 0,
})

const recentResults = ref([])

function statusType(status) {
  const map = {
    success: 'success',
    error: 'danger',
    pending: 'info',
    running: 'warning',
  }
  return map[status] || 'info'
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString('zh-CN')
}

onMounted(async () => {
  try {
    const [accountsRes, resultsRes] = await Promise.all([
      api.get('/accounts'),
      api.get('/results'),
    ])

    const accounts = accountsRes.data.accounts || accountsRes.data || []
    stats.total = accounts.length
    stats.plus = accounts.filter((a) => a.loginType === 'plus' || a.is_plus).length

    const results = resultsRes.data.results || resultsRes.data || []
    stats.success = results.filter((r) => r.status === 'success').length
    stats.error = results.filter((r) => r.status === 'error').length
    recentResults.value = results.slice(0, 20)
  } catch (err) {
    console.error('Failed to load dashboard data:', err)
  }
})
</script>
