# 测活 probe 改 Python curl_cffi + 日志面板设计

> **日期**：2026-05-24
> **目标**：v2.26 测活的 Node `globalThis.fetch` probe 被 Cloudflare 一律拦截返 403（即便走 :7890 代理也无法绕过 TLS 指纹检测），导致 UI 一片"登录失败"。改用 Python curl_cffi（impersonate=chrome131，跟项目里其他 chatgpt.com 调用同套路）spawn 出来做 probe；同时给 Accounts 页加底部折叠日志面板让用户能实时看到测活进度。

---

## 1. 背景

### 1.1 现状 / 故障复现

`server/liveness/checker.js:43-54` 用 `globalThis.fetch` 调 `https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27`。Node 22 undici 默认 dispatcher 不读 HTTP_PROXY；2026-05-24 提交 `7b65000` 已通过 `HttpsProxyAgent + https.request` 让请求走 :7890 主代理。

curl 实测验证：

```
$ curl -x http://127.0.0.1:7890 https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27 \
    -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0"
HTTP=403 + Cloudflare 挑战页 (__cf_chl_tk + cf-mitigated)
```

走代理也是 403。**根因不是代理，是 Cloudflare 通过 TLS 指纹识别出 Node https.request 是机器人**。项目里其他调 chatgpt.com 的代码（`stripe_init.py` / `protocol_register.py` / `chatgpt_register/checkout_link.py`）都用 Python `curl_cffi` 的 `impersonate='chrome131'` 模拟真实浏览器 TLS 指纹，能稳定过 Cloudflare。

### 1.2 决策摘要

| 维度 | 决策 |
|---|---|
| Probe 实现 | Python curl_cffi，spawn 出子进程（复用 stripe-verify.js 的 spawn 套路） |
| TLS 指纹 | `impersonate='chrome131'`（跟 fetchCheckoutLink 默认值一致） |
| 单元测试 | mock spawn 替代 mock fetch；mapPlanType / decodeJwtExp 单测保持不动 |
| 日志可见性 | Accounts 页底部加 `<el-collapse>` 折叠日志面板，订阅 `socketState.logs` 过滤 `[liveness]` 前缀 |
| 日志推送 | `socket.js` 现有 3 个 liveness handler 各加一条 push 到 `socketState.logs` |
| 自动展开 | 测活 running 时面板自动 expand；结束后保留展开（不自动收） |

---

## 2. Python probe 设计

### 2.1 文件位置

`chatgpt_register/liveness_probe.py`（与 `stripe_init.py` 同目录，遵循 Python 子进程命名约定）。

### 2.2 进程协议

**stdin**：单行 JSON 配置。

```json
{
  "access_token": "<JWT>",
  "proxy_url": "http://127.0.0.1:7890",
  "impersonate": "chrome131",
  "timeout_ms": 10000
}
```

**stdout**：JSON-lines。

- 流式日志行：`{"log": "Probing /accounts/check via chrome131..."}`
- 终态行（最后一行，非 `log` 对象）：

```json
{
  "status": "ok",
  "http": 200,
  "plan_type": "plus",
  "reason": null
}
```

或失败：

```json
{
  "status": "error",
  "http": 403,
  "plan_type": null,
  "reason": "cloudflare blocked"
}
```

`status` 仅两种：`"ok"` / `"error"`。`http` 是真实 HTTP 状态码。`plan_type` 仅 `status='ok'` 时填充。`reason` 仅 `status='error'` 时填充。

### 2.3 实现骨架

