# Deactivated 检测增强 + Accounts 页搜索 UX 优化 设计

> **日期**：2026-05-24
> **版本**：v2.29.0
> **目标**：
> 1. 让测活独立识别 OpenAI 封号账号（不再依赖执行流水线先写 `status='deactivated'`），覆盖 Case 1（token 还活、账号已封）和 Case 2（token 已撤、账号已封）两种场景。
> 2. 测活子进程的运行时日志（每个 attempt、每个 Step）实时推到 UI 日志面板，让用户能逐步看到检测过程。
> 3. Accounts 页搜索/筛选 UX 优化：状态/活性多选、搜索框扩展字段、未测试快捷筛、一键重置。

---

## 1. 背景

### 1.1 deactivated 检测现状

v2.28 测活流程对死号识别只有一条路径——runner 末尾检查 DB `status='deactivated'`（来自之前执行流水线 `protocol_register.py` 在登录时检测到 OpenAI 返 `account_deactivated`）。如果账号**从没跑过执行流水线**，测活只能标 `token_expired`，无法区分真过期 vs 封号。

OpenAI 对两类响应：

| 账号状态 | /accounts/check 返回 | 测活当前判定 | 实际真相 |
|---|---|---|---|
| Plus 活账号 | HTTP 200, plan_type='plus' | plus | plus ✓ |
| Free 活账号 | HTTP 200, plan_type='free' | canceled | canceled ✓ |
| **被封 + token 还活** | HTTP 200, `is_deactivated:true` | **canceled (误)** | **deactivated** |
| **被封 + token 已撤** | HTTP 401 | token_expired (除非 DB 已标 deactivated) | **deactivated** |
| Token 过期 / 改密 | HTTP 401 | token_expired ✓ | token_expired ✓ |

### 1.2 日志可见性现状

v2.28 hotfix 让 UI 折叠面板订阅 `liveness-status / liveness-progress / liveness-complete` 事件。Python 子进程的 `{"log": "..."}` 行（如 `[Liveness] GET /accounts/check attempt 1/3 via chrome142, proxy=on`）由 `checker.js` 用 `console.log(p.log)` 写到 server stdout，**没推到 socket** → UI 面板看不到逐 attempt 的过程日志，用户只看到首尾两条（checking / 终态）。

### 1.3 搜索 UX 现状

`Accounts.vue` 的 filter 控件：

- `search` 单字段（只匹配 email）
- `statusFilter` 单选下拉（12 个状态选项）
- `planFilter` 单选（plus / free / unknown）
- `authFilter` 单选（yes / no）
- `aliveFilter` 单选（8 个 alive 状态）

**痛点**：状态 / 活性筛选只能单选；搜索匹配字段窄；没有快捷筛"未测过"；没有"一键清"。

### 1.4 决策摘要

| 维度 | 决策 |
|---|---|
| Case 1 (200 + is_deactivated) | 修 `mapPlanType('deactivated')` 直接归 alive_status='deactivated' |
| Case 2 (401 + 实际封号) | probe 返 token_expired 后 spawn 轻量级 `deactivated_check.py` 跑 Step 0-2 → 检测 `account_deactivated` 标记 |
| Step 0-2 范围 | homepage + signin + authorize（**不要 OTP / SMS**，5-10s 一次） |
| 日志流到 UI | runner 注入 `onLog` 回调到 checker / verifyDeactivated → 透传 Python `{"log":...}` → io.emit `'liveness-log'` → 前端 push socketState.logs |
| 搜索字段拓展 | email / refresh_token / client_id / totp_secret / password 拼成 haystack |
| 状态/活性 multi-select | `<el-select multiple collapse-tags>`；filter 用 `Array.includes` |
| 快捷筛 | "仅看未测试"（aliveFilter=['unknown']）+ "7 天未测"（按 alive_checked_at 时间过滤） |
| 重置筛选 | 一键清 search/3 个 multi/2 个 single + staleOnly |
| 版本号 | v2.29.0（DB schema 不变） |

---

## 2. Part A — deactivated 检测后端

