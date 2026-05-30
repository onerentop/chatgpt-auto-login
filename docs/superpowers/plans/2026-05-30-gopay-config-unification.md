# GoPay 配置统一化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `gopay/config/config.json` 的所有配置合并到主 `config.json`，消除双配置文件。号池 tab 新增 SmsBower provider，代理 tab 新增印尼通道。

**Architecture:** 三处改动：(1) config.json schema 扩展（phonePool.smsbower + proxy.idGopay + gopay 顶层字段）；(2) Python 侧 `gopay_activate.py` 配置读取改为主 config.json；(3) Node/Vue 侧 Config.vue + proxy/index.js + gopay-engine.js + routes/gopay-activate.js 配置源统一。

**Tech Stack:** Node.js (Express)、Python 3.11+ (`json`)、Vue 3 + Element Plus。

---

## Task 1: config.example.json 扩展

**Files:**
- Modify: `config.example.json`

- [ ] **Step 1: 添加 smsbower、idGopay、gopay 字段**

在 `config.example.json` 的 `phonePool` 中加 `smsbower`，`proxy` 部分补充（若无 proxy 则新建），顶层加 `gopay`：

```json
{
  "phone": "your_phone_number",
  "smsApiUrl": "http://your-sms-api-url/api/get_sms?key=your_key",
  "cardNumber": "your_card_number",
  "cardExpiry": "MM / YY",
  "cardCvv": "CVV",
  "enableCPA": true,
  "cpaUrl": "https://your-cpa-domain/management.html",
  "cpaKey": "your_cpa_management_key",
  "discordToken": "your_discord_token",
  "discordChannelId": "channel_id",
  "discordMessageId": "message_id",
  "discordGuildId": "guild_id",
  "discordAppId": "app_id",
  "phonePool": {
    "enabled": false,
    "provider": "local",
    "maxBindingsPerPhone": 3,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30,
    "zhusms": {
      "cardKey": "",
      "service": "codex",
      "baseUrl": "https://zhusms.com"
    },
    "smscloud": {
      "apiKey": "",
      "baseUrl": "https://smscloud.sbs/api/system",
      "serviceCode": "",
      "countryCode": [187]
    },
    "oapi": {
      "baseUrl": "https://sms.oapi.vip/api.php",
      "apiKey": ""
    },
    "smsbower": {
      "apiKey": "",
      "serviceCode": "ni",
      "countryCode": 6,
      "maxPrice": 0.15
    }
  },
  "proxy": {
    "enabled": true,
    "subscriptionUrl": "",
    "regionFilter": "US",
    "whitelist": [],
    "jpCheckout": {
      "enabled": true,
      "keyword": "",
      "whitelist": []
    },
    "idGopay": {
      "enabled": false,
      "proxyTemplate": ""
    }
  },
  "gopay": {
    "defaultPin": "147258",
    "smsProvider": "smsbower"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add config.example.json
git commit -m "feat(config): add smsbower, idGopay, gopay fields to config.example.json"
```

---

## Task 2: server/proxy/index.js 改配置来源

**Files:**
- Modify: `server/proxy/index.js`

- [ ] **Step 1: 改 buildSingboxConfig 中 IPRoyal outbound 的配置来源**

当前代码（约 282-302 行）从 `gopay/config/config.json` 读取 `proxy_template`。改为从主 `config.json` 的 `proxy.idGopay` 读取。

将：
```javascript
    try {
      const gopayCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'gopay', 'config', 'config.json'), 'utf-8'));
      const proxyTpl = gopayCfg?.gopay?.proxy_template || '';
```

改为：
```javascript
    try {
      const mainCfg = readCfg();
      const idCfg = mainCfg.proxy?.idGopay || {};
      const proxyTpl = idCfg.enabled ? (idCfg.proxyTemplate || '') : '';
```

其余逻辑不变（解析 user:pass@host:port → HTTP outbound + mixed inbound + route rule）。

- [ ] **Step 2: 验证 sing-box 启动**

```bash
node -e "const {refresh}=require('./server/proxy/index');refresh().then(()=>console.log('ok')).catch(e=>console.error(e.message))"
```

Expected: `ok`（如果 `config.json` 有 `proxy.idGopay.enabled=true` + 有效 `proxyTemplate`）。

- [ ] **Step 3: Commit**

```bash
git add server/proxy/index.js
git commit -m "refactor(proxy): read idGopay config from main config.json instead of gopay/config"
```

---

## Task 3: gopay_activate.py 改配置读取

**Files:**
- Modify: `gopay_activate.py`

- [ ] **Step 1: 改 _load_config 读主 config.json**

