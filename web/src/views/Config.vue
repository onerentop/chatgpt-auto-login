<template>
  <div class="app-stack--lg">
    <PageHeader title="配置设置" subtitle="7 个分类 · 改动后点右侧保存才会写入 config.json">
      <template #actions>
        <el-tag v-if="isDirty" type="warning" size="small">未保存</el-tag>
        <el-button type="primary" :loading="saving" data-hotkey="submit" @click="handleSave">保存配置</el-button>
      </template>
    </PageHeader>

    <SectionCard flush>
    <el-tabs v-model="activeTab" tab-position="left" class="cfg-tabs">
      <el-tab-pane label="支付" name="payment">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
          <el-form-item label="手机号">
            <el-input v-model="form.phone" placeholder="请输入手机号" />
          </el-form-item>
          <el-form-item label="短信 API URL">
            <el-input v-model="form.smsApiUrl" placeholder="请输入短信接口地址" />
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="号池" name="phone-pool">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
          <el-divider content-position="left">号池</el-divider>
          <el-form-item label="启用号池">
            <el-switch v-model="form.phonePool.enabled" />
            <span style="margin-left:8px;color:#909399;font-size:12px">PKCE 撞手机验证时从池里取号（Phase 2 接通）</span>
          </el-form-item>
          <el-form-item label="每号最大绑定数">
            <el-input-number v-model="form.phonePool.maxBindingsPerPhone" :min="1" :max="100" />
          </el-form-item>
          <el-form-item label="SMS 轮询间隔 (ms)">
            <el-input-number v-model="form.phonePool.smsPollIntervalMs" :min="500" :max="60000" :step="500" />
          </el-form-item>
          <el-form-item label="SMS 最多尝试次数">
            <el-input-number v-model="form.phonePool.smsMaxAttempts" :min="1" :max="100" />
          </el-form-item>

          <el-form-item label="Provider">
            <el-radio-group v-model="form.phonePool.provider">
              <el-radio value="local">本地号池（v2.37）</el-radio>
              <el-radio value="zhusms">zhusms 卡密</el-radio>
              <el-radio value="smscloud">smscloud</el-radio>
              <el-radio value="oapi">oapi (CDK 池)</el-radio>
            </el-radio-group>
          </el-form-item>

          <template v-if="form.phonePool.provider === 'zhusms'">
            <el-form-item label="zhusms 卡密">
              <el-input v-model="form.phonePool.zhusms.cardKey" placeholder="ZS-XXXXXXXX" />
            </el-form-item>
            <el-form-item label="Service">
              <el-input v-model="form.phonePool.zhusms.service" placeholder="codex" />
            </el-form-item>
            <el-form-item label="Base URL">
              <el-input v-model="form.phonePool.zhusms.baseUrl" placeholder="https://zhusms.com" />
            </el-form-item>
            <el-form-item label="余额测试">
              <el-button @click="testZhusmsBalance" :loading="testingZhusms">查询余额</el-button>
              <span style="margin-left:8px;color:#909399">{{ zhusmsBalance || '点按钮测试' }}</span>
            </el-form-item>
          </template>

          <!-- v2.44.0: smscloud 配置 -->
          <template v-if="form.phonePool.provider === 'smscloud'">
            <el-form-item label="apiKey">
              <el-input v-model="form.phonePool.smscloud.apiKey" type="password" show-password placeholder="smscloud.sbs apiKey" style="width: 360px" />
            </el-form-item>
            <el-form-item label="baseUrl">
              <el-input v-model="form.phonePool.smscloud.baseUrl" placeholder="https://smscloud.sbs/api/system" style="width: 360px" />
            </el-form-item>
            <el-form-item label="服务">
              <el-select v-model="form.phonePool.smscloud.serviceCode" placeholder="先拉服务列表" filterable clearable style="width: 240px">
                <el-option v-for="s in smscloudServices" :key="s.code" :label="`${s.name} (${s.code})`" :value="s.code" />
              </el-select>
              <el-button size="small" :loading="loadingSmscloudServices" @click="fetchSmscloudServices" style="margin-left: 8px">拉服务列表</el-button>
            </el-form-item>
            <el-form-item label="国家">
              <el-select v-model="form.phonePool.smscloud.countryCode" placeholder="选 1+ 国家（按顺序作为 retry fallback）" filterable multiple clearable style="width: 360px">
                <el-option v-for="c in smscloudCountries" :key="c.id" :label="`${c.chn}${c.eng ? ' / ' + c.eng : ''} (id=${c.id})${c.retailPrice != null ? ' · ¥' + c.retailPrice + ' / ' + c.count + '号' : ''}`" :value="c.id" />
              </el-select>
              <el-button size="small" :loading="loadingSmscloudCountries" @click="fetchSmscloudCountries" style="margin-left: 8px">拉国家列表</el-button>
            </el-form-item>
            <el-form-item label="余额测试">
              <el-button :loading="testingSmscloudBalance" @click="testSmscloudBalance">查询余额</el-button>
              <span v-if="smscloudBalance !== null" style="margin-left: 12px; color: var(--el-color-success); font-weight: 600">余额: {{ smscloudBalance }}</span>
              <span v-else style="margin-left:8px;color:#909399">点按钮测试（先保存 apiKey）</span>
            </el-form-item>
          </template>

          <!-- v2.50.0: oapi CDK 池配置 -->
          <template v-if="form.phonePool.provider === 'oapi'">
            <el-form-item label="oapi baseUrl">
              <el-input v-model="form.phonePool.oapi.baseUrl" placeholder="https://sms.oapi.vip/api.php" style="width: 360px" />
            </el-form-item>
            <el-form-item label="CDK 池">
              <div style="width: 600px">
                <el-input v-model="oapiCdkBulkText" type="textarea" :rows="4" placeholder="每行一个 CDK，例：SMS-XXXX-XXXX-XXXX" />
                <div style="margin-top: 8px">
                  <el-button type="primary" size="small" @click="importOapiCdks">导入 CDK</el-button>
                  <el-button size="small" @click="loadOapiCdks">刷新列表</el-button>
                </div>
              </div>
            </el-form-item>
            <el-form-item label="">
              <el-table :data="oapiCdks" stripe size="small" max-height="320" style="width: 600px">
                <el-table-column label="CDK" width="160">
                  <template #default="{ row }">
                    <code style="font-size: 12px">{{ row.cdk.slice(0, 8) }}…{{ row.cdk.slice(-4) }}</code>
                  </template>
                </el-table-column>
                <el-table-column prop="phone" label="phone" width="130" />
                <el-table-column label="状态" width="80">
                  <template #default="{ row }">
                    <el-tag :type="row.status === 'available' ? 'success' : 'danger'" size="small">{{ row.status }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="bindings_used" label="已绑" width="60" />
                <el-table-column prop="remaining" label="剩余" width="60" />
                <el-table-column label="操作" width="70">
                  <template #default="{ row }">
                    <el-button size="small" text type="danger" @click="deleteOapiCdk(row.cdk)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-form-item>
          </template>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="执行" name="execute">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
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
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="Discord" name="discord">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
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
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="OAuth / CPA" name="oauth">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
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
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="代理" name="proxy">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
          <el-form-item label="启用代理">
            <el-switch v-model="form.proxyEnabled" />
            <span style="color:#909399;margin-left:8px;font-size:12px">每个账户切换一次出口节点</span>
          </el-form-item>
          <el-form-item label="机场订阅 URL">
            <el-input v-model="form.proxySubscriptionUrl" placeholder="https://.../subscribe?token=..." />
          </el-form-item>
          <el-form-item label="节点白名单">
            <el-select v-model="form.proxyWhitelist" multiple filterable clearable
                       collapse-tags collapse-tags-tooltip
                       placeholder="留空 = 按区域关键字过滤；选中 = 精确指定节点"
                       style="width: 480px">
              <el-option v-for="tag in allNodeTags" :key="tag" :label="tag" :value="tag">
                <span :style="usTagSet.has(tag) ? 'font-weight:600;color:#67c23a' : ''">
                  {{ tag }}
                </span>
                <span v-if="usTagSet.has(tag)" style="float:right;color:#67c23a;font-size:11px">US</span>
              </el-option>
            </el-select>
            <div style="font-size:12px;color:#909399;margin-top:4px">
              匹配 regionFilter 的节点已绿色高亮。空 = 关键字过滤模式（默认）。
            </div>
          </el-form-item>
          <el-form-item label="区域过滤">
            <el-input v-model="form.proxyRegionFilter" placeholder="留空=不过滤；US=仅美国"
                      :disabled="form.proxyWhitelist?.length > 0" />
            <span v-if="form.proxyWhitelist?.length > 0"
                  style="color:#909399;margin-left:8px;font-size:12px">已被白名单覆盖</span>
          </el-form-item>
          <el-form-item label="">
            <el-button :loading="refreshingProxy" @click="refreshProxy">应用并启动代理</el-button>
            <el-button @click="stopProxy">停止代理</el-button>
            <el-button @click="detectExit">检测出口 IP</el-button>
          </el-form-item>
          <div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0 0 160px">
            代理实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
          </div>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="JP 通道" name="jp">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
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
          <div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0 0 160px">
            JP 通道实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
          </div>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="节点黑名单" name="blacklist">
        <div style="margin-bottom: 24px">
          <div style="font-weight:600;margin-bottom:8px">主代理黑名单</div>
          <div style="width: 760px">
            <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
              <span style="font-size:12px; color:#909399">
                共 {{ blacklist.main.length }} 个节点 · 业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期
              </span>
              <el-button size="small" :disabled="!blacklist.main.length" @click="clearChannel('main')">
                清空主代理黑名单
              </el-button>
              <el-button size="small" @click="loadBlacklist">刷新</el-button>
            </div>
            <el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
              <el-table-column label="节点" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ row.node || row.tag }}</template>
              </el-table-column>
              <el-table-column label="原因" width="160">
                <template #default="{ row }">
                  <el-tag :type="reasonTagType(row.reason)" size="small">{{ reasonLabel(row.reason) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="解禁时间" width="120">
                <template #default="{ row }">
                  <span v-if="row.bannedUntil">{{ formatRemaining(row.bannedUntil) }}</span>
                  <span v-else-if="row.ttlRemainingMs > 0">{{ formatTtl(row.ttlRemainingMs) }}</span>
                  <span v-else style="color:#909399">已过期</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80">
                <template #default="{ row }">
                  <el-button size="small" link type="primary" @click="unbanOne(row.node || row.tag, 'main')">
                    解禁
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:8px">JP 通道黑名单</div>
          <div style="width: 760px">
            <div style="display:flex; gap:8px; margin-bottom:8px; align-items:center">
              <span style="font-size:12px; color:#909399">
                共 {{ blacklist.jp.length }} 个节点 · 业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期
              </span>
              <el-button size="small" :disabled="!blacklist.jp.length" @click="clearChannel('jp')">
                清空 JP 黑名单
              </el-button>
              <el-button size="small" @click="loadBlacklist">刷新</el-button>
            </div>
            <el-table :data="blacklist.jp" size="small" empty-text="（无）" max-height="260">
              <el-table-column label="节点" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ row.node || row.tag }}</template>
              </el-table-column>
              <el-table-column label="原因" width="160">
                <template #default="{ row }">
                  <el-tag :type="reasonTagType(row.reason)" size="small">{{ reasonLabel(row.reason) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="解禁时间" width="120">
                <template #default="{ row }">
                  <span v-if="row.bannedUntil">{{ formatRemaining(row.bannedUntil) }}</span>
                  <span v-else-if="row.ttlRemainingMs > 0">{{ formatTtl(row.ttlRemainingMs) }}</span>
                  <span v-else style="color:#909399">已过期</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="80">
                <template #default="{ row }">
                  <el-button size="small" link type="primary" @click="unbanOne(row.node || row.tag, 'jp')">
                    解禁
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
    </SectionCard>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import PageHeader from '../components/ui/PageHeader.vue'
import SectionCard from '../components/ui/SectionCard.vue'

const formRef = ref(null)
const saving = ref(false)
const refreshingProxy = ref(false)
const testingZhusms = ref(false)
const zhusmsBalance = ref('')
// v2.44.0 smscloud 动态数据
const smscloudServices = ref([])
const smscloudCountries = ref([])
const smscloudBalance = ref(null)
const loadingSmscloudServices = ref(false)
const loadingSmscloudCountries = ref(false)
const testingSmscloudBalance = ref(false)
const allNodeTags = ref([])
const jpKddiTagSet = ref(new Set())
const usTagSet = ref(new Set())
const activeTab = ref('payment')

const blacklist = ref({ main: [], jp: [] })
let blacklistTimer = null

// FX-6: dirty form guard. We can't watch immediately because onMounted will
// load real values into `form` and that would mark the form dirty before
// the user has touched anything. `loaded` becomes true at the end of
// onMounted's loader so the watcher only starts counting changes after.
const isDirty = ref(false)
const loaded = ref(false)

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
  proxyWhitelist: [],
  proxyJpEnabled: true,
  proxyJpKeyword: 'KDDI',
  proxyJpWhitelist: [],
  phonePool: { enabled: false, maxBindingsPerPhone: 5, smsPollIntervalMs: 3000, smsMaxAttempts: 30, provider: 'local', zhusms: { cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' }, smscloud: { apiKey: '', baseUrl: 'https://smscloud.sbs/api/system', serviceCode: '', countryCode: [187] }, oapi: { baseUrl: 'https://sms.oapi.vip/api.php' } },
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
      if (Array.isArray(cfg.proxy.whitelist)) form.proxyWhitelist = cfg.proxy.whitelist
      if (cfg.proxy.jpCheckout) {
        if (cfg.proxy.jpCheckout.enabled !== undefined) form.proxyJpEnabled = cfg.proxy.jpCheckout.enabled
        if (cfg.proxy.jpCheckout.keyword !== undefined) form.proxyJpKeyword = cfg.proxy.jpCheckout.keyword
        if (Array.isArray(cfg.proxy.jpCheckout.whitelist)) form.proxyJpWhitelist = cfg.proxy.jpCheckout.whitelist
      }
    }
    if (cfg.phonePool) {
      form.phonePool = {
        enabled: cfg.phonePool.enabled ?? false,
        maxBindingsPerPhone: cfg.phonePool.maxBindingsPerPhone ?? 5,
        smsPollIntervalMs: cfg.phonePool.smsPollIntervalMs ?? 3000,
        smsMaxAttempts: cfg.phonePool.smsMaxAttempts ?? 30,
        provider: cfg.phonePool.provider || 'local',
        zhusms: cfg.phonePool.zhusms
          ? { ...{ cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' }, ...cfg.phonePool.zhusms }
          : { cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' },
        // v2.44.0: smscloud provider 默认 baseUrl + countryCode=187 (US)
        smscloud: cfg.phonePool.smscloud
          ? { ...{ apiKey: '', baseUrl: 'https://smscloud.sbs/api/system', serviceCode: '', countryCode: [187] }, ...cfg.phonePool.smscloud }
          : { apiKey: '', baseUrl: 'https://smscloud.sbs/api/system', serviceCode: '', countryCode: [187] },
        // v2.50.0: oapi provider 默认 baseUrl
        oapi: cfg.phonePool.oapi
          ? { ...{ baseUrl: 'https://sms.oapi.vip/api.php' }, ...cfg.phonePool.oapi }
          : { baseUrl: 'https://sms.oapi.vip/api.php' },
      }
    } else {
      form.phonePool = {
        enabled: false,
        maxBindingsPerPhone: 5,
        smsPollIntervalMs: 3000,
        smsMaxAttempts: 30,
        provider: 'local',
        zhusms: { cardKey: '', service: 'codex', baseUrl: 'https://zhusms.com' },
        smscloud: { apiKey: '', baseUrl: 'https://smscloud.sbs/api/system', serviceCode: '', countryCode: [187] },
        oapi: { baseUrl: 'https://sms.oapi.vip/api.php' },
      }
    }
    // v2.47: 旧 number countryCode 归一为 [number] 兼容 multi-select
    if (form.phonePool.smscloud.countryCode != null && !Array.isArray(form.phonePool.smscloud.countryCode)) {
      form.phonePool.smscloud.countryCode = [form.phonePool.smscloud.countryCode]
    }
  } catch (err) {
    console.error('Failed to load config:', err)
  }
  await loadAllNodes()
  await loadBlacklist()
  startBlacklistPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('beforeunload', onBeforeUnload)
  // Defer turning on dirty-tracking until next tick so the form-restoration
  // mutations above don't trip the watcher.
  loaded.value = true
})

watch(
  () => JSON.stringify(form),
  () => { if (loaded.value) isDirty.value = true },
)

function onBeforeUnload(e) {
  if (isDirty.value) {
    // Modern browsers ignore returnValue text but require it to be set.
    e.preventDefault()
    e.returnValue = ''
  }
}

onBeforeRouteLeave(async (to, from) => {
  if (!isDirty.value) return true
  try {
    await ElMessageBox.confirm(
      '有未保存的更改，确定要离开？离开后改动会丢失。',
      '未保存的更改',
      { type: 'warning', confirmButtonText: '丢弃并离开', cancelButtonText: '继续编辑' },
    )
    return true
  } catch {
    return false
  }
})

// FX-14: pause blacklist polling when the tab is hidden so we don't burn
// network on background tabs.
function startBlacklistPolling() {
  if (blacklistTimer) return
  blacklistTimer = setInterval(loadBlacklist, 10000)
}
function stopBlacklistPolling() {
  if (blacklistTimer) { clearInterval(blacklistTimer); blacklistTimer = null }
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    stopBlacklistPolling()
  } else {
    loadBlacklist()
    startBlacklistPolling()
  }
}

async function loadAllNodes() {
  try {
    const { data } = await api.get('/proxy/nodes')
    allNodeTags.value = data.nodeTags || []
    jpKddiTagSet.value = new Set(data.jpKddiTags || [])
    usTagSet.value = new Set(data.usTags || [])
  } catch {
    allNodeTags.value = []
    jpKddiTagSet.value = new Set()
    usTagSet.value = new Set()
  }
}

async function handleSave() {
  saving.value = true
  try {
    const payload = { ...form }
    delete payload.proxyEnabled
    delete payload.proxySubscriptionUrl
    delete payload.proxyRegionFilter
    delete payload.proxyWhitelist
    delete payload.proxyJpEnabled
    delete payload.proxyJpKeyword
    delete payload.proxyJpWhitelist
    payload.proxy = {
      enabled: form.proxyEnabled,
      subscriptionUrl: form.proxySubscriptionUrl,
      regionFilter: form.proxyRegionFilter,
      whitelist: form.proxyWhitelist || [],
      jpCheckout: {
        enabled: form.proxyJpEnabled,
        keyword: form.proxyJpKeyword,
        whitelist: form.proxyJpWhitelist || [],
      },
    }
    await api.put('/config', payload)
    isDirty.value = false
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
    await loadAllNodes()
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '启动失败')
  } finally {
    refreshingProxy.value = false
  }
}

async function stopProxy() {
  try {
    await ElMessageBox.confirm(
      '停止代理将断开当前所有 execute / liveness 流水线的网络。确认停止？',
      '确认停止代理',
      { type: 'warning', confirmButtonText: '停止', cancelButtonText: '取消' },
    )
  } catch { return }
  try {
    await api.post('/proxy/stop')
    ElMessage.success('代理已停止')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '停止失败')
  }
}

