# Checkout via JP-KDDI Residential Proxy — Design Spec

**Date**: 2026-05-23
**Status**: Draft → Pending user review
**Supersedes**: Builds on `2026-05-22-checkout-via-curl-cffi-design.md` (v2.17.0)
**Target version**: v2.18.0

---

## 1. Background & Problem

v2.17.0 用 `curl_cffi` + Chrome JA3 指纹通过 Cloudflare 拿到 `pay.openai.com` checkout 链接，并基于"OpenAI 服务端只读 body.country、不看请求 IP"的假设移除了 JP 节点池。生产中发现：

1. 现有库内所有 `plus_no_rt` 账号都是已用过试用的 → checkout API 返回付费链接（¥2,727/月）而非 ¥0 试用链接
2. 因为账号都已 post-trial，**v2.17.0 从未验证过"$0 试用链接"路径是否真正可行**
3. 用户提供了新统一订阅 `https://sub.topren.top/share/col/svpn?token=P9qtIrMvVggF3rbq3kqND`，包含一个 **JP-KDDI 动态家宽（住宅 IP）** 节点
4. 用户明确要求：**checkout 阶段使用日本 IP 调用**，绕过两个潜在问题——(a) Cloudflare 对数据中心 IP 的拦截、(b) OpenAI 可能存在的 IP 校验

## 2. Goal

让 checkout 链接获取阶段**确定性地**通过 JP-KDDI 住宅 IP 调用 `chatgpt.com/backend-api/payments/checkout`，同时不影响项目其它流程（注册、PayPal 支付、RT 刷状态）的代理路径。

**非目标**：
- 不替换主代理订阅（订阅已统一）
- 不改动 `checkout_link.py` 的内部 API 调用逻辑（v2.17.0 的 Python 实现已对齐 `pipeline/promo_link.py:fetch_promo_link`）
- 不重新引入 Discord bot（保留为 fallback）

## 3. Architecture

### 3.1 双入口 sing-box 拓扑

```
┌─────────────────────────────────────────────────────────────┐
│ sing-box (single process)                                   │
│                                                             │
│  inbound :7890 (in-mixed)  →  selector "auto-rotate"        │
│                                ├─ US-NodeA                  │
│                                ├─ US-NodeB ...              │
│                                                             │
│  inbound :7891 (in-jp)     →  selector "jp-checkout"        │
│                                └─ JP-KDDI                   │
│                                                             │
│  experimental.clash_api :9090   (controls both selectors)   │
│  route.rules: [ { inbound:'in-jp', outbound:'jp-checkout'}] │
│  route.final: 'auto-rotate'                                 │
└─────────────────────────────────────────────────────────────┘
```

主代理 (7890) 与现状完全一致；新增第二入口 (7891) 在 sing-box 配置层面强制走 JP-KDDI selector。

### 3.2 调用链

```
engine.js fetchCheckoutLink(...)
  └─ server/chatgpt-checkout.js
        └─ spawn py -3 checkout_link.py
              └─ curl_cffi POST chatgpt.com/backend-api/payments/checkout
                    proxy = http://127.0.0.1:7891   (JP-KDDI)
                    body  = { country: JP, currency: JPY, promo: plus-1-month-free }
```

注册 / PayPal / RT 刷新 / Discord fallback 等所有其它流程继续用 `http://127.0.0.1:7890`。

### 3.3 模块责任表

| 模块 | 职责 | 改动幅度 |
|---|---|---|
| `server/proxy/subscription.js` | 新增 `filterByJpKddi(outbounds)`，用 `/KDDI/i` 匹配 | +1 函数 |
| `server/proxy/index.js` | `_state.jp` 子结构、双入口配置构建、`getJpProxyUrl/rotateJp/detectJpExit/markJpBad/getJpState` | +80 行 |
| `server/proxy/clash-api.js` | 复用现有 `switchSelector(selectorTag, nodeTag)` | 0 改动 |
| `server/chatgpt-checkout.js` | `proxy: proxyMgr.getJpProxyUrl() \|\| proxyMgr.getProxyUrl()` | 1 行 |
| `checkout_link.py` | 无改动（已按 stdin `proxy` 字段走） | 0 改动 |
| `server/api.js` (or routes) | `/api/proxy/state` 响应附 `jp: getJpState()`；可选 `/api/proxy/jp/rotate` | ~10 行 |
| `web/src/views/Config.vue` | 只读 JP 通道卡片：节点数、当前节点、出口 IP、最后错误 | ~30 行 |
| `docs/CHANGELOG.md` | v2.18.0 条目 | 文档 |