将：
```python
def _load_config():
    cfg_path = os.environ.get("OPAI_CONFIG_FILE", "")
    if not cfg_path:
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gopay", "config", "config.json")
    if not os.path.exists(cfg_path):
        return {}
    with open(cfg_path) as f:
        return json.load(f)
```

改为：
```python
def _load_config():
    cfg_path = os.environ.get("GOPAY_CONFIG_FILE", "")
    if not cfg_path:
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if not os.path.exists(cfg_path):
        return {}
    with open(cfg_path) as f:
        return json.load(f)
```

- [ ] **Step 2: 改 _make_proxy 从 proxy.idGopay 读取**

将：
```python
def _make_proxy(cfg):
    """返回 GoPay 代理地址。优先用 sing-box 27890（已绑 WLAN 转发到 IPRoyal，绕 TUN）。"""
    direct = os.environ.get("GOPAY_PROXY", "")
    if direct:
        return direct
    return f"http://127.0.0.1:{SINGBOX_GOPAY_PORT}"
```

改为：
```python
def _make_proxy(cfg):
    direct = os.environ.get("GOPAY_PROXY", "")
    if direct:
        return direct
    id_cfg = cfg.get("proxy", {}).get("idGopay", {})
    if id_cfg.get("enabled") and id_cfg.get("proxyTemplate"):
        return f"http://127.0.0.1:{SINGBOX_GOPAY_PORT}"
    return ""
```

- [ ] **Step 3: 改 main() 的 provider 和 pin 读取**

将：
```python
    inp = json.loads(sys.stdin.read())
    access_token = inp.get("access_token", "")
    midtrans_url = inp.get("midtrans_url", "")
    pin = inp.get("pin", "147258")

    cfg = _load_config()
    provider = create_sms_provider()
```

改为：
```python
    inp = json.loads(sys.stdin.read())
    access_token = inp.get("access_token", "")
    midtrans_url = inp.get("midtrans_url", "")

    cfg = _load_config()
    gopay_cfg = cfg.get("gopay", {})
    pool_cfg = cfg.get("phonePool", {})

    pin = inp.get("pin", "") or gopay_cfg.get("defaultPin", "147258")

    provider_name = gopay_cfg.get("smsProvider", "smsbower")
    provider_params = pool_cfg.get(provider_name, {})
    api_key = provider_params.get("apiKey", "")
    provider = create_sms_provider(provider_name, api_key)
```

- [ ] **Step 4: 验证 Python 能读主配置**

```bash
py -3 -c "import sys; sys.path.insert(0,'gopay/app/src'); exec(open('gopay_activate.py').read().split('def main')[0]); cfg=_load_config(); print('gopay:', cfg.get('gopay',{})); print('smsbower:', cfg.get('phonePool',{}).get('smsbower',{}))"
```

Expected: 打印出 `gopay` 和 `smsbower` 字段值。

- [ ] **Step 5: Commit**

```bash
git add gopay_activate.py
git commit -m "refactor(gopay): read config from main config.json, remove gopay/config dependency"
```

---

## Task 4: gopay-engine.js + routes/gopay-activate.js 清理

**Files:**
- Modify: `server/gopay-engine.js`
- Modify: `server/routes/gopay-activate.js`

- [ ] **Step 1: 清理 gopay-engine.js**

删除 `GOPAY_CONFIG` 常量和相关读取逻辑。`gopayInput` 只传 `access_token` 和 `pin`（从主 config 读取）。`gopayEnv` 不再设 `GOPAY_PROXY`。

将 `gopay-engine.js` 顶部的：
```javascript
const GOPAY_CONFIG = path.join(__dirname, '..', 'gopay', 'config', 'config.json');
```
删除。

将 Phase 4+5 的 spawn 段：
```javascript
      const gopayInput = {
        access_token: accessToken,
        pin: '147258',
      };
      const gopayEnv = {};
      try {
        const cfg = JSON.parse(fs.readFileSync(GOPAY_CONFIG, 'utf-8'));
        const proxy = cfg.gopay?.register_proxy || '';
        if (proxy) {
          gopayEnv.GOPAY_PROXY = proxy;
        }
      } catch { /* no config, use env default */ }
```

改为：
```javascript
      const mainCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
      const gopayInput = {
        access_token: accessToken,
        pin: mainCfg.gopay?.defaultPin || '147258',
      };
      const gopayEnv = {};
```

- [ ] **Step 2: 清理 routes/gopay-activate.js**

删除 `GOPAY_CONFIG` 常量。`GET /config` 和 `POST /config` 改为读写主 `config.json` 的 `gopay` + `phonePool.smsbower` + `proxy.idGopay` 子集。

将顶部的：
```javascript
const GOPAY_CONFIG = path.join(__dirname, '..', '..', 'gopay', 'config', 'config.json');
```