async function detectExit() {
  try {
    const { data } = await api.post('/proxy/detect-exit')
    ElMessage.success(`出口 IP: ${data.exitIp || '未知'}`)
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '检测失败')
  }
}

// v2.42.1: 直接保留后端 superset 字段（node / reason / bannedUntil / addedAt + 老的
// tag / ttlRemainingMs / source），表格列按需取值；做 防御性兜底以兼容字符串数组形态。
function normalizeBlacklist(data) {
  const norm = (arr) => (Array.isArray(arr) ? arr : []).map((item) => {
    if (typeof item === 'string') return { node: item, tag: item, reason: 'custom', bannedUntil: null }
    return {
      node: item.node || item.tag || '',
      reason: item.reason || 'custom',
      bannedUntil: item.bannedUntil || null,
      addedAt: item.addedAt || null,
      // 保留 v2.30 兼容字段，formatTtl fallback 用
      tag: item.tag || item.node || '',
      ttlRemainingMs: typeof item.ttlRemainingMs === 'number' ? item.ttlRemainingMs : 0,
      source: item.source || 'auto',
    }
  })
  return { main: norm(data?.main), jp: norm(data?.jp) }
}

async function loadBlacklist() {
  try {
    const { data } = await api.get('/proxy/blacklist')
    blacklist.value = normalizeBlacklist(data)
  } catch (err) {
    // Polling: keep last successful state to avoid table flicker on transient errors.
    // Only log in dev so silent failures are still diagnosable.
    if (import.meta.env.DEV) console.warn('[blacklist] poll failed:', err?.message)
  }
}