```python
import sys, json
from curl_cffi import requests

config = json.loads(sys.stdin.read())
access_token = config['access_token']
proxy_url = config.get('proxy_url') or None
impersonate = config.get('impersonate', 'chrome131')
timeout_s = (config.get('timeout_ms', 10000)) / 1000.0

CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'

print(json.dumps({"log": f"probing /accounts/check via {impersonate}, proxy={'on' if proxy_url else 'off'}"}), flush=True)

try:
    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None
    res = requests.get(
        CHECK_URL,
        headers={'Authorization': f'Bearer {access_token}'},
        proxies=proxies,
        impersonate=impersonate,
        timeout=timeout_s,
    )
    http = res.status_code
    if http == 200:
        body = res.json()
        # Extract plan_type from common response shapes
        a = (body.get('accounts') or {}).get('default') or body.get('account_plan') or body or {}
        plan_type = (
            a.get('plan_type')
            or (a.get('entitlement') or {}).get('subscription_plan')
            or 'unknown'
        )
        print(json.dumps({"status": "ok", "http": 200, "plan_type": plan_type, "reason": None}), flush=True)
    elif http == 401:
        print(json.dumps({"status": "error", "http": 401, "plan_type": None, "reason": "token_expired"}), flush=True)
    elif http == 403:
        # Two sub-cases: cloudflare bot challenge vs OpenAI account forbidden.
        # Cloudflare returns HTML with __cf_chl_tk; OpenAI returns JSON.
        text = res.text[:200]
        if '__cf_chl' in text or 'cf-mitigated' in text:
            reason = 'cloudflare blocked'
        else:
            reason = 'account forbidden'
        print(json.dumps({"status": "error", "http": 403, "plan_type": None, "reason": reason}), flush=True)
    else:
        print(json.dumps({"status": "error", "http": http, "plan_type": None, "reason": f"http {http}"}), flush=True)
except Exception as e:
    msg = str(e)[:80]
    print(json.dumps({"status": "error", "http": 0, "plan_type": None, "reason": f"exception: {msg}"}), flush=True)
```

注意：导入期不能 print（必须 stderr 重定向）—— `from curl_cffi import requests` 不会 print，安全。

---

## 3. checker.js 改造

### 3.1 新接口

```js
async function probe(accessToken, opts = {}) → {
  alive_status: 'plus' | 'canceled' | 'token_expired' | 'login_fail' | 'network_error' | 'proxy_error',
  alive_reason: string,
}
// opts: { signal, spawnImpl?, proxyUrl? }
```

`spawnImpl` 替代之前的 `fetchImpl` 作为依赖注入入口。生产路径用 `require('child_process').spawn`；测试注入 fake spawn 返回预设 stdout。

### 3.2 实现要点

1. **JWT exp 本地检查保留**：过期立即返回 `token_expired`，不 spawn Python（spec §3 v2.26 已有逻辑）。
2. **spawn 套路复用 stripe-verify.js**（line 64-122）：
   - `spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] })`
   - 写 stdin JSON、监听 stdout / stderr、setTimeout 超时 kill
   - 解析 JSON-lines：`{"log": ...}` 走 console.log，最后一行非 log 是终态
3. **删除 `_requestViaProxy` 函数**（`7b65000` 加的，已不需要）。
4. **proxyUrl 默认从 `require('./proxy').getProxyUrl()`** 拉取实时值（与现行其他子进程一致）。

### 3.3 终态映射

| Python 输出 | alive_status | alive_reason |
|---|---|---|
| `status='ok', http=200, plan_type='plus'` | `plus` | `check ok` |
| `status='ok', http=200, plan_type='free'` | `canceled` | `no plus` |
| `status='ok', http=200, plan_type=其他` | `canceled` | `plan: <type>` |
| `status='error', http=401, reason='token_expired'` | `token_expired` | `check 401` |
| `status='error', http=403, reason='cloudflare blocked'` | `proxy_error` | `cloudflare blocked` |
| `status='error', http=403, reason='account forbidden'` | `login_fail` | `check 403 forbidden` |
| `status='error', http=429` | `network_error` | `check 429` |
| `status='error', http >= 500` | `network_error` | `check <http>` |
| `status='error', http=0, reason='exception: ...'` | `network_error` | `exception: <msg>` |
| spawn timeout（10s 超时 + 2s 启动余量 = 12s 总） | `network_error` | `probe timeout` |
| spawn ENOENT / Python 未安装 | `network_error` | `spawn error` |

Cloudflare 403 改归类为 `proxy_error` 而非 `login_fail` —— 表达"网络层被挡"而不是"账号有问题"，并提示用户切节点/换 impersonate。

---

## 4. Socket.IO 日志推送

### 4.1 修改 `web/src/socket.js`

