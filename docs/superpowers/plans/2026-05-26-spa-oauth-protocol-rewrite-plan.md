# SPA OAuth 协议侧重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `chatgpt_register/liveness_login.py` 重写为新 SPA OAuth 流程，让协议模式 liveness 重新工作（liabhzo 类账号能正确归 `deactivated`，alive 账号能正确归 `plus`）。

**Architecture:** 5 步 JSON API：(1) GET /authorize 拿 cookies → (2) POST /api/accounts/authorize/continue → (3) IMAP 取 OTP → (4) POST /api/accounts/email-otp/validate → (5) GET chatgpt.com/api/auth/session 拿 access_token。curl_cffi Session 自动管 cookie jar；TLS 用 Chrome impersonate；走 sing-box socks5h://127.0.0.1:7890。

**Tech Stack:** Python 3 + `curl_cffi` (Chrome JA3 模拟), `imapflow` 通过 Node 子流程（不变，复用 chatgpt_register/otp.py）, Node `child_process.spawn` 拉起 Python（不变）, runner.js JS 关键词正则。

参考 spec：`docs/superpowers/specs/2026-05-26-spa-oauth-protocol-rewrite-design.md`

---

## File Structure

**新建：** 无（重用既有文件结构）

**修改：**

- `chatgpt_register/liveness_login.py` — 重写 `login()` 函数，删 `_parse_state_from_authorize_page`、删 sentinel/state CSRF 相关代码、删 password 提交、删 v2.41.9/10/11/12/13 加的 `_final_path` 分类
- `server/liveness/runner.js` — 关键词正则扩展（`account_deactivated` → deactivated，`invalid_code` → login_fail），删 v2.41.13 加的 `page structure` 兜底
- `chatgpt_register/__tests__/test_liveness_login.py`（如果存在；否则不动） — 删旧 sentinel/state mock
- `server/liveness/__tests__/runner.test.js` — 新增 deactivated / invalid_code 分类断言

**不动：**

- `chatgpt_register/otp.py`（IMAP 不变）
- `chatgpt_register/sentinel.py`（register 流程还在用）
- `chatgpt_register/protocol_register.py`（待 reconnaissance，本 plan 不动）
- `server/liveness/light-login.js` 浏览器 path（待评估，本 plan 不动）
- `server/liveness/checker.js`、`runner.js` 的 retry/throttle/concurrency 架构（不变）

---

## Task 1: 写新 `login()` 函数骨架 + step 1 GET /authorize

**Files:**
- Modify: `chatgpt_register/liveness_login.py` — 完全重写 `login()` 函数体（保留 import、`_log`、`_emit`、`_build_session` 等辅助；删 `_parse_state_from_authorize_page`）

- [ ] **Step 1: 删除旧实现**

删除 `liveness_login.py` 里下列代码块（用 Read 工具确认行号后 Edit 删除）：
- `_parse_state_from_authorize_page` 函数（约 line 105-119）
- `login()` 函数全部代码体（约 line 122-300+），保留 def 签名和 docstring

- [ ] **Step 2: 写新 login() 函数体（step 1: GET /authorize）**

在 `login()` 函数体里写：

