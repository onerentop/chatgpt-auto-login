# smscloud Phone Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加 smscloud (https://smscloud.sbs) 作为第三个手机号 SMS provider，沿用 zhusms provider 模式（`phonePool.provider="smscloud"` 互斥启用）。Config UI 动态拉服务/国家列表让用户选码。

**Architecture:** (1) `server/smscloud-provider.js` 提供 6 个 API 包装函数 (2) `protocol-engine.js _acquirePhoneForProtocol` 加 smscloud dispatch 分支 (3) `protocol_phone_verify.py poll_sms` 加 smscloud 分支 (4) `server/routes/phone-pool.js` 加 3 个 REST 路由让 Config UI 拉数据 (5) Config.vue UI 加 provider radio + smscloud 配置 form。

**Tech Stack:** Node fetch via global undici dispatcher (HTTPS_PROXY env 自动走 sing-box), Python curl_cffi 同样走 HTTPS_PROXY env。所有 endpoint GET + `apiKey` HTTP header。Vue 3 Composition + Element Plus el-select。

参考 spec: `docs/superpowers/specs/2026-05-27-smscloud-provider-design.md`

---

## File Structure

**新建：**

- `server/smscloud-provider.js` — 6 个 API 包装函数 (takeOrder / pollOrderSms / cancelOrder / finishOrder / getBalance / listServices / listCountries)
- `server/__tests__/smscloud-provider.test.js` — mock fetch 单测
- `docs/superpowers/specs/2026-05-27-smscloud-provider-design.md` (已存在)

**修改：**

- `protocol-engine.js` — `_acquirePhoneForProtocol` 加 `if (provider === 'smscloud')` 分支（约 line 175 之后）
- `protocol_phone_verify.py` — `poll_sms` 加 `if provider == 'smscloud'` 分支（约 line 75 之后）
- `server/routes/phone-pool.js` — 加 `POST /smscloud/balance` / `/services` / `/countries` 三路由（在既有 `/zhusms/balance` 之后）
- `web/src/views/Config.vue` — provider radio 加 smscloud 选项 + smscloud 配置 form
- `config.example.json` — `phonePool.smscloud: { apiKey, baseUrl, serviceCode, countryCode }` schema
- `docs/CHANGELOG.md` — v2.44.0 章节

**不动：**

- `server/zhusms-provider.js` (smscloud 是平行 provider，不动既有)
- `server/phone-pool.js` (local pool 不动)
- `_pkce_common.py` (Python 公共)

---

## Task 1: 新建 `server/smscloud-provider.js`

**Files:**
- Create: `server/smscloud-provider.js`
- Create: `server/__tests__/smscloud-provider.test.js`

- [ ] **Step 1: 写 smscloud-provider.js**

```js
// v2.44.0 — smscloud 远程接码 provider (smscloud.sbs)
// API: https://smscloud.sbs/docx/ — HTTP header apiKey + GET REST
// 鉴权: header `apiKey: <key>`
// 响应: { code, message, data } — code === 0 success
//
// 跟 zhusms-provider.js 不同点:
//   - 无 session/cookie，纯 apiKey + GET
//   - 全 endpoint GET（不是 POST form）
//   - id 字段是 string（zhusms 也 string），但 base URL 是 /api/system 前缀

const DEFAULT_BASE_URL = 'https://smscloud.sbs/api/system';

async function _get(url, apiKey) {
  // fetch 走全局 undici dispatcher (HTTPS_PROXY env 自动经 sing-box)
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      'apiKey': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e._smscloudCode = 'network_error';
    throw e;
  }
  const j = await r.json();
  if (j.code !== 0) {
    const e = new Error(j.message || `code=${j.code}`);
    e._smscloudCode = String(j.code);
    throw e;
  }
  return j.data;
}

async function takeOrder(apiKey, baseUrl, serviceCode, countryCode) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/public/sms/getNumber?serviceCode=${encodeURIComponent(serviceCode)}&countryCode=${encodeURIComponent(countryCode)}`;
  const data = await _get(url, apiKey);
  // 标准化为 zhusms takeOrder 兼容 shape: { order_no, phone, raw }
  return {
    order_no: String(data.id),
    phone: '+' + String(data.phoneNumber).replace(/^\+/, ''),
    raw: data,
  };
}