### 2.1 Case 1: `mapPlanType` 处理 `'deactivated'`

`server/liveness/checker.js`:

```js
function mapPlanType(planType) {
  if (planType === 'plus') return { alive_status: 'plus', alive_reason: 'check ok' };
  if (planType === 'free') return { alive_status: 'canceled', alive_reason: 'no plus' };
  if (planType === 'deactivated') return { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
  return { alive_status: 'canceled', alive_reason: `plan: ${planType}` };
}
```

Python `liveness_probe.py` 在 v2.28 hotfix `3b64727` 已经在 `is_deactivated=true` 时返 `plan_type='deactivated'`——本改动直接打通。

### 2.2 Case 2: 新 `chatgpt_register/deactivated_check.py`

跑 `protocol_register.py` Step 0-2 的精简版（**仅到 authorize，无 OTP**）。预算 5-10s/账号。

**输入**（stdin JSON）：

```json
{
  "email": "alice@outlook.com",
  "client_id": "<Outlook OAuth client_id>",
  "refresh_token": "<Outlook IMAP refresh_token>",
  "proxy_url": "http://127.0.0.1:7890",
  "impersonate": "chrome131"
}
```

**输出**（JSON-lines on stdout）：

- 流式 log：`{"log": "  [Deactivated] Step 0: Homepage..."}`
- 终态：
  - `{"status": "deactivated", "reason": "account_deactivated"}`
  - `{"status": "active", "reason": null}` — signin OK 且未见 deactivated 标记
  - `{"status": "error", "reason": "<msg>"}` — Cloudflare / 网络 / signin fail

**实现要点**：

- 复用 `protocol_register.py` 已有的 `get_csrf` / `signin` / `authorize` 函数（若可 import）或抄一份。
- Step 2 (authorize) 后判别（同 `protocol_register.py:711` 和 `:745`）：

```python
if "account_deactivated" in page_html or "account_disabled" in page_html:
    _emit({"status": "deactivated", "reason": "account_deactivated"})
    return
```

- 不论 redirect 到 `/email-verification` / `/log-in` / `/create-account/password` 都返 `status='active'`（这些路径意味着账号"还在"，只是 token 死了或要 OTP；deactivated_check 只看封号信号）。
- 超时 12s（5s signin + 7s authorize 余量）。

### 2.3 `server/liveness/checker.js` 新 `verifyDeactivated`

包装 spawn，套路对照 `verifyCheckoutIsFree` (`server/stripe-verify.js`):

```js
async function verifyDeactivated(account, opts = {}) {
  const { signal, onLog, spawnImpl, proxyUrl } = opts;
  // spawn chatgpt_register/deactivated_check.py
  // stdin payload: { email, client_id, refresh_token, proxy_url, impersonate: 'chrome131' }
  // listen stdout JSON-lines: log lines → onLog?.('info', msg); terminal → resolve
  // 12s timeout, 4s startup grace
  // returns: { status: 'deactivated' | 'active' | 'error', reason }
}
module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType, mapTerminal, verifyDeactivated };
```

### 2.4 `server/liveness/runner.js` 改 dispatchOne

```
[1] codexFile.read(email) → tok
[2] tok 存在 → probe(tok, { onLog })
       ├─ plus / canceled (200 含 deactivated 新映射) → 终态
       ├─ token_expired → 进 [3]
       └─ 其他 (login_fail / network_error / proxy_error) → 终态

[3] verifyDeactivated(account, { onLog })   ← NEW Case 2
       ├─ deactivated → 终态 alive_status='deactivated', reason='account_deactivated'
       ├─ active     → 进 [4]
       └─ error      → 保留 probe 的 token_expired 判定（verifyDeactivated 网络异常不覆盖）

[4] lightLogin(account)  ← 原有路径
       ├─ 协议模式抛 LivenessLoginNotImplementedError → 保留 [2] 的 token_expired
       ├─ 浏览器模式拿新 token → re-probe → 新判定
       └─ 其他失败 → login_fail
```