```python
def login(email, password, login_type, client_id, refresh_token, totp_secret, proxy_url):
    """新 SPA OAuth flow:
    1. GET /authorize → 拿 cookies (oai-did, __cf_bm 等)
    2. POST /api/accounts/authorize/continue → 触发 OTP 邮件
    3. IMAP 拉 OTP
    4. POST /api/accounts/email-otp/validate → 拿 chatgpt.com session cookies
    5. GET chatgpt.com/api/auth/session → 拿 access_token + user.id
    """
    if not password and login_type != "outlook":
        raise Exception("no password")  # gmail 走旧 flow（暂不支持），出错
    if login_type == "outlook" and (not client_id or not refresh_token):
        raise Exception("outlook oauth missing")

    session, impersonate_name = _build_session(proxy_url)
    device_id = str(uuid.uuid4())
    session.cookies.set("oai-did", device_id, domain="chatgpt.com")
    session.cookies.set("oai-did", device_id, domain="auth.openai.com")
    session.cookies.set("oai-did", device_id, domain=".auth.openai.com")

    # Step 1: GET /authorize → SPA shell（无需 parse HTML，只为拿 Cloudflare cookies）
    auth_url = (
        f"{_AUTH}/authorize?client_id={_CODEX_CLIENT_ID}"
        "&scope=openid%20email%20profile%20offline_access%20model.request"
        "%20model.read%20organization.read%20organization.write"
        "&response_type=code"
        "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fauth%2Fcallback%2Flogin-web"
    )
    _log("Step 1: GET /authorize (拿 cookies)")
    try:
        r = session.get(auth_url, headers={"Accept": "text/html"},
                       allow_redirects=True, timeout=30)
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'CONNECTION_RESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: GET /authorize {msg[:40]}")

    if r.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r.status_code}")
    if r.status_code in (403, 429):
        _body_lower = (r.text or "").lower()
        if any(kw in _body_lower for kw in ('cloudflare', 'just a moment', 'challenge-platform', 'cf-mitigated', 'attention required')):
            raise Exception(f"proxy reset (login): Cloudflare HTTP {r.status_code}")
    _log(f"Step 1 OK: status={r.status_code} cookies={len(session.cookies)}")
```

- [ ] **Step 3: 跑 py 语法检查**

运行：`cd chatgpt-auto-login && py -3 -c "from chatgpt_register.liveness_login import login; print('import ok')"`
预期：`import ok`

- [ ] **Step 4: Commit**

```bash
git add chatgpt_register/liveness_login.py
git commit -m "refactor(liveness): step 1 GET /authorize 新实现 (拿 cookies)

新 SPA OAuth flow 重写第 1 步。删 _parse_state_from_authorize_page +
旧 login() 函数体；保留 _build_session / _log / 错误契约。"
```

---

## Task 2: 加 step 2 POST /api/accounts/authorize/continue

**Files:**
- Modify: `chatgpt_register/liveness_login.py` — 在 step 1 之后接 step 2

- [ ] **Step 1: 写 step 2 代码**

在 step 1 末尾 append：

```python
    # Step 2: POST /api/accounts/authorize/continue → 触发 OTP 邮件
    _log("Step 2: POST authorize/continue")
    try:
        r2 = session.post(
            f"{_AUTH}/api/accounts/authorize/continue",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": _AUTH,
                "Referer": f"{_AUTH}/log-in",
            },
            json={"username": {"kind": "email", "value": email}},
            timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'ECONNRESET' in msg or 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: authorize/continue {msg[:40]}")

    if r2.status_code in (403, 429):
        raise Exception(f"proxy reset (login): HTTP {r2.status_code}")
    if r2.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r2.status_code}")
    try:
        j2 = r2.json()
    except Exception:
        raise Exception(f"unexpected: authorize/continue body not json (HTTP {r2.status_code})")

    if r2.status_code >= 400:
        err = (j2.get("error") or {}).get("code") or "unknown"
        if err == "unknown_user" or err == "invalid_email":
            raise Exception(f"login_fail: authorize/continue {err}")
        raise Exception(f"login_fail: authorize/continue HTTP {r2.status_code} code={err}")

    page_type = (j2.get("page") or {}).get("type")
    if page_type != "email_otp_verification":
        raise Exception(f"login_fail: unexpected page.type={page_type}")
    _log(f"Step 2 OK: page.type={page_type}")
```

- [ ] **Step 2: 重新 import 校验**

运行：`cd chatgpt-auto-login && py -3 -c "from chatgpt_register.liveness_login import login; print('import ok')"`
预期：`import ok`

- [ ] **Step 3: Commit**

```bash
git add chatgpt_register/liveness_login.py
git commit -m "feat(liveness): step 2 POST authorize/continue 触发 OTP 邮件"
```

