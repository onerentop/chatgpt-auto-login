# 系统级透明代理 + 自动 Failover 设计

**状态**：草案，待 review
**日期**：2026-05-26
**触发**：v2.41.14 测活实测发现"每开发一个功能都要传 proxy URL 太麻烦"+"sing-box 节点 rotate 时业务 inflight 失败"两个长期痛点。当前 19 处 Node `getProxyUrl()` + 6 个 Python 脚本 `proxy_url` 参数 + IMAP `LIVENESS_IMAP_PROXY` env 散落各处，server/proxy 自实现的"主动健康检查 + rotate + 失败计数"重复造 sing-box 的轮子，且 rotate 期间业务无感知导致 timeout。

**目标**：

1. 业务代码 **100% 透明**（无显式 `getProxyUrl()` 调用，无 `proxy_url` 参数传递）
2. 坏节点 / 风控节点**自动切换**，业务无感
3. 本地并存其他代理软件（Clash / V2Ray）**不冲突**
4. 总代码量**净减 ~300 行**，可维护性提升

## 1. 总体架构

```
┌─────────────────────────────────────────┐
│  应用代码 (Node + Python + Chrome)        │
│  几乎无 getProxyUrl() 调用                │
│  全局 HTTPS_PROXY env 透传                │
└────────────────┬────────────────────────┘
                 │ HTTPS_PROXY=http://127.0.0.1:7890
                 ▼
┌─────────────────────────────────────────┐
│  sing-box (mixed 7890 + JP 7891)         │
│                                          │
│  ┌── urltest "main" (US 5 节点) ───┐     │
│  │  latency-based 自动选最优         │     │
│  │  dead-node 自动跳                │     │
│  │  bad-node API ban 优先排除       │     │
│  └──────────────────────────────────┘     │
│  ┌── urltest "jp" (JP 1 节点) ────┐      │
│  └──────────────────────────────────┘     │
└──────────────┬───────────────────────────┘
               ▼
       Internet (OpenAI / Outlook IMAP / ...)
```

### 1.1 核心思想 3 层

1. **应用层 100% 透明**：业务代码不知道代理。Node `setGlobalDispatcher(new EnvHttpProxyAgent())` + 全局 env。Python `os.environ['HTTPS_PROXY']`。Chrome `--proxy-server` 默认从 env 读。
2. **sing-box 自动 failover**：删 `server/proxy/` 当前的"主动健康检查 + rotate"（重复造 sing-box 轮子），改用 `urltest` outbound，dead node 自动跳，latency-based 自动选最优。
3. **双层风控检测**：`urltest` 解决端口活但慢。业务层捕获 Cloudflare 403 / rate_limited / connection reset 调 `POST /api/proxy/bad-node` API → server 临时 ban 当前 active 节点 N 分钟 → urltest 自动避开。

### 1.2 本地并存代理软件的防御

用户本地可能开 Clash (7897) / V2Ray (10808) / 系统代理。通过**端口隔离**自然不冲突（server 主动连 7890，不会去 7897）。

唯一陷阱：用户系统级 env 设了 `HTTPS_PROXY=http://127.0.0.1:7897`（Clash "系统代理"模式自动设），server 启动时会**继承**走错代理。**强制覆盖**：

```js
// server/proxy/global.js — 必须在所有 require 之前 require
const SINGBOX_PROXY = `http://127.0.0.1:${config.proxy.localPort || 7890}`;

if (process.env.HTTPS_PROXY && process.env.HTTPS_PROXY !== SINGBOX_PROXY) {
  console.warn(
    `[Proxy] 忽略继承的 HTTPS_PROXY=${process.env.HTTPS_PROXY}` +
    `（可能来自系统代理 / Clash）— 强制覆盖为 sing-box ${SINGBOX_PROXY}`
  );
}

process.env.HTTPS_PROXY = SINGBOX_PROXY;
process.env.HTTP_PROXY = SINGBOX_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,.local';  // server↔sing-box/Clash API 不走代理（避免循环）