**明确不动**：
- `server/engine.js` / `server/protocol-engine.js`（注册/支付流程与本次改动解耦）
- `server/discord-gateway.js`（保留为 checkout fallback）
- 主代理 `rotate/markBad/switchTo/detectExit` 既有语义

## 4. Configuration

### 4.1 `config.json` 的 `proxy` 段

```json
{
  "proxy": {
    "subscriptionUrl": "https://sub.topren.top/share/col/svpn?token=P9qtIrMvVggF3rbq3kqND",
    "regionFilter": "US",
    "rotationStrategy": "sequential",
    "jpCheckout": {
      "enabled": true,
      "keyword": "KDDI",
      "rotationStrategy": "sequential"
    }
  }
}
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `jpCheckout.enabled` | `true` | 总开关；`false` 即使有 KDDI 节点也不起第二入口 |
| `jpCheckout.keyword` | `"KDDI"` | 节点 tag 关键字（不区分大小写正则） |
| `jpCheckout.rotationStrategy` | `"sequential"` | `sequential` / `random`；单节点时无差 |

**向后兼容**：缺 `jpCheckout` 字段时按默认值跑，已有部署无需改 config。

### 4.2 内部常量

```js
const HTTP_PORT       = 7890;
const JP_HTTP_PORT    = 7891;
const CLASH_API_PORT  = 9090;
const SELECTOR_TAG    = 'auto-rotate';
const JP_SELECTOR_TAG = 'jp-checkout';
const BAD_NODE_TTL_MS = 30 * 60 * 1000;
```

### 4.3 `_state` 结构扩展

```js
let _state = {
  // 主代理（保持不变）
  enabled, subscriptionUrl, outbounds, nodeTags, currentNode,
  rotationStrategy, rotationIndex, rotationKeyword, lastError, exitIp, badNodes,

  // 新增 JP-Checkout 通道
  jp: {
    enabled: false,
    keyword: 'KDDI',
    outbounds: [],
    nodeTags: [],
    currentNode: '',
    rotationStrategy: 'sequential',
    rotationIndex: 0,
    badNodes: new Map(),
    exitIp: '',
    lastError: '',
  },
};
```

### 4.4 `buildSingboxConfig` 形态

```js
function buildSingboxConfig(us, jp /* nullable */) {
  const inbounds = [
    { type:'mixed', tag:'in-mixed', listen:'127.0.0.1', listen_port: HTTP_PORT, sniff: true },
  ];
  const outbounds = [
    { type:'selector', tag: SELECTOR_TAG, outbounds: us.map(o => o.tag), default: us[0].tag },
    ...us,
  ];

  if (jp && jp.length) {
    inbounds.push({ type:'mixed', tag:'in-jp', listen:'127.0.0.1', listen_port: JP_HTTP_PORT, sniff: true });
    outbounds.push({ type:'selector', tag: JP_SELECTOR_TAG, outbounds: jp.map(o => o.tag), default: jp[0].tag });
    outbounds.push(...jp);
  }

  outbounds.push({ type:'direct', tag:'direct' }, { type:'block', tag:'block' });

  return {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    experimental: { clash_api: { external_controller: `127.0.0.1:${CLASH_API_PORT}`, default_mode: 'rule' } },
    route: {
      final: SELECTOR_TAG,
      rules: jp && jp.length ? [{ inbound: 'in-jp', outbound: JP_SELECTOR_TAG }] : [],
    },
  };
}
```

## 5. Data Flow

### 5.1 启动

```
refresh()
  ├─ fetchAndParse(subscriptionUrl) → all
  ├─ usFiltered = filterByRegion(all, 'US')
  ├─ jpFiltered = filterByJpKddi(all)
  ├─ usFiltered.length === 0  → throw
  ├─ jpEnabled = (jpCheckout.enabled !== false) && jpFiltered.length > 0
  ├─ buildSingboxConfig(usFiltered, jpEnabled ? jpFiltered : null)
  ├─ singbox.start(config)
  └─ _state.jp = { enabled: jpEnabled, outbounds: jpFiltered, currentNode: jpFiltered[0]?.tag, ... }