async function pollOrderSms(orderNo, apiKey, baseUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const data = await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/sync/${orderNo}`, apiKey);
      if (data && data.code) return String(data.code);
    } catch (e) {
      // 静默 retry — 短信未到不算错误，code=未到 时 _get 会抛但 retry
      if (e._smscloudCode === 'network_error') {
        // 网络错也继续 retry (不阻塞业务)
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return null;
}

async function cancelOrder(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/cancel/${orderNo}`, apiKey);
}

async function finishOrder(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/finish/${orderNo}`, apiKey);
}

async function getBalance(apiKey, baseUrl) {
  const data = await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/balance`, apiKey);
  return data?.balance;
}

async function listServices(apiKey, baseUrl) {
  return await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/services`, apiKey);
}

async function listCountries(apiKey, baseUrl) {
  return await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/countries`, apiKey);
}

module.exports = {
  takeOrder, pollOrderSms, cancelOrder, finishOrder, getBalance,
  listServices, listCountries,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,  // test 用
};
```

- [ ] **Step 2: 写 smscloud-provider.test.js**

```js
const test = require('node:test');
const assert = require('node:assert');

function mockFetch(handler) {
  const orig = global.fetch;
  global.fetch = async (url, opts) => handler(url, opts);
  return () => { global.fetch = orig; };
}

test('takeOrder: 成功返回 { order_no, phone }', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/getNumber?serviceCode=tg&countryCode=187'));
    return {
      ok: true,
      json: async () => ({ code: 0, data: { id: '2046386613387407360', phoneNumber: '15551234567', countryPhoneCode: '+1' } }),
    };
  });
  try {
    const smscloud = require('../smscloud-provider');
    const order = await smscloud.takeOrder('test-key', null, 'tg', '187');
    assert.strictEqual(order.order_no, '2046386613387407360');
    assert.strictEqual(order.phone, '+15551234567');
  } finally { restore(); }
});

test('takeOrder: code !== 0 抛错并带 _smscloudCode', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1001, message: 'service not available' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await assert.rejects(
      smscloud.takeOrder('key', null, 'tg', '187'),
      (e) => e.message.includes('service not available') && e._smscloudCode === '1001'
    );
  } finally { restore(); }
});

test('pollOrderSms: data.code 拿到验证码', async () => {
  let calls = 0;
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/orders/sync/order-123'));
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ code: 0, data: null }) };  // 第 1 次未到
    return { ok: true, json: async () => ({ code: 0, data: { code: '654321' } }) };
  });
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const code = await smscloud.pollOrderSms('order-123', 'key', null, { pollIntervalMs: 10, maxAttempts: 5 });
    assert.strictEqual(code, '654321');
    assert.ok(calls >= 2);
  } finally { restore(); }
});

test('pollOrderSms: maxAttempts 全过返回 null', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: null }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const code = await smscloud.pollOrderSms('o1', 'key', null, { pollIntervalMs: 10, maxAttempts: 3 });
    assert.strictEqual(code, null);
  } finally { restore(); }
});

test('getBalance: 返回 data.balance 数值', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: { balance: 128.5 } }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const bal = await smscloud.getBalance('key', null);
    assert.strictEqual(bal, 128.5);
  } finally { restore(); }
});

test('listServices: 返回服务数组', async () => {
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ code: 0, data: [{ code: 'tg', name: 'Telegram' }, { code: 'ai', name: 'OpenAI' }] }) }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const services = await smscloud.listServices('key', null);
    assert.strictEqual(services.length, 2);
    assert.strictEqual(services[0].code, 'tg');
  } finally { restore(); }
});
```

- [ ] **Step 3: 跑测试**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
node --test server/__tests__/smscloud-provider.test.js
```

Expected: 6 pass。

- [ ] **Step 4: 跑全套 npm test 不 regress**

```bash
npm test
```

Expected: 304 + 6 = 310 pass。

- [ ] **Step 5: Commit**

```bash
git add server/smscloud-provider.js server/__tests__/smscloud-provider.test.js
git commit -m "feat(phone-pool): smscloud provider — API 包装 + 单测 (v2.44.0 Task 1)

API base https://smscloud.sbs/api/system，HTTP header apiKey 鉴权。
6 个函数: takeOrder / pollOrderSms / cancelOrder / finishOrder /
getBalance / listServices / listCountries。

takeOrder shape 兼容 zhusms ({ order_no, phone, raw })。
fetch 走全局 undici dispatcher (HTTPS_PROXY env 自动经 sing-box)。

6 新单测 pass，npm test 310 pass。"
```

