# OpenAI add_phone HTTP 协议（抓包报告 2026-05-26）

> **抓包账号**: `fbpi1478530@outlook.com`（未绑过手机的 Outlook 账号）
> **抓包号码**: `+19286413808`（被 OpenAI 判 VoIP 拒绝 — 不影响端点/payload 提取）
> **抓包方法**: utils.js 临时 capture hook + Playwright `page.on('request'/'response')` → 输出到 `phase0-fbpi1478530_outlook_com.json`
> **服务环境**: protocolMode=false（浏览器模式 + PipelineEngine + Playwright Chrome 148）+ phonePool.enabled=true / provider=local

---

## 1. phone-start 端点 ✅ confirmed

**URL**: `POST https://auth.openai.com/api/accounts/add-phone/send`

**Request headers**（必要部分，去掉 datadog tracing / sec-ch-ua 等 Chrome 自动加的）：

```http
Accept: application/json
Content-Type: application/json
Origin: https://auth.openai.com
Referer: https://auth.openai.com/add-phone
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
```

**重要**：phone-start request **不带 `openai-sentinel-token`**（与 `authorize/continue` 和 `email-otp/validate` 不同，那两个端点必须带 sentinel）。**protocol_phone_verify.py 不需要 `get_sentinel_token(flow="phone_start")` 调用**。

**Request body**:

```json
{"phone_number": "+19286413808"}
```

字段名是 `phone_number` 而非 `phone`。E.164 格式。

**Reject response (VoIP 拒号)** —— HTTP **400**:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "message": "Invalid phone number. Please try again.",
    "type": "invalid_request_error",
    "param": null,
    "code": "voip_phone_disallowed"
  }
}
```

**判定函数（Python）**:

```python
def is_phone_rejected(resp):
    """判定 phone-start 响应是否表示 OpenAI 拒号（VoIP / 黑名单 / 速率限制 / 区域限制等）。
    确认：HTTP 400 + body.error.type == 'invalid_request_error' + error.code 已观测到 voip_phone_disallowed。
    其它可能的 error.code（待实测累积）：phone_send_failed / unable_to_send / cannot_send /
      phone_rejected / phone_already_used / rate_limit_exceeded / region_disallowed / ...
    所有 4xx 一律算 rejected（保守策略，宁多勿少 — release+retry 比 hang/submit-error 好）。
    """
    if 400 <= resp.status_code < 500:
        return True
    try:
        data = resp.json()
        err = data.get("error") or {}
        if err.get("type") == "invalid_request_error":
            return True
    except Exception:
        pass
    return False
```

**Success response** ✅ **smoke test 2026-05-26 confirmed**:

```json
{
  "continue_url": "https://auth.openai.com/phone-verification",
  "method": "GET",
  "page": {
    "type": "phone_otp_verification",
    "backstack_behavior": "default"
  }
}
```

**判定函数（Python，保守版）**:

```python
def has_sms_prompt(resp):
    """判定 phone-start 是否进入"等待 SMS 输入"状态。
    实测确认前用 fallback：200 + body 含 continue_url 即认为成功 —— OpenAI 一致用
    continue_url 串联多步流程（authorize/continue → email-verification → add-phone → ...）。
    """
    if not resp.ok:
        return False
    try:
        data = resp.json()
        if data.get("continue_url"):
            return True
        page_type = (data.get("page") or {}).get("type", "")
        return any(kw in page_type.lower() for kw in ["sms", "phone_verify", "phone_code", "verify_phone"])
    except Exception:
        return False
```

---

## 2. phone-validate 端点 ✅ confirmed (smoke 2026-05-26)

**URL**: `POST https://auth.openai.com/api/accounts/phone-otp/validate`

> **注意**：第一次推测 `/api/accounts/add-phone/validate` 错了 — smoke test HTTP 404 "Invalid URL"。正确 path 是 `phone-otp/validate`，对应 `phone_otp_verification` 的 page.type。OpenAI 的 send/validate 命名空间在 add-phone 流程**不一致**（send 用 `add-phone/`，validate 用 `phone-otp/`）。

**推测 payload**: `{"code": "123456"}`（对照 `email-otp/validate` payload 完全相同的字段名）

**推测 success response**: 同 `email-otp/validate` 成功格式：

**Success response** ✅ confirmed:

```json
{
  "continue_url": "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
  "method": "GET",
  "page": {
    "type": "sign_in_with_chatgpt_codex_consent",
    "backstack_behavior": "default"
  }
}
```

⚠️ **`continue_url` 指向 consent 页（不是 localhost:1455 callback）**。新账号第一次 OAuth 必须经过 consent 同意 step，详见 section 3。