setGlobalDispatcher(new EnvHttpProxyAgent());
```

Python spawn 时**显式覆盖** env（不依赖父进程继承）：

```js
require('child_process').spawn('py', ['-3', script], {
  env: { ...process.env, HTTPS_PROXY: SINGBOX_PROXY, HTTP_PROXY: SINGBOX_PROXY, NO_PROXY: '127.0.0.1,localhost' },
});
```

**结果**：无论本地开什么其他代理软件，server 都只走 sing-box 7890，互不影响。

**逃生口**：`config.proxy.useExternalProxy: "http://127.0.0.1:7897"`（默认 null）。设了就跳过 sing-box 直连外部代理（v2.42+ 极端救急用，本 spec 默认 NOT_IMPLEMENTED）。

## 2. 应用层透明实现（具体改动清单）

### 2.1 Node 侧入口

新建 `server/proxy/global.js`（含 §1.2 代码块）。`server/index.js` **顶部第一行**：

```js
require('./proxy/global');  // FIRST — must precede all other requires
```

### 2.2 Node 侧删除 `getProxyUrl()` 调用 — 19 处

| 文件 | 行号 | 改动 |
|------|------|------|
| `protocol-engine.js:34` | 删 `proxy: proxyMgr.getProxyUrl()`（Python 自己读 env） |
| `protocol-engine.js:68` | 同上 PKCE |
| `protocol-engine.js:685` | launchChrome 删 `proxyServer` 参数 |
| `server/engine.js:276` | launchChrome 删 `proxyServer` 参数 |
| `server/discord-gateway.js:13` | 删 `getProxyUrl()` wrapper 函数 + 调用 |
| `server/stripe-verify.js:47` | 删 spawn 时 `proxy` 字段 |
| `server/liveness/checker.js:13-16,81,158` | 删 4 处 `getProxyUrl()` |
| `server/liveness/runner.js:91,186,223` | 删 3 处 `proxyUrl: getProxyMgr()?.getProxyUrl()` |
| `verify-t3-account.js:64` | launchChrome 删 `proxyServer` |

**JP 通道例外**（唯一显式 dispatcher，1 处）：

```js
// server/chatgpt-checkout.js 顶部
const { ProxyAgent } = require('undici');
const jpDispatcher = new ProxyAgent(`http://127.0.0.1:${config.proxy?.jpPort || 7891}`);

// 调用处
const r = await fetch(checkoutUrl, { dispatcher: jpDispatcher });
```

不再调 `proxyMgr.getJpProxyUrl()` / `proxyMgr.getJpState()`。

### 2.3 Python 侧 — 6 个脚本

每个 Python 入口顶部加 4 行：

```python
import os
_DEFAULT_PROXY = os.environ.get('HTTPS_PROXY') or 'http://127.0.0.1:7890'
os.environ['HTTPS_PROXY'] = _DEFAULT_PROXY
os.environ['HTTP_PROXY'] = _DEFAULT_PROXY
os.environ.setdefault('NO_PROXY', '127.0.0.1,localhost')
```

涉及文件 + 删除内容：

- `protocol_register.py` — 删 line 486-501 stdin proxy 读取 + `proxies = {}` 构造
- `protocol_phone_verify.py` — 删 line 73-77, 121, 127, 170 `poll_sms(..., proxy_url)` 参数链
- `chatgpt_register/liveness_login.py` — `_build_session(proxy_url)` 删参数；删 line 415 stdin proxy 读取
- `chatgpt_register/liveness_probe.py` — 删 line 131, 139, 147 `proxy_url` 处理
- `stripe_init.py` — 删 line 32 `proxies = {...}`
- `checkout_link.py` — 删 line 31 `proxies = {...}`

curl_cffi / requests / urllib3 自动读 `HTTPS_PROXY` env，调用变成：

```python
# 旧
session = requests.Session(impersonate='chrome142')
session.proxies = {"http": proxy_url, "https": proxy_url}

