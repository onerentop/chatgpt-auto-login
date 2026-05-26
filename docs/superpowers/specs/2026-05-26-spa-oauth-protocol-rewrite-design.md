# SPA OAuth 协议侧重写设计

**状态**：草案，待 review
**日期**：2026-05-26
**触发**：v2.41.13 修复 liveness `authorize page structure changed` 噪音时发现 OpenAI 把 `/authorize` 整改成 SPA，旧协议侧 `_parse_state_from_authorize_page` 永远拿不到 state。reconnaissance 实测 `gyjstbd9622137@outlook.com` 走通新 flow 拿到 access_token。

## 1. 背景

`chatgpt_register/liveness_login.py` 用 curl_cffi 模拟 6 步 Auth0 表单 POST 流程拿 access_token，给 `/backend-api/accounts/check` 测活：

```
GET /authorize → server-render HTML 含 <input name="state" value="...">
POST /u/login/identifier （sentinel + state + username）
POST /u/login/password   （sentinel + state + password）
POST /u/mfa-email-challenge （触发 OTP 邮件）
POST /u/mfa-email-challenge （sentinel + state + OTP）
GET /authorize/resume  → callback → access_token
```

**v2.41.13 发现**：OpenAI 已经把 `/authorize` 改成 React SPA（49KB shell + 一堆 CDN JS bundle，无任何 `<form>`），上面整条 form-POST 流程全部死掉，`_parse_state` 永远返 None。v2.41.13 仅做了"识别这种 page → 归 unknown 不重试"的伤口包扎，根本问题没解决。所有协议模式 outlook 账号 liveness 都失效。

## 2. 新 SPA OAuth flow（reconnaissance 实测）

5 个 HTTP 调用从输邮箱走到拿 access_token：

| # | Method/URL | Request | Response (200) | Cookies 副作用 |
|---|-----------|---------|----------------|---------------|
| 1 | `GET https://auth.openai.com/authorize?client_id=...&scope=...&response_type=code&redirect_uri=...` | (空) | 49KB SPA HTML shell | `oai-did`, `__cflb`, `__cf_bm`, `_cfuvid` |
| 2 | `GET https://auth.openai.com/api/accounts/client_auth_session_dump` | (空) | `{client_auth_session:{session_id, openai_client_id, email, requested_oauth_scopes:[...], country_code_hint, original_screen_hint:"login", auth_session_logging_id, app_name_enum:"chat"}}` | — |
| 3 | `POST https://auth.openai.com/api/accounts/authorize/continue` | `{"username":{"kind":"email","value":"<email>"}}` | `{continue_url:"https://auth.openai.com/email-verification", method:"GET", page:{type:"email_otp_verification", payload:{email_verification_mode:"passwordless_login"}}}` | — |
| 4 | **(等 IMAP OTP)** | | | |
| 5 | `POST https://auth.openai.com/api/accounts/email-otp/validate` | `{"code":"<6-digit>"}` | 200 (空 body 或 redirect 指令；浏览器接到 cookies 后跳 chatgpt.com callback) | `_puid`, `__Secure-oai-is`, `__Secure-next-auth.session-token` 等 chatgpt.com 域 cookie |
| 6 | `GET https://chatgpt.com/api/auth/session` | (带 cookies) | `{accessToken:"eyJ...", user:{id:"user-...", email}, account, expires:"2026-08-24T..."}` | — |

**关键变化**：

- **没有 password step** — passwordless email OTP，单凭邮箱 + OTP 登录
- **没有 state CSRF / sentinel token** — 所有 session 跟踪靠 cookies 自动 sync（curl_cffi Session 已支持）
- **JSON API + 强类型** vs 旧的 form-POST + 字符串 form fields
- 客户端 JS 应用 ID 是 `app_X8zY6vW2pQ9tR3dE7nK1jL5gH`，但 OAuth `client_id` query 参数仍可用旧的 codex client_id `pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869`（reconnaissance 实测）

