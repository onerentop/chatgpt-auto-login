# GoPay 配置统一化设计

> 状态：用户确认（2026-05-30）
> 范围：将 `gopay/config/config.json` 的所有配置合并到主 `config.json`，消除双配置文件。

## 1. 目标

- 号池 tab 新增 SmsBower provider（和 smscloud/oapi 并列）
- 代理 tab 新增"印尼通道"（和 JP 通道并列）
- 删除 `gopay/config/` 目录，`gopay_activate.py` 从主 `config.json` 读取所有配置
- 保持 `opai` 包内部的 `create_sms_provider` 工厂不变（参数由外部传入）

## 2. config.json 结构变更

### 2.1 phonePool 新增 smsbower

```json
"phonePool": {
  "provider": "oapi",
  "maxBindingsPerPhone": 3,
  "smsPollIntervalMs": 3000,
  "smsMaxAttempts": 30,

  "smsbower": {
    "apiKey": "",
    "serviceCode": "ni",
    "countryCode": 6,
    "maxPrice": 0.15
  },

  "smscloud": {
    "apiKey": "...",
    "baseUrl": "https://smscloud.sbs/api/system/",
    "serviceCode": "dr",
    "countryCode": [7, 6],
    "maxPrice": 3.2
  },

  "oapi": { ... },
  "zhusms": { ... }
}
```

smsbower 字段说明：
- `apiKey`：SmsBower API 认证密钥
- `serviceCode`：服务代码（印尼 GoPay = `"ni"`）
- `countryCode`：国家代码（印尼 = `6`）
- `maxPrice`：单次最高价格（USD）

smscloud 的 `serviceCode` 和 `countryCode` 保持当前值（美区 `"dr"` + `[7,6]`）。GoPay 激活时 `gopay_activate.py` 会用印尼特有参数覆盖（见 §4）。

### 2.2 proxy 新增印尼通道

```json
"proxy": {
  "enabled": true,
  "subscriptionUrl": "...",
  "regionFilter": "US",
  "whitelist": [],

  "jpCheckout": {
    "enabled": true,
    "keyword": "",
    "whitelist": ["jp-KDDI-..."]
  },

  "idGopay": {
    "enabled": true,
    "proxyTemplate": "http://user:pass_country-id_session-{sid}@geo.iproyal.com:12321"
  }
}
```

`idGopay` 字段说明：
- `enabled`：是否启用印尼通道（控制 sing-box 27890 inbound + IPRoyal outbound 生成）
- `proxyTemplate`：IPRoyal HTTP CONNECT 代理模板。`{sid}` 在每次 `buildSingboxConfig` 时替换为随机 8 字符 session ID（IP 轮转）

### 2.3 新增顶层 gopay 字段

```json
"gopay": {
  "defaultPin": "147258",
  "smsProvider": "smsbower"
}
```

- `defaultPin`：GoPay PIN（6 位数字）
- `smsProvider`：GoPay 激活使用的 SMS provider 名称（覆盖 `phonePool.provider`，因为 GoPay 需要印尼号，而主流水线可能用美国号）

## 3. 删除的文件

| 文件 | 处理 |
|------|------|
| `gopay/config/config.json` | 删除（配置迁移到 `config.json`）|
| `gopay/config/config.example.json` | 删除（合并到 `config.example.json`）|
| `.gitignore` 中 `gopay/config/config.json` | 移除该行 |

`gopay/app/src/opai/` 包保持不动（纯 Python 库，不直接读 config 文件）。

## 4. gopay_activate.py 改造

### 4.1 配置读取

```python
def _load_config():
    # 读主 config.json（和 Node 同一个文件）
    cfg_path = os.path.join(os.path.dirname(__file__), "config.json")
    return json.load(open(cfg_path))
```

### 4.2 SMS Provider 构建

```python
cfg = _load_config()
gopay_cfg = cfg.get("gopay", {})
pool_cfg = cfg.get("phonePool", {})

# GoPay 用自己的 smsProvider 字段（默认 smsbower），不用 phonePool.provider
provider_name = gopay_cfg.get("smsProvider", "smsbower")

# 从 phonePool 对应 provider 子对象取 API key 和参数
provider_params = pool_cfg.get(provider_name, {})
api_key = provider_params.get("apiKey", "")

provider = create_sms_provider(provider_name, api_key)
```

### 4.3 代理读取

```python
proxy_cfg = cfg.get("proxy", {}).get("idGopay", {})
proxy_template = proxy_cfg.get("proxyTemplate", "")
# 生成随机 session 代理 URL
sid = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
proxy = proxy_template.replace("{sid}", sid) if proxy_template else ""
```

### 4.4 PIN 读取

```python
pin = gopay_cfg.get("defaultPin", "147258")
```

## 5. server/proxy/index.js 改造

`buildSingboxConfig` 中 IPRoyal outbound 的配置来源从 `gopay/config/config.json` 改为主 `config.json`：

```javascript
// 之前：fs.readFileSync('gopay/config/config.json')
// 之后：从已有的 readCfg() 读取
const idCfg = cfg.proxy?.idGopay || {};
if (BIND_IFACE && idCfg.enabled && idCfg.proxyTemplate) {
  // 解析 proxyTemplate → 生成 HTTP outbound + mixed inbound
}
```

其他逻辑不变（端口 27890、`bind_interface`、session 轮转、route rule）。

## 6. UI 改造

### 6.1 Config.vue 号池 tab

在现有 provider 下拉菜单新增 `"smsbower"` 选项。选中后显示：
- API Key 输入框
- Service Code 输入框（默认 `ni`）
- Country Code 输入框（默认 `6`）
- Max Price 输入框（默认 `0.15`）

布局和现有 smscloud/oapi 的表单一致。

### 6.2 Config.vue 代理 tab

在 JP 通道区块下方新增"印尼通道（GoPay）"区块：
- Enabled 开关
- Proxy Template 输入框（placeholder: `http://user:pass@host:port`）

### 6.3 Config.vue 新增 GoPay 区块

在号池 tab 或代理 tab 后面加一个小区块（不需要独立 tab）：
- Default PIN 输入框（默认 `147258`）
- SMS Provider 下拉（可选 smsbower/smscloud，默认 smsbower）

### 6.4 config.example.json 更新

合并 GoPay 相关字段到 `config.example.json`（脱敏值）。

## 7. gopay-engine.js 改造

- 不再读 `gopay/config/config.json`
- `gopayInput` 不传 config 路径，`gopay_activate.py` 自己读主 `config.json`
- `gopayEnv` 不再设 `GOPAY_PROXY`（Python 脚本从 config 读取）

## 8. 不改

- `gopay/app/src/opai/` 包内部代码（纯库，不直接读配置）
- `opai/core/config.py` 的 `OPAI_CONFIG_FILE` 机制（仍可通过环境变量覆盖，但默认不再需要）
- 号池页面（`PhonePool.vue`）的现有功能
- 现有美区流水线的配置和行为

## 9. 迁移路径

1. 用户在 Config 页填写 smsbower/smscloud API key + 印尼代理模板
2. `gopay/config/config.json` 不再被读取
3. 首次启动时如果 `config.json` 没有 `gopay`/`smsbower`/`idGopay` 字段，使用默认值（不 crash）