// v2.42.1 Task 3: 批量解禁 → 调 POST /proxy/clear-blacklist (后端 listBanned + unbanNode 逐条)，
// 而不是旧 /proxy/blacklist/clear（后者仅清 manual 内存映射，碰不到 DB 持久层）。
async function clearChannel(channel) {
  const nodes = blacklist.value[channel] || []
  if (nodes.length === 0) return
  try {
    await ElMessageBox.confirm(
      `确定清空 ${channel === 'main' ? '主代理' : 'JP'} 黑名单 ${nodes.length} 个节点？`,
      '批量解禁',
      { type: 'warning' },
    )
  } catch { return }
  try {
    const { data } = await api.post('/proxy/clear-blacklist', { channel })
    await loadBlacklist()
    ElMessage?.success(`已清空 ${data.cleared} 个节点`)
  } catch (err) {
    ElMessage?.error(`清空失败: ${err?.response?.data?.error || err.message}`)
  }
}

// v2.42.1 Task 3: 单个解禁 → POST /proxy/unban-node。
async function unbanOne(node, channel = 'main') {
  if (!node) return
  try {
    await api.post('/proxy/unban-node', { node, channel })
    await loadBlacklist()
    const display = node.length > 40 ? node.slice(0, 40) + '...' : node
    ElMessage?.success(`已解禁 ${display}`)
  } catch (err) {
    ElMessage?.error(`解禁失败: ${err?.response?.data?.error || err.message}`)
  }
}

