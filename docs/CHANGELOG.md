# Changelog

## v2.43.3 — 2026-05-27

### ProtocolEngine 同步 PipelineEngine：每账号重读 config.json 拿 phoneSlots

Diff 协议模式 (PE) vs 浏览器模式 (PipelineEngine) payment 段，绝大部分行为已同步（`server/engine.js` 注释明说 "Mirrors protocol-engine.js"）。唯一一处差异：

| | 旧 PE | PipelineEngine |
|---|------|------|
| phoneSlots 来源 | `runtimeCfg.phoneSlots?.[0]` (startup snapshot) | `JSON.parse(fs.readFileSync(config.json))` (每账号重读) |

**修复** (`protocol-engine.js` line 737-739)：

```js
// v2.43.3: 同步 PipelineEngine 行为
const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
const slot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
```

**效果**：用户运行时改 `config.json`（切手机号池 / 改 SMS API URL）**不用重启 batch**，下个账号 payment 阶段自动用新 config。

公共改动（v2.43.1 clickSubmit + v2.43.2 Chrome --lang=en-US）已自动影响两个引擎（共用 `payment.js` + `server/chrome.js`）。

**测试**：304 Node test pass，无 regression。

## v2.43.2 — 2026-05-27

### Chrome 强制 en-US locale 省 PayPal 切国家 4s

实测：每账号 PayPal checkout 进入时 `Country: C2 → US`，等 billing schema 重渲染 4120ms。1000 账号 batch 浪费 ~1 小时。

**根因**：`server/chrome.js` `launchChrome` 没传 locale 参数 → Chrome 用 Windows 系统 locale (zh-CN) → 发 `Accept-Language: zh-CN` → PayPal 看 Accept-Language 优先于 IP geo → 给中文 + C2 国家 fallback。

**修复** (`server/chrome.js launchChrome` args)：

```js
'--lang=en-US',                  // Chrome UI 语言 + Accept-Language seed
'--accept-lang=en-US,en;q=0.9',  // HTTP header Accept-Language (权威源)
```

预期 PayPal 直接 `initial === 'US'` 跳过 4s 切换分支。不影响 OpenAI/Stripe（多数 `data-testid`/`id` selector）。**304 Node test pass**。

## v2.43.1 — 2026-05-27

### 修偶发 PayPal not reached：clickSubmit 验证 submit 真触发

实测日志：`[Pay] OpenAI page submitted` → `Waiting for PayPal redirect... ×5` → `PayPal not reached`（~40s 主 loop timeout）。约 1/10 偶发。

**根因**：`payment.js` `clickSubmit` 找到按钮 + `btn.click()` 后**立即 `return true`**，没验证 submit 真触发。偶发 React 重渲染时 click event 被吞 / button stale → 外表"click 成功"但 Stripe 后端没收到 submit → 页面停留在 `pay.openai.com` → 主 loop 15 轮 timeout 归 PayPal not reached。

**修复（Playwright 业界 best practice）**：

`clickSubmit` 改 `Promise.race`，在 click **之前** setup 3 个 listener：

1. `page.waitForResponse(matcher)` 监听 Stripe submit API 响应：
   - `/v1/payment_pages/.../confirm|init|finalize`
   - `/v1/(sources|payment_methods|setup_intents)`
   - paypal.com POST（直跳）
2. `page.waitForURL` 检测 URL 离开 `pay.openai.com` / `checkout.stripe.com`
3. `page.waitForSelector` 检测 Stripe error toast（`.SubmitButton-Error` / `[role="alert"]`）— **fail-fast**

6s 内任意 listener resolve → submit 触发（return true）或 fail-fast（return false 让外层 retry）。**6s timeout 无副作用** → click 没触发 → 内层 retry（最多 10 次自动重新找按钮重 click）。

