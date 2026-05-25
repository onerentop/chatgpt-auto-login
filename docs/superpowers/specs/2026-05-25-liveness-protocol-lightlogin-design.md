# Liveness Protocol-Mode lightLogin 设计（v2.26 Phase B）

**Date:** 2026-05-25
**Status:** Draft → 待评审
**Predecessors:** v2.26.0 (account liveness check Phase A — browser-mode lightLogin)

## Background

v2.26.0 实现了浏览器模式 `lightLogin`（Playwright 操作 auth.openai.com 表单 → 密码 + OTP → `/api/auth/session` 拿 access_token），但**协议模式留作 Phase B 待办**：`server/liveness/light-login.js:24` 仍是

```js
if (protocolMode) throw new LivenessLoginNotImplementedError();
```

`runner.js:99-117` 已经为这条 throw 准备了兜底（保留 probe verdict 若是 token_expired，否则标 `alive_status='login_fail', reason='liveness not yet supported in protocol mode'`）。

**生产观察的痛点**：协议模式下，**没有 `cpa-auth/codex-{email}.json` 缓存文件的账号**（从未跑过流水线、或文件被删）测活时 `!tok` 触发 lightLogin → 命中 stub → 标 `login_fail`，看起来像账号死了实际是机制缺失。其他有缓存的账号正常工作 —— 这条 stub 路径就是唯一的盲点。

本 spec 实现协议模式 lightLogin，关闭这个盲点。

## Goals

1. 实现协议模式纯登录（password + OTP → access_token），返回与 browser 路径同 shape `{accessToken, accountId, expiresAtIso}`。
2. `runner.js` 零改动 —— 现有 9 类 keyword 错误映射不变；新实现的 reason 字符串契约对齐。
3. `light-login.js:protocolMode` 分支不再抛 stub，spawn `chatgpt_register/liveness_login.py` 替代。
4. `LivenessLoginNotImplementedError` 类**保留**为兜底（Python 二进制缺失 / pyotp 缺失等极端场景）。
5. OTP 处理在 Python 内（Outlook IMAP 复用现有；Gmail TOTP 用新 pyotp 依赖）—— 避免 Node 预拉抢到旧 OTP 邮件的 race。
6. 与 `protocol_register.py` 共享底层（sentinel / session / Chrome JA3 / OTP），但**解耦**双流程（liveness 改动不动 register）。

## Non-Goals

- 不重写 `protocol_register.py`（其 register 流程包含 create_account / consent / PKCE 等 liveness 不需要的步骤，强行复用会复杂化）。
- 不实现 codex 客户端 deeplink / refresh_token 链路 —— liveness 只需 web session access_token。
- 不向 runner / checker / codex-file 任何模块加新逻辑。
- 不引入新前端 UI / config 字段。
- 不为 `_parse_state_from_authorize_page` / sentinel 集成写自动化测试 —— 这些靠真实 Auth0 流程实测。

## 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| Python 架构 | 新建 `chatgpt_register/liveness_login.py` | 与 register 流程解耦，单测独立；vs 复用 protocol_register.py 加 login_only flag → 紧耦合，register 改动无声影响 liveness |
| OTP 位置 | Python 内部（共享模块 `chatgpt_register/otp.py`） | Node 预拉 OTP race：邮件在 password 提交后才发 |
| TOTP 实现 | 新增 `pyotp` 依赖 | 6 行实现 vs 自己写 TOTP 算法的维护成本；pyotp 是 stdlib-quality |
| 错误契约 | Python reason 字符串包含 runner.js 9 类 keyword 之一 | runner.js 零改动；新实现可独立演进 |
| 返回 shape | `{accessToken, accountId, expiresAtIso}` 与 browser 一致 | runner.js 现有 codex.write 直接消费，无适配层 |
| OTP 抽函数粒度 | 只抽 `_fetch_imap_otp` + `_get_imap_baseline`（不抽 session/sentinel） | OTP 是清晰边界；session/sentinel 抽出会触发 protocol_register.py ~994 行的大重构（超 scope） |
| pyotp 缺失行为 | Outlook 不受影响；Gmail 抛 `otp fail: no method` | 友好降级，不要求所有用户装 pyotp |