`probeRes.alive_status === 'token_expired'` 时**只**触发 verifyDeactivated；其它失败状态（network_error / proxy_error / login_fail）**不**走 verifyDeactivated（避免对节点问题误判）。

runner 末尾已有的"DB status==='deactivated' 时覆盖"逻辑（v2.28 hotfix `3f9c437`）保留作兜底——主要兜底走过执行流水线但 verifyDeactivated 跳过的场景（如 verifyDeactivated 自身 error）。

### 2.5 Case 2 实时日志（A.3 一部分）

`verifyDeactivated` 跟 `probe` 一样接受 `onLog` 回调；runner 注入：

```js
const onLog = (level, message) => {
  io.emit('liveness-log', { email, level, message });
};
const probeRes = await checker.probe(tok, { signal, onLog });
// ... if needed:
const verifyRes = await checker.verifyDeactivated(account, { signal, onLog });
```

`checker.probe / verifyDeactivated` 把 Python `{"log": "..."}` 行改成 `onLog?.('info', msg)` 替代之前的 `console.log(p.log)`。

### 2.6 Socket.IO 事件: `liveness-log`

v2.26 spec §6.2 已经列出 `liveness-log` 事件名（payload `{ email, level, message }`），但 runner 当时没实际 emit。本次正式实现。

**前端 socket.js**：

```js
socket.on('liveness-log', (data) => {
  pushLivenessLog(data.email, data.level || 'info', data.message);
});
```

`pushLivenessLog` 已有（v2.28 Task 2 commit `ed1100e`）；它给 message 加 `[liveness]` 前缀。但 Python 的 log 本身已经有 `[Liveness]` / `[Deactivated]` 前缀，会出现重复前缀 `[liveness] [Liveness] ...`。

**规范化**：`pushLivenessLog` 不再无条件加前缀，改成"如果 message 不以 `[` 开头就加 `[liveness] `"。这样 Python 子进程已有的 `[Liveness]` / `[Deactivated]` / `[Checkout]` 前缀保留原貌、runner 自己写的简短消息（如 `'checking'`）自动加 `[liveness]`。

```js
function pushLivenessLog(email, level, message) {
  const prefixed = message?.startsWith('[') ? message : `[liveness] ${message}`;
  socketState.logs.push({ ... message: prefixed });
}
```

Accounts.vue `livenessLogs` computed 的过滤条件也得对应放宽：

```js
const livenessLogs = computed(() =>
  socketState.logs.filter(l => /^\s*\[(liveness|Liveness|Deactivated|Checkout|StripeInit|Proto|Pay)\]/.test(l.message))
    .slice(-200)
)
```

但更稳健做法：runner 在 emit `liveness-log` 时**单独标识**这是测活日志，不依赖前缀文本。在 socketState.logs 的对象里加 `source: 'liveness'`：

```js
function pushLivenessLog(email, level, message) {
  socketState.logs.push({
    timestamp: new Date().toISOString(),
    email: email || '',
    level,
    message,
    source: 'liveness',
  });
  ...
}
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness').slice(-200)
)
```

后者更干净。spec 采用 `source` 字段方案。

---

## 3. Part B — 搜索/筛选 UX 优化

### 3.1 状态 / 活性多选

`Accounts.vue` 模板：

```vue
<el-select v-model="statusFilter" placeholder="状态" clearable multiple collapse-tags collapse-tags-tooltip style="width:180px;margin-left:8px">
  <el-option label="Plus(有RT)" value="plus" />
  <!-- ... 同现有 12 项 ... -->
</el-select>

<el-select v-model="aliveFilter" placeholder="活性" clearable multiple collapse-tags collapse-tags-tooltip style="width:180px;margin-left:8px">
  <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
</el-select>
```

Script 改：

```js
const statusFilter = ref([])  // was ref('')
const aliveFilter = ref([])   // was ref('')
```

filteredAccounts 逻辑：

```js
if (statusFilter.value.length && !statusFilter.value.includes(a._status)) return false
if (aliveFilter.value.length && !aliveFilter.value.includes(a._aliveStatus || 'unknown')) return false
```