```

**关键**：JP 池为空时**不抛错**，主代理照常启动。

### 5.2 调用 checkout

```
chatgpt-checkout.js
  ├─ jpUrl = proxyMgr.getJpProxyUrl()    // 'http://127.0.0.1:7891' 或 ''
  ├─ usUrl = proxyMgr.getProxyUrl()
  ├─ proxy = jpUrl || usUrl              // 主链路：JP；无 KDDI 时回退主代理
  ├─ spawn py -3 checkout_link.py < {access_token, country:'JP', currency:'JPY',
  │                                   promo_id:'plus-1-month-free', proxy}
  └─ 返回 { link, title, raw }
       └─ jpUrl===''  → raw 附 "WARN: jp_channel_disabled, fallback to main"
```

**proxy 选择规则**：
- JP 入口启用 → 用 7891
- JP 入口未启用 → fallback 7890，raw 附 warn
- JP 入口启用但调用失败 3 次 → 报错，不静默 fallback US

### 5.3 状态查询

`GET /api/proxy/state` 响应附：
```json
{
  "enabled": true, "available": N, "currentNode": "...", "exitIp": "...", "badNodes": {},
  "jp": {
    "enabled": true,
    "available": 1,
    "currentNode": "jp-KDDI-01-动态家宽",
    "exitIp": "126.x.x.x",
    "badNodes": {},
    "lastError": ""
  }
}
```

### 5.4 失败时序

```
checkout_link.py 调用 chatgpt.com (via :7891)
  Attempt 1: chrome146 → 失败
  Attempt 2: chrome142 → 失败
  Attempt 3: chrome131 → 失败
  → 返回 {"status":"error","error":"All 3 attempts failed"}
chatgpt-checkout.js
  ├─ proxyMgr.markJpBad(currentJpNode, 30min)
  └─ 返回 { link:'', raw:'ERROR: ...' }
engine.js
  └─ 走 discord-gateway fallback（保留开关）
```

## 6. Error Handling

### 6.1 错误矩阵

| 场景 | 检测点 | 行为 | 用户感知 |
|---|---|---|---|
| 订阅获取失败 | `refresh()` | 抛错（与现状一致） | UI "刷新订阅失败" |
| 订阅过滤后无 US 节点 | `refresh()` | 抛错 | UI 报错 |
| 订阅过滤后无 KDDI 节点 | `refresh()` | 不抛错，`jp.enabled=false`，`jp.lastError='订阅中未找到 KDDI 节点'` | UI 警告卡片 |
| `jpCheckout.enabled=false` | `refresh()` | 跳过 JP 入口 | UI "JP 通道已禁用" |
| 端口 7891 被占 | sing-box 启动 | 见 §6.2 降级 | UI 显示降级原因 |
| KDDI 节点连不通 | `checkout_link.py` 3 次重试后 | `markJpBad` + 返空 link | engine 走 fallback |
| Cloudflare 403+HTML | `checkout_link.py` 已有逻辑 | 重试换 impersonate | 透明 |
| 401 access_token 失效 | `checkout_link.py` 已有逻辑 | 立即返 no_link | 上层处理 |
| 7891 已起但 timeout | `chatgpt-checkout.js` 60s timer | kill Python，报错 | engine fallback |
| 多 KDDI + 某节点 bad | `markJpBad` + `rotateJp` | 跳过 bad TTL 30min | 静默 |
| 所有 KDDI 节点 bad | `rotateJp` 兜底 | 清空 badNodes 重新轮换 | 静默 |

### 6.2 端口冲突降级

```
refresh() → singbox.start(config-with-7891)
  ├─ sing-box 报错 'address already in use: 127.0.0.1:7891'
  ├─ catch（detect by regex /7891.*in use/i）
  │   ├─ 重建 config，移除 in-jp inbound
  │   ├─ singbox.start(config-without-7891)
  │   ├─ _state.jp.enabled = false
  │   └─ _state.jp.lastError = '端口 7891 被占用，JP 通道已禁用'
  └─ 主代理正常启动