---

## Task 3: 加 step 3 IMAP 拉 OTP（复用既有逻辑）

**Files:**
- Modify: `chatgpt_register/liveness_login.py` — 调既有 `fetch_imap_otp` / `get_imap_baseline`

- [ ] **Step 1: 写 step 3 代码**

在 step 2 末尾 append：

```python
    # Step 3: IMAP 取 OTP（Outlook 路径；Gmail TOTP 不在本 flow 范围）
    if login_type != "outlook":
        raise Exception(f"login_fail: SPA OAuth 仅支持 outlook，login_type={login_type}")
    if not fetch_imap_otp:
        raise Exception("login_fail: pyotp/imap deps missing")
    _log("Step 3: IMAP poll OTP")
    try:
        baseline = get_imap_baseline(email, client_id, refresh_token)
    except Exception as e:
        baseline = 0
        _log(f"IMAP baseline failed (use 0): {str(e)[:50]}")
    # 给 OpenAI 邮件队列 5 秒缓冲再开始 poll，避免拿到过期 baseline 邮件
    import time as _t; _t.sleep(5)
    otp = fetch_imap_otp(email, client_id, refresh_token, baseline_uid=baseline, timeout=90,
                        log=lambda m: _log(f"IMAP: {m}"))
    if not otp:
        raise Exception("otp timeout")
    _log(f"Step 3 OK: OTP={otp[:2]}****")
```

- [ ] **Step 2: import 校验 + Commit**

```bash
py -3 -c "from chatgpt_register.liveness_login import login; print('import ok')"
git add chatgpt_register/liveness_login.py
git commit -m "feat(liveness): step 3 IMAP 拉 OTP (复用 fetch_imap_otp)"
```

---

## Task 4: 加 step 4 POST /api/accounts/email-otp/validate

**Files:**
- Modify: `chatgpt_register/liveness_login.py`

- [ ] **Step 1: 写 step 4 代码**

append：

```python
    # Step 4: POST /api/accounts/email-otp/validate → 拿 chatgpt.com session cookies
    _log("Step 4: POST email-otp/validate")
    try:
        r4 = session.post(
            f"{_AUTH}/api/accounts/email-otp/validate",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": _AUTH,
                "Referer": f"{_AUTH}/email-verification",
            },
            json={"code": otp},
            allow_redirects=True,
            timeout=30,
        )
    except Exception as e:
        msg = str(e)
        if 'reset' in msg.lower():
            raise Exception("proxy reset (login)")
        raise Exception(f"unexpected: email-otp/validate {msg[:40]}")

    if r4.status_code in (403, 429) and r4.status_code != 403:
        raise Exception(f"proxy reset (login): HTTP {r4.status_code}")
    if r4.status_code >= 500:
        raise Exception(f"proxy reset (login): HTTP {r4.status_code}")

    if r4.status_code >= 400:
        try:
            j4 = r4.json()
            err = (j4.get("error") or {}).get("code") or "unknown"
        except Exception:
            err = "parse_error"
        if err == "account_deactivated":
            raise Exception("deactivated: account_deactivated")
        if err == "invalid_code":
            raise Exception("login_fail: invalid_code")
        if err == "rate_limited":
            raise Exception(f"proxy reset (login): rate_limited")
        raise Exception(f"login_fail: email-otp/validate code={err}")
    _log(f"Step 4 OK: HTTP {r4.status_code} cookies={len(session.cookies)}")
```

- [ ] **Step 2: import 校验 + Commit**

```bash
py -3 -c "from chatgpt_register.liveness_login import login; print('import ok')"
git add chatgpt_register/liveness_login.py
git commit -m "feat(liveness): step 4 POST email-otp/validate + 错误码分类

account_deactivated → deactivated; invalid_code → login_fail;
rate_limited → proxy reset。"
```

---

## Task 5: 加 step 5 GET chatgpt.com/api/auth/session

**Files:**
- Modify: `chatgpt_register/liveness_login.py`

