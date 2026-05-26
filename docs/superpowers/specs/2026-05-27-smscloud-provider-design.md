# smscloud Phone Provider 设计

**状态**：草案，待 review
**日期**：2026-05-27
**触发**：添加 smscloud (https://smscloud.sbs) 作为第三个 SMS 提供者，沿用 zhusms provider 模式。

## 1. 背景与目标

现有手机号池支持 2 个 provider：
- **`local`** — 用户自配置的 smsApiUrl 模板（自己的接码 API）
- **`zhusms`** — zhusms.com 远程接码服务

新增 **`smscloud`** — smscloud.sbs 远程接码服务（apiKey 鉴权，纯 GET REST API，更简单）。

**启动开关**：沿用 `cfg.phonePool.enabled` (总开关) + `cfg.phonePool.provider` (选 'local'/'zhusms'/'smscloud') 模式 — 三选一互斥。

**非目标**：不实现 multi-provider chain / fallback / load-balance（YAGNI）。一次只用一个 provider。

## 2. smscloud API

**Base URL**: `https://smscloud.sbs/api/system`
**鉴权**: HTTP header `apiKey: <user_key>`
**全部 endpoint**: GET 请求，`Content-Type: application/x-www-form-urlencoded`
**响应格式**: `{ "code": 0, "message": "", "data": ... }`，`code === 0` 为成功

| Endpoint | 用途 | 参数 | 返回 `data` shape |
|----------|------|------|------|
| `/public/sms/services` | 服务列表 | 无 | `[{ code, name }]` |
| `/public/sms/countries` | 国家列表 | 无 | `[{ id, eng, chn, phoneCode }]` |
| `/public/sms/balance` | 钱包余额 | 无 | `{ balance: 128.5 }` |
| `/public/sms/getNumber` | 申请号码 | `serviceCode`, `countryCode` (query) | `{ id, phoneNumber, countryPhoneCode, creditAmount, activationTime, activationEndTime, ... }` |
| `/public/sms/orders/sync/{id}` | 主动查码 | `id` (path) | `{ id, code, text, dateTime }` 或 `null`（未到） |
| `/public/sms/orders/cancel/{id}` | 取消订单（退款） | `id` (path) | `{}` |
| `/public/sms/orders/finish/{id}` | 完成订单 | `id` (path) | `{}` |
| `/public/sms/orders/resend/{id}` | 重发短信 | `id` (path) | `{}` |
| `/public/sms/orders/replace/{id}` | 更换号码（自动取消旧+申请新） | `id` (path) | 新订单 shape 同 `getNumber` |

**号码格式**：`phoneNumber` 字段不含 `+` 前缀（如 `447700900123`），需要拼 `+` + `countryPhoneCode` 字段拿到的国家码？看 sample：`countryPhoneCode: "+44"` + `phoneNumber: "447700900123"` 显示 `phoneNumber` 已含 country code。**业务用法**：直接用 `phoneNumber` 作为 E164 号码（前面补 `+`）。

## 3. 改动清单

### 3.1 新建 `server/smscloud-provider.js`

API：

```js
async function takeOrder(apiKey, baseUrl, serviceCode, countryCode, proxyUrl)
  // GET /public/sms/getNumber?serviceCode=...&countryCode=...
  // 返回 { order_no: data.id, phone: '+' + data.phoneNumber, raw: data }
  // 失败抛 Error

async function pollOrderSms(orderNo, apiKey, baseUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {})
  // 循环 GET /public/sms/orders/sync/{orderNo}
  // 返回 sms code 字符串 (data.code) 或 null (timeout)
  // sample: { code: 0, data: { code: '123456', text: '...' } } → '123456'

async function cancelOrder(orderNo, apiKey, baseUrl, proxyUrl)
  // GET /public/sms/orders/cancel/{orderNo}

async function finishOrder(orderNo, apiKey, baseUrl, proxyUrl)
  // GET /public/sms/orders/finish/{orderNo}

async function getBalance(apiKey, baseUrl, proxyUrl)
  // GET /public/sms/balance
  // 返回 data.balance

async function listServices(apiKey, baseUrl, proxyUrl)
  // GET /public/sms/services → data: [{ code, name }]

async function listCountries(apiKey, baseUrl, proxyUrl)
  // GET /public/sms/countries → data: [{ id, eng, chn, phoneCode }]

module.exports = { takeOrder, pollOrderSms, cancelOrder, finishOrder, getBalance, listServices, listCountries };
```

**实现细节**：
- 沿用 `zhusms-provider.js` 的 `_get` helper pattern（curl_cffi 或 fetch）+ proxy 支持（`HttpsProxyAgent` if proxyUrl else 默认）
- 所有响应：`if (json.code !== 0) throw new Error(json.message || 'unknown')`
- 网络错误：throw 含 `_smscloudCode='network_error'` 让上游归 proxy_error

### 3.2 `protocol-engine.js` `_acquirePhoneForProtocol` 加分支

在 line 174-216 现有 dispatch 之间加：

```js
async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = []) {
  if (provider === 'zhusms') {
    // ... 既有
  }
  if (provider === 'smscloud') {                                       // ← 新增
    const s = cfg.phonePool.smscloud || {};
    if (!s.apiKey || !s.serviceCode || !s.countryCode) return {};
    try {
      const smscloud = require('./server/smscloud-provider');
      const order = await smscloud.takeOrder(
        s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system',
        s.serviceCode, s.countryCode, proxyUrl
      );
      if (!order) return {};
      return {
        phone: order.phone,
        smsConfig: {
          provider: 'smscloud',
          order_no: order.order_no,
          api_key: s.apiKey,
          base_url: s.baseUrl || 'https://smscloud.sbs/api/system',
        },
        releaseFn: async () => {
          try { await smscloud.cancelOrder(order.order_no, s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system', proxyUrl); } catch {}
        },
      };
    } catch (e) {
      console.log(`[protocol] smscloud takeOrder failed: ${e?.message?.slice(0, 60)}`);
      return {};
    }
  }
  // local fallback
  // ... 既有
}
```

### 3.3 `protocol_phone_verify.py poll_sms` 加分支

Python 侧拉 SMS code。现有 dispatch 在 `protocol_phone_verify.py:73+` `poll_sms(sms_cfg)`，看 `sms_cfg.provider`。

新分支：

```python
def poll_sms(sms_cfg, max_attempts=30, interval=3):
    provider = sms_cfg.get('provider', 'local')
    # ... local / zhusms 既有
    if provider == 'smscloud':
        order_no = sms_cfg.get('order_no')
        api_key = sms_cfg.get('api_key')
        base_url = sms_cfg.get('base_url', 'https://smscloud.sbs/api/system')
        if not order_no or not api_key: return None
        for _ in range(max_attempts):
            try:
                r = curl_requests.get(
                    f"{base_url}/public/sms/orders/sync/{order_no}",
                    headers={"apiKey": api_key},
                    timeout=15,
                )
                j = r.json()
                if j.get('code') == 0 and j.get('data'):
                    code = j['data'].get('code')
                    if code: return code
            except Exception:
                pass
            time.sleep(interval)
        return None
```

### 3.4 `config.json` schema

`config.example.json` 加示例：

```jsonc
{
  "phonePool": {
    "enabled": false,
    "provider": "local",                // "local" | "zhusms" | "smscloud"
    "maxBindingsPerPhone": 3,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30,
    "zhusms": {
      "cardKey": "",
      "service": "codex",
      "baseUrl": "https://zhusms.com"
    },
    "smscloud": {                       // ← 新增
      "apiKey": "",
      "baseUrl": "https://smscloud.sbs/api/system",
      "serviceCode": "",
      "countryCode": 187                // 187=US, 用户从 /countries 拉选
    }
  }
}
```

### 3.5 `web/src/views/Config.vue` UI

- **provider 选择**：el-radio-group 当前是 `local` / `zhusms`，加 `smscloud` 第三选
- **smscloud 配置 form**（仅 provider==='smscloud' 时显示）：
  - apiKey 输入（password 类型）
  - baseUrl 输入（默认 `https://smscloud.sbs/api/system`，可改）
  - serviceCode 选择（el-select，options 从 `POST /api/phone-pool/smscloud/services` 拉）
  - countryCode 选择（el-select，options 从 `POST /api/phone-pool/smscloud/countries` 拉，default 187）
  - "测试余额" 按钮：调 `POST /api/phone-pool/smscloud/balance` 显示
  - "拉服务列表" / "拉国家列表" 按钮（apiKey 填好后启用）

### 3.6 `server/routes/phone-pool.js` API

加 3 个路由：

```js
// 余额查询（Config 页"测试余额"用）
router.post('/smscloud/balance', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const s = cfg?.phonePool?.smscloud;
    if (!s?.apiKey) return res.status(400).json({ error: 'smscloud apiKey not configured' });
    const proxyUrl = process.env.HTTPS_PROXY || null;
    const smscloud = require('../smscloud-provider');
    const balance = await smscloud.getBalance(s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system', proxyUrl);
    res.json({ balance });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// 服务列表（UI 动态拉）
router.post('/smscloud/services', async (req, res) => { /* GET /public/sms/services */ });

// 国家列表（UI 动态拉）
router.post('/smscloud/countries', async (req, res) => { /* GET /public/sms/countries */ });
```

### 3.7 测试

- `server/__tests__/smscloud-provider.test.js` 新建：mock `fetch` / `curl_cffi`，覆盖 takeOrder / pollOrderSms / cancel / balance / 错误码
- `server/__tests__/phone-pool.test.js` 既有：加 1-2 case 验证 `_acquirePhoneForProtocol('smscloud', ...)` dispatch 正确
- Python `tests/test_protocol_phone_verify.py`：加 mock smscloud `/orders/sync/{id}` response 验证 `poll_sms` 返回 code

## 4. 错误处理 / 风险

| 风险 | 缓解 |
|------|------|
| apiKey 泄漏（log / commit） | server side 仅 console.log 前 8 字符 + `***`；config.json 已在 .gitignore |
| serviceCode/countryCode 配错 → takeOrder 失败 | UI 强制从 dropdown 选，禁手填错 code |
| API rate limit / 短信不来 | `pollOrderSms` 30 次 × 3s = 90s timeout，到点 cancel 退款（不靠 timeout finish） |
| Network 错误 | 沿用 zhusms 既有 retry pattern + 走 HTTPS_PROXY env |
| smscloud 暂停服务 / 涨价 | provider 互斥设计 — 用户切回 zhusms / local 即可 |

## 5. 验收标准

1. UI Config 页选 `smscloud` provider → 填 apiKey → 点"拉服务列表"显示 OpenAI/ChatGPT service code → 选 → 保存
2. 执行控制启动 → 跑 1 个账号 → 协议模式 add-phone → 实测从 smscloud 拿到号码 → Python 拉到 OTP → 验证成功
3. `POST /api/phone-pool/smscloud/balance` 返回真实钱包余额（用户测试 apiKey 时用）
4. takeOrder 失败时返回 `{}` → protocol-engine `_acquirePhoneForProtocol` 归 `phonePoolEmpty: true`（沿用既有 fallback）
5. 304+5 Node test pass (新增 ~5 smscloud unit tests)

## 6. 改动量

| 文件 | 改动 |
|------|------|
| `server/smscloud-provider.js` | 新建 ~100 行 |
| `protocol-engine.js _acquirePhoneForProtocol` | +25 行 dispatch 分支 |
| `protocol_phone_verify.py poll_sms` | +20 行 dispatch 分支 |
| `config.example.json` | +5 行 smscloud schema |
| `web/src/views/Config.vue` | +80 行 UI（radio 选项 + form + 测试按钮 + dropdown 拉服务） |
| `server/routes/phone-pool.js` | +30 行 3 个路由 |
| `server/__tests__/smscloud-provider.test.js` | +60 行 mock 单测 |
| `docs/CHANGELOG.md` | v2.44.0 章节 |
| **总计** | **~320 行净增**（不计 spec/plan 文档） |