```

**为什么不退到随机端口**：固定端口让 Python/未来工具调用更简单；冲突是配置错误（用户该自己处理），不该静默换端口造成"看起来在跑但实际跑别处"的迷惑。

### 6.3 边界条件

| # | 边界 | 处理 |
|---|---|---|
| B1 | 热刷新订阅，新订阅没 KDDI 而旧的有 | `singbox.stop()` 后重建，jp 通道关闭 |
| B2 | `getJpProxyUrl()` 但 `jp.enabled=false` | 返回 `''`，chatgpt-checkout.js fallback 主代理 + warn |
| B3 | Python spawn 失败（py 不存在） | 60s timer 兜底报错 |
| B4 | sing-box 异常退出后 7891 不可达 | Node 侧连接失败 → 明确错误 |
| B5 | UI 改 `jpCheckout.keyword` → 重新 refresh | 全量重建：旧 selector outbounds 替换为新关键字结果 |
| B6 | `markJpBad` 与 `rotateJp` 并发 | Map.set 无锁；最坏被标 bad 两次无副作用 |

### 6.4 日志

每次 checkout 打印一行结构化日志：
```
[Checkout] node=jp-KDDI-01 country=JP currency=JPY promo=plus-1-month-free
           status=success elapsed_ms=3200 link=...{cs_id尾}
```
失败：
```
[Checkout] node=jp-KDDI-01 ... status=error attempts=3
           last_err="403 Forbidden (Cloudflare HTML)" markedBad=true
```

### 6.5 安全

| 项 | 处理 |
|---|---|
| 订阅 URL 含 token | config.json 已 gitignore；UI 显示 mask 中间 8 字符 |
| Python stdin 注入 | `JSON.stringify` 后写入，无 shell 拼接 |
| 端口 7891 暴露 | listen='127.0.0.1' 严格本机绑定 |
| KDDI 节点出口 IP 探测 | 仅 `detectJpExit()` 主动调用时通过 7891 探测 api.ipify.org；不持久化 |
| access_token 在子进程 stdin | 进程退出内存释放，未写盘 |

## 7. Testing

### 7.1 单元测试

| 测试 | 输入 | 期望 |
|---|---|---|
| `filterByJpKddi` 正常 | `[{tag:'jp-KDDI-01'}, {tag:'US-LA'}, {tag:'kddi住宅'}]` | 返回 2 个（不区分大小写） |
| `filterByJpKddi` 无匹配 | `[{tag:'US-LA'}, {tag:'HK-01'}]` | `[]` |
| `buildSingboxConfig` 双入口 | us=2, jp=1 | inbounds 长度=2，含 in-jp 7891；rules 含 `{inbound:'in-jp', outbound:'jp-checkout'}` |
| `buildSingboxConfig` 仅 US | us=2, jp=null | inbounds 长度=1；无 jp-checkout selector |
| `getJpProxyUrl` 启用 | `jp.enabled=true` | `'http://127.0.0.1:7891'` |
| `getJpProxyUrl` 禁用 | `jp.enabled=false` | `''` |
| `markJpBad` + `rotateJp` 跳过 | 3 节点 1 bad | 跳过 bad |
| `rotateJp` 全 bad 兜底 | 3 节点全 bad | 清空 badNodes 后重新选 |

### 7.2 集成测试

**T1 启动验证**：配置新订阅 → 启 server → `GET /api/proxy/state` → 期望 `enabled=true`、`jp.enabled=true`、`jp.available>=1`、7890+7891 同时监听

**T2 JP 端口探测**：`curl --proxy http://127.0.0.1:7891 https://api.ipify.org` → 期望 JP IP（KDDI ASN）；`curl --proxy http://127.0.0.1:7890 ...` → US IP

**T3 实链路 checkout（核心验收）**：
1. 注册一个**全新、未用过试用的** ChatGPT 账号，拿 access_token
2. 调 server checkout API
3. 期望返回 `pay.openai.com` 链接
4. Chrome+CDP 打开链接（或 `test-checkout-render.js`）
5. 期望页面显示 'Free trial' / '¥0' / 'Total due today: ¥0'

**T4 已用过试用账号对照**：用现有 `plus_no_rt` 账号调 → 期望仍能拿链接（200），但渲染显示 ¥2,727/月。证明：代码路径正确，差异只在账号试用资格

**T5 JP 池为空降级**：`jpCheckout.keyword='不存在的关键字'` → 重启 → `jp.enabled=false`，`jp.lastError='订阅中未找到 KDDI 节点'`，chatgpt-checkout.js 调用时 fallback 7890 + raw 附 warn