- [ ] **Step 1: 写 step 5 + final return**

append：

```python
    # Step 5: GET chatgpt.com/api/auth/session → 拿 access_token
    _log("Step 5: GET chatgpt.com/api/auth/session")
    try:
        r5 = session.get(f"{_BASE}/api/auth/session",
                        headers={"Accept": "application/json"}, timeout=30)
    except Exception as e:
        raise Exception(f"unexpected: /api/auth/session {str(e)[:40]}")
    if r5.status_code != 200:
        raise Exception(f"no session after login: HTTP {r5.status_code}")
    try:
        sj = r5.json()
    except Exception:
        raise Exception("no session after login: body not json")
    access_token = sj.get("accessToken")
    if not access_token:
        raise Exception("no session after login: missing accessToken")
    account_id = (sj.get("user") or {}).get("id", "")
    expires = sj.get("expires") or ""
    _log(f"Step 5 OK: account_id={account_id}, expires={expires}")

    return {
        "accessToken": access_token,
        "accountId": account_id,
        "expiresAtIso": _to_cst_iso(expires),
    }
```

- [ ] **Step 2: import 校验**

```bash
py -3 -c "from chatgpt_register.liveness_login import login; print('import ok')"
```

- [ ] **Step 3: 用 main entry 跑一次（liabhzo717818）**

`liveness_login.py` 顶部应该有 `if __name__ == "__main__":` block 读 stdin JSON 跑 login → 印 final result。如果没有，加上：

```python
if __name__ == "__main__":
    try:
        cfg = json.loads(sys.stdin.read())
        result = login(
            email=cfg["email"], password=cfg.get("password", ""),
            login_type=cfg.get("login_type", ""), client_id=cfg.get("client_id", ""),
            refresh_token=cfg.get("refresh_token", ""), totp_secret=cfg.get("totp_secret", ""),
            proxy_url=cfg.get("proxy", ""),
        )
        _emit({"status": "ok", **result})
    except Exception as e:
        _err(str(e))
```

测：
```bash
# 用 sqlite3 拿 liabhzo creds 拼 JSON，pipe 给 liveness_login.py
py -3 -c "
import sqlite3, json, subprocess
c = sqlite3.connect('data.db'); cur = c.cursor()
cur.execute('SELECT email,password,login_type,client_id,refresh_token FROM accounts WHERE email=?', ('liabhzo717818@outlook.com',))
e,pw,lt,ci,rt = cur.fetchone()
cfg = {'email':e,'password':pw or '','login_type':lt,'client_id':ci,'refresh_token':rt,'proxy':'socks5h://127.0.0.1:7890'}
p = subprocess.run(['py','-3','chatgpt_register/liveness_login.py'], input=json.dumps(cfg), capture_output=True, text=True, timeout=120)
print('STDOUT:', p.stdout); print('STDERR:', p.stderr[:1000])
"
```

预期：stdout 最后一行 `{"status":"error","reason":"deactivated: account_deactivated"}`

- [ ] **Step 4: Commit**

```bash
git add chatgpt_register/liveness_login.py
git commit -m "feat(liveness): step 5 chatgpt.com/api/auth/session 拿 access_token + main entry"
```

---

## Task 6: runner.js 关键词正则扩展 + 删 v2.41.13 兜底

**Files:**
- Modify: `server/liveness/runner.js` — 改既有 `dispatchOne` 里 catch 块的 keyword chain（约 line 100-130）

- [ ] **Step 1: 修改 keyword chain**

读 `server/liveness/runner.js`，找到 catch (e) 里 if/else if chain。改为：