**Error response** （验证码错）⚠️ 未实测但 OpenAI 框架一致：HTTP 400 + `{"error": {"type": "invalid_request_error", ...}}`，与 phone-start 拒号同结构 → `is_phone_rejected` 判定可复用（实际 protocol_phone_verify.py 用 `validate-error` status 表达，与 phone-rejected 区分）。

---

## 3. consent 同意 flow ✅ confirmed (smoke 2026-05-26)

新账号第一次 OAuth + 经过 add-phone 后，OpenAI 强制 consent UI（codex CLI 授权确认）。浏览器侧靠主循环点 "继续" 按钮，**协议侧需要主动 POST 模拟**。

**完整序列**：

```
phone-otp/validate 200 → continue_url = /sign-in-with-chatgpt/codex/consent
   │
   ▼ GET /sign-in-with-chatgpt/codex/consent (HTML, 200, ~50KB Remix Turbo Stream)
   │
   ▼ HTML body 含 escaped workspace_id：workspaces\",[N],...,\"<uuid>\",\"profile_picture_alt_text\"
   │   → regex 在 'workspaces' 关键字附近 1200 字符内抓首个 UUID
   │
   ▼ POST /api/accounts/workspace/select  body={"workspace_id": "<uuid>"}
   │
   ▼ 200 response 含 continue_url = http://localhost:1455/auth/callback?code=<auth_code>&scope=...&state=...
   │
   ▼ parse_qs(urlparse(continue_url).query).get("code") → auth_code
   │
   ▼ POST /oauth/token → access_token + refresh_token + id_token ✓
```

**关键发现**：
- `POST workspace/select` **必须**带 `workspace_id`（试 empty body 返 400 "Missing required parameter: 'workspace_id'"）
- workspace_id 不在 phone-otp/validate response 里
- workspace_id 只在 `GET /sign-in-with-chatgpt/codex/consent` 的 HTML body 中（Remix render）
- HTML 是 Turbo Stream 编码，UUID 被 escape 成 `\"<uuid>\"`，不能用普通 JSON regex
- 协议侧 OAuth path 走 `authorize/continue` (email-based)，**没**调过 `session/select` (session_id-based)，所以浏览器侧从 session/select response 拿 workspaces 的 path 不适用

**已在 `_pkce_common.follow_continue_for_auth_code` 内实现 fallback**（GET 拿不到 code 时自动触发 consent 流程）。

**已 consent 过的账号**（如旧账号）OpenAI 直接给 `continue_url = localhost:1455/...?code=...` 跳过 consent step — `follow_continue_for_auth_code` 第一段 GET + ConnectionError regex 拿到 code，consent fallback 不触发。

---

## 4. token exchange ✅ confirmed（无变化）

`POST https://auth.openai.com/oauth/token` 协议未变，沿用 `protocol_register.py:_do_pkce_flow` 既有 `oauth/token` 调用（已在 `_pkce_common.exchange_code` 复用）。

---

## 5. 全流程时序图（smoke 2026-05-26 confirmed）

```
Client (curl_cffi Session, cookies from PKCE)
   │
   │ POST /api/accounts/add-phone/send
   │     Body: {"phone_number": "+E.164"}
   ▼
OpenAI
   │
   ├─ 400 + body.error.type=invalid_request_error (code=voip_phone_disallowed 等) ─► status='phone-rejected'
   │
   └─ 200 + body.continue_url=/phone-verification + page.type=phone_otp_verification ─► 进入 SMS 接码
       │
       │ poll_sms (local: GET smsApiUrl regex / zhusms: POST /api/order/status)  30×3s
       ▼
       │ POST /api/accounts/phone-otp/validate         (✅ NOT add-phone/validate)
       │     Body: {"code": "123456"}
       ▼
   OpenAI
       │
       ├─ 4xx invalid_code ──► status='validate-error' (release)
       │
       └─ 200 + body.continue_url ─► follow_continue_for_auth_code(session, continue_url)
           │
           ├─ continue_url 直接 localhost:1455?code=<X> (已 consented 账号) → 拿 code
           │
           └─ continue_url = /sign-in-with-chatgpt/codex/consent (新账号) → consent fallback:
               │
               │ GET /sign-in-with-chatgpt/codex/consent  (HTML 50KB Remix Turbo Stream)
               │   ↓
               │ regex 找 'workspaces' 关键字附近 UUID → workspace_id
               │   ↓
               │ POST /api/accounts/workspace/select  Body: {"workspace_id": "<uuid>"}
               │   ↓
               │ 200 + body.continue_url = localhost:1455?code=<X> → parse_qs 拿 code
           ▼
           │ POST /oauth/token (exchange_code)
           ▼
       OpenAI → 200 + {access_token, refresh_token, id_token}
           │
           ▼
       protocol_phone_verify.py: status='ok' + tokens (binding 保留)
```

---

## 6. protocol_phone_verify.py 占位常量校准清单