// v2.42.1 Task 3: reason → tag color。与 server/proxy/bad-node.js classifyReason 对齐。
function reasonTagType(reason) {
  if (reason === 'cloudflare_403') return 'danger'
  if (reason === 'rate_limited') return 'warning'
  if (reason === 'captcha' || reason === 'openai_403') return 'danger'
  return 'info'
}
function reasonLabel(reason) {
  const map = {
    'cloudflare_403': 'Cloudflare 风控',
    'rate_limited': '速率限制',
    'connection_reset': '连接重置',
    'connection_upload_closed': '连接关闭',
    'openai_403': 'OpenAI 403',
    'captcha': '验证码',
    'custom': '手动',
  }
  return map[reason] || reason || '未知'
}
// v2.42.1 Task 3: 用 ISO bannedUntil 算剩余时间。
function formatRemaining(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const remainSec = Math.max(0, Math.round((t - Date.now()) / 1000))
  if (remainSec === 0) return '已过期'
  if (remainSec < 60) return `${remainSec}s 后`
  if (remainSec < 3600) return `${Math.round(remainSec / 60)}min 后`
  return new Date(t).toLocaleTimeString()
}

// 兼容 v2.30 旧 schema（ttlRemainingMs）。新 row 使用 formatRemaining(row.bannedUntil)。
function formatTtl(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '已过期'
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}