---

## Task 2: `protocol-engine.js` 加 smscloud dispatch

**Files:**
- Modify: `protocol-engine.js`

- [ ] **Step 1: 找 `_acquirePhoneForProtocol` 函数**

Read `protocol-engine.js` 找到 line 174 `async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = []) {` 函数。

- [ ] **Step 2: 在 `if (provider === 'zhusms')` 块之后、`// local` 之前插入 smscloud 分支**

```js
  if (provider === 'smscloud') {
    const s = cfg.phonePool.smscloud || {};
    if (!s.apiKey || !s.serviceCode || !s.countryCode) {
      console.log(`[protocol] smscloud config incomplete (apiKey/serviceCode/countryCode 任一为空)`);
      return {};
    }
    try {
      const smscloud = require('./server/smscloud-provider');
      const order = await smscloud.takeOrder(
        s.apiKey,
        s.baseUrl || 'https://smscloud.sbs/api/system',
        s.serviceCode,
        s.countryCode,
      );
      if (!order || !order.phone) return {};
      return {
        phone: order.phone,
        smsConfig: {
          provider: 'smscloud',
          order_no: order.order_no,
          api_key: s.apiKey,
          base_url: s.baseUrl || 'https://smscloud.sbs/api/system',
        },
        releaseFn: async () => {
          try {
            await smscloud.cancelOrder(order.order_no, s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system');
          } catch (e) {
            console.log(`[protocol] smscloud cancelOrder failed: ${e?.message?.slice(0, 60)}`);
          }
        },
      };
    } catch (e) {
      console.log(`[protocol] smscloud takeOrder failed: ${e?.message?.slice(0, 60)} (code=${e?._smscloudCode || 'n/a'})`);
      return {};
    }
  }
```

**位置**：插在 line 206 `}` 之后 (zhusms 块结尾)、line 207 `// local` 之前。

- [ ] **Step 3: 跑测试**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
node -c protocol-engine.js
npm test
```

Expected: 310 pass。

- [ ] **Step 4: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol-engine): _acquirePhoneForProtocol 加 smscloud 分支 (v2.44.0 Task 2)

dispatch chain: zhusms / smscloud / local 三选一互斥。
smscloud 分支调 takeOrder({apiKey, baseUrl, serviceCode, countryCode})
返回 {phone, smsConfig: {provider:'smscloud', order_no, api_key, base_url},
releaseFn: async => cancelOrder}.

apiKey/serviceCode/countryCode 任一缺失返 {} 让上游 fallback to phonePoolEmpty。
takeOrder 异常 log _smscloudCode 便于诊断。"
```

---

## Task 3: `protocol_phone_verify.py` `poll_sms` 加 smscloud 分支

**Files:**
- Modify: `protocol_phone_verify.py`

- [ ] **Step 1: 找 `poll_sms` 函数**

Read `protocol_phone_verify.py` 找 `def poll_sms(sms_cfg, ...)` (约 line 73)。

- [ ] **Step 2: 加 smscloud 分支**

在既有 `if provider == 'zhusms':` 块之后、`# local fallback` 之前插入：

```python
    if provider == 'smscloud':
        order_no = sms_cfg.get('order_no')
        api_key = sms_cfg.get('api_key')
        base_url = sms_cfg.get('base_url', 'https://smscloud.sbs/api/system')
        if not order_no or not api_key:
            _log('smscloud poll: missing order_no or api_key')
            return None
        from curl_cffi import requests as curl_requests
        for attempt in range(max_attempts):
            try:
                r = curl_requests.get(
                    f"{base_url}/public/sms/orders/sync/{order_no}",
                    headers={"apiKey": api_key, "Accept": "application/json"},
                    timeout=15,
                )
                j = r.json()
                if j.get('code') == 0 and j.get('data'):
                    code = j['data'].get('code')
                    if code:
                        _log(f"smscloud OTP received: {code}")
                        return str(code)
            except Exception as e:
                if attempt == 0:
                    _log(f"smscloud poll error: {str(e)[:60]}")
            time.sleep(interval)
        return None
```

**注意**：`_log` 函数 + `time.sleep` 应已在该文件 import / 既有。

- [ ] **Step 3: 校验**

```bash
py -3 -c "import protocol_phone_verify; print('import ok')"
npm run test:py
```