参考：[Playwright Navigations docs](https://playwright.dev/docs/navigations) listener-before-event 模式 + [BrowserStack Playwright waitForResponse guide](https://www.browserstack.com/guide/playwright-waitforresponse)。

**预期效果**：偶发 1/10 → 1/30+（click race 自动 retry 消化）。runner 外层 3 次 retry 兜底不变。

**测试**：304 Node test pass，无 regression。payment.js 行数 +67（30 → 97）。

## v2.43.0 — 2026-05-27

### login_password 死局修复：step 1B 加 screen_hint=login_or_signup

batch 数据显示 ~55% outlook 账号在 step 2 拿 `page.type=login_password` → liveness 归 `login_fail`。reconnaissance 实测确认：**根因是 liveness step 1B 缺关键 query 参数**，protocol_register.py 同账号能拿 `final_url=/email-verification`（OTP path）因为它传了 `screen_hint=login_or_signup`。

**死局验证（5 个 endpoint 全被 OpenAI reject）**：

| Endpoint | 结果 |
|----------|------|
| `POST /password/verify` (DB pw) | 401 invalid_username_or_password |
| `POST /password/verify` (默认 email-@) | 401 invalid_username_or_password |
| `POST /passwordless/send-otp` (referer=log-in/password) | 409 invalid_state |
| `POST /passwordless/send-otp` (referer=create-account/password) | 409 invalid_state |
| `POST /user/register` (默认 22 字符) | 400 invalid_auth_step |

OpenAI 设计上对已注册 `page.type=login_password` 账号**所有切换路径全拒**。唯一办法：**从 step 1 就让 OpenAI 给 OTP path，不要进入 login_password state**。

**修复** (`chatgpt_register/liveness_login.py`)：

1. step 1B `POST signin/openai` 加 query params（参考 protocol_register.py:590-600）：
   - `screen_hint=login_or_signup` ← 关键标志
   - `login_hint=email` / `prompt=login` / `ext-oai-did` / `auth_session_logging_id`
2. step 1 末尾检测 `final_url`：含 `/email-verification` 则**跳过 step 2 POST authorize/continue**（避免把 session 切回 login_password 触发死局），直接进 step 3 IMAP poll OTP

**实测 `okrlx9229`**（v2.42.x batch login_fail）：

```
Step 1 OK: final_url=https://auth.openai.com/email-verification
Step 1 final_path /email-verification — 跳过 step 2
Step 3: IMAP poll OTP
```

流程根本性修通。OTP timeout 是 sing-box 节点 IMAP 不稳 v2.42.x known issue，跟本修复无关。

**参考项目**：`Gpt-Agreement-Payment/CTF-reg/auth_flow.py` 验证 endpoint shape，`protocol_register.py:590` 验证 signin_params 设计。

**测试**：304 Node + 17 Python (3 skip) pass。

## v2.42.2 — 2026-05-27

### 修 sing-box reload 端口冲突 bug

v2.42.0 已知问题：`reloadSingbox = stop + start` 时 stop 在子进程 exit 立即 resolve，但 Windows TCP_TIME_WAIT / OS socket cleanup 慢，port 7890/7891 未真正释放 → start 立刻 spawn 新 sing-box 抢 port 失败 → 抛 `address already in use` → ban-node API 偶发 broken。

**修复** (`server/proxy/singbox.js` `stop()`)：

进程 exit 后用 `net.createServer().listen()` 主动 probe 每个 mixed/http/socks inbound port 能 bind（= OS 已释放），50ms 间隔轮询最多 2s。超时仅 `console.warn` 不阻塞（避免 deadlock，start 自己会抛 EADDRINUSE 比 stop 卡死好）。

`cfgPathSnapshot` 在 `_proc=null` 之前 snapshot 防止并发 `start(newCfg)` 改 `_configPath` 导致 stop 读到新 config 的 port 的 race。

**测试**：

- 304 Node test pass (302 baseline + 2 新单测)
- 实测：连续 2 次 bad-node API 触发 reload → 都成功无 EADDRINUSE

**改动量**：+42 行 stop 函数体 + 20 行单测 = 净 +50 行。

## v2.42.1 — 2026-05-27

### 代理配置清理 + 黑名单 UI 升级

v2.42.0 sing-box urltest 改造后 housekeeping。删 3 个已被 urltest 接管的废弃字段；Config 代理 tab 简化（状态显示转 Dashboard ProxyPanel）；黑名单 tab 升级支持 reason / 解禁时间 / 批量 unban。

**删除（v2.42 后已废弃）**：

- `config.proxy.rotationStrategy` / `proxy.jpCheckout.rotationStrategy` — urltest 内部自动 latency-based 选最优
- `config.proxy.activeHealthCheck` — urltest 内置 probe (interval 3m)
- `server/proxy/index.js` `_state.rotationStrategy` / `rotationIndex` / `rotationKeyword` 等 state 字段
- `getState()` 返回的 `rotationStrategy` / `rotationIndex` / `rotationKeyword` 字段
- Config 代理 tab：rotationStrategy radio UI + "代理状态" / "JP 通道状态" 显示块（转 Dashboard ProxyPanel）
- `proxyStatus` ref + `loadProxyStatus()` 函数 + 周期 setInterval
- `FAIL_THRESHOLD` 常量引用（v2.42 fail-counter 已删）

**新增 / 升级**：

- `GET /api/proxy/blacklist` 返回结构 **superset**：含 `reason` + `bannedUntil` 字段（向后兼容 v2.30 旧 `addedAt` / `tag` 字段）
- `POST /api/proxy/clear-blacklist` 新增 — 按 channel 批量 unban
- Config 黑名单 tab：
  - **reason 列**：Cloudflare 风控 / 速率限制 / 连接重置 等中文 tag (按类型上色)
  - **解禁时间列**：倒计时 "X min 后" / "X s 后" / "已过期"
  - **单个解禁按钮**：调 `POST /proxy/unban-node`
  - **清空按钮改批量 unban**：调 `POST /proxy/clear-blacklist` + 确认对话框
  - 说明文改写："业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期"
  - `normalizeBlacklist` 双轨 fallback：兼容 v2.42.1 新 schema + v2.30 旧 schema + 字符串数组形态
- Config 代理 tab 加引导链接 → Dashboard ProxyPanel 看实时状态

**向后兼容**：

- 老 `config.json` 含废字段 → server 启动忽略不报错
- v2.30 旧 `currentNode` / `nodeTags` / `exitIp` 等 status 字段保留（其他模块可能用）
- 前端兼容新 / 旧 / 字符串数组三种 blacklist API 返回 shape

**Known issues**（v2.42.0 既有，v2.42.1 未修）：

- sing-box reload 期间 stop+start 偶发端口冲突（旧 sing-box 进程未完全 exit 时新 start 失败）— 仅影响 ban-node API 触发的 reload，主流量不影响。后续单独 spec 处理

**改动量**：净减 ~110 行（删 153 行 + 加 43 行）。

详见 `docs/superpowers/specs/2026-05-26-proxy-config-cleanup-design.md` 和 `docs/superpowers/plans/2026-05-26-proxy-config-cleanup.md`。

## v2.42.0 — 2026-05-26

### 系统级透明代理 + 自动 Failover

业务代码不再传 `proxy_url` 参数。所有 fetch / spawn / launchChrome 通过 `HTTPS_PROXY` env 自动走 sing-box。sing-box 改用 `urltest` outbound 自动 latency-based 选最优节点 + dead 节点自动跳过。业务遇 Cloudflare / rate_limited 调 `POST /api/proxy/bad-node` API → server 临时 ban 当前 active 节点 → urltest 自动避开。

#### 应用层 100% 透明（§spec 2）

- **新 `server/proxy/global.js`** — server/index.js 第一行 require，强制覆盖继承的 `HTTPS_PROXY` env（避免 Clash 7897 / V2Ray 10808 / 系统代理污染）+ `setGlobalDispatcher(new EnvHttpProxyAgent())`。`NO_PROXY=127.0.0.1,localhost,.local` 防止 server↔Clash API 死循环
- **删 Node 19 处 `getProxyUrl()` 调用**：protocol-engine / server/engine / discord-gateway / stripe-verify / liveness/{checker,runner,light-login} / verify-t3-account
- **Python 6 脚本顶部 4 行 env setup** + 删 stdin proxy 字段 + 删 `proxies={}` 字典：protocol_register / protocol_phone_verify / stripe_init / checkout_link / liveness_login / liveness_probe
- **Chrome `launchChrome` 默认从 `process.env.HTTPS_PROXY` 读**
- **`chatgpt-checkout.js` 改用 `jpDispatcher`**（唯一显式 dispatcher 注入，1 处例外）+ spawn checkout_link.py 时显式 env override `HTTPS_PROXY=7891`
- **`chatgpt_register/otp.py` IMAP env 重命名** `LIVENESS_IMAP_PROXY` → `HTTPS_PROXY`（PySocks 上下文管理器保留）

#### sing-box urltest（§spec 3）

- **`buildSingboxConfig` main / jp outbound 改 urltest 类型**（interval 3m, tolerance 50ms, idle_timeout 30m）+ `excludeNodes` 参数支持 ban 节点
- **删 `server/proxy/index.js` ~220 行** rotate / probe / markBad / recordBadAttempt / failCount 逻辑（urltest 取代）— 少数仍 stub 化保留 backwards-compat
- **新增** `getActiveNode(channel)` (Clash API `/proxies/{tag}.now`) + `banFromUrltest(node, dur)` (regenerateAndReload sing-box) + `getJpNodeCount()` (JP fail-fast) + `unbanNode(node)`
- **双端口保留**（7890 main / 7891 jp）— sing-box 不支持 path_regex 路由

#### 双层风控（§spec 4）

- **`POST /api/proxy/bad-node` API** 业务上报 — 不传节点名，server 自查 active 节点 ban N 分钟（默认 5）
- **`server/proxy/with-retry.js` `fetchWithRetry` helper**（Node）— 自动检测 Cloudflare 403 / 429 / ECONNRESET 上报 + retry 1 次（500ms 给 urltest 切节点）
- **`chatgpt_register/proxy_helpers.py` `report_bad_node(reason, channel)`**（Python）fire-and-forget 上报 3s timeout
- **3 critical 业务强制改造**：chatgpt-checkout / stripe-verify / liveness_login.py / light-login.js 加 report_bad_node 调用
- **runner.js 等 opt-in**：discord-gateway / phone-pool / zhusms 保留原生 fetch（未来视需求改）

#### 前端

- **`web/src/components/ProxyPanel.vue`** Dashboard 节点状态分区：main / jp 通道当前 active 节点 + 各节点 active/banned/idle 状态 + 解禁时间，10s 自动刷新
- `GET /api/proxy/status` 补 `mainActiveNode` / `jpActiveNode` / `mainNodes` / `jpNodes` / `bannedNodes` 字段（路由层异步包装，不破坏 v2.30 旧字段向后兼容）

#### 防御本地代理软件

用户本地开 Clash 7897 / V2Ray 10808 / Windows 系统代理时，`server/proxy/global.js` 强制覆盖继承的 env，无论本地什么代理软件 server 都只走 sing-box 7890。

#### 测试

- **npm test 302 pass** （218 baseline + 67 liveness + 17 新 proxy = 302 / 22 v2.30 skip 标 TODO archeology）
- **17 Python (3 skipped)** 一致
- **集成测**：手动 ban 当前 active 节点 → urltest 自动切别的节点 ✓
- **端到端**：liabhzo717818 不传 proxy 拿 `deactivated: account_deactivated` ✓（完整 5 步链路）

#### Known limitations

- **discord-gateway WebSocket** 仍用显式 `HttpsProxyAgent`（URL 改为读 `process.env.HTTPS_PROXY`）—— `ws` 库不识别 env，是已知限制
- **`protocol_register.py` 注册流程 SPA 适配**（v2.41.14 spec §4.2 标的另一 TODO）本版本仍不动，需另起 spec
- **sing-box reload 期间 ~500ms inflight 失败**：fetchWithRetry 自动 retry；ban 是低频事件可接受
- **`undici` 不是 Node v22 内置可 require**（实测 Node 把 undici 打包成 internal/deps 仅供 fetch 内置使用），需 `npm install undici`。已加 `dependencies`（^8.3.0）
- **22 个 v2.30 旧 rotate/probe 测试 skip**（行为已被 sing-box urltest 取代）— 留作 archeology，未删

#### 代码量

净减约 200 行（删 ~470 行旧 rotate/probe/markBad + getProxyUrl 调用 + Python proxy 链路；新增 ~270 行 global.js / with-retry / proxy_helpers / getActiveNode/banFromUrltest / ProxyPanel.vue / status routes）。

详见 `docs/superpowers/specs/2026-05-26-system-wide-proxy-design.md` 和 `docs/superpowers/plans/2026-05-26-system-wide-proxy.md`。

## v2.41.14 — 2026-05-26

### SPA OAuth 协议侧重写（liveness 协议模式）

OpenAI 把 `/authorize` 改成 React SPA 后，旧的 6 步 Auth0 form-POST 流程全部失效（v2.41.13 仅做了"page structure 兜底归 unknown 不重试"的伤口包扎，所有 outlook 账号都归 unknown）。本版本完全重写协议侧 `chatgpt_register/liveness_login.py` 走新的 5 步 JSON API + passwordless email OTP flow，**alive outlook 账号现在能正确识别为 plus**（v2.41.13 之前是 0%，现在 100%）。

#### 新 endpoint chain（实测）

1. `GET https://chatgpt.com/auth/login_with?callback_path=/` → 302 chain → `auth.openai.com/log-in`，curl_cffi cookie jar 收齐 25 个 cookies 含**关键的 `oai-client-auth-session`**（server-side auth session 关联 token）
2. `POST /api/accounts/authorize/continue` `{"username":{"kind":"email","value":"..."}}` headers 必带 `openai-sentinel-token` + `oai-device-id` + `ext-passkey-client-capabilities` → 触发 OTP 邮件 + response body 含 `account_deactivated` 时直接 short-circuit
3. IMAP 拉 OTP（`chatgpt_register/otp.py` 改走 HTTP CONNECT proxy via PySocks，国内直连 outlook.office365.com:993 会 SSL handshake timeout）
4. `POST /api/accounts/email-otp/validate` `{"code":"..."}` 同样 headers → 200 (cookies set) | 403 `account_deactivated`/`invalid_code`/...
5. `GET chatgpt.com/api/auth/session` → `{accessToken, user.id, expires}`

#### 三个关键陷阱（reconnaissance 实测）

| 陷阱 | 现象 | 根因 |
|------|------|------|
| step 2 HTTP 409 `invalid_state` | 直访 `auth.openai.com/authorize` 跳过 chatgpt.com 入口 | OpenAI server 内存里 auth session 是 chatgpt.com 跳转链路 set 的 `oai-client-auth-session` cookie 关联的，直访拿不到 |
| step 2 HTTP 200 但邮箱不收 OTP 邮件 | 没带 `openai-sentinel-token` header | `chatgpt_register/sentinel.py` 注释明确写："QuickJS sentinel token 是 OTP 邮件能下发的关键，纯 Python 兜底会 silent-drop" |
| Python imaplib SSL handshake timeout | `outlook.office365.com:993` 国内直连墙了 | PySocks monkey-patch socket，走 sing-box 7890 mixed 端口 HTTP CONNECT。新 env `LIVENESS_IMAP_PROXY` 控制（默认 `http://127.0.0.1:7890`，空走直连保留旧行为） |

#### runner.js 错误码扩展

```js
/deactivated|account_deactivated|account_disabled/  → alive_status=deactivated
/invalid[_ ]?code/                                   → login_fail (invalid OTP)
/unknown[_ ]?user|invalid[_ ]?email/                 → login_fail
/login[_ ]?fail/                                     → login_fail (通用兜底)
```

v2.41.13 加的 `/page structure|page format/` 兜底保留以防回归（新 flow 不再触发）。

#### 测试与验证

- 218 → **285 Node test pass**（顺手把 `server/liveness/__tests__/*.test.js` 加入 npm test，之前 67 个 liveness 测试漏跑）
- 3 新 mock case：`deactivated` / `invalid_code` / `unknown_user`
- 手动 spawn liabhzo717818 完整走通 step 1-5 拿到 `deactivated: account_deactivated`
- Sample 5 账号 e2e：3/3 alive 账号归 plus ✓，unknown=0（v2.41.13 之前 100% outlook 是 unknown）

#### Known limitations

- **`fetch_imap_otp` 节点选择**：sing-box 节点池里只有 CN2-1g-41.88 实测稳定支持 IMAP HTTP CONNECT 到 outlook 993，yulin / CN2-AI-2g 偶发 timeout。server runner 自动 rotate 节点时如果切到 IMAP-unfriendly 节点，deactivated 账号会归 `login_fail: otp timeout` 而不是 deactivated。alive 账号 plus 检测不受影响（probe 直接用 cached access_token 走 `/accounts/check`）。后续单独 spec 处理 IMAP 通道隔离。
- **`protocol_register.py` 注册流程**：未验证是否同步受 SPA 影响。本版本只覆盖 liveness。如发现注册也坏了开新 spec。
- **浏览器模式 lightLogin (`server/liveness/light-login.js`)**：现状是否仍能走通未验证。本版本只覆盖协议模式。

详见 `docs/superpowers/specs/2026-05-26-spa-oauth-protocol-rewrite-design.md` 和 `docs/superpowers/plans/2026-05-26-spa-oauth-protocol-rewrite-plan.md`。

## v2.41.13 — 2026-05-26

### Liveness `authorize page structure changed` 归 unknown 立即 break

v2.41.12 加了 `path=/email-verification|path=/api/accounts` 关键词覆盖 fallback message，但实测 liabhzo717818 raise 含 `path=/authorize`（GET 没 redirect 到 /log-in，拿到完整 OAuth form HTML 但 `<input name="state">` regex 拿不到），仍归 `network_error` retry 3 次。

**真因**：OpenAI 改 authorize page form 结构，`_parse_state_from_authorize_page` regex 跟不上。跟账号 / 代理无关，需要人工排查 regex。

**修复** (`server/liveness/runner.js`)：

```js
else if (/page structure|page format/i.test(msg)) {
  result = { alive_status: 'unknown', alive_reason: 'authorize page structure changed (needs regex update)' };
}
```

插在 token_expired case 之后、proxy reset case 之前。`unknown` 不是 `network_error`，runner.js 既有 `if (result.alive_status !== 'network_error') break;` 自动跳出，不再 3 次无意义 retry。

**测试**：218 Node + 17 Python pass。

## v2.41.12 — 2026-05-26

### runner.js token_expired 关键词扩展 + final_path debug log

v2.41.10 加了 `_final_path.startswith('/email-verification')` 分支 raise `token_expired: OAuth jumped to ...`，runner.js 识别 `jumped to \/email-verification` 关键词。但实测仍归 network_error — raise 走 fallback `unexpected: authorize page structure changed (..., path=/email-verification)`（`_parse_state` 返了非空但无效 state，跳过 token_expired 分支；或者 path 不在白名单内）。

**修复**：

- **`server/liveness/runner.js`** token_expired 正则**扩展**也匹 fallback message 里 `path=\/email-verification|path=\/api\/accounts` 字面
- `server/liveness/runner.js` network_error fallback message slice 40 → 80 字符（path 保留进 DB 便于诊断）
- **`chatgpt_register/liveness_login.py`** Step 1 GET 后加 `_log(f"Step 1 GET response: status=... body_len=... path=...")` debug 输出 final_path

**测试**：218 Node + 17 Python pass。

## v2.41.11 — 2026-05-26

### Liveness HTTP 403 Cloudflare challenge 归 proxy_error（不再 retry 3 次浪费）

实测 `liabhzo717818@outlook.com` 测活：直接 spawn `liveness_login.py` 拿到 `unexpected: authorize page structure changed (HTTP 403, body_len=6966, path=/authorize)`。

**真因**：`/authorize` HTTP 403 + body 6966 字节是 **Cloudflare "Just a moment..." challenge**（不是 OpenAI flow 错误）。v2.41.4 只检 `r.status_code >= 500` 触发 proxy reset，403 漏了 → 走到 `_parse_state` 拿不到 state → 归 `network_error` retry 3 次。

**修复**（`chatgpt_register/liveness_login.py`，5xx + body<500 检测之后加）：

```python
if r.status_code in (403, 429):
    _body_lower = (r.text or "").lower()
    if any(kw in _body_lower for kw in
           ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
        raise Exception(f"proxy reset (login): Cloudflare HTTP {r.status_code}")
    # 非 Cloudflare 的 403/429 继续走 fallback
```

runner.js 既有 `/proxy reset|ECONNRESET/i` 识别（v2.41.4 加）→ `alive_status='proxy_error'`，runner dispatchOne retry loop `if (result.alive_status !== 'network_error') break` 立即跳出，不再 3 次无意义 retry。

**runner.js 零改动**。

**测试**：218 Node + 17 Python pass。

## v2.41.10 — 2026-05-26

### Liveness `/email-verification` 和 `/api/accounts/*` path 归 token_expired

v2.41.9 修了 `/error` path 归 `login_fail`。实测 `liabhzo717818@outlook.com` 又遇到新场景：3 次 attempt 跳 `/email-verification` 和 `/api/accounts/authorize`，都拿不到 state → raise `authorize page structure changed` → runner 仍归 `network_error` retry 3 次。

**真因**：OpenAI 给该账号 OAuth `/email-verification` 表示"已部分认证，需要 OTP reverify"；`/api/accounts/authorize` 是中间 redirect 失败。**两者都属于 `token_expired`** 语义（账号还活，需要重新认证），不是 `network_error`。

**修复 A** — `chatgpt_register/liveness_login.py`：`_parse_state` 缺失时按 final_path 细分：

```python
if _final_path == '/error' or _final_path.endswith('/error'):
    raise Exception("login_fail: OAuth /error redirect")        # v2.41.9

state, _csrf = _parse_state_from_authorize_page(r)
if not state:
    if _final_path.startswith('/email-verification'):
        raise Exception("token_expired: OAuth jumped to /email-verification (needs OTP reverify)")
    if _final_path.startswith('/api/accounts/'):
        raise Exception("token_expired: OAuth stuck at <path> (needs reverify)")
    raise Exception("unexpected: authorize page structure changed (...)")  # fallback
```

**修复 B** — `server/liveness/runner.js`：catch 关键词分支加 `token_expired` 识别，位置 OAuth case 之后、proxy reset 之前：

```js
else if (/token[_ ]?expired|needs.*OTP|needs.*reverify|jumped to \/email-verification|stuck at \/api\/accounts/i.test(msg)) {
  result = { alive_status: 'token_expired', alive_reason: 'OAuth needs OTP reverify' };
}
```

runner dispatchOne retry loop `if (result.alive_status !== 'network_error') break` — `token_expired` 立刻跳出，不再 3 次无意义 retry。

**测试**：218 Node + 17 Python pass。

## v2.41.9 — 2026-05-26

### Liveness 测活 OAuth /error 页归 login_fail（不再误报 network_error retry）

实测某账号测活日志：

```
[Deactivated] Authorize -> /error
[Deactivated] Step 2: Authorize -> /error (not deactivated)
network_error: unexpected: unexpected: authorize page structure cha — retrying 1/3 in 2s
```

**根因**：`deactivated_check.py` 跳到 `/error` 路径时 emit `active`（runner 只关心 `deactivated` 值），runner 继续 lightLogin → `liveness_login.py` GET authorize 也跳 `/error` 页（HTML body 完整含 OAuth error 提示但没 `state` query / 没 `<input name="state">`）→ `_parse_state_from_authorize_page` 返 None → raise `authorize page structure changed` → runner 关键词匹不中归 `network_error` retry 3 次都同样结果。

**真因**：OpenAI 给该账号 OAuth `/error`（账号问题，非 deactivated 但 OAuth flow 错）。应归 `login_fail` 不重试。

**修复**：

- **A. `chatgpt_register/liveness_login.py`** — Step 1 GET authorize 后，`_parse_state` 之前检测 `final_path == '/error'` → raise 含 `OAuth /error redirect` message
- **B. `server/liveness/runner.js`** — catch 关键词分支加 case `/oauth.*\/error|oauth\s*error|OAuth.*redirect/i` → `alive_status='login_fail'`，插在 `proxy reset` case 之前防 message 含 'proxy' 误匹

**测试**：218 Node + 17 Python pass。

## v2.41.8 — 2026-05-26

### Accounts 活性列 plus 区分有RT / 无RT（主 tag + 副 tag）

`AccountsTable.vue` 活性列原本 `plus` 统一显示 "Plus"。用户诉求：区分有 refresh_token / 无 refresh_token。

**改动**：

- **`server/routes/results.js`** 加 `hasRefreshTokenInCPA(email)` helper + `/api/results` 返回字段 `hasRefreshToken`：parse `cpa-auth/codex-{email}.json` 的 `refresh_token` 字段非空且长度 > 10
- **`Accounts.vue#load()`** 注入 `_hasRefreshToken` 视图字段
- **`AccountsTable.vue` 活性列**：
  - 主 tag 仍是 `aliveStatusLabel`（`Plus` / `已取消` / ...），外层 `<el-tooltip :content="row._aliveReason">` hover 看 alive_reason（v2.41.8 followup 补回，主 v2.41.8 commit 时丢失）
  - **新增副 tag**：`row._aliveStatus === 'plus'` 时显示 `RT`（success / plain）或 `无RT`（warning / plain）
  - 列宽 120 → 160（容纳副 tag）
- **`sortHelpers.js byAliveStatus`** 拆 plus tier：有RT = 0，无RT = 0.5，均在 unknown (tier 1) 之前。配合 v2.41.6 / v2.41.7 "能用优先" 排序

**不变**：

- `Accounts.vue#visibleGroups` 分组维度不细分（plus 仍单一组，内部排序用户点表头）
- 后端 statusDB schema 不动
- liveness 测活流程 / chatgpt_register 不动
- Execute 侧 `AccountTableRows.vue` 不动（Execute `_status` 已经有 `plus` / `plus_no_rt` 之分）

**测试**：218 Node + 17 Python pass。web build 成功。

## v2.41.7 — 2026-05-26

### 账户列表表头加可排序（Accounts 和 Execute 两侧）

用户诉求：两个表格的列表头可点击排序。

**改动**：

- **新建 `web/src/sortHelpers.js`** (58 行) — 抽公共排序常量 + 比较函数：
  - 常量 `PLAN_PRIORITY` / `ALIVE_TIER` （v2.41.6 在 `Accounts.vue` 加的，本次抽出共享）
  - 比较函数 `byPlan` / `byAliveStatus` / `byExecuteStatus` / `byAliveCheckedAt` / `byHasAuth`
  - el-table-column `:sort-method` 兼容 `(a, b) => number`

- **`AccountsTable.vue`** 7 列 sortable：邮箱 / 类型 / 计划（byPlan 业务序）/ 活性（byAliveStatus 三档）/ 上次测活（byAliveCheckedAt 时间戳）/ 凭证（byHasAuth）/ 字母排（邮箱 + 类型）。selection / expand / # / 密码 / 操作不排
- **`AccountTableRows.vue`** 7 列 sortable：邮箱 / 类型 / 计划 / 状态（byExecuteStatus 按 GROUP_ORDER）/ 阶段 / Auth / 原因。selection / # / 操作 / expand 不排
- **`Accounts.vue`** 把 v2.41.6 局部 `ALIVE_TIER` / `PLAN_PRIORITY` 改 import 自 sortHelpers（去重）

**实现细节**：

- `byAliveStatus` / `byAliveCheckedAt` 用 view-model 字段 `_aliveStatus` / `_aliveCheckedAt`（带下划线前缀，由 `Accounts.vue#load()` 注入；row 上没 snake_case 原字段）
- 不设 `:default-sort`，保留 v2.41.6 的 visibleGroups 业务序作为初始顺序
- 分组视图：每个 collapse-item 独立 el-table，sort 仅作用该组内（el-table 默认行为）
- 平铺视图：单 table，sort 作用全 filteredRows

**已知 minor**：`AccountsTable` "凭证" 列视觉是 TOTP/Client ID/RT 三圆点（凭据完整性），sortable 按 `_hasAuth`（CPA/Sub2API 文件是否生成）。语义略偏，后续根据用户反馈再细化（v2.41.8 候选）。

**测试**：218 Node + 17 Python pass。web build 成功（新 sortHelpers chunk 1.76 kB / gzip 0.95 kB）。

## v2.41.6 — 2026-05-26

### Accounts 分组排序按"能用优先"（不能用的往后排）

v2.41.2 引入分组视图后默认按 `b.rows.length - a.rows.length` count 倒序排。用户诉求：能用的优先，不能用的往后。

**改动**（只动 `web/src/views/Accounts.vue` +24/-1）：

- 加 `ALIVE_TIER` 3 档：能用 (`plus` tier 0) → 未知 (`unknown`/`checking`/`canceled`/`proxy_error`/`network_error` tier 1) → 不能用 (`deactivated`/`login_fail`/`token_expired` tier 2)
- 加 `PLAN_PRIORITY` 3 档：`plus` 0 → `unknown` 1 → `free` 2
- 加 `groupPriority(key)` helper 按当前 `groupBy` 返 priority；`loginType` 全部 priority 0（保留 count 倒序原行为）
- `visibleGroups` 排序：主键 priority asc（能用在前），次键 `rows.length` desc

**测试**：218 Node + 17 Python pass。

## v2.41.5 — 2026-05-26

### Accounts 测活日志改每账号 expand row（删底部集中面板）

参照 Execute.vue / AccountTableRows.vue 模式，账号管理页的测活日志从底部集中"测活日志"面板（旧日志 / 实时日志 两个混在一起的 collapse）改为**每行 expand row 展开看自己的日志**。

**改动**：

- **`AccountsTable.vue`** (+49) — 加 `<el-table-column type="expand">` 列 + 2 个 props (`getHistoryLogs` / `getRealtimeLogs`，默认 `() => () => []`)。expand template 渲染该账号 history (默认折叠 ▶) + realtime logs，格式 `[YYYY-MM-DD HH:mm:ss] [level] message`，不含 email（已在该账号 expand 内）
- **`Accounts.vue`** (+25/-60) — 删 line 120-150 集中"测活日志"SectionCard；加 `getHistoryLogs(email) = oldLogs.filter(log => log.email === email)` 和 `getRealtimeLogs` 同款 filter；模板 `<AccountsTable>` 传 prop
- **`socket.js` / 后端** 零改动 — 既有 `socketState.liveness.oldLogs` / `newLogs` 全账号混合数组保留，按 email filter 即可

**附带 cleanup**：implementer 清掉只服务于已删集中面板的 dead code — `oldLogsExpanded` / `newLogsExpanded` / `newLogsContainer` ref + auto-scroll watch + auto-expand-on-running watch + `.liveness-log-list` / `.log-*` CSS。

**测试**：218 Node + 17 Python pass。web build 成功（Accounts chunk 28.82 kB）。

## v2.41.4 — 2026-05-26

### Liveness 测活错误分类细化 + 并发降到 1（避免触发 OpenAI/Cloudflare 限速）

实测 5 账号并发测活：5 个代理节点全部被 bad attempt 拉黑（`liveness_net_error`），sing-box 报 `unexpected EOF` + `forcibly closed by remote host`。Python `liveness_login.py` 拿到 partial/empty response，`_parse_state_from_authorize_page` 返 None → raise `"unexpected: no state in authorize page"` → runner 归 `network_error`（掩盖了真因是 connection close）。

**真因**：OpenAI/Cloudflare 对并发 5 账号测活的所有出口 IP 速率限制。

**修复 A — 错误分类细化** (`chatgpt_register/liveness_login.py`)：

Step 1 GET authorize 后，在 `_parse_state` 之前先判 HTTP/body 状态：

```python
if r.status_code >= 500:
    raise Exception(f"proxy reset (login): HTTP {r.status_code}")
body_len = len(r.text or "")
if body_len < 500:
    raise Exception(f"proxy reset (login): HTTP {r.status_code} body_len={body_len}")
state, _csrf = _parse_state_from_authorize_page(r)
if not state:
    raise Exception(f"unexpected: authorize page structure changed (HTTP {r.status_code}, body_len={body_len}, url={str(r.url)[:80]})")
```

runner 已识别 `proxy reset` 关键词 → 归 `proxy_error`（而非 `network_error`），用户能区分真因。HTTP 200 + body 完整但 state 缺失才算 `authorize page structure changed`。

**body_len=500 阈值**：经验值。实际 authorize page HTML 含 Auth0 form + scripts 远超 5KB，短期安全。OpenAI 改 page 骨架低于 500 字节才会误报。

**修复 B — 并发降到 1** (`server/liveness/runner.js`)：

```js
const CONCURRENCY = 1;        // 旧 3
const THROTTLE_MS = 3_000;    // 旧 1000
```

顺序跑 + 账号间 3s 间隔。**牺牲速度换稳定**：N 账号耗时近似 N×3s + N×登录耗时。大批量需要并发可手动改这两个常量或后续做 env 配置。

**测试**：218 Node + 17 Python pass。`tests/test_liveness_login.py` mock 加 600 字符 body 反映真实 authorize page（修复 A 的连带改动 — 旧 mock text='' 会走新 guard）。

**文件**：

- `chatgpt_register/liveness_login.py` (+8/-1)
- `server/liveness/runner.js` (+4/-2)
- `tests/test_liveness_login.py` (+7/-2)

## v2.41.3 — 2026-05-26

### selection store 引用替换 bug 修复（选中数累加不清空）

实测 Accounts.vue 选中 → 取消选中 → 再选中，ContextActionBar 显示选中数累加不归零。Execute.vue 同样 buggy（用户未注意到）。

**根因**：`web/src/selection.js`：

```js
export function clearSelection(page) {
  state[page] = new Set()   // ← 替换引用！
}
```

但 view 层：

```js
const globalSelectedSet = getSelectionSet('accounts')   // 拿快照到 const
```

`const` 永远指向**初始 Set 引用**。后续 `clearSelection('accounts')` 替换 `state.accounts` 为新 Set，但 view 层的 `globalSelectedSet` 常量还指着旧 Set，永远不会被清空 → 累加。

**修复**：`setSelectionFromRows` 和 `clearSelection` 都改用 in-place `.clear()`，保持引用稳定：

```js
export function setSelectionFromRows(page, rows) {
  if (!state[page]) state[page] = new Set()
  else state[page].clear()
  for (const r of rows) state[page].add(r.email)
}

export function clearSelection(page) {
  if (state[page]) state[page].clear()
  else state[page] = new Set()
}
```

**影响范围**：

- 修 Accounts.vue（v2.41.2 引入分组视图后才暴露）
- 修 Execute.vue（v2.34.0 以来一直 buggy，但用户未注意到）

零 view 改动 — 仅 `web/src/selection.js` 5 行修改。218 Node pass。web build 成功。

## v2.41.2 — 2026-05-26

### Accounts.vue 加分组视图（plan / alive_status / loginType 三维度切换）

参照 Execute v2.34.0 分组模式给账号管理加分组查看。Execute 视角关心 pipeline 执行状态，Accounts 视角关心账号属性（计划/活性/登录类型），所以分组维度不同 + 顶部加 select 切换。

**改动**：

- **抽组件 `web/src/components/AccountsTable.vue`**（176 行）：把 Accounts.vue 原 `<el-table>` + 8 列 + 凭证 popover + 密码眼睛切换 + 操作按钮 (编辑/删除/CPA/Sub) + row-class 行高亮全部抽出。Props: `rows` / `globalSelectedSet`，Emits: `selection-change` / `row-click` / `copy` 等。
- **`web/src/views/Accounts.vue`** (+227 / -136, 760 → 811 行)：
  - 顶部工具栏加 `<el-switch>` 分组开关（默认平铺）+ 仅分组时显示的 `<el-select>` 分组维度（按 Plan / 按 活性 / 按 登录类型）
  - 分组视图：`<el-collapse>` + `v-for visibleGroups`，每组独立 `<AccountsTable>`
  - 平铺视图（默认）：单 `<AccountsTable :rows="filteredAccounts">`
  - `visibleGroups` computed 按 `groupBy` 切换三维度分组逻辑，按 count 倒序
  - **selection 跨组共享**：新加 `globalSelectedSet = getSelectionSet('accounts')`（参照 Execute）。既有 `selected` ref 通过 `syncSelectedFromGlobal` 单向投影，最小化对 `exportSelected` / `delSelected` / `startLiveness` 等既有函数的改动
  - `expandedKeys` 在 `visibleGroups` 变化时 immediate 全展开

**alive_status 标签**：复用 `status.js` 的 `aliveStatusLabel`（"Plus / 已取消 / Token过期 / 未测试 / ..." 细分），比"活/死/未检测"三分类更准。

**不变**：
- ContextActionBar 行为零改动
- row 2 测活控制零改动
- 后端零改动
- selection store 零改动

**测试**：218 Node pass（无后端改动 baseline 不变）、web build 成功（Accounts chunk 28.51 kB，AccountsTable static-imported 合并到 Accounts chunk）。

## v2.41.1 — 2026-05-26

### Execute.vue 选中操作迁移到 ContextActionBar（与 Accounts 体验统一）

`web/src/views/Accounts.vue` v2.35 起用 `ContextActionBar` 实现"选中 > 0 时底部悬浮操作 bar"模式，`Execute.vue` 仍把选中相关操作（执行选中 / 下载选中 / 取消选中）放顶部工具栏，样式不一致。

**改动**：

- **顶部工具栏 row 1**：8 element → 5 element（执行全部 / 重试失败 / 停止 / 下载全部 / 分组开关）
- **新增 `<ContextActionBar>`**（参考 Accounts.vue:85）放在平铺 AccountTableRows 之后、外层 div 收尾之前，选中 > 0 时滑入：
  - `[N 个账号]` 计数
  - `执行选中` button（不再带 (N) 计数 — 避免与左侧重复）
  - `下载选中 ▼ CPA/Sub2API` split-button dropdown
  - 内置 `取消选中` clear button（@clear → clearAllSelection）
- `import ContextActionBar from '../components/ui/ContextActionBar.vue'`

**不变**：

- script setup 函数体（`execSelected` / `downloadSelectedAs` / `clearAllSelection` / `selectedEmails` 等）零改动
- row 2 筛选区零改动
- AccountTableRows / 分组逻辑零改动
- ContextActionBar 组件本体零改动
- 后端零改动

**测试**：218 Node pass（无后端改动 baseline 不变）、web build 成功（Execute chunk 17.23 kB，复用既有 ContextActionBar chunk 1.13 kB）。

**Spec**：`docs/superpowers/specs/2026-05-26-execute-context-action-bar-design.md`

## v2.41.0 — 2026-05-26

### 删除"执行结果"页面（功能跟 Accounts 重叠）

v2.29.1 (FX-2) 把 Results 从孤儿路由加进侧栏菜单，但实际使用中：

- 跑完即用工作流 → cpa-auth/ 文件夹 + Accounts 页"下载 CPA / Sub" 按钮已够
- Results 页"下载所有 / 下载选中" 跟 Accounts v2.30 加的同样功能重叠
- 用户工作流没回看历史的需求

**删除范围**：

- `web/src/views/Results.vue` 整个视图
- `web/src/router.js` `/results` 路由
- `web/src/components/AppLayout.vue` 侧栏菜单"执行结果"项 + Command Palette `nav.results` 命令
- `web/src/views/Dashboard.vue` "近期执行"卡片右上"查看全部 →"按钮

**保留**（被其他视图依赖）：

- `server/routes/results.js` 全部 endpoints：`/api/results` (Dashboard 近期表格用)、`/download-all` / `/download-selected` / `/:email/auth-file` (Accounts/Execute 下载用)、`/:email/logs` (Execute 查日志用)、`/:email/retry`

**UI 效果**：侧栏 6 项 → 5 项（仪表盘 / 账号管理 / 执行控制 / 号池 / 配置设置）。Dashboard "近期执行"卡片仍在；Accounts/Execute 下载与日志功能完全不变。

测试：218 Node pass（无后端改动）+ web build 成功。

## v2.40.9 — 2026-05-26

### 浏览器 token exchange 走代理 + 协议 first-time-consent intermediate URL fix

**v2.40.9 — utils.js token exchange 走代理**：浏览器侧 add_phone 全流程代理覆盖审计发现 `utils.js:533 fetch('https://auth.openai.com/oauth/token')` Node 端 fetch **没传 agent → 直连**绕过 sing-box 代理。Node 默认 fetch 不读 HTTPS_PROXY 也不读 OS 系统代理。之前能拿 RT 是因为 auth.openai.com CDN 边缘碰巧直连可达，但 OAuth state 期间 IP 出口不一致会触发 OpenAI 风控。修复：`agent: HttpsProxyAgent(http://127.0.0.1:7890)` if proxy.enabled。

**v2.40.7/8 — 协议 first-time-consent intermediate URL follow**：实测 ityg8091 fresh 账号场景：phone-otp/validate 通过 + workspace/select 200，但 response.continue_url 不是 localhost callback 而是 hydra OAuth 中间步骤 `/api/oauth/oauth2/auth?login_verifier=...`，GET 该 URL OpenAI 返 Empty reply (curl 52)。

- v2.40.7: `_pkce_common.follow_continue_for_auth_code` consent fallback 检测 continue_url 非 localhost 时 follow 一次 redirect 跟 chain
- v2.40.8: GET intermediate URL 加完整浏览器 navigation headers（Accept / Accept-Language / Sec-Fetch-Site/Mode/Dest/User / Referer）+ H1 fallback 防 HTTP/2-only reject

**已 consented 账号路径不受影响**（OpenAI 直接给 localhost callback URL）—— cmdxps7772 / fbpi1478530 / ityg8091（浏览器跑过一次 consent 后协议跑）已实测拿 RT。

**待 fresh alive 账号验证 first-time-consent end-to-end**（账号库批次较旧，多数已 deactivated）。

**全代理审计结论**：

| 调用 | 状态 |
|---|---|
| 协议 (Python) phone-start / phone-otp/validate / consent fallback / workspace/select / oauth/token / SMS poll | ✅ session.proxies 全覆盖 |
| 浏览器 Chrome 内 OpenAI 请求 | ✅ `--proxy-server` |
| 浏览器 Node fetchSmsCode / zhusms-provider | ✅ HttpsProxyAgent |
| 浏览器 Node oauth/token | ✅ v2.40.9 修复后 HttpsProxyAgent |
| IMAP OTP 邮件抓取（utils.js:83 + ImapFlow） | ⚠️ 直连 Microsoft/Outlook，不在 add_phone 主流程 |

测试：218 Node + 17 Python pass。

## v2.40.6 — 2026-05-26

### PHONE_VALIDATE_PATH regression 永久 fix

v2.40.0 smoke 实测确认 OpenAI phone-validate 真实端点是 `/api/accounts/phone-otp/validate`（不是 `/add-phone/validate`，后者 HTTP 404 "Invalid URL"），当时改了常量但**没 commit** → 后续 v2.40.x 多次 hotfix `git checkout protocol_phone_verify.py` 时被还原回占位。今天 objs9258 + 新号 +19043865442 实测 phone-start 200 + SMS 200 但 validate 404 → 暴露此回归。

- 修：常量永久写死 `/api/accounts/phone-otp/validate`
- 加 regression test `test_phone_validate_path_is_phone_otp` grep 源码防再次回归

测试：17 Python + 218 Node pass。

## v2.40.5 — 2026-05-26

### voip_phone_disallowed 也升级到 markSaturated（号本身永久不能用）

v2.40.4 把账号级风控（`fraud_guard` / `rate_limit_exceeded`）标记号 saturated，但**号本身**就是 VoIP（`voip_phone_disallowed`）这种情况还是走 phone-rejected `release + retry`。但 VoIP 是号本身属性，**对所有账号都拒** —— 没必要每个账号都试一遍才知道，应该一次性 markSaturated。

**改动**：

- **`protocol_phone_verify.py:classify_reject`** 加新 kind `"voip"`：error.code 含 `voip` 或 message 含 `voip` 时归本类
- **Python `main()`** 输出 `status: "voip-blocked"`
- **`protocol-engine.js:_finalizePhoneVerify`** 把 `voip-blocked` 加入 `markSaturated` 分支（与 `rate-limited` / `fraud-blocked` 同处理）
- **日志措辞**：原 `[protocol] account-level block ${status}` 改 `[protocol] block-and-saturate ${status} for ${phone}`（voip 不是 account-level）
- **测试调整**：原 `test_phone_start_rejected` 用 voip_phone_disallowed 期望 phone-rejected → 拆成 `test_phone_start_rejected_voip` (期望 voip-blocked) + `test_phone_start_rejected_unknown` (用 phone_send_failed 期望 phone-rejected 保守 retry)
- **DB 修复**：`+19286413808`（实测 VoIP）已在生产 DB 标记 saturated

**浏览器侧 utils.js 保持不变**（保守 release + retry）—— 浏览器靠 red-text 文本检测，"Invalid phone number" 也可能是其他原因，不像协议侧靠明确 error.code 那样确信。

**测试**：16 Python + 218 Node pass。

## v2.40.4 — 2026-05-26

### 账号风控号 → 标记 saturated（永久排除给所有后续账号）

v2.40.3 协议侧能识别 `fraud_guard` / `rate_limit_exceeded` 立刻 break 不 retry，但**该号仍可被其他账号 acquire** —— 既然 OpenAI 已经对它 flag，给其他账号继续用大概率仍被拒，浪费 SMS 名额。

**用户诉求**：出现 fraud_guard / rate_limit 的号，**无论已经使用了几次**，都直接标记为「用满」（`bindings_used = maxBindingsPerPhone`），让 acquirePhone SQL 的 `WHERE bindings_used < max` 自动排除给所有后续账号用。

**实现**：

- **`server/phone-pool.js:markPhoneSaturated(db, phone, max)`** —— 新函数，把 `bindings_used` 直接拉到 `max`。**不删 binding 行**（保留历史），**不可逆**（手动 UPDATE 可恢复）。
- **`protocol-engine.js:_finalizePhoneVerify`** `rate-limited` / `fraud-blocked` 分支改：local provider 调 `markPhoneSaturated`（不是 releaseFn）；zhusms 仍 cancelOrder。
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支加账号风控 red-text 检测（"suspicious behavior" / "similar to yours" / "too many phone verification" / "rate limit" / "fraud"），命中时调 `saturateFn`（v2.40.4 新增 binding helper）+ 立刻 break，返 `{phoneVerifyFail: 'account-blocked'}`。
- **测试 +1**：`P5c markPhoneSaturated 拉 bindings_used 到 max 排除所有后续账号`（218 pass）。

**DB 修复**：本次 v2.40.4 把已观测触发风控的 2 个号 `+12153910969`（fraud_guard）+ `+12282351427`（rate_limit_exceeded）已在生产 DB 标记 saturated。

**语义说明**：

- `bindings_used >= max`：号在 OpenAI 那边已被 flag，所有未来 acquire 直接跳过
- binding 行保留：历史"哪个账号在该号上失败过" 不丢
- 恢复方法：OpenAI 风控通常 24-72h 解除，可手工 `UPDATE phone_pool SET bindings_used = <N> WHERE phone = ?`，N < max 即可重新启用该号

## v2.40.3 — 2026-05-26

### 协议侧 add_phone 区分账号级风控 vs 号问题（+ rebuild_session 白名单）

v2.40.2 上线后 objs9258 实测两次 phone-start 都 HTTP 400 但 error.code 不同：

- `+12153910969` → `code: "fraud_guard"`（"We've detected suspicious behavior from phone numbers similar to yours"）
- `+12282351427` → `code: "rate_limit_exceeded"`（"You've made too many phone verification requests"）

**问题**：v2.40.2 把所有 4xx 一律归 `phone-rejected` retry 换号 —— 但这两个 code 是**账号-级**封锁，换号也被拒，retry 浪费 spawn / SMS 名额。

**修复**：

- **`protocol_phone_verify.py:classify_reject(resp)`** —— 新函数细分拒号类型：
  - `"rate-limit"` ← `rate_limit_exceeded` / "too many" / "rate limit" 关键词
  - `"fraud"` ← `fraud_guard` / "suspicious" / "similar to yours" 关键词
  - `"phone"` ← 其它 4xx（如 `voip_phone_disallowed`，号本身问题）
  - `None` ← 不是拒号
- **Python `main()`** 按 kind 输出对应 status：`rate-limited` / `fraud-blocked` / `phone-rejected`
- **`protocol-engine.js:_finalizePhoneVerify`** 加新分支：`rate-limited` / `fraud-blocked` → **立刻 break + release**，不浪费 retry attempt
- 既有 `phone-rejected` → release + retry（语义不变）
- 既有 `is_phone_rejected(resp)` boolean wrapper 保留，但内部走 `classify_reject`

**附带**：`_pkce_common.rebuild_session` candidate 用 KNOWN_GOOD 白名单提前过滤（含 `chrome133a` 别名），防止 curl_cffi lazy validation 拿到 invalid Session 后 phone-start 才挂。

**未做**：浏览器侧 `utils.js` red-text 检测应该也区分账号锁不 retry —— 留 v2.40.4 处理（浏览器侧需 `page.on('response')` 监听 HTTP API + body 解析）。

**测试**：217 Node + 15 Python pass。

## v2.40.2 — 2026-05-26

### 协议侧 protocol_phone_verify spawn 几个 hotfix

v2.40.1 上线后 objs9258 实测发现 3 个 `protocol_phone_verify.py` 边缘问题：

1. **`rebuild_session` UA `Chrome/148` → curl_cffi 没 `chrome148` profile → `ImpersonateError`** —— v2.40.0 fallback 单一 `chrome120` 也未必在 curl_cffi 支持列表（取决于 curl_cffi 版本）。修：candidate loop 7 个 profile 逐个 try（UA-derived + chrome146/142/136/131/124/120/chrome 通用别名），与 `protocol_register.py:_CHROME_PROFILES` 对齐。
2. **Python `print(json.dumps(...))` 不带 `flush=True`** —— Node 端 spawn 180s timeout SIGKILL 时 stdout buffer 没刷盘，Node 收到空 → fallback "python exit 1" 误归 post-validate-error 保留 binding。修：10 处 status print 全部 `flush=True`；top-level `try/except` 包 `main()` 保证未捕获异常也输出 JSON。
3. **`_finalizePhoneVerify` 把 spawn `submit-error` 误归 post-validate-error 保留 binding** —— `submit-error` 是 spawn 失败/python crash/stdin 错，号实际没用上，binding 应该 release。修：把 `submit-error` 也归到 `sms-timeout`/`validate-error` 同处理路径（release + break）。

**附加调试改进**：

- `protocol_phone_verify.py:main()` 加 step-by-step `_log`：stdin 字节数、cookies 数、UA Chrome 版本、proxy / no proxy、phone-start status + body 前缀。
- `protocol_phone_verify.py` 错误 `r.text` 截断 120 → 300 字符（看完整 OpenAI error.code）。
- `protocol-engine.js` spawn stderr 截断 200 → 800、detail 日志 80 → 500。

**Smoke 验证**：objs9258 触发 add_phone retry loop —— v2.40.1 excludePhones 工作（两次 attempt 取不同号 +12153910969 / +12282351427），v2.40.2 spawn flush 工作（两次都正确返 `phone-rejected` 状态），v2.40.2 release 工作（DB binding 干净不被错误保留）。

**未解决业务问题**：objs9258 两个号都被 OpenAI 拒 (`HTTP 400 invalid_request_error`) —— 推测 OpenAI 对该账号短窗口内多 phone-start 风控。**不是代码问题**，等待 / 换账号 / 隔时间重试可恢复。

## v2.40.1 — 2026-05-26

### add_phone retry 反复取同号 + 浏览器 voip 文案漏检 + 默认 maxBinding 3

v2.40.0 上线后实测发现三个 paper cuts（不影响主功能但浪费 spawn / 误归类 / 默认值不符合实际策略）：

1. **`acquirePhone` retry 反复取同号** —— `release` 后 `bindings_used` 回最低，下次 `acquirePhone` 又取它，3 次 retry 全打同一号。修：`acquirePhone(db, email, max, excludePhones=[])` 新增第 4 参数，retry 内 caller 维护已尝试号列表。
2. **浏览器侧 red-text 漏 `voip_phone_disallowed` 文案** —— OpenAI 实际渲染 "Invalid phone number. Please try again."，v2.39.4 regex 只覆盖中文「无法发送」+ 英文 "Unable to send" / "cannot send" 三种，VoIP 拒号 fall through 到 submit-error。修：regex 加 `Invalid phone number`。
3. **默认 `maxBindingsPerPhone: 5` → `3`** —— v2.37.0 spec 默认 5 偏宽。实测 OpenAI 允许同号多绑但 SMS 接码方限频，3 是更稳健的默认值。

**修改**

- **`server/phone-pool.js:acquirePhone`** 新增 `excludePhones=[]` 参数，SQL 多加 `AND phone NOT IN (...)` 排除已尝试号。
- **`utils.js:fetchTokensViaPKCE`** add_phone retry loop 维护 `triedPhones` 列表，每次 `acquirePhone` 传入；red-text 正则加 `Invalid phone number`。
- **`protocol-engine.js`** `_finalizePhoneVerify` retry loop 同步维护 `triedPhones`，`_acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones=[])` 加参数。
- **`config.example.json`** `phonePool.maxBindingsPerPhone` 默认 5 → 3；既有用户 config 不动（fallback `|| 3`）。

**测试**：1 个新单测 `P5b acquirePhone excludePhones` 覆盖 retry 内排除逻辑。217/217 pass。

**不变式**：既有 `acquirePhone(db, email, max)` 3 参调用兼容（第 4 参 default `[]`）；既有用户 config 行为不变（`maxBindingsPerPhone` 已设则 fallback 不触发）。

## v2.40.0 — 2026-05-26

### 协议模式 PKCE add_phone 自动化（与浏览器模式 v2.39.4 等价）

v2.39.4 完成浏览器模式（PipelineEngine + Playwright）add_phone 自动化后，协议模式（ProtocolEngine + Python curl_cffi）一直只检测 add_phone 就 fallback 到 `plus_no_rt`。本次补齐协议侧**纯 HTTP**实现，两个模式功能对齐。

**架构**：Node 端 `_finalizePhoneVerify` retry loop 拿号 → spawn `protocol_phone_verify.py` 单次 attempt HTTP 流程 → 按 5 个 status 分流：

- `ok` → tokens 入袋 → `status=plus`
- `phone-rejected` (HTTP 4xx + invalid_request_error，已观测 `voip_phone_disallowed`) → releaseBinding + 换号重试（最多 3 次）
- `sms-timeout` → release + break
- `validate-error` (phone-otp/validate 拒) → release + break
- `post-validate-error` (validate 通过后续步骤失败) → **保留 binding** + break

**新增**

- **`_pkce_common.py`** PKCE 公共函数（抽自 `protocol_register.py`）：`get_sentinel_token` / `_post_with_h1_fallback` / `follow_continue_for_auth_code` / `exchange_code` / `rebuild_session` / `_serialize_cookies`
- **`protocol_phone_verify.py`** 协议模式 add_phone 单次 attempt 脚本（与 v2.39.4 浏览器侧功能等价）
- **`protocol-engine.js`** `_finalizePhoneVerify` retry loop + `_acquirePhoneForProtocol` (local + zhusms 并列) + `runProtocolPhoneVerify` spawn helper
- **`docs/superpowers/research/2026-05-26-openai-add-phone-http.md`** Phase 0 抓包报告（含浏览器侧 capture 推证）

**修改**

- **`protocol_register.py`** 3 处 `return {needsPhone: True}` 改为附带 `session_state`（含 cookies / device_id / UA / code_verifier 等），4 处重复 `follow continue` 逻辑改用 `_pkce_common` 公共函数
- **`protocol-engine.js:_finalizePkce`** `needsPhone` 分支不再 fallback `plus_no_rt`，改调 `_finalizePhoneVerify` 走 add_phone 流程；status 映射与浏览器侧对齐

**OpenAI HTTP 端点**（Phase 0 confirmed）

- `POST /api/accounts/add-phone/send` body=`{phone_number}` — 拒号 4xx + `invalid_request_error` / 接受 200 + `continue_url=/phone-verification`
- `POST /api/accounts/phone-otp/validate` body=`{code}` — 验证码错 4xx / 通过 200 + `continue_url`（已 consented 账号直跳 callback；新账号跳 `/sign-in-with-chatgpt/codex/consent`）

**Consent fallback（新发现）**

新账号第一次 OAuth + 经过 add_phone 后 OpenAI 强制 consent UI。浏览器侧主循环点 "继续" 按钮（v2.39.4 路径），协议侧 `_pkce_common.follow_continue_for_auth_code` 内置 fallback：

1. GET `/sign-in-with-chatgpt/codex/consent` (Remix Turbo Stream HTML ~50KB)
2. regex 在 `workspaces` 关键字附近 1200 字符内抓 workspace UUID
3. POST `/api/accounts/workspace/select` body=`{workspace_id}` → 200 + callback URL
4. parse_qs 提 auth_code → token exchange

已 consented 账号 OpenAI 直接给 `continue_url=localhost:1455/...?code=...`，第一段 GET 提到 code，consent fallback 不触发。

**测试**

- Python 8 个新单测：`tests/test_protocol_phone_verify.py`
- Node 10 个新单测：`server/__tests__/protocol-phone-verify.test.js`
- 总数 231 pass（15 Python + 216 Node = baseline 206 + 18 新 + 7 既有 Python）

**Smoke 验证**

- `fbpi1478530@outlook.com`（未绑账号 + 新 OAuth + 需 consent）协议模式 → `status=plus` + RT/AT/id_token 入袋 ✓
- `cmdxps7772@outlook.com`（已绑 + 已 consented）协议模式 → 直接 callback 拿 RT ✓
- 全 3 attempt VoIP 号拒 → `all-phones-rejected` + `phone_verify_fail` status ✓

**附带发现 (v2.40.1+ 改进项)**

- OpenAI 允许同号给多个账号绑（`+12282351427` 同绑 cmdxps7772 + fbpi1478530），v2.37.0 "永久 binding" 语义可放宽
- v2.39.4 浏览器侧 red-text 检测漏 `voip_phone_disallowed` 实际渲染文案 "Invalid phone number"
- `acquirePhone` retry 时反复取同号（release 后 bindings_used 回 0 又最低优先）— ORDER BY 应加 "刚 release 不再优先" 逻辑

**不变式**

- 浏览器模式 PipelineEngine + `utils.js` v2.39.4 行为零改动
- 协议模式既有 PKCE 主流程（login OTP / choose-account / oauth/token）行为不变 — 仅 add_phone 检测点附加 sessionState
- phone-pool DB schema 零改动
- `zhusms-provider.js` 零改动
- 配置 schema 零改动

**Spec / Plan**：`docs/superpowers/specs/2026-05-26-protocol-add-phone-design.md` + `docs/superpowers/plans/2026-05-26-protocol-add-phone.md`

## v2.39.4 — 2026-05-25

### add_phone OpenAI 拒号 → rollback + retry (最多 3 次)

实测发现 OpenAI 偶尔在 add_phone 提交后红字「无法向此电话号码发送验证码」（号本身没问题，但 OpenAI 在它那边判定不发）。v2.39.3 之前会直接 `phone_verify_fail` 单号挂掉。

**新增**

- **`server/phone-pool.js:releaseBinding(db, phone, email)`** — 撤销刚刚 `acquirePhone` 建立的临时 binding；`DELETE phone_bindings` + `bindings_used = MAX(0, -1)`。仅"OpenAI 没真正发短信"场景调用，v2.37.0「永久 binding」语义在正常路径不变。
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支包成 retry loop（`MAX_PHONE_ATTEMPTS=3`）：
  1. 提交手机后短等 8s `input[autocomplete="one-time-code"]`
  2. 没出现就用 Playwright `locator(':text-matches("无法向此电话号码发送验证码|Unable to send verification|cannot send a verification", "i")')` 查红字
  3. 红字命中 → `releaseFn()` 撤回（local: `releaseBinding`；zhusms: `cancelOrder`）→ 拿下一号
  4. SMS 框真出现 → 进入接码流程；这之后失败（`sms-timeout` / `submit-error`）不再 retry（号已被 OpenAI 接受）
- **不变式**：binding 计数只在 SMS 框出现时增加（即 OpenAI 真发了短信）；3 次全拒 → `{phoneVerifyFail: 'all-phones-rejected'}`

**测试**：206 tests pass（既有 phone-pool / zhusms 覆盖未破）。

## v2.39.0 — 2026-05-25

### zhusms 远程接码 Provider 并列接入

v2.37/v2.38 完成本地号池架构（手动 import phone + sms_api_url）。
本次新增 **zhusms.com 远程接码服务**作为可选 provider — 用户买卡密
（一卡多次），服务端自动 round-robin 取号 + 接 SMS + 释放，不用
维护本地 phone 列表。两个 provider 并列，用户在 Config 二选一。

**新增**

- **`server/zhusms-provider.js`** 包装 zhusms 5 个 endpoint（基于
  https://zhusms.com/openapi.json）：
  - `_activate` (POST /api/guest/activate, 卡密 → Set-Cookie session)
  - `ensureSession` (1 小时 cookie 缓存)
  - `takeOrder` (POST /api/order/take service=<x>, 401 时清 session 重试)
  - `pollOrderSms` (GET /api/order/status?order_no=<x>, regex tolerant 6 位数字)
  - `cancelOrder` (POST /api/order/cancel, 错误路径释放避免占余额)
  - `getBalance` (GET /api/guest/me, UI 余额按钮用)
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支按 `cfg.phonePool.provider`
  分流 local（既有）/ zhusms（新）。通用 Playwright 填表 / 接码 / 提交
  逻辑共用，仅取号 / 接码 fn 不同
- **`server/routes/phone-pool.js`** +1 endpoint `POST /zhusms/balance`
- **Config 字段** `phonePool.{provider, zhusms.{cardKey, service, baseUrl}}`
- **`web/src/views/Config.vue`** provider radio + 条件 zhusms 表单 +
  「查询余额」按钮

**绑定语义对比**

| 维度 | local provider (v2.37) | zhusms provider (v2.39) |
|---|---|---|
| 号管理 | 用户手动 import `phone\|url` | 服务端自动 round-robin |
| 单次成本 | 维护本地 phone 列表 | 卡密扣 1/单 |
| 失败释放 | 无（binding 永久 +1） | `cancelOrder` 释放（不扣余额） |
| 接码 | 每号独立 URL | `/api/order/status?order_no=<x>` |
| 服务标签 | 无（号通用） | 按 service（codex / paypal / ...） |

**不变式**：
- Phase 1 本地号池（DB / UI / route）零改动
- engine.js 不动（4-shape return shape 不变）
- `payment.js` + 协议模式 + Python 不动
- `provider='local'` (default) 时跑老路径，行为零变化

**代理覆盖**：跟全局 proxy 同步 — `proxy.enabled=true` 时 zhusms
所有 API call + SMS poll 走 `HttpsProxyAgent`，与 fetchSmsCode 一致；
disabled 时直连。

**测试**：`server/__tests__/zhusms-provider.test.js` +6（cookie 缓存
/ take / poll 超时 / poll 拿码 / cancel form body / 401 重试）。共
206 tests pass on v2.38.0 baseline 200。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-zhusms-remote-provider-design.md`
+ `docs/superpowers/plans/2026-05-25-zhusms-remote-provider.md`。

## v2.38.0 — 2026-05-25

### 浏览器模式 PKCE add_phone 自动化 (Phase 2a/2)

v2.37.0 Phase 1 交付了号池基础设施（DB / service / 路由 / UI /
Config）。Phase 2a 接通浏览器模式 PKCE 流程消费号池 —— ChatGPT
要求手机号验证时自动从池里取号、Playwright 填表 + 接 SMS + 填验
证码 + 提交、继续 token exchange。

**完成流程**：

```
PKCE Playwright OAuth flow
    │
    ▼ 检测到 add_phone 页 (URL /add-phone 或 DOM input[type=tel])
    │
    ├─ config.phonePool.enabled=false → return {needsPhone:true} → plus_no_rt (兼容)
    │
    └─ acquirePhone(email) ──┬─ null → return {phonePoolEmpty:true} → status='phone_pool_empty'
                              │
                              └─ {phone, smsApiUrl} → 填 phone + submit
                                                   → wait SMS form
                                                   → fetchSmsCode(proxyUrl if proxy enabled)
                                                   → 填 code + submit
                                                   → wait /oauth/callback
                                                   → continue PKCE 主循环 → token exchange ✓
                                                   │
                                                   └ 任一步失败 → {phoneVerifyFail: 'sms-timeout'|'submit-error'}
                                                                → status='phone_verify_fail'
```

**代理覆盖**：跟全局 proxy 配置同步。`proxy.enabled=true` 时
Chrome 已自动走 `http://127.0.0.1:7890`（既有），`fetchSmsCode` 显
式传 proxyUrl 走 HttpsProxyAgent；`proxy.enabled=false` 时全部直连。

**新增**：

- **`server/phone-pool.js:fetchSmsCode`** 加 `proxyUrl` 参数（接 HttpsProxyAgent）
- **`utils.js`** +`isAddPhonePage(page)` 导出（URL + DOM 双重判定）
- **`utils.js:fetchTokensViaPKCE`** add_phone 分支扩展：号池消费 + Playwright 填表 +
  接 SMS + continue 主循环（成功）or 4 种新 return shape（失败分类）
- **`server/engine.js`** 2 处 PKCE 调用站（cached-login + post-payment）处理新 return shape
- **新 status 码**：`phone_pool_empty` (warning) + `phone_verify_fail` (danger)，
  加入 ERROR_STATUSES → Accounts 计划列推导 free（v2.32 规则）
- **前端**：status.js +2 codes；3 个视图筛选下拉自动 pickup（用 EXECUTE_STATUS_FILTER_OPTIONS
  动态生成）

**不变式**：
- `config.phonePool.enabled=false` → 完全跳过号池逻辑（向后兼容老行为）
- 协议模式 `protocol_register.py` / `protocol-engine.js` **不动**（Phase 2b 另开 spec）
- `payment.js` PayPal SMS 流程**不动**（继续用 config.smsApiUrl + handleSmsVerification）
- Python 任何文件**不动**

**测试**：`server/__tests__/phone-pool.test.js` +1 (P7 proxyUrl agent) +
`server/__tests__/utils-isAddPhonePage.test.js` +3（URL match / DOM
fallback / both miss）+ `__tests__/status-row-class.test.js` +2 断言。
共 200 tests pass on v2.37.0 baseline 194。

**Phase 2b 预览**（独立 spec，需用户先抓包）：协议模式 PKCE add_phone
实现，需要 Python bidirectional stdin + OpenAI add_phone endpoint
URLs（用 Chrome DevTools Network 抓 POST 请求 + payload + response shape）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-pkce-add-phone-browser-mode-design.md`
+ `docs/superpowers/plans/2026-05-25-pkce-add-phone-browser-mode.md`。


## v2.37.0 — 2026-05-25

### 手机号号池基础设施 (Phase 1/2)

OAuth PKCE 流程在某些账户上会被 ChatGPT 要求绑定手机号（`needsPhone:
true` 检测点见 `protocol_register.py:273`），**当前流水线在该点卡死**。
本次先建号池基础设施，Phase 2（独立 spec）再接通 PKCE 消费。

**Phase 1 交付**：

- **DB**：新增 `phone_pool` (phone PK / sms_api_url / bindings_used /
  created_at) + `phone_bindings` (phone + email 复合 PK) 两张表。
  `getRawDb()` helper 暴露给 service 用。
- **后端 service** `server/phone-pool.js`：list / import / export /
  delete / acquirePhone / fetchSmsCode 六个函数。
  - `acquirePhone(db, email, max)` 原子取号 + 写 binding + 自增计数器；
    排序 bindings_used ASC + created_at ASC（轮转使用避免某号被打）；
    WHERE 排除已与该 email 绑过的号 + 满号；null = 用尽
  - `fetchSmsCode` regex `/\b(\d{6})\b/` 与 `payment.js:586` PayPal
    路径一致，Phase 2 复用
- **路由** `/api/phone-pool` 4 个 endpoints（GET / + POST /import +
  GET /export + DELETE /:phone）
- **Config 字段** `phonePool.{enabled, maxBindingsPerPhone,
  smsPollIntervalMs, smsMaxAttempts}` 默认 disabled
- **前端** PhonePool.vue 新页面（PageHeader + SectionCard 沿用 v2.34
  设计），sidebar 加「号池」入口，Config.vue 加 4 个 input

**绑定语义**（per 用户明确）：首次使用建立 + 永久绑定 ——
账户被删除不释放 `bindings_used` 计数。满 max 后 phone 不再可用。

**Phase 2 预览**（独立 spec）：协议模式 + 浏览器模式两套 PKCE
add_phone 流程实现，消费 acquirePhone() + fetchSmsCode helper。

**测试**：`server/__tests__/phone-pool.test.js` +6（import 基本 /
import 跳非法 / list boundEmails / acquire 跳满号 / acquire 同 email
不重绑 / delete cascade）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-phone-pool-infrastructure-design.md`
+ `docs/superpowers/plans/2026-05-25-phone-pool-infrastructure.md`。

## v2.34.1 — 2026-05-25

### Hotfix: Proxy 死节点 currentNode 双保险防御

诊断：`refresh()` 在 `server/proxy/index.js:417` 同步设
`currentNode = 第一个白名单节点`（通常 `pro-美国01`），`runHealthProbe`
fire-and-forget 8s+ 后才跑。如果首节点死了，从启动到 probe 完成
窗口内所有用 currentNode 的请求都 ECONNRESET。`detectExit()` 失败
时返回 `"error: ..."` 字符串而非抛错，endpoint try/catch 不触发，
UI 把字符串当报错弹给用户。

**双保险**（跟 v2.31.1 设计风格一致）：

- **A**: `runHealthProbe()` 末尾验证 `currentNode` 是否在 alive 集合；
  不在 → fire-and-forget rotate。新增 `_autoRotateIfCurrentDead(tag,
  probeResults, rotateFn)` 纯函数 + 导出 `__autoRotateIfCurrentDeadForTest`
  测试钩子。Main / JP 通道对称处理。
- **B**: `/api/proxy/detect-exit` 和 `/api/proxy/jp/detect-exit` 收到
  `"error: ..."` 字符串时自动 `rotate()` / `rotateJp()` + 重 call
  endpoint 1 次。

跟 v2.31.1 `recordBadAttempt`（高频路径 3 次累积才拉黑）互补 ——
A/B 给低频但用户可见的路径加专属防御，单次失败立切。

**测试**：`server/proxy/__tests__/dead-currentnode.test.js` +4（dead
触发 / alive 不触发 / 未探过不触发 / 空 tag 跳过）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-proxy-dead-currentnode-defense-design.md`
+ `docs/superpowers/plans/2026-05-25-proxy-dead-currentnode-defense.md`。

## v2.36.0 — 2026-05-25

### 主题换皮 — GitHub 工具风替代 v2.35 indigo SaaS 风

用户原话"现在的前端风格我不喜欢，换一种"。本轮**只换主题层 CSS**，
所有功能 / 结构 / 业务逻辑保持 v2.35 不动。spec 见
`docs/superpowers/specs/2026-05-25-v2.36-github-style-redesign-design.md`。

**改动（3 文件）**：

- 新增 `web/src/styles/v236-github.css` — GitHub Primer 主题层：
  - 主色 `#0969da` GitHub blue 替换 indigo `#5b67f0`；success/
    warning/danger 换 Primer 色（#1f883d / #9a6700 / #cf222e）。
  - Surface / border / text 换 GitHub neutrals (#ffffff / #f6f8fa /
    #d0d7de / #1f2328)。
  - 圆角 6/6/8 统一；阴影几乎只用 1px border 区分层级。
  - 行高亮换 GitHub diff 风（浅黄 #fff8c5 / 浅绿 #dafbe1 / 浅红
    #ffebe9 / 浅蓝 #ddf4ff）。
  - 按钮 hover 去 transform 仅换背景色；默认按钮用 #f6f8fa GitHub
    gray button。
  - 输入框 focus 用 Primer 3px 蓝色光晕 + 蓝色内描边。
  - 暗色用 GitHub Dark Default (#0d1117 canvas / #161b22 subtle /
    #30363d border)。

- `web/src/main.js` — 在 `v235-polish.css` 之后引入 `v236-github.css`，
  让 GitHub 主题覆盖 indigo。**保留 v235-polish.css 不删**，`git
  revert HEAD~1..HEAD` 一次回到 indigo SaaS 风。

- `web/src/components/AccountTableRows.vue` — running 行高亮蓝色从
  硬编码改 `var(--app-row-running)` token，自动跟随 GitHub 蓝。

**测试 & 构建**：184/184 全绿；web/dist 5.59s。

**如不喜欢 GitHub 风可继续换**：复制 `v236-github.css` 改 token
就是新主题；不影响功能层。

## v2.29.0 — 2026-05-25

### Liveness Protocol-Mode lightLogin（v2.26 Phase B 收尾）

关闭 v2.26 Phase B 待办：协议模式下，无 `cpa-auth/codex-{email}.json`
缓存的账号测活时 `!tok` 触发 `lightLogin` → 当时抛 stub →
runner 标 `alive_status='login_fail', reason='liveness not yet
supported in protocol mode'`，看起来像账号死了实际是机制缺失。

**核心改动：**

- **`chatgpt_register/liveness_login.py`** —— 新建协议模式纯登录脚本
  （~290 行）：username → password → OTP → session 7 步走 curl_cffi +
  sentinel，与 `protocol_register.py` 解耦但共享底层。
- **`chatgpt_register/otp.py`** —— 从 `protocol_register.py` 抽出
  `fetch_imap_otp` / `get_imap_baseline`（函数体逐字复制，加 `log=`
  callback 解耦）+ 新增 `gen_totp(secret)`（pyotp lazy import）。
- **`server/liveness/light-login.js`** —— `protocolMode=true` 分支
  spawn `chatgpt_register/liveness_login.py`，120s timeout + abortSignal
  双兜底；spawn ENOENT 仍 reject `LivenessLoginNotImplementedError`
  保留 runner.js:99 兜底兼容。stderr 摘要过 `redact()` 防止 proxy URL
  含凭证泄露到 alive_reason。
- **`server/liveness/runner.js`** —— 1 行改动：`lightLogin(...)` 调用
  加 `proxyUrl: getProxyMgr()?.getProxyUrl()`，让子进程走代理。
- **错误契约**：Python `reason` 字符串包含 runner.js:99-117 的 9 类
  keyword 之一（bad password / outlook oauth missing / otp timeout /
  captcha / proxy reset / no session / unexpected / ...）；runner 错误
  映射零改动。

**对外契约不变**：`lightLogin(account, opts)` 返回 shape
`{accessToken, accountId, expiresAtIso}` 双模式一致；`LivenessLoginNotImplementedError`
类保留为 spawn 失败兜底。

**单测**：`tests/test_liveness_login.py` 新建 3 Y unittest（Y1 no
password / Y2 bad password / Y3 happy path 三字段）+
`server/liveness/__tests__/light-login.test.js` 新增 5 P 单测（P1-P5
Node 端 spawn 胶水），并保留原 v2.26 的 8 个浏览器路径测试。共新增 8 用例。

**新依赖**：`pyotp`（仅 Gmail 协议模式 liveness 需要；Outlook 不影响）。
CLAUDE.md / start.bat 已更新说明，缺失时 start.bat WARN 不阻塞。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-protocol-lightlogin-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-protocol-lightlogin.md`。

## v2.35.0 — 2026-05-25

### 任务流驱动的前端重设计 — Command Palette / Pipeline HUD / 工作台

v2.34 完成了 design token + 包壳；v2.35 按"运营每天做什么"重新组
织前端，加入键盘党生产力工具。spec 见
`docs/superpowers/specs/2026-05-25-v2.35-task-flow-redesign-design.md`。

**B1 现代视觉系统升级（新增 `web/src/styles/v235-polish.css`，叠加
在 v2.34 tokens 之上不改原文件）：**

- 主色 `#5b67f0` indigo 替换 Element Plus 默认 `#409eff`；9 step
  lightness scale 自动让所有 el-* 组件 rebrand。
- 多层柔和阴影（Linear / Vercel 风格）：每档 1px hairline 内描边 +
  两层 diffused shadow。圆角 sm/md/lg 6/10/14。
- 按钮 hover 微 0.5px 上升；focus-visible 全局描边；滚动条变细；
  ElMessage 圆角 + 玻璃感 backdrop-filter。
- 全局动效曲线 cubic-bezier(0.4,0,0.2,1)；`.app-fade-in` opt-in 动画。

**B2 Dashboard 改工作台 hub：**

- 4 hero metric 卡：账号总数 / 今日激活 / 待重试 / 运行中。每张
  含 icon（着色 badge） + 数值 + 副标 delta；可点击跳带筛选的对应
  视图；键盘可达。
- 快捷操作（6 张任务卡）：导入 / 跑一批 / 重试失败 / 测活 / 下载
  凭证 / 调代理。按当前状态自动 disable；点击直接跳带 `?action=
  import/add` 的对应视图。
- 系统健康 6 行：引擎 / 主代理 / JP 通道 / WebSocket / 运行时长 /
  版本。10s 轮询 `/api/health`，颜色 dot 绿 / 灰 / 红。
- 近期执行 SectionCard + "查看全部 →" 跳 Results。

**B3 Command Palette（Ctrl/Cmd+K）：**

- 新增 `web/src/stores/commands.js` 反应式 commands registry +
  `web/src/components/ui/CommandPalette.vue`（Teleport modal）。
- 全局键盘监听 Ctrl/Cmd+K 打开 palette；输入即模糊匹配；分组显示
  （导航 / 账号 / 执行 / 代理 / 配置 / 主题）；↑↓ 选 / ↵ 执行 /
  Esc 关闭。
- AppLayout 注册 11 条核心命令（5 导航 + 主题切换 + 通知 + 账号
  导入/添加/导出 + 下载凭证 ZIP）；视图未来可 registerCommand 扩展。
- 顶栏左上加 `[⌘K / Ctrl K]` 命令按钮（mac/non-mac 自动适配）。

**B4 Pipeline HUD（v2.29 FX-4 deferred 项落地）：**

- 新增 `web/src/stores/pipelineStore.js`：running / total / done /
  currentEmail / currentPhase / recentDurations (last 5)。
- 新增 `web/src/components/ui/PipelineHUD.vue`：v-if 全局可见进度
  带；spinner + X/Y + 当前邮箱 + phase + 渐变进度条 + 已用 + ETA
  + 查看 / 停止。1s tick 刷新；slide-down 入场。
- socket.js 在 `account-status` 事件转发 `recordAccountStatus`；
  `execution-complete` 调 `endPipeline`。
- Execute.vue startExec 成功后调 `beginPipeline(total)`。
- ETA = 最近 5 个账号平均耗时 × 剩余数；< 2 样本时显示 "—"。
- 运营在 Config / Accounts 等页也能看到流水线进度。

**B5 Accounts toolbar 收纳 + ContextActionBar：**

- Toolbar Row 1：搜索 + 状态多选 + "更多筛选 ▾" popover（折叠
  Plan / Auth / 活性 / 仅看未测试 / 7 天未测 / 重置）。popover
  按钮含 brand 圆点 badge 显示已激活高级筛选数。
- Toolbar Row 2：测活全局控制（与选中无关）+ 下载全部 ZIP。
- 新增 `web/src/components/ui/ContextActionBar.vue`：底部居中
  sticky pill 操作栏；slide-up + fade 入场；选中数 > 0 时显示
  导出 / 下载 / 测活 / 删除 / 取消按钮，选中 = 0 时彻底不渲染。
- Accounts.vue onMounted 解析 `?action=import` / `?action=add`
  自动打开对应弹窗（来自 Dashboard 任务卡 / Command Palette）；
  解析后 router.replace 清掉 query。

**B6 EmptyState 升级：**

- 64×64 圆形 icon wrap（surface-2 背景 + hairline border + sh-1
  阴影），title 升 xl 加重，hint 加宽行距；整体加 app-fade-in
  入场动画。

**工程：**

- 182/182 测试全绿（前端无新测试基础设施；后端零改动）。
- 6 个 batch 共 6 commits；每 batch 验证 npm run build 成功。
- 新增依赖：0。新增 npm 包：0。
- 不动文件：`web/src/styles/tokens.css`（v2.34 原状）/ 4 个 composable /
  status.js / selection.js / socket 协议 / 后端任何代码。
- 保留所有 v2.29~v2.34 已有不变式：dirty 守卫、URL 筛选、行运行时
  高亮、通知中心、batch-delete、Execute 分组锁定、列锁定 +
  reserve-selection 等。

## v2.34.0 — 2026-05-25

### Execute 分组锁定 + 视图切换

两个独立但相关的 UX 改进：

**Part A — Sticky grouping**

v2.27 引入分组面板后，运行时 row 跨组跳跃（idle → running → 终态
plus / error）让用户跟丢 —— 刚看的一行跑着跑着就跳到别的组里去了。

修复：`Execute.vue:startExec` 时给 `filteredRows` 设
`_groupStatus = _status` 快照。`groupAccountsByStatus` 改读
`_groupStatus || _status || 'idle'`。socket 更新只动 `_status`
（驱动 v2.33 的行颜色），但 row 留在原组。

- **解锁时机：仅页面刷新**（`loadResults()` 重建 `accounts.value` 时新
  row 没 `_groupStatus` → 回到真实分组）。不主动清。
- **二次执行覆盖快照**：第二次 startExec 重新设 `_groupStatus = _status`
  —— 第二次开始时的真实状态。
- **行颜色不锁**：v2.33 `rowClassFor(row._status)` 仍读真实 `_status`，
  row 颜色随真实状态实时变 —— 用户既看到"还在跑/已成功"也保留视觉位置。

**Part B — 视图切换：分组 / 平铺**

toolbar 加 `<el-switch v-model="groupingEnabled">`（默认开 = 分组）。

- **分组（默认）**：既有 `<el-collapse>` + groups + AccountTableRows
- **平铺**：单 `<AccountTableRows :rows="flatSortedRows">`，按 GROUP_ORDER
  业务优先序排（Plus 在上、运行中、错误、已删除... 依次），同 status
  内稳定插入序

选择跨视图保持一致（复用既有 globalSelectedSet）。`onGroupSelectionChange`
平铺分支用 clearSelection + 重建确保选择 Set 与 UI 同步。

**测试**：`__tests__/status-groups.test.js` +2（_groupStatus 优先于
_status / falsy fallback）。`groupAccountsByStatus` 改动**向后兼容**
—— Accounts.vue 不受影响（其 row 没 `_groupStatus` 概念）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-sticky-grouping-and-view-toggle-design.md`
+ `docs/superpowers/plans/2026-05-25-execute-sticky-grouping-and-view-toggle.md`。

## v2.33.1 — 2026-05-25

### Hotfix: running 专属高亮色，不再与 warning 撞色

v2.33.0 把 `running` 映射到 warning（浅黄）—— 但 warning 还包括
plus_no_rt / token_expired / no_link / canceled / no_jp_proxy /
paypal_captcha 等多个终态。结果一个 token_expired 账户（浅黄）
点执行后变 running（也浅黄），**row 颜色没变化看不出"在跑"**。

**修复**：

- `rowClassFor('running')` 改返回 `'row-status-running'` 专属 class
  （不复用 `row-status-warning`）
- 两个 Vue 文件加 CSS `.row-status-running` —— 浅蓝 `#ecf5ff`
  背景 + 左边 4px Element Plus 主色 `#409eff` border，让"正在跑"
  视觉强突出，与所有终态色（红/黄/绿/灰）都不同
- 8 单测里 `running` 断言改成 `row-status-running`

## v2.33.0 — 2026-05-25

### 账号行运行时整行高亮

Execute 流水线运行时，账户列表的每一行整行换浅色底色，扫一眼就
能识别每个账号当前状态。Accounts.vue 顺带补上之前漏的
`account-status` socket 订阅 —— Execute 在跑时 Accounts 页也实时
反映 status / phase 变化。

**颜色映射（基于 `statusType()`）**

| 类型 | 包含 status | row 背景色 |
|---|---|---|
| `success` | plus | `#f0f9eb` 浅绿 |
| `warning` | running（特殊）/ plus_no_rt / no_link / no_jp_proxy / token_expired / canceled / paypal_captcha | `#fdf6ec` 浅黄 |
| `danger` | error / deactivated / verify_error / login_fail | `#fef0f0` 浅红 |
| `info` | no_promo / aborted | `#f4f4f5` 浅灰 |
| —（idle / 空） | — | 默认背景（不上色） |

**实现要点**

- 新增 `web/src/status.js:rowClassFor(status)` 工具函数，沿用
  `statusType()` 单一来源；唯一例外：`running` 在 TYPE_MAP 是 `''`
  → 回退 info（浅灰）会让"运行中"不醒目，所以强制返回 warning
- `AccountTableRows.vue`（Execute 子组件）和 `Accounts.vue` 的
  `<el-table>` 都加 `:row-class-name="rowClass"`，CSS 4 个类
  使用 `:deep()` + `!important` 覆盖 el-table 默认 zebra
- Accounts.vue 新增 `watch(socketState.accountStatuses, ...)`
  接通实时数据流（Execute.vue 已有，零改动）
- 后端零改动；Dashboard.vue / Results.vue YAGNI 不动

**测试**：182 tests pass — `__tests__/status-row-class.test.js` +8（idle / running 例外 / 4 个 type / 未知 fallback / 大小写）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-row-highlight-during-execution-design.md`
+ `docs/superpowers/plans/2026-05-25-row-highlight-during-execution.md`。

## v2.30.0 — 2026-05-25

### v2.29 deferred 项二轮收敛 — 8 项一次性 ship

接 v2.29 同日发布。仍不动登录/支付/JSON 主管道。spec 见
`docs/superpowers/specs/2026-05-25-v2.30-deferred-followups-design.md`。

**后端（4 项）：**

- **HX-9 SIGINT / SIGTERM 优雅退出**：`server/index.js` 注册信号
  → 调 `logsDB.flush()` 强制 save → `await save.flush()` 等队尾
  原子落盘 → `process.exit(0)`。5s 硬 deadline 防磁盘 wedge 时
  挂死。之前 Ctrl+C 时 logsDB 内未达 10 行阈值的 0-9 条日志直接
  消失。
- **HX-13 Windows tree-kill**：新增 `server/process-utils.js`
  `killTree(pid)`：Windows 走 `taskkill /T /F` 杀整棵进程树；
  POSIX 走 `process.kill(-pid)` 进程组 + 单 PID 双保险。引擎
  `stop()` 改 `killTree(chromeProc.pid) + chromeProc.kill()` /
  `killTree(pyProc.pid) + py.kill()` 双保险。之前 `py.kill()`
  只 SIGTERM 顶层 python.exe，curl_cffi 内部 C 子线程不接受
  信号 → Windows 留僵尸进程；Chrome 同理 renderer / GPU 孙进
  程残留。
- **HX-16 `/api/health` endpoint**：新增 `server/routes/health.js`
  返回 `{ ok, db, proxy: {…字段白名单子集}, engine, uptimeSec,
  version }`。200 / 503 区分 DB ok 与否。同时新增
  `server/engine-singleton.js` 把 `let engine` 从 routes/execute.js
  提升到模块级，避免 cyclic require。
- **PX-7 主动健康检查**：新增 `clashApi.testNodeDelay()` 调用
  Clash `/proxies/{name}/delay` 一次性 HTTPS GET，不动 active
  selector。新增 `server/proxy/health-probe.js#probeAllNodes()`
  并发 4 跑 delay test 写入 `_state.probeResults` Map。`refresh()`
  末尾 fire-and-forget 触发；`config.proxy.activeHealthCheck =
  false` 可关。`rotate / rotateJp` 内先看是否有 alive 节点，有
  则跳过 dead-by-probe；全 dead 时回退原逻辑避免死锁。
  好处：之前首批 3 个账号必失才能识别死节点 + TTL 30min 到期
  又浪费 3 个；现在 refresh 后秒级标 dead，rotate 自动跳过。

**前端（4 项）：**

- **FX-15 Accounts 主表瘦身**：移除 TOTP / Client ID / Refresh
  Token 三列。新增"凭证"列：3 个圆点（绿=有 灰=空）+ "查"按钮
  触发 el-popover 展示完整 3 字段 + 各自复制按钮。主表瘦身约
  350px，1366px 屏幕不再溢出。
- **FX-17 Dark mode**：引入 `element-plus/theme-chalk/dark/css-
  vars.css`。`useDarkMode` composable 写 `html.dark` 类 +
  localStorage；OS 偏好兜底（用户未显式选过时跟随 prefers-color-
  scheme）。AppLayout logo 区加月亮 / 太阳切换按钮。
  `.main` 背景改 `var(--el-bg-color-page, …)` 跟随主题。
- **FX-13 通知中心**：新增 `web/src/notifications.js` 反应式
  store（items 最近 100 + unread）。`web/src/api.js` axios
  interceptor 自动捕获 5xx + 网络错误 → pushNotification
  （4xx 留给业务代码自决，避免吃掉 409 pipeline-busy 这类正常
  拒绝）。AppLayout 顶栏铃铛 + 未读 badge；点开弹 el-drawer
  历史，tag 染色 + 标题 + 正文 + 时间。
- **FX-5 batch-delete**：新增 `accountsDB.bulkDelete(emails)` +
  `POST /api/accounts/batch-delete`。前端 `delSelected` 改单次
  POST，按钮 loading + "删除中…"。之前 N 次串行 DELETE 在
  N=200 时卡 30s 无进度反馈。

**工程：**

- 6 个新测试文件、174 个 case 全绿（v2.29 158 + v2.30 16 新）。
- `server/__tests__/process-utils.test.js`：killTree 输入安全 /
  不存在 PID 静默 / 真子进程实际终止。
- `server/__tests__/health-endpoint.test.js`：200 + 字段不含
  subscriptionUrl/token/password。
- `server/proxy/__tests__/health-probe.test.js`：alive/dead 标
  记 / rotate 跳 dead / 全 dead 回退 / shouldSkip 跳过 manual /
  getState 形状。
- `server/__tests__/accounts-batch-delete.test.js`：成功 / 部分
  notFound / 边界输入。

**仍留下次的**：PX-4 sing-box stop-after-start-success、PX-8
Clash secret + 端口自动、FX-4 Pipeline HUD、HX-10 LogCapture
重写、HX-11 zod schema、HX-19 GitHub Actions CI、`ProxyManager`
类化、`better-sqlite3` 迁移。

## v2.29.0 — 2026-05-25

### 代理 / 前端 UX / 横切硬化 — 4 路审计后 20 项一次性 ship

不动登录/支付/JSON 凭证主管道。spec 见
`docs/superpowers/specs/2026-05-25-v2.29-proxy-ux-and-hardening-design.md`。

**横切硬化（6 项）：**

- **HX-1a/1b DB 原子写 + save 串行化**：`server/db.js#save()` 改成
  `tmp + rename` 原子落盘，断电不会再留半截 `data.db`；并发 set()
  通过 `_saveQueue.then(...)` 串行化，避免快照互相覆盖。新增
  `save.flush()` 供测试 / 优雅退出 await。
- **HX-6 config.json 原子写**：`server/routes/config.js#writeConfig`
  同样改 `tmp + renameSync`。
- **HX-7 默认绑 127.0.0.1**：`server.listen(PORT, HOST, …)`，
  `HOST` 默认 loopback；远程访问需显式 `set HOST=0.0.0.0`，
  启动时显眼警告 dashboard 无认证。CORS allow-list 同步加入
  `http://${HOST}:3000`。
- **HX-3 engine.stop() async**：浏览器 / 协议两套引擎 stop() 改
  async，按 browser.close() → chromeProc.kill() → tempDir rm
  顺序 await，避免 fire-and-forget 让新一轮 engine 撞旧资源。
  /execute 路由构造新 engine 前显式 `await engine.stop()` 兜底
  清掉 LogCapture monkey-patch + tempdir。
- **HX-2 LogCapture 兜底脱敏**：`server/logger.js` 新增
  `redact()`，过滤 JWT 三段 / `access_token=…` / `refresh_token=…`
  / `id_token=…` URL 参数 / `Bearer <token>` / "OTP|code|verification
  code|sms code" 紧邻数字。覆盖 server.log + Socket.IO 推送两路。
  start() idempotent，二次调用不嵌套 wrapper（避免多次切引擎让
  console.log 被层层包装）。

**代理（4 项）：**

- **PX-1 `getState()` 字段白名单**：不再 `{ ..._state }` spread，
  去掉 `subscriptionUrl`（含 token）和 `outbounds`（含 vmess UUID
  / ss 密码）；新增 `hasSubscription: bool` + `subscriptionHost:
  string|null` 让前端仍能展示"已配置 + 主机名"。
- **PX-2 rotate 串行化**：模块级 `_rotateLock` + `withRotateLock`
  helper，`rotate / rotateJp / switchTo` 以及 refresh 末尾的
  selector 同步都过同一把锁，防止 `recordBadAttempt` 的 fire-
  and-forget rotate 与显式 await rotate 竞态 `_state.currentNode`
  + Clash API PUT /proxies。
- **PX-3 refresh 后同步 selector**：sing-box config 写
  `default = filtered[0]`，但 `_state.currentNode = filtered[
  rotationIndex]` 在 `rotationIndex != 0` 时不一致。`refresh()`
  末尾主动调 `clashApi.switchSelector(SELECTOR_TAG, currentNode)`
  对齐，避免下一次 `recordBadAttempt` 冤枉错节点。
- **PX-5 黑名单 auto/manual 分两步清**：`rotate()` 兜底"全部 bad
  → clear"分支先只清 `source === 'auto'`，保留运维 manual 拉黑；
  清完依然无可用节点才退化为全清，防止死锁。

**前端 UX（10 项）：**

- **FX-1 Dashboard / Results 用 statusLabel**：状态 tag 从原始
  code (`verify_error`) 改 `statusLabel`（"Stripe验证失败"）。
- **FX-2 侧栏菜单顺序 + Results 入口**：仪表盘 / 账号管理 / 执行
  控制 / 执行结果 / 配置设置。之前 Results 是孤儿路由，必须改
  URL 才能进。
- **FX-3 WebSocket 断线横幅**：AppLayout 主区顶部 sticky 警告
  + 手动重连按钮，比 Execute 顶部的小 tag 显眼。
- **FX-6 Config dirty form 守卫**：watch form 计 isDirty；
  `onBeforeRouteLeave` + `beforeunload` 双重保护未保存改动。
- **FX-7 键盘快捷键基础三键**：`useHotkeys` composable 全局注册
  `/` 聚焦搜索（焦点在 INPUT 时不抢）+ `Ctrl+Enter` 触发
  `[data-hotkey="submit"]`。Esc 仍由 Element Plus 弹窗承担。
- **FX-8 Accounts 6 个筛选写 URL**：`useUrlSyncedFilters`
  composable 让 search / status / plan / auth / alive / stale
  双向同步到 `route.query`，刷新 / 复制粘 URL 都保持筛选。
- **FX-9 全 FAILED_TO_RETRY 行内重试**：`AccountTableRows.vue`
  重试按钮显示条件从 `error || idle` 扩到 `isFailedToRetry()`
  全部 9 个终态，不再必须勾选→顶部"重试失败"。
- **FX-11 删除选中 confirmDanger**：从 popconfirm（一键，误点率
  高）改 `confirmDanger`，N > 5 时要求输入数字 N 才确认，防止
  误点批量删除。
- **FX-12 Results 状态下拉用单一来源**：v-for
  `EXECUTE_STATUS_FILTER_OPTIONS`（status.js），不再硬编码 12 项。
- **FX-14 Config 黑名单 polling visibility 暂停**：tab 隐藏停
  setInterval；可见时重启并触发一次 loadBlacklist。

**工程：**

- npm scripts `test` / `test:py`：以前要手敲一长串 `node --test`，
  现在 `npm test` 一键跑（158 个 case：143 旧 + 15 新增覆盖
  HX-1/HX-2/PX-1/PX-3/PX-5）。

**未做（留 v3.0 / 下次 spec）：**

PX-4（sing-box stop-after-start-success）、PX-7（主动健康检查）、
PX-8（Clash secret + 端口自动）、FX-4（Execute Pipeline HUD）、
FX-5（后端 batch-delete）、HX-10（LogCapture 重写）、HX-11（zod
schema 校验）、HX-13（Windows tree-kill）、`/healthz` + metrics、
`better-sqlite3` 迁移、ProxyManager 类化。

## v2.28.0 — 2026-05-25

### Ops UX Fixes — 10 个 P1 改进一次性 ship

3 模块审查（执行控制 / 账号管理 / 代理）共发现 32 个改进项，
10 个 P1 打包本版本一次性 ship。覆盖 v2.18-v2.32 快速迭代积攒
的 3 类债：(a) 状态维度扩展未同步到 UI、(b) 后端能力 > 前端
暴露、(c) 危险操作无守卫 + UI 体力活。

**Execute 页（5 项）：**

- **#1 `failedEmails` 涵盖所有可重试终态（9 个）**：之前只识别
  `error` 一个，"重试失败"按钮严重失真；改用新 helper
  `isFailedToRetry()` 涵盖 error / no_link / no_promo /
  verify_error / paypal_captcha / login_fail / token_expired /
  aborted / no_jp_proxy 共 9 个未拿到 Plus 但非死号的终态。
- **#2 statusFilter 下拉动态生成**：从硬编码 11 项 → v-for
  `EXECUTE_STATUS_FILTER_OPTIONS`（status.js LABEL_MAP 全集除
  checking / canceled），下拉自动与状态体系同步。
- **#3 子表加 `原因` 列 + expand-row 顶部 banner**：reason 上列
  高频可见；代理节点 + 出口 IP + updatedAt 放 banner 低频查阅。
  后端 account_status 加 proxy_node / exit_ip 两列 + engine
  emitStatus 时从 proxyMgr 注入。
- **#4 toolbar 显示 engine mode badge**：协议模式 / 浏览器模式 +
  link: API / Discord，从 /config/raw 读 protocolMode 和
  paymentLinkSource。
- **#5 5s polling /execute/status 兜底 Stop 按钮**：socket 仍是
  fast path，polling 仅作为冗余；visibilitychange 暂停节省请求。
  断 socket 后仍可成功 Stop 引擎。

**Accounts 页（3 项）：**

- **#6 toolbar 拆 4 行**：16+ 控件由单行挤拥改成 by 职责分组
  （数据管理 / 筛选 / 测活 / 下载）；aliveFilter 从下载按钮右
  边移回筛选行；statusFilter 改用 EXECUTE_STATUS_FILTER_OPTIONS。
- **#7 TOTP / Refresh Token / Client ID 列加 tooltip + 复制**：
  el-tooltip 显示完整值；DocumentCopy icon 调 navigator.clipboard
  复制并 ElMessage 反馈。
- **#8 测活全部加 ElMessageBox 二次确认**：显示账户数量警告，避
  免误点对几千账户的库一键发起测活打爆 API/proxy。

**Config 页（2 项）：**

- **#9 整页用 7 个 el-tabs 重构**：支付 / 执行 / Discord / OAuth /
  代理 / JP / 节点黑名单。原 482 行平铺由 tab 切换替代滚动查找；
  保存按钮仍是全局一个（所有 tab 字段同时保存）。
- **#10 停止代理加 ElMessageBox 二次确认**：警告将断开当前所有
  execute / liveness 流水线的网络。

**后端配套：**

- `account_status` 表加 `proxy_node` / `exit_ip` 两列；CREATE
  TABLE 块同步 + 老库 PRAGMA-gated ALTER 防御性迁移（幂等不抛错）。
- `statusDB.set` 沿用既有 'in incoming' 显式判断 merge-aware
  pattern（与 paymentLink / accessToken 同），中间态 emitStatus
  不会清空已写入的代理上下文；`statusDB.setAlive` 也同步保留
  proxy_node / exit_ip 防 INSERT OR REPLACE 清空。
- `server/engine.js` + `protocol-engine.js` emitStatus 时从
  `proxyMgr.getState()` 读 currentNode + exitIp 注入 data。
- `/api/results` 透传 proxyNode / exitIp camelCase 字段。

**单测**：6 个新增 — `db-status-proxy-cols.test.js` +6
（M1-M3 sql.js schema 行为 + M4-M6 production code 不变式
回归屏障）+ `status-groups.test.js` 追加 G11/G12 +
`status-filter-options.test.js` 新建 S1。无回归。

**Spec / Plan**：
`docs/superpowers/specs/2026-05-25-v2.28-ops-ux-fixes-design.md` +
`docs/superpowers/plans/2026-05-25-v2.28-ops-ux-fixes.md`。

## v2.32.2 — 2026-05-25

### Hotfix: Execute.vue 计划列推导漏改

v2.32.1 把 3 个新 status 码加进了 `ERROR_STATUSES`，Accounts.vue
的计划列正常显示 free。但 Execute.vue 自己有两处 `_plan` 推导
**没有用 ERROR_STATUSES**，而是硬编码 `['error', 'no_link']`：

- 第 190 行（socket 实时 update）：`if (['error', 'no_link'].includes(data.status)) row._plan = 'free'`
- 第 245 行（load 时 hydrate）：`row._plan = PLUS_STATUSES.includes(st) ? 'plus' : (['error', 'no_link'].includes(st) ? 'free' : '')`

结果 Execute.vue 计划列在 `token_expired` / `canceled` / `login_fail`
/ `deactivated` / `no_promo` 这些 ERROR_STATUSES 状态下都显示 `-`
而非 free。

修复：两处硬编码改为 `ERROR_STATUSES.includes(...)`，并在
import 中加入 `ERROR_STATUSES`。前端 rebuild。

## v2.32.1 — 2026-05-25

### Hotfix: 3 个新 status 码加入 ERROR_STATUSES

v2.32.0 引入的 3 个 status 码 (`canceled` / `token_expired` /
`login_fail`) 当时只加进了 TYPE_MAP / LABEL_MAP / GROUP_ORDER，
**漏加 ERROR_STATUSES**。导致 Accounts.vue:291 的 `_plan` 推导：

```js
PLUS_STATUSES.includes(st) ? 'plus' : (ERROR_STATUSES.includes(st) ? 'free' : '')
```

3 个新 status 既不在 PLUS_STATUSES 也不在 ERROR_STATUSES → `_plan=''`
→ Accounts 页「计划」列显示 `-`（看起来"没数据"）。

修复：`web/src/status.js:ERROR_STATUSES` 追加 3 个值。这 3 个全
归 free（账户层面失败 → Plus 信息已不可信）。前端 rebuild。

## v2.32.0 — 2026-05-25

### 测活终态同步到 status 字段 + 3 个新 status 码

之前 alive_status 和 status 完全解耦：Execute.vue 只看 status，
测活只写 alive_status —— 跑完测活 Execute 页看到的还是上次执行
流水线写的旧值。

**后端 — runner.js dispatchOne 末尾按映射表同步**

| alive_status | → status |
|---|---|
| `plus` | `plus` |
| `deactivated` | `deactivated` |
| `canceled` | `canceled` (新) |
| `token_expired` | `token_expired` (新) |
| `login_fail` | `login_fail` (新) |
| `network_error` / `proxy_error` / `checking` / `unknown` | 不同步 |

例外：`alive=plus` 且 `persisted.status=plus_no_rt` 时保留 plus_no_rt
（plus_no_rt 比 plus 信息更丰富，alive=plus 验证不到 RT 状态，不
降级覆盖）。同步时同时 `io.emit('account-status', ...)` 推送，
Execute.vue 通过既有 socket 路径实时更新 `row._status`。

**前端 — 3 个新 status 码 + 筛选下拉补齐**

- `web/src/status.js`: TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3
- Execute.vue / Accounts.vue / Results.vue 状态筛选下拉 +3 option
  - Results.vue 顺便补 deactivated（之前漏掉）

样式：canceled / token_expired = warning；login_fail = danger。
Labels：已取消 / Token失效 / 登录失败。

**测试**：188 tests pass — runner +4（plus 同步 / deactivated 覆盖 /
network_error 不同步 / plus 不降级 plus_no_rt）on v2.31.1 baseline 184.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-status-sync-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-status-sync.md`。

## v2.27.0 — 2026-05-25

### Execute Page Status-Grouped Account List

Execute 页账户列表由单表平铺改为按 `_status` 分组成 `el-collapse` 折叠面板。默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠 —— 运维一眼能看到"成功资产"，错误账号按需展开排查。

**核心改动：**

- **`groupAccountsByStatus` 纯函数** 加到 `web/src/status.js`：按 `_status` 分桶 + 按固定业务序 `GROUP_ORDER`（12 个状态）排序 + 隐藏空组。`DEFAULT_EXPANDED_STATUSES = ['plus', 'plus_no_rt']` 同 status.js 导出。
- **`AccountTableRows.vue` 子组件**：从 Execute.vue 抽出 el-table 列定义 + 展开日志行模板（~142 行）。Props 含 `rows / running / globalSelectedSet / getHistoryLogs / getRealtimeLogs`。Emits `group-selection-change / expand-change / row-action / auth-download / row-click`。Exposes `clearSelection / toggleRowExpansion`。
- **`Execute.vue` 改造**：`<el-collapse v-model="expandedKeys">` v-for `<AccountTableRows>`；selection 由 `selection.js` 全局 Set 跨组聚合；`autoExpand` 跨子组件接线（先 push `'running'` 进 expandedKeys，nextTick 后调对应子组件 `toggleRowExpansion`）。
- **`statusFilter` 与分组协同**：选某状态 → watch only-add 进 expandedKeys → 该组自动展开；空组隐藏后效果等同于"只看那一组"。

**关键不变式**：`selection.js` 仍是单一来源 —— 子组件 `watch(() => props.rows) + { flush: 'post' }` 在 rows 变化（如跨组迁移）时用 `globalSelectedSet` 回填选中标记。替代了原 `restoreSelection()` 函数。

**单测**：`__tests__/status-groups.test.js` +10（G1-G10：空输入 / 业务序 / 空组过滤 / 同状态聚合 / 缺失 _status / 未知状态 fallback / label-type 派生 / DEFAULT_EXPANDED 常量 / 非数组守卫 / 多个未知 status 插入序）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-status-groups-design.md` + `docs/superpowers/plans/2026-05-25-execute-status-groups.md`。

## v2.31.1 — 2026-05-25

### Hotfix: 测活投票粒度细化 + 自动 rotate

v2.31.0 投票"每个账户末尾 1 票"过粗：1 个账户 3 次 net_error 只
贡献 1 个 failCount，需要 3 个账户都净失败才拉黑节点；且
recordBadAttempt 拉黑后 currentNode 不变，后续账户继续踩坑。

**修复 1 — Proxy auto-rotate**

- `server/proxy/index.js:recordBadAttempt` 在 `next >= FAIL_THRESHOLD`
  时 fire-and-forget `Promise.resolve().then(() => rotate())`
  （jp 通道走 `rotateJp`），让 `currentNode` 立即切到非黑名单节点
- 新增 `__setAutoRotateForTest(mainFn, jpFn)` 注入钩子；传 `null` 恢复默认
- 现有 engine.js / chatgpt-checkout.js 调用方零改动也享受自动 rotate

**修复 2 — Liveness 逐 attempt vote**

- `server/liveness/runner.js:dispatchOne` retry loop 每次 net_error attempt
  立即 `recordBadAttempt(currentNode, 'main', 'liveness_net_error_a<N>')`
- 同账户 3 次连环 net_error 即累加到 FAIL_THRESHOLD=3 拉黑当前节点
- `blacklisted=true` 时显式 `await pm.rotate?.()` —— 双保险，确保
  attempt N+1 看到新 currentNode
- v2.31.0 末尾 vote 块从 bad+good 砍剩 good（bad 已搬进 retry loop）

**测试**：184 tests pass — proxy +2（B5 main / B6 jp 通道阈值触发 rotate）
+ runner +1 替换（3 次 bad call 替原 1 次）+ runner +1 新增
（mid-retry rotate 顺序断言）on v2.31.0 baseline 181.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-blacklist-vote-granularity-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-blacklist-vote-granularity.md`。

## v2.31.0 — 2026-05-24

### Liveness Proxy Blacklist Integration + Accounts Page Download UI

**Part A — 测活集成 proxy 黑名单**

- `server/liveness/runner.js` 在 `dispatchOne` 末尾终态投票：
  - `alive_status ∈ {network_error, proxy_error}` → `proxyMgr.recordBadAttempt(currentNode, 'main', 'liveness_<status>')`
  - `alive_status ∈ {plus, canceled, token_expired, login_fail, deactivated}` → `proxyMgr.recordGoodAttempt(currentNode, 'main')`
- 依赖 v2.30 的 3-attempt retry —— 走到终态的 network_error 是节点持续不通、不是偶发抖动
- `createRunner` 接受可选 `proxyMgr` 注入用于测试 mock；production 走 lazy require
- proxy 未启用时跳过投票（gate `getState().enabled`）
- reason 字符串 `liveness_<status>` 与流水线的 `login_net_error` / `payment_unreachable` 区分，便于排查黑名单来源

**Part B — Accounts 页下载 UI**

- toolbar 在"测活全部"右侧加两个 dropdown：
  - **下载选中 (N)** — POST `/api/results/download-selected` 流式 ZIP
  - **下载全部 (ZIP)** — GET `/api/results/download-all`
  - 每个 dropdown 含 `CPA 格式` / `Sub2API 格式` 命令
- 操作列宽 140 → 240，编辑/删除前加 **CPA** / **Sub** 文字按钮，`_hasAuth=false` 时 disabled
- 三个 helper 函数 (`downloadAuth` / `downloadAllAs` / `downloadSelectedAs`) 跟 Execute.vue 套路一致
- 后端 endpoint 全沿用 v2.29.1 / 早期既有，零后端改动

**测试**：171 tests pass — runner +3 测试（network_error vote bad / plus vote good / proxy disabled skip）on 168 baseline.

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-blacklist-and-accounts-download-design.md` + `docs/superpowers/plans/2026-05-24-liveness-blacklist-and-accounts-download.md`。

## v2.30.0 — 2026-05-24

### Liveness Log Partition + network_error Auto-Retry

**Part A — UI 日志面板拆分**

- 单一 `<el-collapse>` 拆成两个：
  - **旧日志** (默认折叠) — 来自 DB 的最近 200 条历史，跨页面刷新保留
  - **实时日志** (默认展开) — 本次会话 socket 推送的 500 条，自动滚动到底部
- `socketState.logs` 每条 entry 加 `isHistorical: boolean` 字段。`loadLivenessLogs` (onMounted) 设 true；`pushLivenessLog` (socket realtime) 默认 false。
- `watch(newLogs.length)` + `nextTick` + `scrollTop = scrollHeight` 实现自动滚动。无手动滚动暂停检测——KISS。

**Part B — network_error 自动重试**

- `runner.dispatchOne` 重构：抽 `dispatchOnceInner(email, account, onLog, signal)` 单次尝试，外层 3-attempt 循环每次间隔 2s。
- 重试触发：`alive_status === 'network_error'`（含 HTTP 429/5xx / probe timeout / curl exception / spawn ENOENT / stdout 不可解析 / unexpected）。
- 重试进度通过 `onLog('warning', ...)` 流到 UI 面板和 DB（`network_error: ... — retrying 1/3 in 2s`）。
- `abortableSleep` 让 `await sleep()` 在 `abortCtrl.signal` abort 时立刻 resolve，"停止测活" 秒级响应。
- Worst case 耗时：3 × 12s probe + 2 × 2s delay = **~40s/账号**（仅 network_error 触发；正常 plus 单次 1-3s 不受影响）。

**测试**：168 tests pass — runner +3 (3-attempt 重试 / 1-attempt 重试成功 / plus 不重试) on 165 baseline。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-log-partition-and-retry-design.md` + `docs/superpowers/plans/2026-05-24-liveness-log-partition-and-retry.md`。

## v2.29.0 — 2026-05-24

### Liveness Deactivated Detection + Search UX Overhaul

**Part A — deactivated 检测**

- **Case 1 修复**：`mapPlanType('deactivated')` 直接返 `alive_status='deactivated', reason='account_deactivated'`。v2.28 hotfix `3b64727` 已经让 Python 端在 HTTP 200 + `is_deactivated=true` 时报 `plan_type='deactivated'`，但 Node 端 mapPlanType 误归 `canceled` —— 本次打通。
- **Case 2 新增**：新建 `chatgpt_register/deactivated_check.py`，跑 `protocol_register.py` 的 Step 0-2（homepage / signin / authorize），扫描响应体里的 `account_deactivated` / `account_disabled` 标记。无 OTP，5-10s/账号。`server/liveness/checker.js` 新 `verifyDeactivated` 包装 spawn；`runner.dispatchOne` 在 probe 返 `token_expired` 后调它。
- **实时日志**：v2.26 spec §6.2 定义了 `liveness-log` 事件名但 runner 当时没真发。本次正式实现：runner 注入 `onLog(level, message)` 闭包 → `io.emit('liveness-log', {email, level, message})` → 前端 `socket.on('liveness-log')` → `pushLivenessLog`。`pushLivenessLog` 加 `source:'liveness'` 字段，`Accounts.vue` 的 `livenessLogs` computed 改用该字段过滤（不再靠 message 前缀字符串）。

**Part B — Accounts 页搜索 UX**

- 状态、活性筛选改 `<el-select multiple collapse-tags>`，可同时选多项；filter 用 `Array.includes(a._status)`。
- 搜索框 placeholder 改 `搜索 (邮箱/RT/Client ID/TOTP/密码)`，匹配五个字段的 haystack join。
- toolbar 新增 3 个按钮：
  - `仅看未测试` 一键设 `aliveFilter=['unknown']`
  - `7天未测` 切换 `staleOnly`，按 `alive_checked_at` 时间过滤
  - `重置筛选` 一键清 6 个 filter 维度（含 staleOnly），任意 filter 激活时才可用

**测试**：159 tests pass —— 16 checker（+2 deactivated 映射）+ 6 verify-deactivated（新）+ 10 runner（+2 verifyDeactivated 集成）+ 既有 125 unchanged。Python `deactivated_check.py` 沿用 stripe_init.py 模式不写单测，集成 smoke 验证。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-deactivated-detection-and-search-ux-design.md` + `docs/superpowers/plans/2026-05-24-deactivated-detection-and-search-ux.md`。

## v2.28.0 — 2026-05-24

### Liveness Probe Cloudflare Bypass + 日志面板

v2.26 测活在 2026-05-24 实测中发现 **100% 失败**：Node `globalThis.fetch` 调 `/accounts/check` 被 Cloudflare 的 TLS 指纹检测一律拦截返 403，即便走 :7890 主代理也无法绕过（验证 commit `7b65000` 的 `HttpsProxyAgent + https.request` 路径仍中招）。同时用户反馈"测活看不到日志"。

**核心改动：**

- **Python curl_cffi probe**：新建 `chatgpt_register/liveness_probe.py`，套路对照 `stripe_init.py` / `protocol_register.py` / `checkout_link.py`，spawn 出来用 `impersonate='chrome131'` 模拟真实浏览器 TLS 指纹过 Cloudflare。
- **`server/liveness/checker.js` 重构**：删 v2.26 的 `globalThis.fetch` 和 `7b65000` 的 `_requestViaProxy`；改 `spawn('py', ['-3', 'liveness_probe.py'])`，套路对照 `server/stripe-verify.js`。`decodeJwtExp` / `mapPlanType` / `extractPlanType` 保留导出。
- **Cloudflare 403 区分账号 403**：Python 端扫返回体里的 `__cf_chl` / `cf-mitigated` / `Cloudflare` 标记。Cloudflare → `alive_status='proxy_error'`（网络层、提示切节点）；账号 → `alive_status='login_fail'`（账号问题）。
- **测试改造**：11 → 14 测试。5 个纯 helper unit 保留；9 个 probe 测试从 `fetchImpl` 注入改成 `spawnImpl` 注入（fakeChild EventEmitter）；新增包括 spawn ENOENT、stdout unparsable、cloudflare-vs-account 403 discriminator。
- **Accounts 页底部折叠日志面板**：表格下方加 `<el-collapse>`，订阅 `socketState.logs` 过滤 `[liveness]` 前缀。测活启动时自动展开、结束后保留展开供回看。`socket.js` 3 个 liveness handler 各加一条 push（liveness-progress 不打日志避免 flood）。

**预期效果：** 测活通过率从 0% 回到 ~100%（JWT 未过期 + 账号是 Plus 的真实账号），用户能实时看到逐账号 `[liveness] checking → plus: check ok` 日志流。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-python-probe-design.md` + `docs/superpowers/plans/2026-05-24-liveness-python-probe.md`。

**测试**：149 个测试通过。

## v2.27.0 — 2026-05-24

### Skip Phase 1 on Access-Token Cache Hit

Building on v2.25's payment-link cache (Phase 2 + 2.5 skip), this release also persists the protocol-login `accessToken + session JSON` to `account_status`. On retry of a failed account, if the JWT exp is still in the future (with 60s buffer), `result` is reconstituted from the DB and the entire Phase 1 login is skipped — saving the 30-60s OTP+auth0 round-trip on top of v2.25's 8-25s savings.

**核心改动：**

- **DB schema**：`account_status` 加 3 列 `last_access_token / last_session_json / last_access_token_at`，PRAGMA-gated ALTER 防御性迁移存量库。
- **statusDB.set 扩展 merge**：camelCase 入参 `accessToken / sessionJson`；未传时保留 DB 现值（同 v2.25 paymentLink 套路）；新 helper `clearAccessToken` 用于支付成功后清除。
- **双引擎同步**：`protocol-engine.js` 和 `server/engine.js` 都在 `dispatchOne` 入口加 cached-login 分支，紧跟 v2.26.1 引入的 `prevPersisted` snapshot。
- **JWT exp 校验**：复用 v2.26 `server/liveness/checker.js` 导出的 `decodeJwtExp` 工具——单一来源、不重复实现。
- **失败兜底**：cached token 还有效但 OpenAI 已 revoke（改密等）→ Phase 3 page.goto(link) 仍 OK（link 自带 stripe session）；Phase 5 PKCE 重登失败 → plus_no_rt 兜底，下次测活会标 token_expired。

**预期收益：** cache + token 都命中的重试场景，账号耗时从 68-145s 缩到 30-60s（节省 **40-90s/账号**）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-skip-login-on-cache-hit-design.md` + `docs/superpowers/plans/2026-05-24-skip-login-on-cache-hit.md`。

**测试**：`__tests__/db-access-token.test.js` 5 个新单元 + 集成 smoke。146 测试通过。

## v2.26.0 — 2026-05-24

### Account Liveness Check (Phase A — Browser Mode)

Accounts 页加 "测活选中 / 测活全部" 顶部按钮，对账号批量调 `/backend-api/accounts/check` 判 Plus 订阅是否还在 + access_token 是否还能用。本地 JWT 过期或返 401 时自动密码 + OTP 重登拿 `/api/auth/session` 的 access_token、手工拼装 `cpa-auth/codex-{email}.json`，**不走** PKCE。

**核心改动：**

- **DB schema**：`account_status` 加 3 列 `alive_status / alive_checked_at / alive_reason`，PRAGMA-gated ALTER 防御性迁移存量库。新 `statusDB.setAlive` / `clearAlive` 与 `statusDB.set` 同样的 merge-aware 不变式 — 测活写入绝不污染 `status` / `payment_link*` 列。
- **独立模块** `server/liveness/`：4 个核心模块（`checker.js` / `light-login.js` / `codex-file.js` / `runner.js`）+ `server/routes/liveness.js`。runner 3 并发 + 1s 节流，跟 `PipelineEngine` / `ProtocolEngine` 完全解耦、与主流水线可并行。
- **Lazy hybrid 流程**：先用现存 access_token 调 `/backend-api/accounts/check`；2xx 直接判 plan_type；返 401 或本地 JWT 过期才走 `lightLogin` 重登拿新 token、覆写 codex-{email}.json、再调 check。
- **8 种 alive_status**：`plus / canceled / login_fail / token_expired / proxy_error / network_error / unknown / checking`，与执行流水线 status 完全独立的维度。
- **UI**：Accounts.vue 顶部 toolbar + 活性 / 上次测活 列 + 活性筛选下拉。Socket.IO 三事件 `liveness-status / liveness-progress / liveness-complete` 通过 `socketState` 推送，watch 桥接到每行 `_aliveStatus / _aliveReason / _aliveCheckedAt`。
- **不动 sub2api**：与 `utils.saveCPAAuthFile` 不同，`server/liveness/codex-file.js` **只** 写 `cpa-auth/codex-{email}.json`，sub2api 文件由 sub2api 服务自己处理。grep 验证：`server/liveness/*.js` 源码零提及 sub2api。

**端到端验证：**

- **141 个 tests passing**（既有 96 + 6 payment-link + 5 db-alive + 11 checker + 7 codex-file + 9 light-login + 8 runner + 5 routes-liveness = 141；超 spec §9.1 写的 35 因 mapPlanType / sanitize / protocolMode 等子单元拆开单测）。
- **关键不变式 verified**：`server/liveness/codex-file.js` 源码 0 处 `sub2api` write；db `setAlive` 不污染 `status` / `payment_link*` 通过 db-alive.test.js 第 3 例锁。
- **Spec / Plan**：`docs/superpowers/specs/2026-05-24-account-liveness-check-design.md` + `docs/superpowers/plans/2026-05-24-account-liveness-check.md`。

**Phase B 待办：**

协议模式 light-login（`config.protocolMode=true` 时的密码+OTP 重登）—— 现在协议模式只能 check 未过期 token，需重登的账号标 `alive_status='login_fail', reason='liveness not yet supported in protocol mode'`。后续单独立 spec 处理 `chatgpt_register/liveness_login.py` 实现。

## v2.21.0 — 2026-05-24

### Main Proxy Node Whitelist

主代理通道之前只有 `regionFilter` 关键字筛选（默认 `'US'`，走大型正则）。用户想精确指定几个节点只能祈祷它们 tag 共享同一关键字。复刻 JP-Checkout 通道（v2.18.1）的成熟白名单模式，主通道获得对称能力。

**核心改动：**

- **新字段** `cfg.proxy.whitelist: string[]` —— 精确 tag 列表。
- **新决策函数** `pickMainNodes(all, mainCfg)` —— 与 `pickJpNodes` 同构：whitelist 非空时精确匹配（`filterByWhitelist`），空时回退 `regionFilter` 关键字（`filterByRegion`），**双空** 时（regionFilter 为空字符串/未设）返回全部节点。
- **`refresh()` 集成** —— 主通道筛选块改用 `pickMainNodes`，按 `usedWhitelist` 分流日志格式；全不命中订阅时 throw 不静默退化（与 JP 同）。
- **`regionFilter` 默认 `'US'` 仅当字段缺失**：显式空字符串现在被识别为"不过滤"，统一规则用 `??` 替原 `||`。
- **`GET /api/proxy/nodes` 加 `usTags`** —— UI 主白名单下拉据此高亮匹配 regionFilter 的节点。
- **Config.vue 节点白名单分节** —— `el-select multiple filterable` + US 节点绿色加粗 + 'US' 标签；区域过滤输入框在白名单非空时灰显 + "已被白名单覆盖" 提示；代理状态卡加 whitelist 计数 + misses 黄色行。

**对外契约扩展（无破坏）**：`getState()` 返回多两个字段 `whitelist` / `whitelistMisses`（与 `_state.jp.whitelist` 同语义）。Config.vue 是唯一消费者，新增渲染逻辑兼容旧响应（undefined 时不渲染）。

**单测**：`server/proxy/__tests__/index.test.js` +7（W1-W7：5 个仿 pickJpNodes 同号 + W6 双空边界 + W7 字段缺失边界）。proxy 套件总 46→53 用例，无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-main-proxy-whitelist-design.md` + `docs/superpowers/plans/2026-05-24-main-proxy-whitelist.md`。

## v2.20.0 — 2026-05-24

### Proxy Blacklist Threshold + Rotation Cursor Persistence

之前的代理黑名单是"一次失败立即拉黑 30 min"，对网络偶发抖动过于敏感；运维也没有 UI 入口移除误拉黑的节点；`refresh()` 每次都把 `rotationIndex` 重置为 0，导致顺序轮换模式下头部节点反复使用、尾部节点长期闲置。

**核心改动：**

- **连续 3 次失败计数**（中间任一次成功立刻清零）：新函数 `recordBadAttempt(tag, channel, reason)` / `recordGoodAttempt(tag, channel)`，旧 `markBad` / `markJpBad` 保留作 alias 向后兼容。
- **黑名单跨重启持久化**：新表 `proxy_blacklist (tag, channel, expires_at, reason, source)`，新模块 `server/proxy/blacklist.js` 封装 CRUD；首次 `refresh()` 时 hydrate 回内存 Map；TTL 30 min 行为保持。计数器仍在内存。
- **`refresh()` 不重置游标**：仅在节点列表变短时取模到合法范围，`currentNode` 跟随 `rotationIndex` 而非固定 `filtered[0]`。
- **4 个新 REST endpoint**：`GET /api/proxy/blacklist` / `POST /add` / `POST /remove` / `POST /clear`。
- **Config.vue 节点黑名单分节**：主代理 + JP 各一个 `el-table`（节点 / 剩余 TTL / 来源 / 原因 / 移除按钮 + 清空），10s 轮询。
- **触发点扩充**：除现有 3 个点（TLS / payment unreachable / JP checkout 空 link）外，新增 Stripe verify timeout / 协议模式网络类 catch / 浏览器模式 login 网络类 reason 三个。`isProxyNetError` 共享网络错误关键字识别。

**对外契约变化**：`getState().badNodes` 从 `{tag: expiryMs}` 升级为 `{tag: {expiresAt, reason, source}}`。Config.vue 不再读这个字段（专门走 `/api/proxy/blacklist`），无回归。

**单测**：`server/proxy/__tests__/index.test.js` +12（U1-U10 + 2 个 review 修复用例）、`rotation.test.js` 新建 +5 (R1-R5)、`blacklist.test.js` 新建 +6 (B1-B4 + 边界)、`server/__tests__/proxy-route-blacklist.test.js` 新建 +4。共新增 27 用例，60+ 总测试无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-proxy-blacklist-and-rotation-cursor-design.md` + `docs/superpowers/plans/2026-05-24-proxy-blacklist-and-rotation-cursor.md`。

## v2.19.1 — 2026-05-23

### payment.js rolled back to v2.14.0 baseline

实测验证 v2.19 Phase 2.5 链路全程正常（osxti6295 端到端 `redirect_status=succeeded`），但 v2.14 之后的 6 个 payment.js perf/fix 累积导致 PayPal checkout 12 字段在当前 PayPal DOM 下全部 MISSED。先回退 payment.js 到 v2.14.0 最后已知能用的状态，未来如需重新引入这些 perf，按 commit 单独 cherry-pick + 充分验证。

回退的提交：
- `def0d11` fix(payment): restore 'unable to add this card' regex
- `5e28006` perf(payment): race post-submit outcome
- `f695f84` perf(payment): waitForURL replaces polling loops
- `e9e03e0` perf(payment): replace randomDelays with selector waits
- `ef4d1a9` perf(payment): parallelize PayPal field fills（提前已 revert 为 29f97aa）
- `4201276` perf(payment): cache fetchAddress

端到端实测（v2.19 + v2.14 payment.js）：

- ✅ `gexi4056685` → status=`no_promo`（Phase 2.5 拦截 \$20，不浪费 payment.js）
- ✅ `osxti6295` → status=`plus_no_rt`（全流程通过：\$0 → 12 字段 Filled → SMS 307251 → `redirect_status=succeeded`）
- ⚠ `hprfvxml12008` → status=`error`/PayPal `genericError`（PayPal 服务端在 SMS 提交后拒；非代码问题，单账号风控）

## v2.19.0 — 2026-05-23

### Reliable JP-First Checkout

实测推翻了 v2.18.2 阶段的"节点 IP 无关"误判（当时独立测试脚本里 proxyMgr 未初始化导致请求走直连，掩盖了 JP IP 的关键作用）。强制 JP 节点后实测，hprfvxml12008 / ovjvant465198 / osxti6295 等账号能稳定拿到 $0；同时确认 bot 的 Eligibility Check 真实有效——gexi4056685 / qnke4812473 等被 bot 标"无资格"的账号即使强制 JP 仍只拿 $20。

**核心改动**：

- **强制 JP**：`server/chatgpt-checkout.js` 移除 `jpUrl || mainUrl` 静默回退。JP 节点池不可用时立即 resolve `{noJpProxy:true}`，不启动 Python 子进程。
- **Stripe init 验证**：新增 `server/stripe-verify.js` + `stripe_init.py`，从 cs_live URL 提取 cs_id，经 main proxy (7890 US) 调 Stripe `/v1/payment_pages/{cs}/init`，解析 `invoice.amount_due` 判断是否真 $0。
- **Phase 2.5 分支**：`server/engine.js` 在 Phase 2 (checkout) 与 Phase 3 (payment.js) 之间插入验证阶段，按结果分流 3 个新状态。
- **`pk` 字段链路**：`checkout_link.py` 把 OpenAI 响应里的 `publishable_key` 作为 `pk` 输出；`fetchCheckoutLink` 在 result shape 中携带 `pk`；engine.js 将 `discord.pk` 传给 `verifyCheckoutIsFree(link, pk)`。Discord linkSource 路径 (`paymentLinkSource: 'discord'`) 跳过 Phase 2.5 验证（信任 bot 的资格判定）。
- **spawn error handling**：`chatgpt-checkout.js` 和 `stripe-verify.js` 都加了 `py.on('error', ...)` 处理 Python 二进制缺失/权限拒绝等本地故障，避免挂到 timeout。

**新增 status 状态**：

| status | 触发 | 文案 | 可重试 |
|---|---|---|---|
| `no_jp_proxy` | JP 节点池不可用 | JP 节点不可用 | ✅ JP 恢复后 |
| `no_promo` | invoice.amount_due > 0 | 无 0 元资格 | ❌ 账号资格问题 |
| `verify_error` | Stripe init 调用失败 | Stripe 验证失败 | ✅ Stripe 恢复后 |

**单测**：`server/__tests__/stripe-verify.test.js` (9 cases) + `server/__tests__/chatgpt-checkout.test.js` (2 cases) 覆盖 pure helpers 与早返回；既有 proxy 测试 (20 cases) 无回归。

**Web Dashboard**：`web/src/status.js` 加 3 个 type/label 映射；`web/src/views/Dashboard.vue` 加 3 个 KPI 卡片；`web/src/views/Accounts.vue` / `Execute.vue` / `Results.vue` 的状态筛选下拉各加 3 个 option。

**对照 v2.18**：
- v2.18.0: JP-KDDI 双入口
- v2.18.1: jpCheckout 白名单
- v2.18.2: `country=US, currency=USD` 1 行改动（解锁 PayPal + USD 计价）
- **v2.19.0**: fail-fast 与 $0 验证（本次）

**E2E 验证清单**（待运维实际跑，非合并阻塞）：
- [ ] hprfvxml12008 → 应当 status=plus（Phase 2.5 ✓ 通过，Phase 3 完整跑通）
- [ ] gexi4056685 → 应当 status=no_promo（Phase 2.5 拦截 $20 link）
- [ ] 临时 disable jpCheckout → 应当 status=no_jp_proxy（不启动 Python）

## v2.18.1 — 2026-05-23

### Added
- `config.proxy.jpCheckout.whitelist: string[]` —— 精确指定 JP-Checkout 通道使用的节点 tag 数组。非空时优先，空时回退到 v2.18.0 的 `keyword` 过滤行为（向后兼容）。
- `GET /api/proxy/nodes` —— 返回订阅当前全部节点 tag + KDDI 子集，供 UI 下拉选项使用。
- `server/proxy/subscription.js` 新增 `filterByWhitelist(outbounds, whitelist)` —— 用 Set 精确匹配 tag，自动去重 + 剔除非字符串项。
- `server/proxy/index.js` 新增 `pickJpNodes(all, jpCfg)` —— 纯函数承载“whitelist > keyword”决策；导出供单测使用。
- `_state.jp.whitelist` / `_state.jp.whitelistMisses` —— 跟踪用户配置的白名单与订阅中缺失的 tag。
- `_state.allTags` —— refresh 时缓存全部节点 tag，供 `/nodes` 接口快速返回。
- `Config.vue` 加 `JP 节点白名单` 下拉多选 (el-select multiple filterable)：含全部节点 + 搜索框，KDDI 节点绿色加粗高亮 + 右侧 “KDDI” 标签。
- `Config.vue` 状态卡新增 `whitelistMisses` 黄色提示行（白名单中订阅缺失的 tag）。

### Changed
- `refresh()` 改用 `pickJpNodes()` 做节点选择决策，原 `filterByJpKddi` 直接调用降为 `pickJpNodes` 内部回退分支。
- `Config.vue` `JP 节点关键字` 输入框在白名单非空时自动灰显 + 提示 “已被白名单覆盖”。

### Robustness
- 白名单含订阅没有的 tag → 静默跳过，`whitelistMisses` 记录，UI 黄色提示。
- 白名单**全部**不命中 → `jp.enabled=false`，`lastError` 含未匹配的 tag 列表（**不**静默回退到 keyword，避免反直觉行为）。
- 白名单非数组（字符串误填）→ `pickJpNodes` 类型守卫，视为空 → fallback keyword 分支。

### Tests
- 单元测试 20/20 通过：
  - `filterByJpKddi` × 5 (v2.18.0)
  - `filterByWhitelist` × 6 (新增)
  - `buildSingboxConfig` × 4 (v2.18.0)
  - `pickJpNodes` × 5 (新增)
- 集成验证后端 T8-T11 全过（白名单生效、部分命中、全不命中、清空回退）。
- `/api/proxy/nodes` 返回 147 节点、2 个 KDDI tags 验证通过。

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-jp-checkout-whitelist-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-jp-checkout-whitelist.md`

## v2.18.0 — 2026-05-23

### Added
- 新增 `JP-Checkout` 通道：sing-box 增加第二个 mixed inbound (`:7891`)，专用 `jp-checkout` selector 仅选 KDDI 节点。
- `server/proxy/subscription.js` 新增 `filterByJpKddi(outbounds, keyword='KDDI')`，按 tag 关键字（不区分大小写正则）过滤。
- `server/proxy/index.js` 扩展 `_state.jp` 子结构与 `getJpProxyUrl / getJpState / rotateJp / detectJpExit / markJpBad`。
- `/api/proxy/jp/{rotate,detect-exit,mark-bad}` 三个新端点。
- `Config.vue` 加 `JP-Checkout 通道` 分区：启用开关、关键字输入、只读状态卡片（节点数、当前节点、出口 IP、错误）+ 检测/切换按钮。
- 配置 schema 新增 `proxy.jpCheckout: { enabled, keyword, rotationStrategy }`（缺省值 `{ true, 'KDDI', 'sequential' }`，向后兼容）。

### Changed
- `server/chatgpt-checkout.js` 把 proxy 优先级改为 `getJpProxyUrl() || getProxyUrl()`；JP 通道未启用时 raw 字段附 `WARN: jp_channel_disabled`。
- `buildSingboxConfig(us, jp)` 改为接收双池参数；`jp` 为空数组/null 时 `route.rules` 退回单入口形态。

### Fixed
- `server/proxy/singbox.js` 的 `start()` 现在在 spawn 后**主动探测每个 mixed inbound 端口**是否真的 LISTENING；进程死亡或端口未绑定时立即 throw（含 `address already in use` 关键字）。修复 v2.17.0 起就存在的"sing-box 实际已死但 server 仍报 enabled=true"问题。

### Robustness
- 订阅中无 KDDI 节点时**软失败**：主代理正常启动，`jp.enabled=false`，UI 显示提示。
- 7891 端口被占时**降级**：catch sing-box 启动错误后用无 jp 配置重启 sing-box；主代理不受影响。

### Tests
- 单元测试 9/9 通过：
  - `filterByJpKddi` × 5 cases（含正则元字符、空输入、自定义关键字）
  - `buildSingboxConfig` × 4 cases（单/双入口、route.rules 形态、direct/block 兜底）
- 集成验证 T1+T2+T5+T6 全过（双端口 listen、JP 出口 IP 为 KDDI 住宅段、软失败、端口冲突降级）

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-checkout-via-jp-kddi-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-checkout-via-jp-kddi.md`

### 关键验收待项
- **T3 ¥0 试用链接验证**：需要一个全新、未用过试用的 OpenAI 账号通过 checkout 拿链接，Chrome+CDP 渲染验证显示 `Free trial / ¥0 / Total due today: ¥0`。这是 v2.17.0 从未验证到的核心目标。