async function testZhusmsBalance() {
  testingZhusms.value = true
  zhusmsBalance.value = ''
  try {
    const { data } = await api.post('/phone-pool/zhusms/balance', {})
    zhusmsBalance.value = JSON.stringify(data.balance)
    ElMessage.success('余额查询成功')
  } catch (e) {
    zhusmsBalance.value = `错误: ${e?.response?.data?.error || e?.message || '未知'}`
    ElMessage.error(zhusmsBalance.value)
  } finally {
    testingZhusms.value = false
  }
}

// v2.44.0: smscloud 动态拉服务 / 国家 / 余额
async function fetchSmscloudServices() {
  loadingSmscloudServices.value = true
  try {
    const { data } = await api.post('/phone-pool/smscloud/services', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
    })
    smscloudServices.value = data.services || []
    ElMessage.success(`拉到 ${smscloudServices.value.length} 个服务`)
  } catch (e) {
    ElMessage.error(`拉服务失败: ${e?.response?.data?.error || e?.message || '未知'}`)
  } finally {
    loadingSmscloudServices.value = false
  }
}

async function fetchSmscloudCountries() {
  loadingSmscloudCountries.value = true
  try {
    const { data } = await api.post('/phone-pool/smscloud/countries', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
    })
    smscloudCountries.value = data.countries || []
    ElMessage.success(`拉到 ${smscloudCountries.value.length} 个国家`)
  } catch (e) {
    ElMessage.error(`拉国家失败: ${e?.response?.data?.error || e?.message || '未知'}`)
  } finally {
    loadingSmscloudCountries.value = false
  }
}