# 新
session = requests.Session(impersonate='chrome142')  # 自动读 env
```

### 2.4 IMAP 特殊处理 — 保留 + env 统一

`chatgpt_register/otp.py` 既有的 PySocks `_imap_socket_proxy()` 上下文管理器保留（IMAP 不是 HTTP，不读 HTTPS_PROXY env，必须 socket monkey-patch）。但 env name 统一为 `HTTPS_PROXY`：

```python
# chatgpt_register/otp.py
proxy_url = os.environ.get('HTTPS_PROXY', 'http://127.0.0.1:7890')
```

删 `LIVENESS_IMAP_PROXY` 独立 env。

### 2.5 Chrome 启动

`server/chrome.js` `launchChrome(port, tempDir, options = {})` 改成默认读 env：

```js
const proxyServer = options.proxyServer ?? process.env.HTTPS_PROXY;
const args = [
  // ... 既有 args
  proxyServer ? `--proxy-server=${proxyServer}` : null,
].filter(Boolean);
```

业务代码 `launchChrome(port, tempDir, {})` 调用时**不传** `proxyServer`，自动走 env。

### 2.6 NO_PROXY 白名单的关键性

`NO_PROXY=127.0.0.1,localhost,.local` **必须**配置：

| 调用 | 不加 NO_PROXY 后果 |
|------|------------------|
| server 调 `http://127.0.0.1:9090/proxies` (Clash API) | 走 sing-box → 死循环 |
| server 调自己 `http://127.0.0.1:3000/api/...` | 同上 |
| Python 子进程访问 localhost | 同上 |

### 2.7 改动量估算

- 删 Node `getProxyUrl()` 调用 19 处（10 文件）
- 删 Python `proxy_url` 参数 + `proxies={}` 字典 ~50 行（6 文件）
- 新增 `server/proxy/global.js` ~25 行
- Chrome args 改 1 处
- IMAP env 重命名 2 处
- chatgpt-checkout.js JP dispatcher ~10 行
- **净减 ~200 行**

## 3. sing-box urltest 改造 + server/proxy 简化

### 3.1 sing-box outbound 从 selector 改为 urltest

```jsonc
{
  "outbounds": [
    {
      "type": "urltest",
      "tag": "main",
      "outbounds": ["us-node-1", "us-node-2", "us-node-3", "us-node-4", "us-node-5"],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "3m",
      "tolerance": 50,
      "idle_timeout": "30m"
    },
    {
      "type": "urltest",
      "tag": "jp",
      "outbounds": ["jp-node-1"],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "3m"
    }
    // 节点 outbound 定义 (VLESS-Reality 等) 不变
  ],
  "route": {
    "rules": [
      { "inbound": "mixed-7890", "outbound": "main" },
      { "inbound": "mixed-7891", "outbound": "jp" }
    ]
  }
}
```

**关键点**：

- `urltest` 自动选最低延迟节点，dead 自动跳，业务无感
- `interval: 3m`（比当前 server/proxy 30s 主动 probe 频率低，省带宽）
- `tolerance: 50ms` 防抖（避免频繁切节点导致 inflight 中断）
- **保留 7890 / 7891 双端口**：sing-box route rule 不支持 `path_regex`（实测确认），chatgpt.com/backend-api/checkout 与其他 chatgpt.com 同 domain，无法按 path 分流。JP 用独立端口 + dispatcher 区分

### 3.2 server/proxy/index.js 删除清单

**删除（净减 ~280 行）**：

| 函数 | 为什么删 |
|------|--------|
| `runHealthProbe()` | urltest 内部自动 probe |
| `rotate()` / `rotateJp()` | urltest 自动切，不需手动 |
| `markBad(node)` / `_state.failCount` / `_state.failReasons` | urltest 自动跳 dead |
| `getProxyUrl()` / `getJpProxyUrl()` | 业务不再调（全部走 env） |
| `getState()` 里的 `probeResults` / `probeSummary` | 通过 Clash API `/group/main/delay` 拿 |
| `POST /api/proxy/rotate` | 标 deprecated 仅 debug 用 |
| 自动 fail-counter 逻辑 | 改成只接受业务上报（3.3） |