Expected: import ok + 17 pass (3 skip)。

- [ ] **Step 4: Commit**

```bash
git add protocol_phone_verify.py
git commit -m "feat(protocol): poll_sms 加 smscloud 分支 (v2.44.0 Task 3)

curl_cffi GET /public/sms/orders/sync/{id} with apiKey header。
data.code 拿到验证码就 return。
30 次 × 3s = 90s timeout。"
```

---

## Task 4: `server/routes/phone-pool.js` 加 3 路由

**Files:**
- Modify: `server/routes/phone-pool.js`

- [ ] **Step 1: 加 `POST /smscloud/balance`、`/services`、`/countries` 三路由**

在既有 `POST /zhusms/balance` 路由之后追加：

```js
// v2.44.0: smscloud 余额查询（Config 页"测试余额"按钮调）
router.post('/smscloud/balance', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const s = cfg?.phonePool?.smscloud;
    if (!s?.apiKey) return res.status(400).json({ error: 'smscloud apiKey not configured' });
    const smscloud = require('../smscloud-provider');
    const balance = await smscloud.getBalance(s.apiKey, s.baseUrl || 'https://smscloud.sbs/api/system');
    res.json({ balance });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

// v2.44.0: smscloud 服务列表（Config UI 动态拉给用户选 serviceCode）
router.post('/smscloud/services', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const smscloud = require('../smscloud-provider');
    const services = await smscloud.listServices(apiKey, baseUrl);
    res.json({ services });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});

// v2.44.0: smscloud 国家列表（Config UI 动态拉给用户选 countryCode）
router.post('/smscloud/countries', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    const smscloud = require('../smscloud-provider');
    const countries = await smscloud.listCountries(apiKey, baseUrl);
    res.json({ countries });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});
```

**注意**：`fs` 和 `CONFIG_PATH` 应已在该文件 import / 定义（既有 `/zhusms/balance` 已用）。如缺，复用既有 require。

- [ ] **Step 2: 跑测试**

```bash
node -c server/routes/phone-pool.js
npm test
```

Expected: 310 pass。

- [ ] **Step 3: Commit**

```bash
git add server/routes/phone-pool.js
git commit -m "feat(routes): POST /api/phone-pool/smscloud/{balance,services,countries} (v2.44.0 Task 4)

3 路由调 smscloud-provider:
- /balance: 测试 apiKey + 显示钱包余额
- /services: 动态拉服务列表给 UI dropdown
- /countries: 动态拉国家列表给 UI dropdown

req.body 可传 apiKey/baseUrl 直接测，未传则从 config.json 取。"
```

---

## Task 5: `web/src/views/Config.vue` UI 加 smscloud

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: 找 phone-pool 配置块**

Read `web/src/views/Config.vue` 找 `phonePool` 配置区，应该是 `el-tab-pane label="手机号池"` 或类似。

- [ ] **Step 2: provider radio 加 smscloud 选项**

找到 `<el-radio-group v-model="form.phonePoolProvider">` 或 `form.phonePool.provider`，添加 `<el-radio-button label="smscloud">smscloud</el-radio-button>`（既有应有 local + zhusms）。

- [ ] **Step 3: 加 smscloud 配置 form（仅 provider==='smscloud' 时显示）**

在既有 zhusms form 后追加：

```vue
<!-- v2.44.0: smscloud 配置 -->
<template v-if="form.phonePool.provider === 'smscloud'">
  <el-form-item label="apiKey">
    <el-input v-model="form.phonePool.smscloud.apiKey" type="password" show-password placeholder="smscloud.sbs apiKey" />
  </el-form-item>
  <el-form-item label="baseUrl">
    <el-input v-model="form.phonePool.smscloud.baseUrl" placeholder="https://smscloud.sbs/api/system" />
  </el-form-item>
  <el-form-item label="服务">
    <el-select v-model="form.phonePool.smscloud.serviceCode" placeholder="先拉服务列表" filterable style="width: 240px">
      <el-option v-for="s in smscloudServices" :key="s.code" :label="`${s.name} (${s.code})`" :value="s.code" />
    </el-select>
    <el-button size="small" :loading="loadingServices" @click="fetchSmscloudServices" style="margin-left: 8px">拉服务列表</el-button>
  </el-form-item>
  <el-form-item label="国家">
    <el-select v-model="form.phonePool.smscloud.countryCode" placeholder="先拉国家列表" filterable style="width: 240px">
      <el-option v-for="c in smscloudCountries" :key="c.id" :label="`${c.chn} / ${c.eng} (id=${c.id})`" :value="c.id" />
    </el-select>
    <el-button size="small" :loading="loadingCountries" @click="fetchSmscloudCountries" style="margin-left: 8px">拉国家列表</el-button>
  </el-form-item>
  <el-form-item>
    <el-button size="small" :loading="testingBalance" @click="testSmscloudBalance">测试余额</el-button>
    <span v-if="smscloudBalance !== null" style="margin-left: 12px">余额: {{ smscloudBalance }}</span>
  </el-form-item>
</template>
```

