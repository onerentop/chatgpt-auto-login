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
          <el-option label="Plus(有RT)" value="plus" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="无链接" value="no_link" />
          <el-option label="错误" value="error" />
          <el-option label="JP节点不可用" value="no_jp_proxy" />
          <el-option label="无0元资格" value="no_promo" />
          <el-option label="Stripe验证失败" value="verify_error" />
          <el-option label="Stripe计费失败" value="stripe_billing_error" />
          <el-option label="订阅激活超时" value="activation_error" />
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
import { statusType } from '../status'

const results = ref([])
const statusFilter = ref('')

const filteredResults = computed(() => {
  if (!statusFilter.value) return results.value
  return results.value.filter((r) => r.status === statusFilter.value)
})


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