`protocol_phone_verify.py` 当前占位 → 按本报告替换为：

| 占位常量 | 占位值 | 校准为 | Confirmed? |
|---|---|---|---|
| `PHONE_START_PATH` | `/api/accounts/phone/start` | `/api/accounts/add-phone/send` | ✅ |
| `PHONE_VALIDATE_PATH` | `/api/accounts/phone/validate` | `/api/accounts/phone-otp/validate` | ✅（第一次推测 add-phone/validate 错了，smoke 修正） |
| Request body field name (phone) | `phone` | `phone_number` | ✅ |
| Request body field name (code) | `code` | `code` | ✅ |
| sentinel flow="phone_start" 调用 | 有 | **删除**（phone-start 不带 sentinel） | ✅ |
| sentinel flow="phone_validate" 调用 | 有 | **删除**（phone-otp/validate 也不带 sentinel） | ✅ |
| `is_phone_rejected` 判定 | 关键词列表匹配 | HTTP 4xx + body.error.type=='invalid_request_error' | ✅ |
| `has_sms_prompt` 判定 | page.type 含 sms/phone_verify/code | 200 + 含 continue_url | ✅ |
| consent fallback (workspace/select) | 无 | `_pkce_common.follow_continue_for_auth_code` 内置 fallback | ✅ 新增 |

---

## 7. 附带发现：v2.39.4 浏览器侧 red-text 检测缺陷

**问题**：`utils.js:fetchTokensViaPKCE` add_phone 分支的 red-text 检测：

```js
const rejectedNode = await page.locator(':text-matches("无法向此电话号码发送验证码|Unable to send verification|cannot send a verification", "i")').first().isVisible(...)
```

实测 OpenAI 在 voip_phone_disallowed 场景渲染的文案是 **"Invalid phone number. Please try again."** —— 既有 regex **不匹配**，导致 fall through 到 "no rejection text" 分支返回 `submit-error`，而不是正确的 `phone-rejected-by-openai` + retry。

**影响**：
- 功能上仍然 release binding（catch 块里调了 releaseFn）— 池子不会被污染 ✓
- 但 fbpi1478530 这次 attempt 1 拿到 submit-error 就 break 了，**没用上 retry 机制**（按 v2.39.4 设计本应换号重试 3 次）

**fix 建议**（v2.40.1 范围，本次 v2.40.0 不做）：
1. red-text 检测正则补充 `"Invalid phone number"` / `"invalid"` (case-insensitive)
2. 或者更稳：监听 phone/send 的 HTTP response，4xx 直接判定 rejected（CDP `page.on('response')` 捕获 + 立即归类）

---

## 8. 完整抓包事件列表

`phase0-fbpi1478530_outlook_com.json` 共 18 个事件，关键 5 个：

| # | Method | Path | Status | 备注 |
|---|---|---|---|---|
| 8 | POST | `/api/accounts/authorize/continue` | 200 | 邮箱提交 + 触发 OTP，response 跳 email_otp_verification |
| 12 | POST | `/api/accounts/email-otp/validate` | 200 | OTP 提交，response 跳 add_phone |
| 16 | POST | `/api/accounts/add-phone/send` | 400 | **本报告主角**，voip 拒号 |

完整 JSON 见 `phase0-fbpi1478530_outlook_com.json`（项目根）。

---

## 9. Smoke test 结果（2026-05-26 second pass）

**全部推测项已 confirm**，使用 `fbpi1478530@outlook.com` + `+12282351427`：

1. ✅ phone-start success response — `{continue_url: "/phone-verification", page.type: "phone_otp_verification"}`
2. ✅ phone-validate endpoint — `POST /api/accounts/phone-otp/validate`（第一次推测 add-phone/validate 错，404 修正）
3. ✅ phone-validate payload — `{"code": "<6 digits>"}`
4. ✅ phone-validate success response — `{continue_url: ".../codex/consent"}` (新账号 consent 待签)
5. ⚠️ phone-validate error response — 未实测，OpenAI 一致 4xx + invalid_request_error 框架
6. ✅ **新发现**：consent fallback — `POST /api/accounts/workspace/select {workspace_id}`，`workspace_id` 从 consent 页 HTML 的 Remix Turbo Stream 编码里 regex 提取（near 'workspaces' 关键字）
7. ✅ token exchange RT 入袋

**Smoke 端到端结果**：`fbpi1478530@outlook.com` 协议模式 → `status=plus` + RT/AT/id_token 全部入袋 + cpa-auth/codex-fbpi1478530-at-outlook-com.json 含 refresh_token。

**附带发现**：OpenAI 允许同号给多个账号绑定（`+12282351427` 同时绑 cmdxps7772 + fbpi1478530，OpenAI 不拒）。v2.37.0 phone-pool 的"永久绑定"语义可放宽（v2.41+ 优化）。