Plan / Auth 保持单选（选项少 + 二元判断）。

### 3.2 搜索框扩展字段

```js
if (q) {
  const haystack = [a.email, a.refresh_token, a.client_id, a.totp_secret, a.password]
    .map(s => (s || '').toLowerCase()).join(' ');
  if (!haystack.includes(q)) return false;
}
```

Placeholder：`搜索 (邮箱/RT/Client ID/TOTP/密码)`。

注意密码也加进搜索 — 部分用户记不住邮箱但记密码片段。安全上 OK（同机本地工具）。

### 3.3 未测过 / 7 天未测快捷

模板 toolbar 加：

```vue
<el-button size="small" text @click="aliveFilter = ['unknown']">仅看未测试</el-button>
<el-button size="small" text :type="staleOnly ? 'primary' : ''" @click="staleOnly = !staleOnly">7 天未测</el-button>
```

Script：

```js
const staleOnly = ref(false)
// in filteredAccounts:
if (staleOnly.value) {
  const cutoff = Date.now() - 7 * 86400_000;
  const checkedAt = a._aliveCheckedAt ? Date.parse(a._aliveCheckedAt) : 0;
  if (checkedAt && checkedAt > cutoff) return false;  // checked within 7d → out
  // never-checked (checkedAt=0) always passes through
}
```

### 3.4 一键重置筛选

```vue
<el-button size="small" text :disabled="!hasAnyFilter" @click="resetFilters">
  重置筛选
</el-button>
```

```js
const hasAnyFilter = computed(() =>
  !!search.value || statusFilter.value.length > 0 || !!planFilter.value
  || !!authFilter.value || aliveFilter.value.length > 0 || staleOnly.value
)

function resetFilters() {
  search.value = ''
  statusFilter.value = []
  planFilter.value = ''
  authFilter.value = ''
  aliveFilter.value = []
  staleOnly.value = false
}
```

### 3.5 布局

最终 toolbar 顺序（沿用现有 sticky toolbar 一行）：

```
[搜索 240w] [状态 multi 180w] [活性 multi 180w] [Plan 110w] [Auth 110w] [仅看未测试] [7天未测] [重置筛选] [N/Total]
```

---

## 4. 错误处理 + 边界

| # | 场景 | 处理 |
|---|---|---|
| 1 | deactivated_check.py spawn ENOENT | resolve `{status:'error', reason:'spawn error'}` → runner 保留 probe 的 token_expired |
| 2 | deactivated_check stdout 不可解析 | `{status:'error', reason:'unparsable'}` → 保留 token_expired |
| 3 | deactivated_check 12s 超时 | kill + resolve `error` → 保留 token_expired |
| 4 | account 没 client_id / refresh_token (Outlook 缺 IMAP 凭证) | Python 端在 stdin 解析时返 `{status:'error', reason:'no IMAP creds'}` → 保留 probe 判定 |
| 5 | Cloudflare 在 Step 0/1/2 拦 | Python 端 same as liveness_probe.py（多 impersonate 重试 3 次） |
| 6 | runner 中途 abort | onLog 闭包检查 abort 信号；spawn 子进程被 kill |
| 7 | 网络层 ECONNRESET 在 deactivated_check | resolve `error` → 保留 token_expired |
| 8 | UI 日志面板溢出 | 已有 200 条 slice + 500 条 cap（v2.28 Task 2），新增不变 |
| 9 | 用户在状态多选选了一堆然后想清空那一个 filter | `<el-select clearable>` 已支持 × 清空数组 |
| 10 | staleOnly 跟 aliveFilter 冲突（用户同时选"活性=plus"和"7天未测"） | AND 拼合理：plus 账号且 7 天没复测 → 命中 |

---

## 5. 测试策略

### 5.1 单元测试

**`server/liveness/__tests__/checker.test.js` 扩展**（现 14 测试 → 16）：

- `mapPlanType('deactivated')` → alive_status='deactivated', reason='account_deactivated'
- `mapTerminal({status:'ok', http:200, plan_type:'deactivated'})` → alive_status='deactivated'