async function testSmscloudBalance() {
  testingSmscloudBalance.value = true
  try {
    // balance 路由直接从 config 读取，需先保存 apiKey
    const { data } = await api.post('/phone-pool/smscloud/balance', {})
    smscloudBalance.value = data.balance
    ElMessage.success(`余额: ${data.balance}`)
  } catch (e) {
    ElMessage.error(`测试余额失败: ${e?.response?.data?.error || e?.message || '未知'}`)
  } finally {
    testingSmscloudBalance.value = false
  }
}

// v2.46.0: serviceCode 变化时自动拉 inventory，merge 价格 + 库存到 smscloudCountries
async function fetchInventory(serviceCode) {
  try {
    const { data } = await api.post('/phone-pool/smscloud/inventory', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
      serviceCode,
    })
    const inv = data.inventory || []
    const byId = new Map(inv.map(i => [i.country, i]))
    const existingIds = new Set(smscloudCountries.value.map(c => c.id))
    const merged = smscloudCountries.value.map(row => {
      const m = byId.get(row.id)
      return m ? { ...row, retailPrice: m.retailPrice, count: m.count }
               : { ...row, retailPrice: null, count: null }
    })
    for (const i of inv) {
      if (!existingIds.has(i.country)) {
        merged.push({ id: i.country, chn: i.countryName, eng: '', phoneCode: '', retailPrice: i.retailPrice, count: i.count })
      }
    }
    smscloudCountries.value = merged
    ElMessage.success(`已加载 ${inv.length} 个有库存国家的价格`)
  } catch (e) {
    console.warn('[smscloud inventory] fetch failed:', e)
    ElMessage.warning('价格拉取失败：' + (e?.response?.data?.error || e.message))
  }
}

