<template>
  <div class="app-stack--lg">
    <PageHeader title="GoPay 激活" subtitle="印尼区 GoPay 支付激活 ChatGPT Plus" />

    <!-- Toolbar -->
    <SectionCard flush>
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap">
        <el-input v-model="accessToken" placeholder="ChatGPT Access Token" style="flex:1;min-width:300px" />
        <el-button type="primary" :loading="running" :disabled="running || !accessToken" @click="startActivation">
          开始激活
        </el-button>
        <el-button type="danger" :disabled="!running" @click="stopActivation">停止</el-button>
        <el-button @click="refreshStatus">刷新状态</el-button>
      </div>
    </SectionCard>

    <!-- Status -->
    <SectionCard title="引擎状态">
      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="状态">
          <el-tag :type="running ? '' : 'info'" size="small">{{ running ? '运行中' : '空闲' }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="阶段">
          <el-tag type="warning" size="small">{{ phaseLabel }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="当前账号">{{ status.currentAccount || '-' }}</el-descriptions-item>
      </el-descriptions>
    </SectionCard>

    <!-- Log -->
    <SectionCard title="实时日志">
      <div ref="logBox" class="gopay-log-box">
        <div v-for="(line, i) in logs" :key="i" class="gopay-log-line">{{ line }}</div>
        <div v-if="logs.length === 0" style="color:#999">暂无日志</div>
      </div>
    </SectionCard>

    <!-- Results -->
    <SectionCard title="结果" v-if="results.length > 0">
      <el-table :data="results" stripe size="small" max-height="300">
        <el-table-column prop="email" label="邮箱" min-width="200" />
        <el-table-column prop="status" label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="resultType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="phone" label="GoPay手机号" width="160" />
        <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
        <el-table-column prop="timestamp" label="时间" width="180" />
      </el-table>
    </SectionCard>

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
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import api from '../api'
import { socketState } from '../socket'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const accessToken = ref('')
const status = ref({ running: false, phase: 'idle', currentAccount: null, results: [], logCount: 0 })
const logs = computed(() => socketState.gopayLogs)
const results = computed(() => socketState.gopayResults)
const config = ref(null)
const logBox = ref(null)

const running = computed(() => status.value.running)
const PHASE_LABELS = {
  idle: '空闲',
  plan_check: 'Plan检查',
  stripe_checkout: 'Stripe结账',
  gopay_activate: 'GoPay注册+支付',
  verify_plus: '验证Plus',
}
const phaseLabel = computed(() => PHASE_LABELS[status.value.phase] || status.value.phase)

let pollTimer = null

function resultType(s) {
  if (s === 'success' || s === 'plus_gopay') return 'success'
  if (s === 'gopay_fraud') return 'danger'
  if (s?.includes('fail')) return 'danger'
  return 'warning'
}

async function startActivation() {
  try {
    socketState.gopayLogs.splice(0)
    socketState.gopayResults.splice(0)
    await api.post('/gopay-activate/start', {
      email: 'manual',
      accessToken: accessToken.value,
      planType: 'free',
    })
    startPolling()
  } catch (e) {
    logs.value.push(`Error: ${e.response?.data?.error || e.message}`)
  }
}

async function stopActivation() {
  try {
    await api.post('/gopay-activate/stop')
  } catch {}
}

async function refreshStatus() {
  try {
    const { data } = await api.get('/gopay-activate/status')
    status.value = data
    results.value = data.results || []
  } catch {}
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    await refreshStatus()
    if (!status.value.running) stopPolling()
  }, 2000)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
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
    logs.value.push('配置已保存')
  } catch (e) {
    logs.value.push(`保存失败: ${e.message}`)
  }
}

watch(logs, () => {
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
  })
}, { deep: true })

onMounted(() => {
  refreshStatus()
  loadConfig()
})
onUnmounted(() => stopPolling())
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