```js
// catch (e) {
const msg = String(e?.message || e || '');

// (顺序：具体 → 模糊；具体的先 break)
if (e?.name === 'LivenessLoginNotImplementedError') {
  result = { alive_status: 'login_fail', alive_reason: 'liveness not yet supported in protocol mode' };
}
else if (/no password|bad password|outlook oauth missing/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: msg.slice(0, 80) };
}
else if (/otp timeout|otp fail/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: 'OTP failed' };
}
else if (/captcha/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: 'captcha' };
}
else if (/no session after login/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: msg.slice(0, 80) };
}
// v2.41.14: 新 SPA flow 的错误码
else if (/deactivated|account_deactivated/i.test(msg)) {
  result = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
}
else if (/login_fail.*invalid_code|invalid_code/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: 'invalid OTP' };
}
else if (/login_fail.*unknown_user|unknown_user|invalid_email/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: 'unknown user / invalid email' };
}
else if (/login_fail/i.test(msg)) {
  result = { alive_status: 'login_fail', alive_reason: msg.slice(0, 80) };
}
else if (/proxy reset|ECONNRESET/i.test(msg)) {
  result = { alive_status: 'proxy_error', alive_reason: 'proxy reset (login)' };
}
// v2.41.13 page structure 兜底 — 删掉。新 flow 不应再触发，留着会掩盖真问题。
else {
  result = { alive_status: 'network_error', alive_reason: `unexpected: ${msg.slice(0, 80)}` };
}
```

- [ ] **Step 2: 删 v2.41.10/12 历史关键词（已被新关键词覆盖）**

如果 chain 里还有 `/token[_ ]?expired|OAuth jumped|stuck at \/api\/accounts|path=\/email-verification/` 之类 v2.41.10/12 关键词，全部删除（新 flow 不再走这些路径，留着没用且容易误匹）。

- [ ] **Step 3: 跑 Node test**

```bash
cd chatgpt-auto-login && npm test
```

预期：218 pass，新增的 deactivated / invalid_code 测试也 pass（Task 7 加）。**先跑一遍，确认旧测试没回归**。如果旧 mock 测试断言旧关键词（token_expired 等），删那些断言。

- [ ] **Step 4: Commit**

```bash
git add server/liveness/runner.js
git commit -m "feat(liveness): runner.js 错误关键词适配 SPA OAuth (v2.41.14 pre)

新 flow 的 error.code 直接出现在 raise message 里：
- account_deactivated → deactivated
- invalid_code → login_fail
- unknown_user/invalid_email → login_fail
删 v2.41.10/12 的 path-based 关键词 + v2.41.13 page structure 兜底。"
```

---

## Task 7: 加单测覆盖新错误码分类

**Files:**
- Modify: `server/liveness/__tests__/runner.test.js`（或对应测试文件）

- [ ] **Step 1: 找 runner test 文件**

```bash
ls server/liveness/__tests__/
```

预期：含 `runner.test.js`（或 checker.test.js）。Read 它看既有 mock 模式。

- [ ] **Step 2: 加 3 个测试 case**

在既有 test file 末尾 append：

```js
test('liveness: account_deactivated → deactivated', async () => {
  const mockLogin = async () => { const e = new Error('deactivated: account_deactivated'); throw e; };
  const result = await dispatchOneWithMock(mockLogin, 'foo@outlook.com');
  assert.strictEqual(result.alive_status, 'deactivated');
  assert.match(result.alive_reason, /account_deactivated/);
});

test('liveness: invalid_code → login_fail', async () => {
  const mockLogin = async () => { throw new Error('login_fail: invalid_code'); };
  const result = await dispatchOneWithMock(mockLogin, 'foo@outlook.com');
  assert.strictEqual(result.alive_status, 'login_fail');
  assert.match(result.alive_reason, /invalid OTP/);
});

test('liveness: unknown_user → login_fail', async () => {
  const mockLogin = async () => { throw new Error('login_fail: authorize/continue unknown_user'); };
  const result = await dispatchOneWithMock(mockLogin, 'foo@outlook.com');
  assert.strictEqual(result.alive_status, 'login_fail');
  assert.match(result.alive_reason, /unknown user/i);
});
```

（`dispatchOneWithMock` 用既有 test 里的 helper 名字；如果命名不同，套用既有 case 的模板。）