**保留**：

| 函数 / 路由 | 用途 |
|-----------|------|
| `fetchSubscription()` | 拉节点订阅 |
| `parseV2RayLinks()` | 解析节点 |
| `buildSingboxConfig()` | 生成 sing-box config（改 urltest 模板） |
| `pickJpNodes(nodes, whitelist)` | JP 白名单过滤 |
| `ensureBinary()` | 下载 sing-box.exe |
| Clash API subset：`getActiveNode()` / `banFromUrltest()` | 给 bad-node API 用 |
| `GET /api/proxy/status` | 暴露状态给前端 |
| `POST /api/proxy/bad-node` | 业务上报风控 |
| `proxy_blacklist` 表 | 存储 banned 节点 + 解禁时间 |

### 3.3 `POST /api/proxy/bad-node` API

业务**不传节点名**（不知道当前 active 节点），server 自己查：

```js
// server/routes/proxy.js
router.post('/bad-node', async (req, res) => {
  const { reason, channel = 'main', durationMinutes = 5 } = req.body;
  if (!['cloudflare_403','rate_limited','connection_reset','openai_403','captcha','custom'].includes(reason)) {
    return res.status(400).json({ error: 'unknown reason' });
  }
  const activeNode = await proxyMgr.getActiveNode(channel);
  if (!activeNode) return res.json({ ok: true, banned: null });
  await proxyDB.banNode(activeNode, reason, Date.now() + durationMinutes * 60_000);
  await proxyMgr.banFromUrltest(activeNode, durationMinutes);
  console.log(`[Proxy] Banned ${activeNode} for ${durationMinutes}min (${reason})`);
  res.json({ ok: true, banned: activeNode, until: Date.now() + durationMinutes * 60_000 });
});
```

业务调用（fire-and-forget）：

```js
// Node
fetch('http://127.0.0.1:3000/api/proxy/bad-node', {
  method: 'POST',
  body: JSON.stringify({ reason: 'cloudflare_403', channel: 'jp' }),
  headers: {'Content-Type':'application/json'}
}).catch(() => {});

// Python
import requests
try:
    requests.post('http://127.0.0.1:3000/api/proxy/bad-node',
                  json={'reason':'cloudflare_403'}, timeout=3)
except Exception:
    pass
```

### 3.4 ban-from-urltest 实现机制

sing-box 不支持运行时往 urltest.outbounds 加/删节点（实测）。**唯一可行**：动态重生成 config + reload。

```js
async banFromUrltest(node, durationMinutes) {
  const newConfig = buildSingboxConfig({ excludeNodes: [node] });
  await fs.writeFile(SINGBOX_CONFIG, JSON.stringify(newConfig, null, 2));
  await reloadSingbox();  // SIGHUP / kill+respawn
  setTimeout(() => unbanNode(node), durationMinutes * 60_000);
}
```

reload ~500ms inflight 流量会断。但 ban 是低频事件（5 分钟一次），可接受。

Clash API `/proxies/{node}/healthcheck` 实测只能查不能写，**不能**用来 force-mark-dead。

### 3.5 状态可见性

`GET /api/proxy/status` 返回：

```jsonc
{
  "ok": true,
  "mainActiveNode": "us-vmrack-CN2精品-1g-41.88",
  "mainNodes": [
    { "name": "us-vmrack-CN2精品-1g-41.88", "delay": 124, "alive": true, "banned": null },
    { "name": "us-vmrack-CN2精品-AI-2g-95.41", "delay": 89, "alive": true, "banned": "2026-05-26T13:30:00Z" }
  ],
  "jpActiveNode": "jp-node-1",
  "jpNodes": [/* ... */],
  "bannedHistory": [/* 最近 N 条 */]
}
```

前端 Dashboard 加节点延迟 bar + ban 状态显示。

### 3.6 启动 sequence