## Architecture

```
chatgpt_register/otp.py                    ← 新建（~80 行）：fetch_imap_otp + get_imap_baseline
                                              抽自 protocol_register.py，函数体逐字保留；新加 gen_totp(secret)
chatgpt_register/liveness_login.py         ← 新建（~260 行）：纯登录流程
                                              username/password/OTP/session → access_token
                                              复用 chatgpt_register.sentinel.get_sentinel_token
server/liveness/light-login.js             ← 加 protocolMode 分支：调 protocolLightLogin spawn 替代
                                              throw LivenessLoginNotImplementedError；保留 browser 路径
server/liveness/__tests__/light-login.test.js  ← 新建：5 P 单测（spawn mock）
tests/test_liveness_login.py               ← 新建：3 Y unittest（curl_cffi mock）
server/liveness/runner.js                  ← 1 行改动：lightLogin(...) 调用加 proxyUrl 参数
protocol_register.py                       ← 微改：import otp.py 替代内联函数（不改函数体）
CLAUDE.md + start.bat                      ← pyotp 依赖说明
docs/CHANGELOG.md                          ← v2.29.0 节
```

**不动**：runner.js (错误映射) / checker.js / codex-file.js / sentinel.py / engines / 前端。

### 数据流

```
runner.dispatchOnceInner (需 relogin: !tok 或 probe=token_expired)
  → lightLogin(account, { protocolMode: true, proxyUrl, signal })
  → light-login.js 检测 protocolMode
  → protocolLightLogin(account, { signal, proxyUrl })
  → spawn('py', ['-3', 'chatgpt_register/liveness_login.py'])
  → stdin: JSON { email, password, login_type, client_id, refresh_token, totp_secret, proxy }
  → Python: session = curl_cffi.Session(impersonate=rotated)
            → GET /authorize → parse state
            → POST /u/login/identifier (sentinel)
            → POST /u/login/password (sentinel) → 检测 bad password
            → if need_otp: fetch OTP (IMAP/TOTP) → POST /u/email-otp/challenge
            → check final URL = chatgpt.com (else captcha / otp fail)
            → GET /api/auth/session → accessToken
  → stdout JSON-lines: {"log":"..."} ... {"status":"ok","accessToken":"...","accountId":"...","expiresAtIso":"..."}
  → Node 解析最后一行 → 抛对应 Error 字符串 OR resolve
  → runner.js 现有 catch (line 99-117) 按 keyword 映射 alive_status
  → codex.write({ accessToken, accountId, expiresAtIso })
  → 再 probe 验证 access_token 真活
```

### Python 端 stdin schema

```jsonc
{
  "email":         "user@outlook.com",
  "password":      "...",
  "login_type":    "outlook" | "google",
  "client_id":     "...",
  "refresh_token": "...",
  "totp_secret":   "JBSW...",
  "proxy":         "http://127.0.0.1:7890"
}
```

### Python 端 stdout（JSON-lines）

```jsonc
{"log":"  [LivenessLogin] Step 0: Homepage..."}
{"log":"  [LivenessLogin] Step 5: submit OTP (code=12***)"}

// 终态：
{"status":"ok","accessToken":"eyJ...","accountId":"a-xxx","expiresAtIso":"2026-08-22T12:34:56+08:00"}
// 或：
{"status":"error","reason":"bad password"}
{"status":"error","reason":"otp timeout"}
{"status":"error","reason":"captcha"}
{"status":"error","reason":"proxy reset (login)"}
{"status":"error","reason":"no session after login"}
{"status":"error","reason":"unexpected: <40 chars>"}
```

### 关键不变式