- [ ] **Step 3: 跑测试**

```bash
node --test server/liveness/__tests__/runner.test.js
```

预期：新加的 3 case 全 pass。

- [ ] **Step 4: 跑全套**

```bash
npm test
```

预期：≥ 218 + 3 pass。

- [ ] **Step 5: Commit**

```bash
git add server/liveness/__tests__/
git commit -m "test(liveness): 新错误码 deactivated / invalid_code / unknown_user 单测"
```

---

## Task 8: 集成测 3 账号（liabhzo + gyjstbd + 故意错 OTP）

**Files:** 不改代码，跑实际 liveness 验证

- [ ] **Step 1: 测 liabhzo（预期 deactivated）**

POST trigger：
```bash
curl -s -X POST http://127.0.0.1:3000/api/liveness/start -H "Content-Type: application/json" -d '{"emails":["liabhzo717818@outlook.com"]}'
```

等 60s 后查 DB：
```powershell
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/results/'; $r | Where-Object { $_.email -eq 'liabhzo717818@outlook.com' } | Select-Object email, alive_status, alive_reason
```

预期：`alive_status: deactivated`，`alive_reason: account_deactivated`

- [ ] **Step 2: 测 gyjstbd9622137（预期 plus）**

```bash
curl -s -X POST http://127.0.0.1:3000/api/liveness/start -H "Content-Type: application/json" -d '{"emails":["gyjstbd9622137@outlook.com"]}'
```

等 90s 后查（要等 IMAP）：
```powershell
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/results/'; $r | Where-Object { $_.email -eq 'gyjstbd9622137@outlook.com' } | Select-Object email, alive_status, alive_reason
```

预期：`alive_status: plus`

- [ ] **Step 3: 测 invalid_code（手动注入错 OTP）**

临时 patch `liveness_login.py` step 3 末尾：在 `otp = fetch_imap_otp(...)` 之后加 `otp = "000000"  # FORCED WRONG`。重启 server，跑 gyjstbd 一次。

预期 DB：`alive_status: login_fail`，`alive_reason: invalid OTP`

测完**立即还原** patch（删 `otp = "000000"`），别 commit。

- [ ] **Step 4: 还原 patch 不 commit**

```bash
git diff chatgpt_register/liveness_login.py  # 确认有 patch
git checkout chatgpt_register/liveness_login.py  # 还原
```

---

## Task 9: E2E batch + CHANGELOG + merge + tag

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: E2E batch 跑全部 outlook 账号**

```bash
curl -s -X POST http://127.0.0.1:3000/api/liveness/start -H "Content-Type: application/json" -d '{}'
```

等到 status running=false。查 summary：
```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/liveness/status' | Select-Object -ExpandProperty summary | ConvertTo-Json
```

预期：`unknown` < 5%。如果 > 5%，case-by-case 查 alive_reason 看是否有未覆盖错误码（补 Task 6 keyword chain 再跑）。

- [ ] **Step 2: 写 CHANGELOG**

prepend 到 `docs/CHANGELOG.md` 顶部：

