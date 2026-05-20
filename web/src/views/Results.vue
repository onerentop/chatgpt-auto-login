<template>
  <div>
    <el-row style="margin-bottom: 16px" :gutter="12" align="middle">
      <el-col :span="24">
        <el-select
          v-model="statusFilter"
          placeholder="筛选状态"
          clearable
          style="width: 160px; margin-right: 12px"
          @change="loadResults"
        >
          <el-option label="全部" value="" />
          <el-option label="Plus成功" value="success" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="无链接" value="no_link" />
          <el-option label="错误" value="error" />
        </el-select>
        <el-button @click="handleDownloadAll">下载全部 ZIP</el-button>
        <el-button @click="loadResults">刷新</el-button>
      </el-col>
    </el-row>

    <el-table :data="filteredResults" stripe style="width: 100%">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column prop="status" label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
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
          >
            下载
          </el-button>
          <span v-else style="color: #909399">无</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button
            type="warning"
            size="small"
            link
            @click="handleRetry(row.email)"
          >
            重试
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const results = ref([])
const statusFilter = ref('')

const filteredResults = computed(() => {
  if (!statusFilter.value) return results.value
  return results.value.filter((r) => r.status === statusFilter.value)
})

function statusType(status) {
  const map = {
    success: 'success',
    plus_no_rt: 'warning',
    error: 'danger',
    no_link: 'warning',
    running: '',
    idle: 'info',
  }
  return map[status] || 'info'
}

async function loadResults() {
  try {
    const { data } = await api.get('/results')
    results.value = data.results || data || []
  } catch (err) {
    console.error('Failed to load results:', err)
  }
}

onMounted(loadResults)

function handleDownload(email) {
  const token = localStorage.getItem('token')
  window.open(`/api/results/${encodeURIComponent(email)}/auth-file?token=${token}`)
}

function handleDownloadAll() {
  const token = localStorage.getItem('token')
  window.open(`/api/results/download-all?token=${token}`)
}

async function handleRetry(email) {
  try {
    const { data } = await api.post(`/results/${encodeURIComponent(email)}/retry`)
    ElMessage.success(`已加入重试队列，起始位置: ${data.startFrom ?? 0}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '重试失败')
  }
}
</script>