let _inventoryTimer = null
watch(() => form.phonePool.smscloud.serviceCode, (newCode) => {
  if (_inventoryTimer) clearTimeout(_inventoryTimer)
  if (!newCode || !form.phonePool.smscloud.apiKey) return
  _inventoryTimer = setTimeout(() => fetchInventory(newCode), 300)
}, { immediate: true })

// v2.50.0 oapi CDK 池
const oapiCdkBulkText = ref('')
const oapiCdks = ref([])

async function loadOapiCdks() {
  try {
    const { data } = await api.get('/phone-pool/oapi/list')
    oapiCdks.value = data.items || []
  } catch (e) { ElMessage.error('加载失败：' + e.message) }
}

async function importOapiCdks() {
  if (!oapiCdkBulkText.value.trim()) return ElMessage.warning('粘贴 CDK 后再导入')
  try {
    const { data } = await api.post('/phone-pool/oapi/import', { text: oapiCdkBulkText.value })
    ElMessage.success(`导入 ${data.added} 个，跳过 ${data.skipped} 个`)
    oapiCdkBulkText.value = ''
    await loadOapiCdks()
  } catch (e) { ElMessage.error('导入失败：' + (e?.response?.data?.error || e.message)) }
}

async function deleteOapiCdk(cdk) {
  try {
    await api.delete('/phone-pool/oapi/' + encodeURIComponent(cdk))
    await loadOapiCdks()
  } catch (e) { ElMessage.error('删除失败：' + e.message) }
}

watch(() => form.phonePool.provider, (v) => {
  if (v === 'oapi') loadOapiCdks()
}, { immediate: true })

onBeforeUnmount(() => {
  stopBlacklistPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<style scoped>
/* Left-rail tabs — give the tab labels real width on the left so 7 tabs
 * don't get cramped, while the right panel uses full remaining width. */
.cfg-tabs {
  min-height: 520px;
}
.cfg-tabs :deep(.el-tabs__header.is-left) {
  margin-right: 0;
  border-right: 1px solid var(--app-border-soft);
  background: var(--app-surface-2);
}
.cfg-tabs :deep(.el-tabs__nav.is-left) {
  padding: var(--sp-2) 0;
}
.cfg-tabs :deep(.el-tabs__item.is-left) {
  height: 40px;
  line-height: 40px;
  padding: 0 var(--sp-4);
  text-align: left;
  color: var(--app-text-2);
  transition: color var(--tr-fast), background var(--tr-fast);
}
.cfg-tabs :deep(.el-tabs__item.is-left:hover) {
  background: var(--app-surface);
  color: var(--app-text);
}
.cfg-tabs :deep(.el-tabs__item.is-active) {
  color: var(--app-brand);
  background: var(--app-surface);
}
.cfg-tabs :deep(.el-tabs__content) {
  padding: var(--sp-4) var(--sp-5);
}
</style>