**新 `server/liveness/__tests__/verify-deactivated.test.js`**（5 测试）：

- spawn returns `deactivated` → resolve `{status:'deactivated', reason:'account_deactivated'}`
- spawn returns `active` → resolve `{status:'active', reason:null}`
- spawn returns `error` → resolve `{status:'error', reason:'<msg>'}`
- spawn timeout → resolve `error`
- spawn ENOENT → resolve `error`

**`server/liveness/__tests__/runner.test.js` 扩展**（现 8 → 10）：

- probe 返 token_expired → verifyDeactivated 返 deactivated → 终态 alive_status='deactivated'
- probe 返 token_expired → verifyDeactivated 返 active → 走 lightLogin（保留 token_expired in protocol mode）

**Python `deactivated_check.py` 不单测**（IO 重，同 stripe_init.py 策略）。

### 5.2 集成 smoke（手工）

启动 server → Accounts 页 → 选 5 个账号（混合 Plus / token expired / deactivated）→ 测活选中 →期望：

| 账号类型 | 期望 alive_status | UI 日志面板看到 |
|---|---|---|
| Plus | plus | 检测开始 + chromeXX attempt + plus / check ok |
| Plus + is_deactivated=true | deactivated | attempt + HTTP 200 + deactivated detected |
| token 过期、账号活 | token_expired | attempt + 401 + Step 0/1/2 + active → preserve token_expired |
| token 撤、账号封 | deactivated | attempt + 401 + Step 0/1/2 + Account deactivated detected |
| Free | canceled | attempt + plus → canceled |

### 5.3 回归

`node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js`

预期 **155** 个测试通过（149 baseline + 2 mapPlanType + 5 verifyDeactivated + 2 runner = 158；实际允许 ±3 浮动取决于子测试细节）。

---

## 6. 实现影响 + 文件清单

| 文件 | 改动 |
|---|---|
| `server/liveness/checker.js` | mapPlanType 加 `'deactivated'` 分支；新 `verifyDeactivated`；`probe` 把 `console.log(p.log)` 改 `onLog?.('info', msg)`；export 加 verifyDeactivated |
| `chatgpt_register/deactivated_check.py` | 新文件，~120 行 |
| `server/liveness/runner.js` | dispatchOne 在 token_expired 后 spawn verifyDeactivated；构造 onLog 闭包 emit `'liveness-log'`；增 SUMMARY_KEYS 已包含 deactivated（v2.28 hotfix `3f9c437` 已加） |
| `server/liveness/__tests__/checker.test.js` | +2 mapPlanType / mapTerminal 测试 |
| `server/liveness/__tests__/verify-deactivated.test.js` | 新建，5 测试 |
| `server/liveness/__tests__/runner.test.js` | +2 测试（verifyDeactivated 集成路径） |
| `web/src/socket.js` | `pushLivenessLog` 加 `source: 'liveness'` 字段；新 `socket.on('liveness-log')` handler |
| `web/src/views/Accounts.vue` | filter 改 multi-select / 搜索字段扩展 / 快捷按钮 / 重置；`livenessLogs` 过滤改用 `source==='liveness'` |
| `docs/CHANGELOG.md` | v2.29.0 节 |

---

## 7. YAGNI 边界

- ❌ 不在 deactivated_check.py 里实现 OTP（5-10s 限制）
- ❌ 不缓存 deactivated_check 结果（每次 401 都 spawn 一次，账号死状态不会自愈）
- ❌ 不加"批量重置筛选历史" / "保存筛选器"功能
- ❌ 不区分 Cloudflare 失败 vs 真 active（Step 2 Cloudflare 返 error 时保留 token_expired，不主动 retry）
- ❌ Plan / Auth filter 不改 multi（选项少、二元判断够用）
- ❌ 不导出搜索结果到 CSV（YAGNI 边界已在 v2.26 spec 列）

---

## 8. 版本号

v2.29.0。DB schema 不变（SUMMARY_KEYS 已含 deactivated）。