改为：
```javascript
const MAIN_CONFIG = path.join(__dirname, '..', '..', 'config.json');
```

`GET /config` 改为：
```javascript
router.get('/config', (_req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
    const result = {
      gopay: cfg.gopay || { defaultPin: '147258', smsProvider: 'smsbower' },
      smsbower: cfg.phonePool?.smsbower || {},
      smscloud: cfg.phonePool?.smscloud || {},
      idGopay: cfg.proxy?.idGopay || {},
    };
    if (result.smsbower.apiKey) result.smsbower.apiKey = result.smsbower.apiKey.slice(0, 6) + '***';
    if (result.smscloud.apiKey) result.smscloud.apiKey = result.smscloud.apiKey.slice(0, 6) + '***';
    const tpl = result.idGopay.proxyTemplate || '';
    if (tpl.includes('@')) result.idGopay.proxyTemplate = '***@' + tpl.split('@').pop();
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: 'Config not found', detail: e.message });
  }
});
```

`POST /config` 改为将请求体的字段 merge 回主 `config.json`：
```javascript
router.post('/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(MAIN_CONFIG, 'utf-8'));
    if (req.body.gopay) cfg.gopay = { ...(cfg.gopay || {}), ...req.body.gopay };
    if (req.body.smsbower) cfg.phonePool = { ...(cfg.phonePool || {}), smsbower: { ...(cfg.phonePool?.smsbower || {}), ...req.body.smsbower } };
    if (req.body.idGopay) cfg.proxy = { ...(cfg.proxy || {}), idGopay: { ...(cfg.proxy?.idGopay || {}), ...req.body.idGopay } };
    fs.writeFileSync(MAIN_CONFIG, JSON.stringify(cfg, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add server/gopay-engine.js server/routes/gopay-activate.js
git commit -m "refactor(gopay): engine and routes read from main config.json"
```

---

## Task 5: Config.vue 号池 + 代理 + GoPay UI

**Files:**
- Modify: `web/src/views/Config.vue`

- [ ] **Step 1: 号池 tab 加 smsbower provider**

在 provider radio group（约 41 行）加一个选项：
```html
<el-radio value="smsbower">smsbower</el-radio>
```

在 oapi template 之后加 smsbower 表单：
```html
<template v-if="form.phonePool.provider === 'smsbower'">
  <el-form-item label="apiKey">
    <el-input v-model="form.phonePool.smsbower.apiKey" type="password" show-password placeholder="SmsBower API Key" style="width: 360px" />
  </el-form-item>
  <el-form-item label="serviceCode">
    <el-input v-model="form.phonePool.smsbower.serviceCode" placeholder="ni" style="width: 120px" />
  </el-form-item>
  <el-form-item label="countryCode">
    <el-input-number v-model="form.phonePool.smsbower.countryCode" :min="1" />
  </el-form-item>
  <el-form-item label="maxPrice (USD)">
    <el-input-number v-model="form.phonePool.smsbower.maxPrice" :min="0" :step="0.01" :precision="2" />
  </el-form-item>
</template>
```

在 `form` 初始化的 `phonePool` 默认值中加：
```javascript
smsbower: { apiKey: '', serviceCode: 'ni', countryCode: 6, maxPrice: 0.15 },
```

在 `loadConfig` 的 `phonePool` 合并中加：
```javascript
smsbower: cfg.phonePool.smsbower
  ? { ...{ apiKey: '', serviceCode: 'ni', countryCode: 6, maxPrice: 0.15 }, ...cfg.phonePool.smsbower }
  : { apiKey: '', serviceCode: 'ni', countryCode: 6, maxPrice: 0.15 },
```

- [ ] **Step 2: 代理 tab 加印尼通道**

在 JP 通道区块之后加：
```html
<el-divider content-position="left">印尼通道（GoPay）</el-divider>
<el-form-item label="启用印尼通道">
  <el-switch v-model="form.proxyIdGopayEnabled" />
</el-form-item>
<el-form-item label="代理模板" v-if="form.proxyIdGopayEnabled">
  <el-input v-model="form.proxyIdGopayTemplate" placeholder="http://user:pass_country-id_session-{sid}@host:port" style="width: 480px" />
  <div style="color:#909399;font-size:12px;margin-top:4px">{sid} 自动替换为随机 session ID（IP 轮转）</div>
</el-form-item>
```

在 `form` 初始化中加：
```javascript
proxyIdGopayEnabled: false,
proxyIdGopayTemplate: '',
```

在 `loadConfig` 中加：
```javascript
form.proxyIdGopayEnabled = cfg.proxy?.idGopay?.enabled ?? false
form.proxyIdGopayTemplate = cfg.proxy?.idGopay?.proxyTemplate ?? ''
```

