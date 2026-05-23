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
      <el-divider content-position="left">JP-Checkout 通道</el-divider>
      <el-form-item label="启用 JP 通道">
        <el-switch v-model="form.proxyJpEnabled" />
        <span style="color:#909399;margin-left:8px;font-size:12px">checkout API 走日本住宅 IP（7891）</span>
      </el-form-item>
      <el-form-item label="JP 节点关键字">
        <el-input v-model="form.proxyJpKeyword" placeholder="KDDI" style="width:220px"
                  :disabled="form.proxyJpWhitelist?.length > 0" />
        <span v-if="form.proxyJpWhitelist?.length > 0"
              style="color:#909399;margin-left:8px;font-size:12px">已被白名单覆盖</span>
      </el-form-item>
      <el-form-item label="JP 节点白名单">
        <el-select v-model="form.proxyJpWhitelist" multiple filterable clearable
                   collapse-tags collapse-tags-tooltip
                   placeholder="留空 = 按关键字过滤；选中 = 精确指定节点"
                   style="width: 480px">
          <el-option v-for="tag in allNodeTags" :key="tag" :label="tag" :value="tag">
            <span :style="jpKddiTagSet.has(tag) ? 'font-weight:600;color:#67c23a' : ''">
              {{ tag }}
            </span>
            <span v-if="jpKddiTagSet.has(tag)" style="float:right;color:#67c23a;font-size:11px">KDDI</span>
          </el-option>
        </el-select>
        <div style="font-size:12px;color:#909399;margin-top:4px">
          含 KDDI 的节点已绿色高亮。空 = 关键字过滤模式（默认）。
        </div>
      </el-form-item>
      <el-form-item label="JP 通道状态" v-if="proxyStatus?.jp">
        <div style="font-size:12px;color:#606266">
          <div>状态：{{ proxyStatus.jp.enabled ? '运行中' : '未启用' }}
               ({{ proxyStatus.jp.available || 0 }} 节点<span
                  v-if="proxyStatus.jp.whitelist?.length"> / 白名单 {{ proxyStatus.jp.whitelist.length }} 个</span>)</div>
          <div v-if="proxyStatus.jp.currentNode">当前节点：{{ proxyStatus.jp.currentNode }}</div>
          <div v-if="proxyStatus.jp.exitIp">JP 出口 IP：{{ proxyStatus.jp.exitIp }}</div>
          <div v-if="proxyStatus.jp.whitelistMisses?.length"
               style="color:#e6a23c;margin-top:4px">
            ⚠ 白名单未命中：{{ proxyStatus.jp.whitelistMisses.slice(0,3).join(', ') }}{{
              proxyStatus.jp.whitelistMisses.length > 3 ? `... 共 ${proxyStatus.jp.whitelistMisses.length} 个` : ''
            }}
          </div>
          <div v-if="proxyStatus.jp.lastError" style="color:#f56c6c">{{ proxyStatus.jp.lastError }}</div>
          <div style="margin-top:6px">
            <el-button size="small" @click="detectJpExit">检测 JP 出口 IP</el-button>
            <el-button size="small" @click="rotateJp">切换 JP 节点</el-button>
          </div>
        </div>
      </el-form-item>
      <el-divider content-position="left">节点黑名单</el-divider>
      <el-form-item label="主代理黑名单">
        <div style="width: 700px">
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
            <span style="font-size:12px; color:#909399">
              共 {{ blacklist.main.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
            </span>
            <el-button size="small" :disabled="!blacklist.main.length" @click="clearChannel('main')">
              清空主代理黑名单
            </el-button>
            <el-button size="small" @click="loadBlacklist">刷新</el-button>
          </div>
          <el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
            <el-table-column prop="tag" label="节点" min-width="220" show-overflow-tooltip />
            <el-table-column label="剩余时间" width="110">
              <template #default="{ row }">{{ formatTtl(row.ttlRemainingMs) }}</template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'manual' ? 'warning' : 'info'">
                  {{ row.source === 'manual' ? '手动' : '自动' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="removeNode(row.tag, 'main')">
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form-item>
      <el-form-item label="JP 通道黑名单">
        <div style="width: 700px">
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
            <span style="font-size:12px; color:#909399">
              共 {{ blacklist.jp.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
            </span>
            <el-button size="small" :disabled="!blacklist.jp.length" @click="clearChannel('jp')">
              清空 JP 黑名单
            </el-button>
            <el-button size="small" @click="loadBlacklist">刷新</el-button>
          </div>
          <el-table :data="blacklist.jp" size="small" empty-text="（无）" max-height="260">
            <el-table-column prop="tag" label="节点" min-width="220" show-overflow-tooltip />
            <el-table-column label="剩余时间" width="110">
              <template #default="{ row }">{{ formatTtl(row.ttlRemainingMs) }}</template>
            </el-table-column>
            <el-table-column label="来源" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.source === 'manual' ? 'warning' : 'info'">
                  {{ row.source === 'manual' ? '手动' : '自动' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="removeNode(row.tag, 'jp')">
                  移除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
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
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const formRef = ref(null)
const saving = ref(false)
const refreshingProxy = ref(false)
const proxyStatus = ref(null)
const allNodeTags = ref([])
const jpKddiTagSet = ref(new Set())

const FAIL_THRESHOLD = 3
const blacklist = ref({ main: [], jp: [] })
let blacklistTimer = null

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
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
  proxyJpWhitelist: [],
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
      if (cfg.proxy.jpCheckout) {
        if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
        if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
        if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist
      }
    }
  } catch (err) {
    console.error('Failed to load config:', err)
  }
  await loadProxyStatus()
  await loadAllNodes()
  await loadBlacklist()
  blacklistTimer = setInterval(loadBlacklist, 10000)
})

async function loadProxyStatus() {
  try {
    const { data } = await api.get('/proxy/status')
    proxyStatus.value = data
  } catch (err) {
    proxyStatus.value = null
  }
}

async function loadAllNodes() {
  try {
    const { data } = await api.get('/proxy/nodes')
    allNodeTags.value = data.nodeTags || []
    jpKddiTagSet.value = new Set(data.jpKddiTags || [])
  } catch {
    allNodeTags.value = []
    jpKddiTagSet.value = new Set()
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
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
    delete payload.proxyJpWhitelist
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      rotationStrategy: form.proxyRotationStrategy,
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
        whitelist: form.proxyJpWhitelist || [],
      },
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
    await loadAllNodes()
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

async function detectJpExit() {
  try {
    const { data } = await api.post('/proxy/jp/detect-exit')
    ElMessage.success(`JP 出口 IP: ${data.exitIp || '未知'}`)
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'JP 检测失败')
  }
}

async function rotateJp() {
  try {
    const { data } = await api.post('/proxy/jp/rotate')
    ElMessage.success(`已切换到: ${data.currentNode}`)
    await loadProxyStatus()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '切换失败')
  }
}

async function loadBlacklist() {
  try {
    const { data } = await api.get('/proxy/blacklist')
    blacklist.value = data
  } catch {
    blacklist.value = { main: [], jp: [] }
  }
}

async function removeNode(tag, channel) {
  try {
    const { data } = await api.post('/proxy/blacklist/remove', { tag, channel })
    blacklist.value = data
    ElMessage.success(`已移除 ${tag}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '移除失败')
  }
}

async function clearChannel(channel) {
  try {
    await ElMessageBox.confirm(
      `确认清空${channel === 'main' ? '主代理' : 'JP 通道'}黑名单？`,
      '确认操作',
      { type: 'warning' },
    )
  } catch { return }
  try {
    const { data } = await api.post('/proxy/blacklist/clear', { channel })
    blacklist.value = data
    ElMessage.success('已清空')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '清空失败')
  }
}

function formatTtl(ms) {
  if (ms <= 0) return '已过期'
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

onBeforeUnmount(() => {
  if (blacklistTimer) clearInterval(blacklistTimer)
})
</script>
