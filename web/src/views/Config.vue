<template>
  <el-card>
    <template #header>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span>配置设置</span>
        <el-button type="primary" :loading="saving" @click="handleSave">保存配置</el-button>
      </div>
    </template>

    <el-form label-width="160px" style="max-width: 700px">
      <el-divider content-position="left">并发配置</el-divider>
      <el-form-item label="并发线程数">
        <el-select v-model="form.threads" style="width:120px" @change="onThreadsChange">
          <el-option :value="1" label="1 线程" />
          <el-option :value="2" label="2 线程" />
          <el-option :value="3" label="3 线程" />
          <el-option :value="4" label="4 线程" />
        </el-select>
        <span style="margin-left:12px;color:#909399;font-size:12px">每个线程需要独立的手机号和接码 API</span>
      </el-form-item>

      <el-divider content-position="left">手机号 / 接码 API（{{ form.phoneSlots.length }} 组）</el-divider>
      <div v-for="(slot, idx) in form.phoneSlots" :key="idx" style="margin-bottom:16px;padding:12px;background:#fafafa;border-radius:4px;border:1px solid #eee">
        <div style="font-weight:bold;margin-bottom:8px;color:#409EFF">线程 {{ idx + 1 }}</div>
        <el-form-item :label="`手机号 ${idx + 1}`">
          <el-input v-model="slot.phone" placeholder="手机号" />
        </el-form-item>
        <el-form-item :label="`接码 API ${idx + 1}`">
          <el-input v-model="slot.smsApiUrl" placeholder="SMS API URL" />
        </el-form-item>
      </div>

      <el-divider content-position="left">支付卡信息</el-divider>
      <el-form-item label="卡号"><el-input v-model="form.cardNumber" /></el-form-item>
      <el-form-item label="有效期"><el-input v-model="form.cardExpiry" placeholder="MM / YY" /></el-form-item>
      <el-form-item label="CVV"><el-input v-model="form.cardCvv" /></el-form-item>

      <el-divider content-position="left">Discord 配置</el-divider>
      <el-form-item label="Token"><el-input v-model="form.discordToken" show-password /></el-form-item>
      <el-form-item label="Channel ID"><el-input v-model="form.discordChannelId" /></el-form-item>
      <el-form-item label="Message ID"><el-input v-model="form.discordMessageId" /></el-form-item>
      <el-form-item label="Guild ID"><el-input v-model="form.discordGuildId" /></el-form-item>
      <el-form-item label="App ID"><el-input v-model="form.discordAppId" /></el-form-item>

      <el-divider content-position="left">CPA 配置</el-divider>
      <el-form-item label="启用 CPA OAuth"><el-switch v-model="form.enableCPA" /></el-form-item>
      <el-form-item label="CPA URL"><el-input v-model="form.cpaUrl" /></el-form-item>
      <el-form-item label="CPA 密钥"><el-input v-model="form.cpaKey" show-password /></el-form-item>

      <el-divider content-position="left">Web 管理</el-divider>
      <el-form-item label="管理密码"><el-input v-model="form.webPassword" show-password /></el-form-item>
    </el-form>
  </el-card>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const saving = ref(false)
const form = reactive({
  threads: 1,
  phoneSlots: [{ phone: '', smsApiUrl: '' }],
  cardNumber: '',
  cardExpiry: '',
  cardCvv: '',
  discordToken: '',
  discordChannelId: '',
  discordMessageId: '',
  discordGuildId: '',
  discordAppId: '',
  enableCPA: false,
  cpaUrl: '',
  cpaKey: '',
  webPassword: '',
})

function onThreadsChange(val) {
  while (form.phoneSlots.length < val) {
    form.phoneSlots.push({ phone: '', smsApiUrl: '' })
  }
  while (form.phoneSlots.length > val) {
    form.phoneSlots.pop()
  }
}

onMounted(async () => {
  try {
    const { data } = await api.get('/config/raw')
    const cfg = data.config || data
    for (const key of Object.keys(form)) {
      if (key === 'phoneSlots') {
        if (cfg.phoneSlots?.length > 0) {
          form.phoneSlots = cfg.phoneSlots
        } else if (cfg.phone) {
          form.phoneSlots = [{ phone: cfg.phone, smsApiUrl: cfg.smsApiUrl || '' }]
        }
      } else if (cfg[key] !== undefined) {
        form[key] = cfg[key]
      }
    }
    // Ensure phoneSlots matches threads count
    onThreadsChange(form.threads)
  } catch {}
})

async function handleSave() {
  saving.value = true
  try {
    // Also set phone/smsApiUrl from first slot for backward compat
    const toSave = { ...form }
    if (form.phoneSlots.length > 0) {
      toSave.phone = form.phoneSlots[0].phone
      toSave.smsApiUrl = form.phoneSlots[0].smsApiUrl
    }
    await api.put('/config', toSave)
    ElMessage.success('配置已保存')
  } catch (err) { ElMessage.error('保存失败') }
  finally { saving.value = false }
}
</script>