JS 端 setup() 加：

```js
import { ref } from 'vue'
import axios from 'axios'

// v2.44.0 smscloud 动态数据
const smscloudServices = ref([])
const smscloudCountries = ref([])
const smscloudBalance = ref(null)
const loadingServices = ref(false)
const loadingCountries = ref(false)
const testingBalance = ref(false)

async function fetchSmscloudServices() {
  loadingServices.value = true
  try {
    const { data } = await axios.post('/api/phone-pool/smscloud/services', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
    })
    smscloudServices.value = data.services || []
    ElMessage?.success(`拉到 ${smscloudServices.value.length} 个服务`)
  } catch (e) {
    ElMessage?.error(`拉服务失败: ${e?.response?.data?.error || e.message}`)
  } finally { loadingServices.value = false }
}

async function fetchSmscloudCountries() {
  loadingCountries.value = true
  try {
    const { data } = await axios.post('/api/phone-pool/smscloud/countries', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
    })
    smscloudCountries.value = data.countries || []
    ElMessage?.success(`拉到 ${smscloudCountries.value.length} 个国家`)
  } catch (e) {
    ElMessage?.error(`拉国家失败: ${e?.response?.data?.error || e.message}`)
  } finally { loadingCountries.value = false }
}

async function testSmscloudBalance() {
  testingBalance.value = true
  try {
    const { data } = await axios.post('/api/phone-pool/smscloud/balance', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
    })
    smscloudBalance.value = data.balance
  } catch (e) {
    ElMessage?.error(`测试余额失败: ${e?.response?.data?.error || e.message}`)
  } finally { testingBalance.value = false }
}
```

确保 `form.phonePool.smscloud` 在初始 form 数据里有 default `{ apiKey: '', baseUrl: 'https://smscloud.sbs/api/system', serviceCode: '', countryCode: 187 }`。

- [ ] **Step 4: build web**

```bash
cd web && npm run build && cd ..
```

Expected: build 成功。

- [ ] **Step 5: 跑 npm test**

```bash
npm test
```

Expected: 310 pass。

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat(web): Config 加 smscloud provider UI (v2.44.0 Task 5)

phone-pool provider radio 加 smscloud 选项。
smscloud 配置 form (apiKey / baseUrl / serviceCode / countryCode):
- '拉服务列表' / '拉国家列表' 按钮调 POST /api/phone-pool/smscloud/{services,countries} 填充 select options
- '测试余额' 按钮调 POST /api/phone-pool/smscloud/balance 显示余额

form.phonePool.smscloud default 含 baseUrl + countryCode=187 (US)。"
```

---

## Task 6: config.example.json + CHANGELOG + merge + tag v2.44.0

**Files:**
- Modify: `config.example.json`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: config.example.json 加 smscloud 段**

Read `config.example.json` 找 `phonePool` 块，在 `zhusms` 之后加：

```jsonc
"smscloud": {
  "apiKey": "",
  "baseUrl": "https://smscloud.sbs/api/system",
  "serviceCode": "",
  "countryCode": 187
}
```

- [ ] **Step 2: CHANGELOG v2.44.0 章节**

prepend `docs/CHANGELOG.md` 顶部：

```markdown
## v2.44.0 — 2026-05-27

### 新增 smscloud 手机号 SMS provider

继 `local` / `zhusms` 之后加第三个 SMS provider：smscloud.sbs (HTTP header apiKey + GET REST，base `https://smscloud.sbs/api/system`)。

**启动方式**：`config.phonePool.provider = "smscloud"` 互斥启用（沿用 zhusms 模式）。

**改动**：

