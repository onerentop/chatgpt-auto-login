<template>
  <div class="app-stack--lg">
    <PageHeader title="GoPay 激活" subtitle="印尼区 GoPay 支付激活 ChatGPT Plus（自动协议登录）" />

    <SectionCard flush>
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap">
        <el-button type="primary" :loading="running" :disabled="running || selectedEmails.length === 0" @click="activate">
          激活选中 ({{ selectedEmails.length }})
        </el-button>
        <el-button type="danger" :disabled="!running" @click="stopActivation">停止</el-button>
        <el-button @click="loadAccounts">刷新列表</el-button>
        <span style="color:#909399;font-size:12px">登录注册走纯协议；与主执行控制(PayPal)互斥</span>
      </div>
    </SectionCard>

    <SectionCard title="账号列表" flush>
      <el-table :data="accounts" stripe size="small" max-height="460" @selection-change="onSelectionChange" row-key="email">
        <el-table-column type="selection" width="44" />
        <el-table-column prop="email" label="邮箱" min-width="220" />
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="statusType(rowStatus(row.email))" size="small">{{ statusLabel(rowStatus(row.email)) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="步骤" width="100" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openStepsDrawer(row.email)">查看步骤</el-button>
          </template>
        </el-table-column>
      </el-table>
    </SectionCard>

    <!-- Log -->
    <SectionCard title="实时日志">
      <div ref="logBox" class="gopay-log-box">
        <div v-for="(line, i) in logs" :key="i" class="gopay-log-line">{{ line }}</div>
        <div v-if="logs.length === 0" style="color:#999">暂无日志</div>
      </div>
    </SectionCard>

    <!-- AccountStepDrawer — gopay pipeline real-time step visualization -->
    <AccountStepDrawer
      v-model="stepsDrawerOpen"
      :email="drawerEmail"
      :live="true"
      mode="gopay"
    />

    <!-- GoPay Config -->
    <SectionCard title="GoPay 配置">
      <el-button size="small" style="margin-bottom:12px" @click="loadConfig">加载配置</el-button>
      <el-button size="small" style="margin-bottom:12px" @click="saveConfig">保存配置</el-button>
      <div v-if="config">
        <el-form label-width="140px" size="small">
          <el-form-item label="SMS Provider">
            <el-select v-model="config.sms.provider" style="width:180px">
              <el-option label="SmsBower" value="smsbower" />
              <el-option label="SmsCloud" value="smscloud" />
              <el-option label="HeroSms" value="herosms" />
              <el-option label="NexSms" value="nexsms" />
            </el-select>
          </el-form-item>
          <el-form-item label="SMS API Key">
            <el-input v-model="config.sms.api_key" style="width:300px" />
          </el-form-item>
          <el-form-item label="印尼代理">
            <el-input v-model="config.gopay.register_proxy" placeholder="http://user:pass@host:port" style="width:400px" />
          </el-form-item>
        </el-form>
      </div>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { socketState } from '../socket'
import { statusType, statusLabel } from '../status'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'
import AccountStepDrawer from '../components/AccountStepDrawer.vue'

const accounts = ref([])
const selectedEmails = ref([])
const logBox = ref(null)
const stepsDrawerOpen = ref(false)
const drawerEmail = ref('')
const config = ref(null)

const logs = computed(() => socketState.gopayLogs)
const running = computed(() =>
  Object.values(socketState.accountStatuses || {}).some(s => s.status === 'running')
)

function rowStatus(email) {
  return socketState.accountStatuses?.[email]?.status || 'idle'
}
function onSelectionChange(rows) {
  selectedEmails.value = rows.map(r => r.email)
}
function openStepsDrawer(email) {
  drawerEmail.value = email || ''
  stepsDrawerOpen.value = true
}

async function loadAccounts() {
  try {
    const { data } = await api.get('/accounts')
    accounts.value = data.map(a => ({ email: a.email }))
  } catch (e) { ElMessage.error(e.response?.data?.error || '加载账号失败') }
}

async function activate() {
  try {
    await api.post('/gopay-activate/start', { emails: selectedEmails.value })
    ElMessage.success('已开始激活')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '激活失败')
  }
}

async function stopActivation() {
  try {
    await api.post('/gopay-activate/stop')
    ElMessage.info('正在停止…')
  } catch (e) { ElMessage.error(e.response?.data?.error || '停止失败') }
}

async function loadConfig() {
  try {
    const { data } = await api.get('/gopay-activate/config')
    config.value = {
      sms: { provider: 'smsbower', api_key: '', ...data.sms },
      gopay: { register_proxy: '', ...data.gopay },
    }
  } catch (e) {
    config.value = { sms: { provider: 'smsbower', api_key: '' }, gopay: { register_proxy: '' } }
  }
}

async function saveConfig() {
  if (!config.value) return
  try {
    await api.post('/gopay-activate/config', config.value)
    socketState.gopayLogs.push('配置已保存')
  } catch (e) {
    socketState.gopayLogs.push(`保存失败: ${e.message}`)
  }
}

watch(logs, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
}, { deep: true })

onMounted(() => {
  loadAccounts()
  loadConfig()
})
</script>

<style scoped>
.gopay-log-box {
  background: var(--el-bg-color-page, #f5f7fa);
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
  border-radius: 6px;
  padding: 12px;
  max-height: 400px;
  overflow-y: auto;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.6;
}
.gopay-log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