1. **runner.js 零改动**：现有 line 99-117 已 cover 所有错误分支；本 spec 只让 protocolMode 不再抛 stub。
2. **错误关键字契约**：Python reason 必须包含 runner.js 9 类 keyword 之一（substring match）。
3. **OTP 在 Python 内拉**：`get_imap_baseline` 在 Step 3 password POST 之前调，避免 race。
4. **JSON-lines 协议**：stdin 一次性 JSON 输入，stdout 流式 JSON-lines；任何 `print` 必须到 stderr（chatgpt_register/* 的 side-effect prints 已通过顶部 `_orig_stdout` 重定向）。
5. **codex.write 不在 Python 端做**：保持 runner.js 单一来源。
6. **pyotp lazy import**：Outlook-only 部署不需要；缺失时 `gen_totp = None`，Gmail 路径抛 `otp fail: no method`。
7. **proxyUrl 显式注入**：light-login.js 不 require '../proxy'，避免 module coupling；runner 传入。

## Python 端实现

### `chatgpt_register/otp.py`

```python
"""OTP helpers — IMAP for Outlook, TOTP for Gmail.

Extracted from protocol_register.py for reuse across the register flow
and the new liveness_login flow. Function bodies are byte-for-byte
copies of the originals; only the home module changed.
"""
import json, time, imaplib
import email as email_lib
from curl_cffi import requests as cr


def fetch_imap_otp(email_addr, client_id, refresh_token, baseline_uid, timeout=90):
    """Wait up to `timeout` seconds for a new OTP email (UID > baseline_uid).
    Returns 6-digit code as string, or raises Exception on timeout / parse fail.

    Body preserved from protocol_register.py:_fetch_imap_otp.
    """
    # ... [original body verbatim from protocol_register.py lines ~142-198] ...


def get_imap_baseline(email_addr, client_id, refresh_token):
    """Capture current max UID in INBOX before triggering OTP send.

    Body preserved from protocol_register.py:_get_imap_baseline.
    """
    # ... [original body verbatim from protocol_register.py lines ~199-220] ...


def gen_totp(secret):
    """Generate current 6-digit TOTP from Gmail TOTP base32 secret.
    Lazy imports pyotp (new dependency). Returns string '123456'.
    """
    import pyotp
    return pyotp.TOTP(secret).now()
```

`protocol_register.py` 改动：

```python
# Replace lines ~142-220 (the function bodies) with:
from chatgpt_register.otp import (
    fetch_imap_otp as _fetch_imap_otp,
    get_imap_baseline as _get_imap_baseline,
)
```

保留下划线前缀别名，避免修改 `protocol_register.py` 内所有调用点。

### `chatgpt_register/liveness_login.py`

完整脚本骨架。关键流程参照 `light-login.js` 步骤 1-9 + `protocol_register.py` 的 sentinel/session 模式。

```python
#!/usr/bin/env python3
"""Liveness re-login (protocol mode).

Pure password + OTP login — no register, no PKCE, no codex deeplink.
Only purpose: refresh access_token for /backend-api/accounts/check.

Input: JSON on stdin {email, password, login_type, client_id?,
                      refresh_token?, totp_secret?, proxy?}
Output: JSON-lines on stdout — streaming {"log":"..."} and final terminal:
   {"status":"ok",    "accessToken":"...", "accountId":"...", "expiresAtIso":"..."}
   {"status":"error", "reason":"<keyword matched by runner.js:99-117>"}

Reason strings MUST contain one of (matched case-insensitively by runner.js):
   bad password / no password / outlook oauth missing / otp timeout /
   otp fail / captcha / no session / proxy reset / unexpected:<...>
"""
import sys, json, time, uuid, random
from datetime import datetime, timedelta, timezone

# Redirect side-effect prints from chatgpt_register/* imports to stderr —
# JSON-lines stdout protocol cannot tolerate any stray text.
_orig_stdout = sys.stdout
sys.stdout = sys.stderr
try:
    from chatgpt_register.sentinel import get_sentinel_token
    from chatgpt_register.otp import fetch_imap_otp, get_imap_baseline, gen_totp
except Exception:
    def get_sentinel_token(*a, **k): return ""
    fetch_imap_otp = get_imap_baseline = gen_totp = None
finally:
    sys.stdout = _orig_stdout

try:
    from curl_cffi import CurlHttpVersion
    HTTP11 = CurlHttpVersion.V1_1
except Exception:
    HTTP11 = None


_CHROME = [
    ("chrome146", 146), ("chrome142", 142), ("chrome136", 136),
    ("chrome133a", 133), ("chrome131", 131), ("chrome124", 124),
]

def _log(msg):
    print(json.dumps({"log": f"  [LivenessLogin] {msg}"}), flush=True)

def _emit(payload):
    print(json.dumps(payload), flush=True)

def _err(reason):
    _emit({"status": "error", "reason": str(reason)[:120]})

def _to_cst_iso(dt_str_or_obj):
    if not dt_str_or_obj:
        return ""
    if isinstance(dt_str_or_obj, str):
        try:
            d = datetime.fromisoformat(dt_str_or_obj.replace("Z", "+00:00"))
        except Exception:
            return ""
    else:
        d = dt_str_or_obj
    cst = d.astimezone(timezone(timedelta(hours=8)))
    return cst.isoformat()

def _build_session(proxy_url):
    """Mirror protocol_register.py session setup — Chrome JA3 + rotating impersonate."""
    from curl_cffi import requests as curl_requests
    if proxy_url and proxy_url.startswith('http://'):
        proxy_url = 'socks5h://' + proxy_url[len('http://'):]
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    session = None
    impersonate_name = None
    for _ in range(5):
        impersonate_name, _major = random.choice(_CHROME)
        try:
            session = curl_requests.Session(impersonate=impersonate_name)
            if proxies:
                session.proxies = proxies
            break
        except Exception:
            session = None
    if not session:
        session = curl_requests.Session()
        if proxies:
            session.proxies = proxies
    _log(f"Profile: {impersonate_name}, proxy: {'on' if proxy_url else 'direct'}")
    return session, impersonate_name


def _parse_state_from_authorize_page(response):
    """Extract state CSRF from Auth0 authorize redirect URL or HTML form."""
    import re
    from urllib.parse import urlparse, parse_qs

    url = str(response.url)
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if 'state' in qs:
        return qs['state'][0], None
    body = response.text or ""
    m = re.search(r'name="state"\s+value="([^"]+)"', body)
    if m:
        return m.group(1), None
    return None, None


def login(email, password, login_type, client_id, refresh_token, totp_secret, proxy_url):
    """Returns {accessToken, accountId, expiresAtIso} or raises Exception
    whose str() contains a runner.js-matchable keyword."""
    AUTH = "https://auth.openai.com"
    BASE = "https://chatgpt.com"
    CODEX_CLIENT_ID = "pdlLIX2Y72MIl2rhLhTE9VV9bN9MD869"

    if not password:
        raise Exception("no password")
    if login_type == "outlook" and (not client_id or not refresh_token):
        raise Exception("outlook oauth missing")

    session, impersonate_name = _build_session(proxy_url)
    device_id = str(uuid.uuid4())
    session.cookies.set("oai-did", device_id, domain="chatgpt.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

    # IMAP baseline BEFORE submitting password (avoid race with old OTP email)
    imap_baseline = 0
    if login_type == "outlook" and fetch_imap_otp:
        try:
            imap_baseline = get_imap_baseline(email, client_id, refresh_token)
            _log(f"IMAP baseline: {imap_baseline}")
        except Exception as e:
            _log(f"IMAP baseline failed (will use 0): {str(e)[:50]}")

    # Step 1: GET authorize page → parse state
    auth_url = (
        f"{AUTH}/authorize?client_id={CODEX_CLIENT_ID}"
        "&scope=openid%20email%20profile%20offline_access%20model.request"
        "%20model.read%20organization.read%20organization.write"
        "&response_type=code"
        "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web"
    )
    _log("Step 1: GET authorize page")
    try:
        r = session.get(auth_url, headers={"Accept": "text/html"},
                       allow_redirects=True, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: navigation {msg[:40]}")

    state, _csrf = _parse_state_from_authorize_page(r)
    if not state:
        raise Exception("unexpected: no state in authorize page")

    # Step 2: submit username
    _log("Step 2: submit username")
    sentinel = get_sentinel_token(session, device_id, flow="login_identifier",
                                  user_agent=session.headers.get("User-Agent", ""))
    try:
        r = session.post(f"{AUTH}/u/login/identifier?state={state}",
                        data={"state": state, "username": email,
                              "js-available": "true", "webauthn-available": "true",
                              "is-brave": "false", "webauthn-platform-available": "false",
                              "action": "default"},
                        headers={"openai-sentinel-token": sentinel,
                                 "Content-Type": "application/x-www-form-urlencoded"},
                        allow_redirects=True, timeout=30)
    except Exception as e:
        if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: identifier {str(e)[:40]}")

    # Step 3: submit password
    _log("Step 3: submit password")
    sentinel = get_sentinel_token(session, device_id, flow="login_password",
                                  user_agent=session.headers.get("User-Agent", ""))
    try:
        r = session.post(f"{AUTH}/u/login/password?state={state}",
                        data={"state": state, "username": email, "password": password,
                              "action": "default"},
                        headers={"openai-sentinel-token": sentinel,
                                 "Content-Type": "application/x-www-form-urlencoded"},
                        allow_redirects=True, timeout=30)
    except Exception as e:
        if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: password {str(e)[:40]}")

    if 'error=invalid' in str(r.url) or 'invalid_user_password' in (r.text or ''):
        raise Exception("bad password")

    # Step 4: detect OTP requirement
    final_url = str(r.url)
    need_otp = ('/u/email-otp' in final_url or '/u/mfa-otp' in final_url
                or '/email-otp/challenge' in final_url)

    if need_otp:
        _log("Step 4: OTP required")
        try:
            if login_type == "outlook" and fetch_imap_otp:
                code = fetch_imap_otp(email, client_id, refresh_token, imap_baseline, timeout=90)
            elif login_type == "google" and totp_secret and gen_totp:
                code = gen_totp(totp_secret)
            else:
                raise Exception("otp fail: no method")
        except TimeoutError:
            raise Exception("otp timeout")
        except Exception as e:
            msg = str(e).lower()
            if 'timeout' in msg: raise Exception("otp timeout")
            raise Exception(f"otp fail: {str(e)[:40]}")

        # Step 5: submit OTP
        _log(f"Step 5: submit OTP (code={code[:2]}***)")
        sentinel = get_sentinel_token(session, device_id, flow="email_otp_validate",
                                      user_agent=session.headers.get("User-Agent", ""))
        try:
            r = session.post(f"{AUTH}/u/email-otp/challenge?state={state}",
                            data={"state": state, "code": code, "action": "default"},
                            headers={"openai-sentinel-token": sentinel,
                                     "Content-Type": "application/x-www-form-urlencoded"},
                            allow_redirects=True, timeout=30)
        except Exception as e:
            if 'reset' in str(e).lower(): raise Exception("proxy reset (login)")
            raise Exception(f"unexpected: otp submit {str(e)[:40]}")
        final_url = str(r.url)

        # OTP rejected by server (URL still on /u/email-otp/*)
        if '/u/email-otp' in final_url:
            raise Exception("otp fail: rejected by server")

    # Step 6: ensure landed on chatgpt.com callback
    if 'chatgpt.com' not in final_url:
        if '/u/login' in final_url or '/authorize' in final_url:
            raise Exception("captcha")
        raise Exception(f"unexpected: stuck at {final_url[:40]}")

    # Step 7: fetch /api/auth/session for accessToken
    _log("Step 7: fetch /api/auth/session")
    try:
        r = session.get(f"{BASE}/api/auth/session",
                       headers={"Accept": "application/json"}, timeout=15)
        session_data = r.json() if r.status_code == 200 else {}
    except Exception:
        session_data = {}

    access_token = session_data.get("accessToken") or ""
    if not access_token:
        raise Exception("no session after login")

    return {
        "accessToken": access_token,
        "accountId": (session_data.get("user") or {}).get("id", ""),
        "expiresAtIso": _to_cst_iso(session_data.get("expires", "")),
    }


def main():
    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        _err(f"unexpected: bad stdin {str(e)[:40]}")
        return

    email = input_data.get("email", "")
    password = input_data.get("password", "")
    login_type = input_data.get("login_type", "")
    client_id = input_data.get("client_id", "")
    refresh_token = input_data.get("refresh_token", "")
    totp_secret = input_data.get("totp_secret", "")
    proxy_url = input_data.get("proxy", "")

    try:
        result = login(email, password, login_type, client_id, refresh_token,
                      totp_secret, proxy_url)
        _emit({"status": "ok", **result})
    except Exception as e:
        _err(str(e))


if __name__ == "__main__":
    main()
```

## Node 端实现

### `server/liveness/light-login.js` 改动

**(a) 顶部加 spawn 依赖**：

```js
const { spawn } = require('child_process');
const path = require('path');

const PROTOCOL_SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'liveness_login.py');
const PROTOCOL_TIMEOUT_MS = 120_000;
```

文件头注释更新为反映双模式：

```js
// 双模式实现：
//   - 浏览器模式 (default)：Playwright 操作 auth.openai.com 表单
//   - 协议模式 (config.protocolMode=true, v2.29 Phase B)：spawn
//     chatgpt_register/liveness_login.py 用 curl_cffi 走 Auth0 HTTP API
```

**(b) `lightLogin` 入口 protocolMode 分支**：

```js
async function lightLogin(account, opts = {}) {
  const { protocolMode, playwrightConnect, getOtp, signal, proxyUrl } = opts;

  if (protocolMode) {
    return await protocolLightLogin(account, { signal, proxyUrl });
  }

  // ...existing browser path unchanged...
}
```

**(c) 新增 `protocolLightLogin` 函数**（完整体见第 3 节 spec body）：

关键行为：
- Pre-flight 校验（no password / outlook oauth missing）— 与 browser 路径同关键字
- spawn 子进程，stdin JSON 输入
- 120s timeout + signal abort 双兜底
- spawn `error` 事件 → reject `LivenessLoginNotImplementedError`（runner 兜底兼容）
- 正常退出后解析 stdout JSON terminal:
  - `status: ok` → resolve `{accessToken, accountId, expiresAtIso}`
  - `status: error` → reject `new Error(reason)`（reason 含 runner.js keyword）
  - 无终态 → reject `unexpected: no terminal (exit N) <stderr tail>`

**(d) `runner.js` 一行改动**：

```js
// Before:
const fresh = await lightLogin(account, {
  protocolMode: config.protocolMode,
  signal: abortSignal,
});

// After:
const fresh = await lightLogin(account, {
  protocolMode: config.protocolMode,
  proxyUrl: proxyMgr.getProxyUrl(),
  signal: abortSignal,
});
```

`proxyMgr` 已经在 runner 工厂中注入；无需新 require。

## 错误映射矩阵（Python reason → runner alive_status）

| Python `reason` | runner.js 关键字（/regex/i） | → `alive_status` | UI label |
|---|---|---|---|
| `"bad password"` | `/bad password/` | `login_fail` | 登录失败 |
| `"no password"` | `/no password/` | `login_fail` | 登录失败 |
| `"outlook oauth missing"` | `/outlook oauth missing/` | `login_fail` | 登录失败 |
| `"otp timeout"` 含 `timeout` | `/otp/` 含 timeout | `login_fail` | 登录失败 |
| `"otp fail: ..."` | `/otp/` 不含 timeout | `login_fail` | 登录失败 |
| `"captcha"` | `/captcha/` | `login_fail` | 登录失败 |
| `"no session after login"` | `/no session/` | `login_fail` | 登录失败 |
| `"proxy reset (login)"` | `/proxy reset\|ECONNRESET/` | `proxy_error` | 代理异常 |
| `"unexpected: <40 chars>"` | else fallback | `network_error` | 网络异常 |

### 特殊路径

| 触发场景 | Node 端 | runner 分支 | 最终 alive_status |
|---|---|---|---|
| Python 二进制找不到 / spawn ENOENT | reject `LivenessLoginNotImplementedError` | line 99 兜底 | 若 probeRes=token_expired 保留；否则 `login_fail` + `'liveness not yet supported in protocol mode'` |
| pyotp 缺失（仅 Gmail 触发） | Python 抛 `otp fail: no method` | `/otp/` 匹配 | `login_fail` + `'otp fail'` |
| 120s 超时 | reject `unexpected: liveness_login timeout (120s)` | fallback | `network_error`（runner 自动重试 3 次） |
| runner abort | reject `unexpected: aborted` | runner abortSignal 早返回 | 不写状态 |
| stdout 无 terminal / Python 崩 | reject `unexpected: no terminal (exit N) <stderr>` | fallback | `network_error` |
| OTP rejected by server | Python 抛 `otp fail: rejected by server` | `/otp/` 匹配 | `login_fail` + `'otp fail'` |

### 边界

1. **captcha vs bad password**：bad password 通过 URL `error=invalid` / body `invalid_user_password` 精确检测；captcha 是汇总桶（含手机验证 / 风控弹窗 / Auth0 异常）。与 browser 路径行为等价。
2. **OTP rejected**：协议模式可从 URL pattern 精确区分 OTP rejected vs 通用 captcha —— 比 browser 路径更精确。
3. **sentinel 失败**：`get_sentinel_token` 返空字符串允许；OpenAI 可能返 400/403 → `unexpected: ...` fallback → network_error 重试。与 register 流程同策略。
4. **runner.js:104-106 兜底 dead code**：protocolLightLogin 正常路径不抛 `LivenessLoginNotImplementedError`，line 104-106 对绝大多数调用是 dead code 但保留为 spawn 失败兜底。
5. **cooldown / retry**：runner 现有 `NETWORK_RETRY_MAX=3` 循环对 network_error 自动重试；login_fail 终态不重试（账号/凭证问题，重试无意义）。
6. **proxy_error → 节点投票**：v2.31.x 的 vote 块会调 `proxyMgr.recordBadAttempt(currentNode, 'main', 'liveness_proxy_error')` → 3 次失败拉黑节点。协议 vs 浏览器等价。
7. **`login_type` 缺失**：Python 端校验降级 `else: raise Exception("otp fail: no method")`。容错。

## 测试策略

### JS 单测（5 cases）— `server/liveness/__tests__/light-login.test.js`

| # | 用例 |
|---|---|
| P1 | protocolMode=true + 缺 password → 抛 `'no password'`，不 spawn |
| P2 | outlook 账号缺 client_id → 抛 `'outlook oauth missing'`，不 spawn |
| P3 | spawn 返 `{"status":"ok","accessToken":"abc",...}` → resolve 完整字段 |
| P4 | spawn 返 `{"status":"error","reason":"bad password"}` → reject Error.message === `'bad password'` |
| P5 | spawn `error` 事件（ENOENT）→ reject `LivenessLoginNotImplementedError` |

mock 模式参考 `server/liveness/__tests__/checker.test.js`。

### Python 单测（3 cases）— `tests/test_liveness_login.py`

| # | 用例 |
|---|---|
| Y1 | `login()` 调用时 password='' → 抛 `Exception('no password')` |
| Y2 | mock session.post 返 200 + URL 含 `error=invalid` → 抛 `Exception('bad password')` |
| Y3 | mock happy path → 返三字段齐全 |

复用 `tests/test_protocol_register_h1_fallback.py` 的 stub 模式。

### 不写测试

- `protocolLightLogin` timeout / abort race（fake timer 成本高）
- runner.js 端到端集成（不触及 runner 代码；keyword 类已被 P3-P5 代表性覆盖）
- `_parse_state_from_authorize_page`（Auth0 真实响应无法准确 mock）

### 人工验证清单（12 项）

- [ ] `pip install pyotp` 后服务能起；缺 pyotp 时 Outlook 账号正常
- [ ] 基础 Outlook：无 codex 文件的账号测活 → 真实 alive_status
- [ ] 基础 Gmail：TOTP 账号无 codex 文件 → 测活成功
- [ ] bad password → alive_reason `'bad password'`
- [ ] outlook oauth missing：清掉 client_id → alive_reason `'outlook oauth missing'`
- [ ] OTP timeout：断 IMAP → 90s 后 alive_reason `'otp timeout'`
- [ ] proxy reset：关 sing-box → alive_reason `'proxy reset (login)'`
- [ ] 120s 超时：iptables drop auth.openai.com → 130s 后 `network_error` + runner 重试
- [ ] runner abort：测活中点停止 → 子进程被 kill
- [ ] pyotp 缺失：临时 uninstall → Outlook 正常，Gmail `otp fail: no method`
- [ ] Python 二进制缺失：改 PROTOCOL_SCRIPT 路径 → reject `LivenessLoginNotImplementedError`
- [ ] codex 文件写入：成功后看 `cpa-auth/codex-{email}.json` 含 access_token 三字段

## 风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| R1 | Auth0 表单字段变更（OpenAI 服务端升级） | 与 protocol_register.py 同样的 brittleness；共享 sentinel + Chrome JA3 模式，共担风险 |
| R2 | `_parse_state_from_authorize_page` 解析失败 | 抛 `unexpected:...` → network_error → runner 重试 3 次 |
| R3 | pyotp 新依赖，Outlook-only 不需要但 import 失败影响 module | 顶部 lazy import + try/except → `gen_totp = None`；仅 Gmail 路径 hit |
| R4 | curl_cffi `impersonate=chromeXXX` 兼容性差异 | 5 次 fallback retry 降级到无 impersonate |
| R5 | 协议模式登录绕过 sentinel 被 OpenAI 风控 | sentinel 3-tier fallback 已在 register 实测命中率 >95%；liveness 不批量触发 |
| R6 | OTP race（baseline 抓晚错过新邮件） | `get_imap_baseline` 在 Step 3 之前调；timeout 90s |
| R7 | liveness_login.py 与 protocol_register.py 行为漂移 | OTP / sentinel 共享模块；Auth0 endpoint spec 注明 "mirrors light-login.js"，PR 评审对照 |
| R8 | `state` URL-encoded 字符二次编码 | `parse_qs` 正确解码；curl_cffi form data 自动 urlencode，不重复 |

## 实施顺序建议（供 writing-plans 参考）

**6 任务 commit**（按依赖顺序）：

| Task | 文件 | 内容 |
|---|---|---|
| 1 | `chatgpt_register/otp.py` + `protocol_register.py` | 抽出 `_fetch_imap_otp` / `_get_imap_baseline`；protocol_register import 别名；run protocol_register Python 测试无回归 |
| 2 | `chatgpt_register/liveness_login.py` + `tests/test_liveness_login.py` | 新建脚本 + 3 个 Y unittest |
| 3 | `server/liveness/light-login.js` + `server/liveness/__tests__/light-login.test.js` | 加 protocolLightLogin spawn 胶水 + 5 个 P 单测 |
| 4 | `server/liveness/runner.js` | 1 行：`lightLogin(...)` 调用加 `proxyUrl` 参数 |
| 5 | `CLAUDE.md` + `start.bat` | `pip install curl_cffi pyotp` 命令更新；start.bat 加 pyotp smoke 提示（不阻塞） |
| 6 | `docs/CHANGELOG.md` | 追加 v2.29.0 节 |

## 估算

| 文件 | 行数（净增） |
|---|---|
| `chatgpt_register/otp.py` | +80 |
| `chatgpt_register/liveness_login.py` | +260 |
| `protocol_register.py` | -79（删抽出函数 + 加 import 别名） |
| `server/liveness/light-login.js` | +110 |
| `server/liveness/__tests__/light-login.test.js` | +120 |
| `tests/test_liveness_login.py` | +90 |
| `server/liveness/runner.js` | +1 |
| `CLAUDE.md` | +3 |
| `start.bat` | +5 |
| `docs/CHANGELOG.md` | +30 |
| **合计** | **~620 行净增** |

实施总耗时预估：**1-1.5 个工作日**（含 PR 审 + 12 项人工验证）。