现有 3 个 handler 各加一行 push 到 `socketState.logs`：

```js
function pushLivenessLog(email, level, message) {
  socketState.logs.push({
    timestamp: new Date().toISOString(),
    email: email || '',
    level,
    message: `[liveness] ${message}`,
  });
  if (socketState.logs.length > 500) socketState.logs.splice(0, socketState.logs.length - 500);
}

socket.on('liveness-status', (data) => {
  // ... 现有 aliveStatuses 写入 ...
  const level = data.alive_status === 'plus' ? 'success'
              : data.alive_status === 'checking' ? 'info'
              : data.alive_status === 'canceled' ? 'warning'
              : 'warning';
  pushLivenessLog(data.email, level, `${data.alive_status}${data.alive_reason ? ': ' + data.alive_reason : ''}`);
});

socket.on('liveness-progress', (data) => {
  socketState.liveness.done = data.done || 0;
  // ... 现有 ...
});  // 不打日志（太密）

socket.on('liveness-complete', (data) => {
  // ... 现有 summary push 那条 log 已存在，直接复用，前缀改 [liveness] 即可 ...
});
```

### 4.2 不动 backend

`server/liveness/runner.js` 现行的 `io.emit('liveness-status', ...)` 不需改。日志渲染由前端 socket.js 接收事件后构造。

---

## 5. Accounts 页日志面板

### 5.1 模板

`web/src/views/Accounts.vue` 表格下方追加：

```vue
<el-collapse v-model="logsExpanded" style="margin-top: 12px">
  <el-collapse-item :title="`测活日志 (${livenessLogs.length})`" name="liveness-logs">
    <div class="liveness-log-list">
      <div v-for="(log, i) in livenessLogs" :key="i" :class="'log-' + log.level">
        <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
        <span v-if="log.email" class="log-email">{{ log.email }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="livenessLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无测活日志</div>
    </div>
  </el-collapse-item>
</el-collapse>
```

样式（scoped）：

```css
.liveness-log-list { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; padding: 4px 8px; }
.liveness-log-list > div { padding: 2px 0; }
.log-time { color: #909399; margin-right: 8px; }
.log-email { color: #409EFF; margin-right: 8px; }
.log-msg { color: #303133; }
.log-success .log-msg { color: #67C23A; }
.log-warning .log-msg { color: #E6A23C; }
.log-error .log-msg { color: #F56C6C; }
.log-info .log-msg { color: #909399; }
```

### 5.2 Script

```js
import { computed, ref, watch } from 'vue'
import { socketState } from '../socket'

const logsExpanded = ref([])
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.message?.startsWith('[liveness]')).slice(-200)
)

// Auto-expand when liveness starts (not closing automatically — user controls)
watch(() => socketState.liveness.running, (now) => {
  if (now && !logsExpanded.value.includes('liveness-logs')) {
    logsExpanded.value = ['liveness-logs'];
  }
});
```

### 5.3 不变式

- 面板默认收起（空数组）。
- 测活启动时自动展开，结束后不自动收（用户手动）。
- 仅显示最近 200 条 `[liveness]` 前缀日志，更早的滑出（与 socketState.logs 500 上限协同）。
- Execute 页不受影响（它过滤的是 `account-status` / `log` 事件，不与 `[liveness]` 前缀冲突）。

---

## 6. 错误处理 + 边界