- **`server/smscloud-provider.js`** 新建：6 个 API 包装 (takeOrder / pollOrderSms / cancelOrder / finishOrder / getBalance / listServices / listCountries)
- **`protocol-engine.js _acquirePhoneForProtocol`** 加 smscloud dispatch 分支
- **`protocol_phone_verify.py poll_sms`** 加 smscloud 分支（curl_cffi GET /orders/sync/{id} with apiKey header）
- **`server/routes/phone-pool.js`** 加 `POST /api/phone-pool/smscloud/{balance,services,countries}` 路由
- **`web/src/views/Config.vue`** provider radio 加 smscloud + 配置 form（apiKey + 动态拉服务/国家 select + 测试余额按钮）
- **`config.example.json`** 加 `phonePool.smscloud` schema (apiKey / baseUrl / serviceCode / countryCode=187)

**测试**：310 Node test pass（+6 smscloud unit tests），17 Python (3 skip) pass，web build OK。

**外部依赖**：smscloud.sbs apiKey 用户自行获取，详见 https://smscloud.sbs/docx/。
```

- [ ] **Step 3: 跑全套测试**

```bash
npm test && npm run test:py && (cd web && npm run build && cd ..)
```

Expected: 310 + 17 (3 skip) + web build OK。

- [ ] **Step 4: Commit CHANGELOG**

```bash
git add config.example.json docs/CHANGELOG.md
git commit -m "docs(changelog): v2.44.0 smscloud phone provider"
```

- [ ] **Step 5: Merge + tag + push**

```bash
git checkout master && git merge --ff-only dev
git tag -a v2.44.0 -m "v2.44.0 — smscloud phone provider

新增 smscloud.sbs 作为第三个 SMS provider。
config.phonePool.provider='smscloud' 启用，apiKey + serviceCode + countryCode 配置。
Config UI 动态拉服务/国家列表 + 测试余额。
310 Node + 17 Python pass。"

git push origin master
git push origin v2.44.0
git checkout dev
git push origin dev
```

- [ ] **Step 6: 重启 server**

```bash
# kill old server + sing-box
powershell -c "Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object { try { \$c = (Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$_.Id)\").CommandLine; if (\$c -match 'server[\\/]index\.js') { Stop-Process -Id \$_.Id -Force } } catch {} }; Get-Process -Name sing-box -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.Id -Force }; Start-Sleep 5"

# start v2.44.0
node server/index.js
```

实测：UI 进 Config → 手机号池 → 选 smscloud → 填 apiKey → 拉服务列表 → 选 OpenAI / ChatGPT service code → 拉国家列表 → 选 US → 测试余额 → 显示数字。

---

## Self-Review

**1. Spec 覆盖检查**：

| Spec 章节 | Plan 任务 |
|----------|----------|
| §3.1 server/smscloud-provider.js | Task 1 |
| §3.2 protocol-engine.js dispatch | Task 2 |
| §3.3 protocol_phone_verify.py poll_sms | Task 3 |
| §3.4 config.example.json schema | Task 6 step 1 |
| §3.5 Config.vue UI | Task 5 |
| §3.6 routes/phone-pool.js | Task 4 |
| §3.7 测试 | Task 1 step 2 + Task 6 step 3 |

**2. Placeholder 扫描**：无 TBD / TODO。每 task 含完整代码 + 命令 + 预期输出 + commit message。

**3. 类型 / 命名一致性**：

- `smsConfig.provider === 'smscloud'` / `smsConfig.api_key` / `smsConfig.order_no` / `smsConfig.base_url` 跨 Task 2/3 一致
- `cfg.phonePool.smscloud.{apiKey, baseUrl, serviceCode, countryCode}` 跨 Task 2/4/5/6 一致
- `_smscloudCode` 字段在 Task 1 错误对象 + Task 2/4 catch 用法一致

**4. 错误契约一致性**：

- takeOrder 失败 → `_acquirePhoneForProtocol` 返 `{}` → `_finalizePhoneVerify` 归 `phonePoolEmpty: true`（沿用既有 fallback）
- pollOrderSms timeout → return null → Python `poll_sms` return None → 业务侧 `phoneVerifyFail: 'otp_timeout'`

---

## Execution Handoff

Plan 完成。两种执行方式：

1. **Subagent-Driven (推荐)** — 6 个 task 顺序派 implementer。Task 1 / 4 / 5 改动较大，fresh subagent context 更稳。
2. **Inline Execution** — 在当前 session 顺序跑 Task 1-6。
