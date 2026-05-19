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
      <el-form-item label="卡号">
        <el-input v-model="form.cardNumber" placeholder="请输入卡号" />
      </el-form-item>
      <el-form-item label="有效期">
        <el-input v-model="form.cardExpiry" placeholder="MM/YY" />
      </el-form-item>
      <el-form-item label="CVV">
        <el-input v-model="form.cardCvv" placeholder="CVV" />
      </el-form-item>

      <el-divider content-position="left">Discord 配置</el-divider>
      <el-form-item label="Discord Token">
        <el-input v-model="form.discordToken" type="password" show-password />
      </el-form-item>
      <el-form-item label="Channel ID">
        <el-input v-model="form.channelId" />
      </el-form-item>
      <el-form-item label="Message ID">
        <el-input v-model="form.messageId" />
      </el-form-item>
      <el-form-item label="Guild ID">
        <el-input v-model="form.guildId" />
      </el-form-item>
      <el-form-item label="App ID">
        <el-input v-model="form.appId" />
      </el-form-item>

      <el-divider content-position="left">CPA 配置</el-divider>
      <el-form-item label="启用 CPA">
        <el-switch v-model="form.enableCPA" />
      </el-form-item>
      <el-form-item label="CPA URL">
        <el-input v-model="form.cpaUrl" placeholder="请输入 CPA 回调地址" />
      </el-form-item>
      <el-form-item label="CPA Key">
        <el-input v-model="form.cpaKey" type="password" show-password />
      </el-form-item>
      <el-form-item label="Web 密码">
        <el-input v-model="form.webPassword" type="password" show-password />
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

const form = reactive({
  phone: '',
  smsApiUrl: '',
  cardNumber: '',
  cardExpiry: '',
  cardCvv: '',
  discordToken: '',
  channelId: '',
  messageId: '',
  guildId: '',
  appId: '',
  enableCPA: false,
  cpaUrl: '',
  cpaKey: '',
  webPassword: '',
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
  } catch (err) {
    console.error('Failed to load config:', err)
  }
})

async function handleSave() {
  saving.value = true
  try {
    await api.put('/config', { ...form })
    ElMessage.success('配置已保存')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>
