<template>
  <el-card>
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span>配置设置</span>
        <el-button type="primary" :loading="saving" @click="handleSave">保存配置</el-button>
      </div>
    </template>

    <el-form
      ref="formRef"
      :model="form"
      label-width="160px"
      style="max-width: 600px"
    >
      <el-divider content-position="left">支付配置</el-divider>
      <el-form-item label="手机号">
        <el-input v-model="form.phone" placeholder="请输入手机号" />
      </el-form-item>
      <el-form-item label="短信 API URL">
        <el-input v-model="form.smsApiUrl" placeholder="请输入短信接口地址" />
      </el-form-item>
      <el-divider content-position="left">执行模式</el-divider>
      <el-form-item label="协议注册模式">
        <el-switch v-model="form.protocolMode" />
        <span style="color:#909399;margin-left:8px;font-size:12px">开启后使用协议注册（仅支付时开浏览器）</span>
      </el-form-item>
      <el-form-item label="支付链接来源">
        <el-select v-model="form.paymentLinkSource" style="width: 220px">
          <el-option label="ChatGPT API（推荐）" value="api" />
          <el-option label="Discord 机器人（后备）" value="discord" />
        </el-select>
        <span style="color:#909399;margin-left:8px;font-size:12px">API 直调，需 JP 节点；Discord 走 WebSocket Bot</span>
      </el-form-item>

      <el-divider content-position="left">Discord 配置</el-divider>
      <el-form-item label="Discord Token">
        <el-input v-model="form.discordToken" type="password" show-password />
      </el-form-item>
      <el-form-item label="Channel ID">
        <el-input v-model="form.discordChannelId" />
      </el-form-item>
      <el-form-item label="Message ID">
        <el-input v-model="form.discordMessageId" />
      </el-form-item>
      <el-form-item label="Guild ID">
        <el-input v-model="form.discordGuildId" />
      </el-form-item>
      <el-form-item label="App ID">
        <el-input v-model="form.discordAppId" />
      </el-form-item>

      <el-divider content-position="left">OAuth / CPA 配置</el-divider>
      <el-form-item label="启用 OAuth (PKCE)">
        <el-switch v-model="form.enableOAuth" />
        <span style="color:#909399;margin-left:8px;font-size:12px">开启后支付完走 PKCE 获取 refresh_token</span>
      </el-form-item>
      <el-form-item label="启用 CPA">
        <el-switch v-model="form.enableCPA" />
      </el-form-item>
      <el-form-item label="CPA URL">
        <el-input v-model="form.cpaUrl" placeholder="请输入 CPA 回调地址" />
      </el-form-item>
      <el-form-item label="CPA Key">
        <el-input v-model="form.cpaKey" type="password" show-password />
      </el-form-item>

      <el-divider content-position="left">代理 / 节点轮换</el-divider>
      <el-form-item label="启用代理">
        <el-switch v-model="form.proxyEnabled" />
        <span style="color:#909399;margin-left:8px;font-size:12px">每个账户切换一次出口节点</span>
      </el-form-item>
      <el-form-item label="机场订阅 URL">
        <el-input v-model="form.proxySubscriptionUrl" placeholder="https://.../subscribe?token=..." />
      </el-form-item>
      <el-form-item label="区域过滤">
        <el-input v-model="form.proxyRegionFilter" placeholder="留空=不过滤；US=仅美国" />
      </el-form-item>
      <el-form-item label="轮换策略">
        <el-radio-group v-model="form.proxyRotationStrategy">
          <el-radio value="sequential">顺序</el-radio>
          <el-radio value="random">随机</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="">
        <el-button :loading="refreshingProxy" @click="refreshProxy">应用并启动代理</el-button>
        <el-button @click="stopProxy">停止代理</el-button>
        <el-button @click="detectExit">检测出口 IP</el-button>
      </el-form-item>
      <el-form-item label="代理状态" v-if="proxyStatus">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.enabled ? '运行中' : '未运行' }} ({{ proxyStatus.nodeTags?.length || 0 }} 节点)</div>
          <div v-if="proxyStatus.currentNode">当前节点：{{ proxyStatus.currentNode }}</div>
          <div v-if="proxyStatus.exitIp">出口 IP：{{ proxyStatus.exitIp }}</div>
          <div v-if="proxyStatus.lastError" style="color:#f56c6c">错误：{{ proxyStatus.lastError }}</div>
        </div>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const formRef = ref(null)
const saving = ref(false)
const refreshingProxy = ref(false)
const proxyStatus = ref(null)

const form = reactive({
  protocolMode: false,
  paymentLinkSource: 'api',
  enableOAuth: false,
  phone: '',
  smsApiUrl: '',
  discordToken: '',
  discordChannelId: '',
  discordMessageId: '',
  discordGuildId: '',
  discordAppId: '',
  enableCPA: false,
  cpaUrl: '',
  cpaKey: '',
  proxyEnabled: false,
  proxySubscriptionUrl: '',
  proxyRegionFilter: 'US',
  proxyRotationStrategy: 'sequential',
})

onMounted(async () => {
  try {
    const { data } = await api.get('/config/raw')
    const cfg = data.config || data
    Object.keys(form).forEach((key) => {
      if (cfg[key] !== undefined) {
        form[key] = cfg[key]
      }
    })
    // Map proxy.{} nested config to flat form fields
    if (cfg.proxy) {
      if (cfg.proxy.enabled !== undefined) form.proxyEnabled = cfg.proxy.enabled
      if (cfg.proxy.subscriptionUrl !== undefined) form.proxySubscriptionUrl = cfg.proxy.subscriptionUrl
      if (cfg.proxy.regionFilter !== undefined) form.proxyRegionFilter = cfg.proxy.regionFilter
      if (cfg.proxy.rotationStrategy !== undefined) form.proxyRotationStrategy = cfg.proxy.rotationStrategy
    }
  } catch (err) {
    console.error('Failed to load config:', err)
  }
  loadProxyStatus()
})

async function loadProxyStatus() {
  try {
    const { data } = await api.get('/proxy/status')
    proxyStatus.value = data
  } catch (err) {
    proxyStatus.value = null
  }
}

async function handleSave() {
  saving.value = true
  try {
    const payload = { ...form }
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyRotationStrategy
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
    }
    await api.put('/config', payload)
    ElMessage.success('配置已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function refreshProxy() {
  refreshingProxy.value = true
  try {
    await handleSave()
    await api.post('/proxy/refresh')
    ElMessage.success('代理已启动')
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '启动失败')
  } finally {
    refreshingProxy.value = false
  }
}

async function stopProxy() {
  try {
    await api.post('/proxy/stop')
    ElMessage.success('代理已停止')
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '停止失败')
  }
}

async function detectExit() {
  try {
    const { data } = await api.post('/proxy/detect-exit')
    ElMessage.success(`出口 IP: ${data.exitIp || '未知'}`)
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '检测失败')
  }
}
</script>