## 3. 错误码分类

`POST /api/accounts/email-otp/validate` 失败响应（HTTP 4xx + body 含 `error.code`）：

| `error.code` | 含义 | 映射到 liveness `alive_status` |
|--------------|------|------------------------------|
| `account_deactivated` | 账号被 OpenAI 永久停用 | `deactivated` |
| `invalid_code` | OTP 错（输入错 / 邮件被用过 / 超时） | `login_fail` 或继续 retry |
| `rate_limited` (推测) | 验证过频 | `proxy_error`（不重试 OTP，给冷却时间） |
| 其他 | 未分类 | `unknown`（先归这里，碰到再补） |

`POST /api/accounts/authorize/continue` 失败响应：

| `error.code` (推测) | 含义 | 映射 |
|--------------|------|------|
| `invalid_email` / `unknown_user` | 邮箱不存在 | `login_fail` |
| 网络层 5xx / Cloudflare 403 | 代理问题 | `proxy_error` |

**注意**：错误码列表是基于 `account_deactivated` 一个实测样本 + 推测的旧 flow 命名规则。实现阶段需要：
- 故意输错 OTP 一次抓 `invalid_code` shape
- 监控生产 7 天看实际出现哪些 `error.code`

## 4. 影响范围

### 4.1 必改

- **`chatgpt_register/liveness_login.py`** — 完全重写 `login()` 函数。删除：sentinel token 获取、6 步 form POST、`_parse_state_from_authorize_page`。改为：5 步 JSON API 调用 + cookie jar 自动 sync。
- **`server/liveness/runner.js`** — 错误关键词正则扩展，匹配新 error.code（`account_deactivated` → `deactivated`，`invalid_code` → `login_fail`）。
- **`__tests__/`** — 删旧 mocked sentinel/state 测试，写新 mocked JSON API 测试。

### 4.2 待评估，不在本 spec 范围

- **`chatgpt_register/protocol_register.py`** — 注册新账号流程。它也走 `/authorize`，但走的是 signup flow (`signup_mode != login`)，OpenAI 可能同步改造也可能没改。需要单独 reconnaissance 一个新注册账号确认。**本 spec 只覆盖 liveness 重写。如果 register flow 也坏了，开新 spec。**
- **`server/liveness/light-login.js` 浏览器 path** — Playwright 走的也是 auth.openai.com，新 SPA 仍渲染 username/password OTP UI（实测能看到登录页），所以浏览器 path **理论上**仍能工作。但 `await page.fill('input[name="password"]', ...)` 这一步在 passwordless flow 里没有 password input，会卡住。需要确认浏览器 path 现在是否实际还能用，若不能，需要同步改写 step。

### 4.3 不动

- `server/engine.js` PipelineEngine（不直接调 auth）
- `protocol-engine.js` ProtocolEngine（不直接调 auth）
- `server/chatgpt-checkout.js` / `server/stripe-verify.js` / `payment.js`（不依赖 auth.openai.com 登录）
- `chatgpt_register/otp.py`（IMAP 拿 OTP 不变，跟登录 flow 解耦）
- `chatgpt_register/sentinel.py`（注册流程可能还在用，liveness 不再需要）

## 5. 实现细节

### 5.1 curl_cffi Session cookie jar

新 flow 强依赖跨 endpoint cookie 自动 sync（步骤 1 设的 `__cf_bm` 在步骤 3 + 5 都要带）。`curl_cffi.requests.Session` 已经原生支持 cookie jar。验证点：
- 步骤 1 后 `session.cookies` 应该含 `oai-did` / `__cf_bm`
- 步骤 5 成功后 `session.cookies` 应该多出 `_puid` (chatgpt.com 域)
- 步骤 6 `GET chatgpt.com/api/auth/session` 自动带 chatgpt.com 域 cookies

### 5.2 Chrome impersonate 不变

继续走 `_CHROME` 列表里 `chrome131..146` 随机选；TLS 指纹比 URL 路径关键，OpenAI 的 Cloudflare WAF 主要看这个。