| # | 场景 | 处理 |
|---|---|---|
| 1 | Python 未安装 / `py` 命令不在 PATH | spawn ENOENT → alive_status='network_error', reason='spawn error: <code>' |
| 2 | curl_cffi 未安装 | Python 启动后 import fail → stderr 输出 traceback；checker.js stdout 解析失败 → network_error / 'probe unparsable' |
| 3 | Probe 超时（>10s） | setTimeout 触发 → kill Python → resolve network_error / 'probe timeout' |
| 4 | Cloudflare 仍 403（impersonate 失效） | reason='cloudflare blocked' → alive_status='proxy_error'（让用户知道是网络层问题，不是账号问题） |
| 5 | 节点真挂（代理本身不通） | curl_cffi 内部 connection reset / refused → exception 分支 → alive_status='network_error', reason='exception: ...' |
| 6 | JSON parse 异常（API 返回奇怪 schema） | Python 端 `body = res.json()` 抛 → 进 except 分支 → reason='exception: ...' |
| 7 | runner abort 中段 | runner 已有 AbortSignal，spawn 不受影响（子进程会跑完，但结果会被丢弃 — 浪费一次调用，可接受） |
| 8 | 同时 50 个 probe 并发 | runner 限 3 并发，所以同时最多 3 个 Python 子进程，资源占用可控 |
| 9 | proxy.getProxyUrl 返 null（代理未启动） | proxies=None 传给 curl_cffi → 直连 → 大概率被 Cloudflare 拦 → alive_status='proxy_error' |
| 10 | 用户在测活进行中打开 Accounts 页 | watch 触发自动展开；既有的 200 条最近 [liveness] 日志立即显示 |

---

## 7. 测试策略

### 7.1 删除 / 改造既有测试

`server/liveness/__tests__/checker.test.js` 现有 11 测试：

- **保留 5 个** unit 测试（`decodeJwtExp` 2 + `mapPlanType` 3）—— 不依赖 spawn。
- **改造 6 个** probe 测试 —— 把 `fetchImpl` 改成 `spawnImpl`，注入返回 fake JSON-lines 的 stub。

### 7.2 新加测试

`server/liveness/__tests__/checker.test.js` 改造后保持 11 测试覆盖：

| # | 用例 | mock spawn 输出 |
|---|---|---|
| 1 | JWT exp 已过期，不 spawn | （spawn 不应被调用，count=0） |
| 2 | spawn returns plus | `{"status":"ok","http":200,"plan_type":"plus"}` |
| 3 | spawn returns free | `{"status":"ok","http":200,"plan_type":"free"}` |
| 4 | spawn returns team | `{"status":"ok","http":200,"plan_type":"team"}` |
| 5 | spawn returns 401 | `{"status":"error","http":401,"reason":"token_expired"}` |
| 6 | spawn returns cloudflare 403 | `{"status":"error","http":403,"reason":"cloudflare blocked"}` |
| 7 | spawn returns account forbidden 403 | `{"status":"error","http":403,"reason":"account forbidden"}` |
| 8 | spawn returns 5xx | `{"status":"error","http":503,"reason":"http 503"}` |
| 9 | spawn returns exception | `{"status":"error","http":0,"reason":"exception: timeout"}` |
| 10 | spawn ENOENT | mock error event |
| 11 | spawn timeout (>10s) | mock 不 emit close，超时触发 kill |

Python 端 `chatgpt_register/liveness_probe.py` **不写单测**（IO 重 + 需 OpenAI 真账号，与 stripe_init.py 一致策略）。集成 smoke 验证。

### 7.3 集成 smoke

启动服务 → Accounts 页选 5 个 plus 账号 → 测活选中 → 期望：

- 日志面板自动展开，逐条出现 `[liveness] checking` → `[liveness] plus: check ok`
- 5 个账号全部 🟢 Plus
- toolbar 进度条 5/5 ✗0
- DB `alive_status='plus'`、`alive_reason='check ok'`、`alive_checked_at` 是最新 ISO

### 7.4 回归

`node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js`

预期 146 仍通过。

---

## 8. 不做的事（YAGNI）

- ❌ 自动尝试多个 impersonate（chrome131 fail → chrome133a → ...）—— 一次一个 impersonate 够用，需要时手动改 config
- ❌ 把 `impersonate` 暴露到 config.json —— hardcoded `chrome131`，跟项目其他 Python 子进程一致
- ❌ Python probe 写入 cpa-auth json —— probe 只读 token，不写文件
- ❌ 主动 refresh token / fallback to /backend-api/me —— 一个 endpoint 够用
- ❌ 日志面板加搜索 / 过滤 / 清空按钮 —— 200 条上限自然滚动
- ❌ 日志面板支持导出 —— socketState.logs 已在浏览器内存中，需要时 DevTools 复制

---

## 9. 版本号

下次 release 标 **v2.28.0**（修复 + 小功能；DB schema 不变）。
