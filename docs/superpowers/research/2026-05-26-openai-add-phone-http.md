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

**Success response** ⚠️ **未抓到 — 待实测补充**

推测（基于 OpenAI 既有 send/validate 模式）：

```json
{
  "continue_url": "https://auth.openai.com/add-phone-verify",   // 或类似 /add-phone-code
  "method": "GET",
  "page": {
    "type": "sms_phone_verify",   // 或 "add_phone_code" / "phone_verification_code"
    "backstack_behavior": "default",
    "payload": { ... }
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

## 2. phone-validate 端点 ⚠️ 待实测确认

**推测 URL**: `POST https://auth.openai.com/api/accounts/add-phone/validate`（按 OpenAI `<endpoint>/send` + `<endpoint>/validate` 命名习惯，对照 `email-otp/send` + `email-otp/validate`）

也可能是 `/api/accounts/add-phone/verify` 或 `/api/accounts/add-phone/confirm`。

**推测 payload**: `{"code": "123456"}`（对照 `email-otp/validate` payload 完全相同的字段名）

**推测 success response**: 同 `email-otp/validate` 成功格式：

```json
{
  "continue_url": "https://auth.openai.com/<某个 OAuth continue 链>",
  "method": "GET",
  "page": { "type": "..." }
}
```

`continue_url` 跟随 redirect 会到 `localhost:1455/auth/callback?code=<auth_code>`（OAuth callback）。

**推测 error response**（验证码错）: HTTP 400 + `{"error": {"message": "Invalid code", "type": "invalid_request_error", "code": "invalid_code"}}`

**Smoke test (plan Task 26) 必须验证这些推测并更新本节为 confirmed。**

---

## 3. follow continue → callback chain ⚠️ 待实测

**抓包未到达 phone-validate**，但 OpenAI 既有 flow 一致：
- POST validate → 200 + `continue_url`
- GET `continue_url` → 302 → ... → 302 → `localhost:1455/auth/callback?code=<X>&state=<Y>`
- 浏览器 fetch localhost:1455 失败（本机没监听）→ Playwright `page.url()` 拿到 `localhost:1455?code=...` URL，提取 `code` 参数

协议侧 `_pkce_common.follow_continue_for_auth_code` 已实现等价逻辑（curl_cffi `session.get(continue_url, allow_redirects=True)` → 抓 ConnectionError 文本里 `code=` 参数），无需改动。

---

## 4. token exchange ✅ confirmed（无变化）

`POST https://auth.openai.com/oauth/token` 协议未变，沿用 `protocol_register.py:_do_pkce_flow` 既有 `oauth/token` 调用（已在 `_pkce_common.exchange_code` 复用）。

---

## 5. 全流程时序图

```
Client (curl_cffi Session, cookies from PKCE)
   │
   │ POST /api/accounts/add-phone/send
   │     Headers: Accept/Content-Type JSON + Referer add-phone + UA (无需 sentinel)
   │     Body: {"phone_number": "+E.164"}
   ▼
OpenAI
   │
   ├─ 400 + body.error.code=voip_phone_disallowed (或其它 reject code) ─► protocol_phone_verify.py: status='phone-rejected' (release + retry)
   │
   └─ 200 + body.continue_url + body.page.type='sms_*' (待确认) ─► 进入 SMS 接码状态
       │
       │ poll_sms (local: GET smsApiUrl regex / zhusms: POST /api/order/status)
       │   30 次 × 3s 轮询
       ▼
       │ POST /api/accounts/add-phone/validate (推测 endpoint，待确认)
       │     Body: {"code": "123456"} (推测 payload)
       ▼
   OpenAI
       │
       ├─ 4xx + invalid_code ──► protocol_phone_verify.py: status='validate-error' (release)
       │
       └─ 200 + body.continue_url ─► follow_continue_for_auth_code (既有公共函数)
           │
           │ GET continue_url → 302 → ... → localhost:1455?code=<X> (ConnectionError + regex)
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
| `PHONE_VALIDATE_PATH` | `/api/accounts/phone/validate` | `/api/accounts/add-phone/validate` | ⚠️ 推测，smoke test 验证 |
| Request body field name (phone) | `phone` | `phone_number` | ✅ |
| Request body field name (code) | `code` | `code` (推测同 `email-otp/validate`) | ⚠️ 推测 |
| sentinel flow="phone_start" 调用 | 有 | **删除**（phone-start 不带 sentinel） | ✅ |
| sentinel flow="phone_validate" 调用 | 有 | **删除**（推测 validate 也不带 sentinel） | ⚠️ 推测 |
| `is_phone_rejected` 判定 | 关键词列表匹配 | HTTP 4xx + body.error.type=='invalid_request_error' | ✅ |
| `has_sms_prompt` 判定 | page.type 含 sms/phone_verify/code | 200 + 含 continue_url | ✅（保守） |

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

## 9. 剩余 unknowns + 下一步

**Smoke test (plan Task 26) 必须实测以下推测项**，并把本报告对应 section 标 confirmed：

1. **phone-start success response body schema**（拿一个 OpenAI 接受的真实非 VoIP 号实测）
2. **phone-validate endpoint URL**（推测 `/api/accounts/add-phone/validate`）
3. **phone-validate payload schema**（推测 `{"code": "..."}`）
4. **phone-validate success response**（推测含 `continue_url`）
5. **phone-validate error response**（推测 4xx + invalid_code）

校准方法：smoke test 时**临时 export `PHASE0_CAPTURE=1`**（utils.js 已含 capture hook，restore 时记得把 hook 也去掉 → 临时改 restore 顺序），重启服务跑账号，dump 后人工补完本报告 section 1-2 的 ⚠️。