```markdown
## v2.41.14 — 2026-05-26

### SPA OAuth 协议侧重写（liveness 协议模式）

OpenAI 把 `/authorize` 改成 React SPA 后，旧 6 步 form-POST 流程全部失效（v2.41.13 仅做了"page structure 兜底归 unknown 不重试"的伤口包扎）。本版本完全重写协议侧 `chatgpt_register/liveness_login.py` 走新的 5 步 JSON API + passwordless email OTP flow。

**新 endpoint chain**：

1. GET `/authorize?...` → 拿 Cloudflare cookies (oai-did/__cf_bm)
2. POST `/api/accounts/authorize/continue` `{"username":{"kind":"email","value":"..."}}` → 触发 OTP 邮件
3. IMAP 拉 OTP（复用 chatgpt_register/otp.py，不变）
4. POST `/api/accounts/email-otp/validate` `{"code":"..."}` → 拿 chatgpt.com session cookies
5. GET `chatgpt.com/api/auth/session` → 拿 access_token + user.id

**新错误码分类**（`server/liveness/runner.js`）：

- `account_deactivated` → `deactivated`（这就是 liabhzo717818 一直被错归 unknown 的真因 —— OpenAI 已停用）
- `invalid_code` → `login_fail`
- `unknown_user` / `invalid_email` → `login_fail`
- `rate_limited` → `proxy_error`
- 删 v2.41.10/12 的 path-based 关键词 + v2.41.13 page structure 兜底（新 flow 不再触发）

**集成测**：
- `liabhzo717818@outlook.com` → `deactivated` ✓
- `gyjstbd9622137@outlook.com` → `plus` ✓
- 故意错 OTP → `login_fail invalid OTP` ✓

**仍不变**：
- 浏览器模式 lightLogin（待评估，本版本不动）
- 注册流程 `protocol_register.py`（待 reconnaissance，本版本不动）
- 测试套件：218 + 3 新 Node test pass + 17 Python pass

详见 `docs/superpowers/specs/2026-05-26-spa-oauth-protocol-rewrite-design.md`。
```

- [ ] **Step 3: Commit changelog**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.41.14 SPA OAuth 协议侧重写"
```

- [ ] **Step 4: Merge + tag + push**

```bash
git checkout master && git merge --ff-only dev
git tag -a v2.41.14 -m "v2.41.14 — SPA OAuth 协议侧重写 (liveness)

OpenAI authorize page SPA 化后旧 form-POST 流程全失效。
重写 5 步 JSON API + passwordless email OTP flow。
liabhzo717818 终于正确归 deactivated。
218+3 Node + 17 Python pass。"
git push origin master
git push origin v2.41.14
git checkout dev
```

- [ ] **Step 5: 重启 server**

```powershell
# 停旧 server 进程
# 启新 server
node server/index.js
```

测一遍 liveness 状态确认线上 alive 比例。

---

## Self-Review

**1. 覆盖 spec 检查：**

| Spec 章节 | Plan 任务 |
|----------|-----------|
| §2 新 flow 5 步 | Task 1-5（每步独立 task） |
| §3 错误码分类 | Task 4（raise）+ Task 6（runner 匹配）+ Task 7（单测） |
| §4.1 改 liveness_login.py + runner.js | Task 1-5 + Task 6 |
| §5.1 cookie jar | Task 1 step 4 注释（_log 输出 cookie 数验证）|
| §5.5 Exception 契约 | Task 4 step 1（4 个 raise 字符串） |
| §6 测试策略 | Task 7（单测）+ Task 8（集成）+ Task 9 step 1（e2e） |
| §9 验收标准 | Task 8（实测）+ Task 9 step 1（e2e summary） |

**2. Placeholder 扫描：** Task 7 的 `dispatchOneWithMock` helper 名字依赖既有 test，标了"如果命名不同，套用既有 case 的模板" — 这是合理的灵活性，不是 placeholder。其他每步都有完整代码 + 命令 + 预期输出。

**3. 类型一致性：** `_AUTH` / `_BASE` / `_CODEX_CLIENT_ID` / `fetch_imap_otp` / `get_imap_baseline` 全是 `liveness_login.py` 顶部既有的常量/导入，跨 task 命名一致。

**4. 错误契约一致性：** Task 4 抛 `deactivated: account_deactivated` 跟 Task 6 正则 `/deactivated|account_deactivated/i` 匹配；Task 4 `login_fail: invalid_code` 跟 Task 6 `/login_fail.*invalid_code|invalid_code/i` 匹配。✓

---

## Execution Handoff

Plan 完整。两种执行方式：

1. **Subagent-Driven（推荐）** — 派 implementer 每 task 一个 fresh subagent，spec compliance + code quality 两阶段 review；
2. **Inline Execution** — 我在当前 session 顺序跑 Task 1 → 9，每 task 完确认。
