# SMS Provider 动态服务/国家选择设计

> 状态：待用户确认（2026-05-30）
> 范围：给 smsbower、herosms、nexsms 三个 SMS provider 加服务列表和国家列表的动态查询，与 smscloud 已有的体验一致。

## 1. 目标

Config 页号池 tab 中，选择 smsbower/herosms/nexsms 时，serviceCode 和 countryCode 不再手动输入，改为：
- "拉服务列表"按钮 → 下拉选择
- "拉国家列表"按钮 → 下拉选择
- 与现有 smscloud 的动态选择体验一致

## 2. 各平台 API

### 2.1 SmsBower (`smsbower.page`)

| 端点 | URL | 响应 |
|------|-----|------|
| 服务列表 | `GET /stubs/handler_api.php?api_key={key}&action=getServicesList` | `{status:"success", services:[{code,name}]}` |
| 国家列表 | `GET /stubs/handler_api.php?api_key={key}&action=getCountries` | `[{id, eng, chn, rus}]` |

### 2.2 HeroSMS (`hero-sms.com`)

与 SmsBower 同一套 SMS-Activate 兼容 API：

| 端点 | URL | 响应 |
|------|-----|------|
| 服务列表 | `GET /stubs/handler_api.php?api_key={key}&action=getServicesList` | `{status:"success", services:[{code,name}]}` |
| 国家列表 | `GET /stubs/handler_api.php?api_key={key}&action=getCountries` | `[{id, eng, chn, rus}]` |

### 2.3 NexSMS (`api.nexsms.net`)

| 端点 | URL | 响应 |
|------|-----|------|
| 服务列表 | `GET /api/services?apiKey={key}` | `{code:0, data:[{code,name}]}` |
| 国家列表 | `GET /api/countries?apiKey={key}` | `{code:0, data:[{id,name}]}` |

## 3. 后端路由

在 `server/routes/phone-pool.js` 新增 6 个路由（每个 provider 2 个）：

```
POST /api/phone-pool/smsbower/services   → 代理调 SmsBower getServicesList
POST /api/phone-pool/smsbower/countries  → 代理调 SmsBower getCountries
POST /api/phone-pool/herosms/services    → 代理调 HeroSMS getServicesList
POST /api/phone-pool/herosms/countries   → 代理调 HeroSMS getCountries
POST /api/phone-pool/nexsms/services     → 代理调 NexSMS /api/services
POST /api/phone-pool/nexsms/countries    → 代理调 NexSMS /api/countries
```

请求 body 统一格式：`{ apiKey: "..." }`

SmsBower 和 HeroSMS 共用同一个请求逻辑（handler_api.php 格式），只是 baseUrl 不同：
- SmsBower: `https://smsbower.page/stubs/handler_api.php`
- HeroSMS: `https://hero-sms.com/stubs/handler_api.php`

NexSMS 用独立格式（REST API，apiKey 作 query param）。

响应统一归一化为：
```json
{
  "services": [{ "code": "ni", "name": "GoPay/Gojek" }],
  "countries": [{ "id": 6, "name": "Indonesia" }]
}
```

## 4. 前端 Config.vue 改造

### 4.1 smsbower/herosms 表单

serviceCode 和 countryCode 从手动输入改为下拉 + 拉取按钮（与 smscloud 一致）：

```html
<el-form-item label="服务">
  <el-select v-model="form.phonePool.smsbower.serviceCode" filterable clearable style="width:240px">
    <el-option v-for="s in smsbowerServices" :key="s.code" :label="`${s.name} (${s.code})`" :value="s.code" />
  </el-select>
  <el-button size="small" @click="fetchSmsbowerServices">拉服务列表</el-button>
</el-form-item>
<el-form-item label="国家">
  <el-select v-model="form.phonePool.smsbower.countryCode" filterable clearable style="width:240px">
    <el-option v-for="c in smsbowerCountries" :key="c.id" :label="`${c.name} (id=${c.id})`" :value="c.id" />
  </el-select>
  <el-button size="small" @click="fetchSmsbowerCountries">拉国家列表</el-button>
</el-form-item>
```

herosms 同理（用 `herosmsServices`/`herosmsCountries`）。

### 4.2 nexsms 表单

同样模式，但字段名是 `countryId`（不是 `countryCode`）：

```html
<el-select v-model="form.phonePool.nexsms.countryId" ...>
```

### 4.3 JS 数据

新增 reactive 数组：
```javascript
const smsbowerServices = ref([])
const smsbowerCountries = ref([])
const herosmsServices = ref([])
const herosmsCountries = ref([])
const nexsmsServices = ref([])
const nexsmsCountries = ref([])
```

fetch 函数模式与现有 `fetchSmscloudServices` 一致：
```javascript
async function fetchSmsbowerServices() {
  const { data } = await api.post('/phone-pool/smsbower/services', {
    apiKey: form.phonePool.smsbower.apiKey,
  })
  smsbowerServices.value = data.services || []
}
```

## 5. 不改

- `gopay/app/src/opai/core/` 的 Python SMS provider 代码（构造函数参数不变）
- `gopay_activate.py` 的配置读取逻辑
- smscloud 现有的动态选择功能
- 号池的其他 provider（local、zhusms、oapi）

## 6. 文件清单

| 文件 | 改动 |
|------|------|
| `server/routes/phone-pool.js` | 新增 6 个 POST 路由 |
| `web/src/views/Config.vue` | smsbower/herosms/nexsms 表单改为下拉选择 + 拉取按钮 |