### 5.3 代理

`socks5h://127.0.0.1:7890` （sing-box 主代理）不变。所有 5 步 + IMAP 都走它。

### 5.4 超时 + retry

- 单步超时 30s（旧值）
- IMAP 轮询超时 90s（旧值）
- runner.js 已有 retry 包装；本层不做 retry（cookie jar 重试同一 session 没意义，要新 session 就 runner 那层重新 spawn Python）

### 5.5 错误抛出契约

继续遵守 runner.js 关键词匹配规则（见 `server/liveness/runner.js`）。新增 raise：

```python
# step 3 失败
raise Exception(f"login_fail: authorize/continue 拒绝 (code={err_code})")

# step 5 — account_deactivated
raise Exception(f"deactivated: OpenAI 账号已停用 (code=account_deactivated)")

# step 5 — invalid_code
raise Exception(f"login_fail: OTP 验证失败 (code=invalid_code)")

# 网络层（Cloudflare 403 / 5xx / connection reset）
raise Exception(f"proxy reset (login): ...")
```

runner.js 既有正则需要扩展：
- `/deactivated|account_deactivated/i` → `deactivated`（已有 `deactivated` 分类，正则要加这俩词）

## 6. 测试策略

### 6.1 单测 (`server/liveness/__tests__/` + `__tests__/`)

mock curl_cffi/HTTP 层（不真实出网），固定 5 个 endpoint 的 response 样本（success + 4 类 error.code），断言 `liveness_login.py` 抛对应 Exception 字符串。

### 6.2 集成测

实测三个账号：
- `gyjstbd9622137@outlook.com` — 实测过 alive，应返回 plus，access_token expires ≈ 90 天
- `liabhzo717818@outlook.com` — 实测过 deactivated，应抛 `deactivated`
- 一个故意输错 OTP 的（手动 patch 代码强制写错 OTP）确认 `invalid_code` shape

### 6.3 端到端

整个 server 跑一次 batch liveness（30+ 账号），看 unknown 数量降到 0，所有账号有明确的 plus / plus_no_rt / deactivated / login_fail / proxy_error。

## 7. 不解决（YAGNI）

- **重写 register flow**：注册流程的新 SPA 适配单独立 spec
- **删 sentinel.py**：还有 register 在用
- **改 PipelineEngine 浏览器 path**：browser path 现状是否能用先实测，不能用单独立 spec
- **改 client_id**：继续用 codex `pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869`，OpenAI 接受
- **状态机重构**：runner.js 既有 retry/throttle/concurrency 架构不变

## 8. 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 推测的 `invalid_code` shape 不对 | 中 | 实现阶段抓一次实际错误 OTP 样本 |
| 步骤 2 `client_auth_session_dump` 是否必需调？(reconnaissance 是 SPA 自动调，可能 step 3 不依赖 step 2) | 中 | 实现阶段先**省略** step 2，跑通就不补；不通再加 |
| OpenAI 再次改 flow | 低 | 5 步比 6 步更"原子"，单点改动好排查；保留 v2.41.13 unknown fallback |
| Cookie domain 跨子域跳转不工作 | 低 | curl_cffi 标准支持 |
| Refresh token 流程改变 | N/A | passwordless flow 没有 RT；现有 plus_no_rt 账号继续无 RT 是预期，不是 regression |

## 9. 验收标准

1. `liabhzo717818@outlook.com` liveness 跑出 `alive_status=deactivated`（不是 unknown）
2. `gyjstbd9622137@outlook.com` 等已知 alive 账号 liveness 跑出 `alive_status=plus`
3. v2.41.13 加的 `/page structure|page format/` 兜底永远不再被触发（这个 case 不应再出现）
4. 218 Node + 17 Python 测试全绿
5. batch liveness 跑全部 outlook 账号，unknown 比例 < 5%（剩余的是真正的边角错误）