```
server/index.js 启动
  ↓
require('./proxy/global')     ← 第 1 步：设 env，强制覆盖系统继承
  ↓
require('./proxy')            ← 第 2 步：拉订阅 → 生成 urltest config → 启 sing-box
  ↓
require('./db') / 路由 / ...  ← 第 3 步：业务（所有 fetch 自动走 sing-box）
```

### 3.7 改动量

- `server/proxy/index.js` 删 rotate/probe/auto-blacklist: -280 行
- `server/proxy/index.js` `getActiveNode` / `banFromUrltest` 新增: +60 行
- `buildSingboxConfig.js` selector→urltest 模板: -20 净
- `server/routes/proxy.js` bad-node API: +30 行
- 前端 Dashboard 节点延迟 vue: +50 行
- **净减 ~160 行**

## 4. 错误处理 + Retry + 测试

### 4.1 错误分类

| 错误特征 | 类型 | 业务处理 | 上报 bad-node |
|---------|------|----------|--------------|
| `ECONNRESET` / `socket hang up` | TCP 不稳 | retry 1 次 | 第 2 次失败上报 |
| HTTP 403 + Cloudflare body | 风控 | 立即 fail | 立即上报 (cloudflare_403) |
| HTTP 429 / rate_limited body | 限流 | 立即 fail | 立即上报 (rate_limited) |
| HTTP 5xx | 上游故障 | retry，不切节点 | 不上报 |
| timeout 30s | 节点或上游死 | retry 1 次 | 第 2 次失败上报 |

### 4.2 统一 helper

`server/proxy/with-retry.js`（Node）：

```js
async function fetchWithRetry(url, opts = {}, { channel = 'main', maxRetries = 1 } = {}) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 403) {
        const text = await r.clone().text();
        if (/cloudflare|just a moment|challenge-platform/i.test(text)) {
          reportBadNode('cloudflare_403', channel);
          throw new Error('proxy_blocked: cloudflare');
        }
      }
      if (r.status === 429) {
        reportBadNode('rate_limited', channel);
        throw new Error('proxy_blocked: rate_limited');
      }
      return r;
    } catch (e) {
      const msg = String(e.message);
      if (/ECONNRESET|connection.*closed|socket hang up|timeout/i.test(msg)) {
        if (i === maxRetries) {
          reportBadNode('connection_reset', channel);
          throw e;
        }
        await new Promise(r => setTimeout(r, 500));  // 等 urltest 切节点
        continue;
      }
      throw e;
    }
  }
}

function reportBadNode(reason, channel) {
  fetch('http://127.0.0.1:3000/api/proxy/bad-node', {
    method: 'POST',
    body: JSON.stringify({ reason, channel }),
    headers: {'Content-Type':'application/json'},
  }).catch(() => {});
}
```

**采用策略分两档**：

- **强制改造**（3 个 critical 业务模块）：`server/chatgpt-checkout.js`、`server/stripe-verify.js`、`server/liveness/light-login.js` — 这些遇 Cloudflare 403 / rate_limited 频繁，必须上报 bad-node。Implementation plan 列入 verify checklist。
- **opt-in**（其他业务）：`server/discord-gateway.js`、`server/phone-pool.js`、`server/zhusms-provider.js` 等 — 保留原生 fetch，遇错直接抛。后续如发现风控也可改造，但不在 v2.42 强制范围。

Python helper `chatgpt_register/proxy_helpers.py` `report_bad_node(reason, channel)` 同样 fire-and-forget。

### 4.3 测试策略

**单测**：

- `server/proxy/__tests__/global.test.js` — `setGlobalDispatcher` 后 env 覆盖正确；继承的 env 被覆盖 + warning
- `server/proxy/__tests__/build-singbox-urltest.test.js` — `buildSingboxConfig({excludeNodes})` 不含 banned 节点
- `server/proxy/__tests__/bad-node-api.test.js` — POST cloudflare_403 → DB 写入 + reload 触发
- `server/proxy/__tests__/with-retry.test.js` — mock fetch 403 cloudflare → 调 bad-node + 抛 proxy_blocked
- Python `tests/test_otp_proxy.py` — `HTTPS_PROXY` env 设置后 otp.py PySocks 走该端口