在 `saveConfig` 的 payload 构建中加：
```javascript
proxy: {
  ...payload.proxy,
  idGopay: {
    enabled: form.proxyIdGopayEnabled,
    proxyTemplate: form.proxyIdGopayTemplate,
  },
},
```

- [ ] **Step 3: 号池 tab 底部加 GoPay 区块**

在号池 tab 末尾加：
```html
<el-divider content-position="left">GoPay 激活</el-divider>
<el-form-item label="GoPay PIN">
  <el-input v-model="form.gopayPin" placeholder="147258" style="width: 160px" />
</el-form-item>
<el-form-item label="GoPay SMS Provider">
  <el-select v-model="form.gopaySmsProvider" style="width: 180px">
    <el-option label="smsbower" value="smsbower" />
    <el-option label="smscloud" value="smscloud" />
  </el-select>
  <span style="margin-left:8px;color:#909399;font-size:12px">GoPay 注册用印尼号，独立于主流水线 provider</span>
</el-form-item>
```

在 `form` 初始化中加：
```javascript
gopayPin: '147258',
gopaySmsProvider: 'smsbower',
```

在 `loadConfig` 中加：
```javascript
form.gopayPin = cfg.gopay?.defaultPin ?? '147258'
form.gopaySmsProvider = cfg.gopay?.smsProvider ?? 'smsbower'
```

在 `saveConfig` 的 payload 中加：
```javascript
gopay: {
  defaultPin: form.gopayPin,
  smsProvider: form.gopaySmsProvider,
},
```

- [ ] **Step 4: 构建前端验证**

```bash
cd web && npm run build
```

Expected: 构建成功，无错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Config.vue
git commit -m "feat(ui): add SmsBower provider, ID proxy channel, GoPay settings to Config page"
```

---

## Task 6: 删除 gopay/config 目录 + 清理

**Files:**
- Delete: `gopay/config/config.json`
- Delete: `gopay/config/config.example.json`
- Modify: `.gitignore`

- [ ] **Step 1: 迁移现有配置值到主 config.json**

将 `gopay/config/config.json` 中的值手动写入主 `config.json`（如果尚未存在）：

在 `config.json` 中确保有：
```json
"phonePool": {
  ...existing...,
  "smsbower": {
    "apiKey": "<from gopay/config>",
    "serviceCode": "ni",
    "countryCode": 6,
    "maxPrice": 0.15
  }
},
"proxy": {
  ...existing...,
  "idGopay": {
    "enabled": true,
    "proxyTemplate": "<from gopay/config gopay.proxy_template>"
  }
},
"gopay": {
  "defaultPin": "147258",
  "smsProvider": "smsbower"
}
```

- [ ] **Step 2: 删除 gopay/config 目录**

```bash
rm -rf gopay/config/
```

- [ ] **Step 3: 清理 .gitignore**

移除 `gopay/config/config.json` 行。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove gopay/config/, all config now in main config.json"
```

---

## Task 7: E2E 验证

**Files:** 无新文件

- [ ] **Step 1: 启动服务**

```bash
node server/index.js
```

确认 sing-box 启动（main + JP + IPRoyal 三通道），无报错。

- [ ] **Step 2: 打开 Config 页验证 UI**

浏览器 `http://127.0.0.1:3000/#/config`：
- 号池 tab 能选 smsbower，字段正确显示
- 代理 tab 印尼通道区块正确显示
- GoPay 区块 PIN + smsProvider 正确显示
- 保存后刷新，值保持

- [ ] **Step 3: 跑 GoPay 激活测试**

用 access token 测试完整流程（Phase 4 → 3 → 5），确认从主 config.json 正确读取 smsbower API key、IPRoyal 代理、PIN。

- [ ] **Step 4: Commit tag**

```bash
git tag v3.1.0-config-unified
```

---

## Self-Review

**Spec 覆盖：** §2.1 phonePool.smsbower → Task 1+5；§2.2 proxy.idGopay → Task 1+2+5；§2.3 gopay 顶层 → Task 1+5；§3 删除文件 → Task 6；§4 gopay_activate.py → Task 3；§5 proxy/index.js → Task 2；§6 UI → Task 5；§7 gopay-engine.js → Task 4；§8 不改 → 无 Task（确认不动）；§9 迁移路径 → Task 6 Step 1。

**类型一致：** `proxyTemplate`（config.json 驼峰） vs `proxy_template`（旧 gopay config 下划线）— Task 2/3 统一用驼峰 `proxyTemplate`。`smsProvider`（gopay 顶层）vs `provider`（phonePool 主流水线）— 分开，不冲突。