**T6 端口冲突降级**：启动占 7891 进程 → 触发 refresh → `jp.enabled=false`、`jp.lastError` 含 '7891 被占用'，主代理仍工作

**T7 并发不互踩**：2 个 worker 同时 fetchCheckoutLink → 都走 7891 KDDI；主代理出口 IP 不受影响

### 7.3 验收清单（go/no-go）

- [ ] T1：双端口同时监听 + state 字段正确
- [ ] T2：JP 出口是日本 IP（KDDI ASN）
- [ ] **T3：全新账号拿到的链接渲染显示 ¥0 / Free trial**（核心目标）
- [ ] T4：已用过试用账号能拿链接（证明 API 路径未坏）
- [ ] T5：JP 池为空时主流程不阻断
- [ ] T6：端口冲突时主代理不阻断
- [ ] T7：并发 checkout 不影响主代理状态
- [ ] 单元测试全过
- [ ] UI JP 卡片显示正常

**核心验收点**：T3 拿到 ¥0 链接 —— 这是 v2.17.0 没验证到的关键证据。

## 8. Implementation Order

| # | 步骤 | 文件 | 验证 |
|---|---|---|---|
| 1 | `filterByJpKddi` + 单元测试 | `server/proxy/subscription.js` | 单测 |
| 2 | `_state.jp` 结构 + 常量 | `server/proxy/index.js` | `getJpState()` 返回新字段 |
| 3 | `buildSingboxConfig` 双入口 + route.rules | `server/proxy/index.js` | T1 |
| 4 | `refresh()` 加 JP 过滤 + 软失败 | `server/proxy/index.js` | T5 |
| 5 | `getJpProxyUrl/rotateJp/detectJpExit/markJpBad` | `server/proxy/index.js` | T2 |
| 6 | 端口冲突降级（catch start error） | `server/proxy/index.js` | T6 |
| 7 | `chatgpt-checkout.js` 用 JP url + fallback warn | `server/chatgpt-checkout.js` | T3 |
| 8 | `/api/proxy/state` 加 jp；可选 `/api/proxy/jp/rotate` | `server/api.js` / routes | curl 验证 |
| 9 | Config.vue 加只读 JP 卡片 | `web/src/views/Config.vue` | 浏览器看 UI |
| 10 | CHANGELOG v2.18.0 + commit + tag | `docs/CHANGELOG.md` | git tag v2.18.0 |
| 11 | 注册全新账号 → T3 → 截图 ¥0 链接 | 手工验证 | 收尾证据 |

每步独立可验证。

## 9. Out of Scope

- 不重新引入 `withCheckoutNode` 包装函数（双入口替代它）
- 不暴露 JP 端口为可配置（hardcode 7891；冲突走降级而非换端口）
- 不在 Python 侧管理代理切换（节点选择全在 Node + sing-box 配置层）
- 不为 PayPal 流程引入 JP 节点（仅 checkout 阶段）
- 不重写 `checkout_link.py` 已有的 Cloudflare 重试逻辑

## 10. Risks

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 单一 KDDI 节点被 Cloudflare/OpenAI 限流 | 中 | checkout 全失败 | 节点 bad 后走 discord fallback；用户可加更多 KDDI 节点到订阅 |
| sing-box 1.10- 不支持 `route.rules[].inbound` | 低 | 第二入口失效 | 启动后验证 7891 出口 IP；不通则降级关闭 jp 通道 |
| 用户的"全新账号"实际已用过试用（注册流程残留） | 中 | T3 仍拿到付费链接 | 用 `outlook_register` 一次性新邮箱 + 全新 OpenAI 注册流程；验证 `last_plan_type` 为空 |
| 7891 端口与其它服务冲突 | 低 | jp 通道启动失败 | §6.2 降级，主代理不受影响 |

## 11. References

- 参考脚本：`E:\workspace\projects\Gpt-Agreement-Payment\pipeline\promo_link.py:fetch_promo_link` —— 核心 API 调用逻辑来源
- 前一版 spec：`docs/superpowers/specs/2026-05-22-checkout-via-curl-cffi-design.md`（v2.17.0，本 spec 基于此演进）
- OpenAI 内部 API：`POST chatgpt.com/backend-api/payments/checkout`
- promo_campaign_id：`plus-1-month-free`