**集成测**：

- **B1**：5 节点中 1 个延迟 9999ms → 启 sing-box → fetch google.com 不走 dead 节点
- **B2**：调 bad-node API → 1s 后 status 显示 banned → 下次 fetch 不走该节点
- **B3**：ban 过期 5 分钟后自动恢复

**端到端**：

- **E1**：跑 liveness liabhzo717818 → 在 CN2-1g 节点拿 deactivated（不传任何 proxy 参数）
- **E2**：跑 chatgpt-checkout → 用 JP dispatcher → 拿 $0 link
- **E3**：模拟 Cloudflare 403 → 自动 ban → 下次 liveness 用其他节点

### 4.4 性能 + 资源

| 指标 | 当前 | v2.42 | 差异 |
|------|------|-------|------|
| sing-box probe 频率 | 30s (server 自跑) | 3min (sing-box 自跑) | 省 ~95% |
| Node fetch dispatcher overhead | 0 | ~1ms | 可忽略 |
| Python curl_cffi env proxy overhead | 0 | 0 | 无差异 |
| 切节点 inflight 中断率 | rotate 时 100% | urltest 切换 ~100ms | 反而更稳 |

### 4.5 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| undici `EnvHttpProxyAgent` 不兼容 Node 18 | 低 | server 启动失败 | 检测 Node 版本，<18 用 `ProxyAgent` 显式 |
| `setGlobalDispatcher` 影响 IMAP token 路径 | 低 | IMAP token 异常 | login.microsoftonline.com 走 main 通道也 OK |
| Python `os.environ['HTTPS_PROXY']` 影响 imaplib | 低 | imaplib SSL 出错 | imaplib 不读该 env，只读 socket |
| sing-box reload 期间 inflight 失败 | 中 | ~500ms 业务断 | fetchWithRetry 自动 retry；ban 低频 |
| `urltest` 切换期间 inflight 失败 | 低 | ~100ms 业务断 | fetchWithRetry 自动 retry；tolerance 50ms 防抖 |
| 关键业务忘了用 fetchWithRetry | 中 | 风控时不上报 bad-node | 强制改造 chatgpt-checkout / liveness / stripe-verify |
| bad-node API 自己被风控（递归） | 极低 | server 自调失败 | NO_PROXY 含 127.0.0.1 |
| 用户 NO_PROXY env 跟我们冲突 | 低 | 意外路由 | 强制覆盖 process.env，不读继承 |

### 4.6 不解决（YAGNI）

- 多区域代理池（EU / SG）
- 节点 quality 评分（latency 之外的 success rate）
- 跨 server 集群 ban 同步
- GraphQL API for proxy state
- `protocol_register.py` 注册流程 SPA 适配（v2.41.14 spec §4.2 留待另起 spec）

## 5. 验收标准

1. server/index.js 启动后 `process.env.HTTPS_PROXY === 'http://127.0.0.1:7890'`（不管系统有没有设）
2. 跑任意业务（liveness / checkout / phone-verify）**不传** proxy URL，自动走 sing-box
3. 故意 ban CN2-1g 节点 → urltest 自动切 CN2-AI-2g → 业务继续工作（不需要重启 server）
4. 业务遇 Cloudflare 403 → 自动调 bad-node API → 5 分钟内不再选该节点
5. 5 分钟后 ban 过期 → 节点自动恢复（延迟正常的话）
6. 全套 npm test 285+ pass，新增 ~5-8 个 proxy 相关测试
7. 总代码 **净减 ~250-300 行**

## 6. 总改动量

| Section | 改动 |
|---------|------|
| §2 应用层透明 | -250 行 / +50 行 = 净 -200 |
| §3 sing-box urltest | -300 行 / +140 行 = 净 -160 |
| §4 错误处理 + 测试 | +120 行（helper + 测试） |
| **合计** | **净 -240 行**，删 19 处 getProxyUrl + 6 个 Python proxy_url 链 |
