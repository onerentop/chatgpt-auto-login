# 协议模式 PKCE add_phone 自动化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 协议模式（ProtocolEngine + Python curl_cffi）补齐 PKCE add_phone 自动化，与浏览器模式 v2.39.4 功能等价（local + zhusms 两个 provider 都支持），实现 retry / rollback / binding 保留语义。

**Architecture:** Node 端 `_finalizePhoneVerify` 拿号 → spawn 新脚本 `protocol_phone_verify.py` 单次 attempt HTTP 流程 → 按 5 个 status 分流（ok / phone-rejected / sms-timeout / validate-error / post-validate-error）→ retry 3 次。Python 公共代码抽到 `_pkce_common.py`。phone-pool 操作全在 Node。

**Tech Stack:** Python curl_cffi（HTTP 与 OpenAI 通信）、Node child_process spawn（IPC stdin/stdout JSON）、sql.js（既有 phone-pool DB）、unittest（Python 测试）、node:test（Node 测试）。

**Spec：** `docs/superpowers/specs/2026-05-26-protocol-add-phone-design.md`

**注意：spec 里把 `protocol-engine.js` 误写成 `server/protocol-engine.js`，实际在 repo 根目录 `./protocol-engine.js`，本 plan 以正确路径为准。**

---

## 文件结构

| 文件 | 操作 | 责任 |
|---|---|---|
| `docs/superpowers/research/2026-05-26-openai-add-phone-http.md` | 创建 | Phase 0 抓包报告（endpoint / payload / sentinel flow / error code）|
| `_pkce_common.py` | 创建 | Python PKCE 公共函数（session 重建 / sentinel / follow continue / token exchange / cookie 序列化）|
| `protocol_register.py` | 修改 | 改 import 用 `_pkce_common`；3 处 needsPhone 检测点附加 sessionState 输出 |
| `protocol_phone_verify.py` | 创建 | 单次 add_phone HTTP 流程脚本（无内部 retry）|
| `tests/test_protocol_phone_verify.py` | 创建 | Python 8 个新单测 |
| `protocol-engine.js` | 修改 | 新 `runProtocolPhoneVerify` + `_acquirePhoneForProtocol` + `_finalizePhoneVerify`；改造 `_finalizePkce` |
| `server/__tests__/protocol-phone-verify.test.js` | 创建 | Node 10 个新单测 |
| `docs/CHANGELOG.md` | 修改 | v2.40.0 条目 |

---

## Task 0: Phase 0 — 抓包确定 OpenAI add_phone HTTP 协议

**这是手动研究任务**，没有自动化测试，但必须先完成 — 后续所有 Phase 都依赖这份报告里的 endpoint / payload / sentinel flow / error code。

**Files:**
- Create: `docs/superpowers/research/2026-05-26-openai-add-phone-http.md`

- [ ] **Step 1: 准备一个未绑过手机的真实账号**

从既有账号列表里找一个没在 `data.db` 的 `phone_bindings` 里出现过的 + OpenAI 那边也确实没绑过的。可以用：

```bash
node -e "
const { initDB, getRawDb } = require('./server/db');
initDB().then(() => {
  const r = getRawDb().exec('SELECT email FROM phone_bindings ORDER BY email');
  console.log('已绑过手机的:', r[0]?.values || []);
});
"
```

挑一个**不在**上面列表里的账号。

- [ ] **Step 2: Chrome DevTools 开 Network 面板，preserve log 打勾**

打开 Chrome → DevTools (F12) → Network → 勾 "Preserve log"。

- [ ] **Step 3: 走完一次完整 add_phone 流程**

手动跑：登录账号 → 触发 PKCE（访问 https://auth.openai.com/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=xxxx&code_challenge_method=S256） → 跳到 add-phone 页 → 填手机 → 收 SMS → 填验证码 → 走完到 consent → callback。

- [ ] **Step 4: 抓 phone-start 请求**

Network 面板找填手机后第一个 POST 请求（通常是 `POST /api/accounts/phone/something`）。记录：
- 完整 URL path
- Request headers（重点：`openai-sentinel-token`、`oai-device-id`、`Origin`、`Referer`、`Content-Type`、`User-Agent`）
- Request body JSON（完整字段名 + 值的格式）
- Response status code
- Response body JSON（完整字段名）

写进报告。

- [ ] **Step 5: 抓 phone-validate 请求**

填完 SMS 验证码后的 POST 请求。记录同 Step 4。

- [ ] **Step 6: 抓「拒号」响应（红字）**

如果 Step 3 没自然遇到拒号，故意填一个明显假号（如 `+15555555555`）触发"无法向此电话号码发送验证码"。记录 response status code + body（要的是 OpenAI 那边怎么表示拒号 — 是 HTTP 4xx 还是 200 + body 含 error 字段）。

- [ ] **Step 7: 抓「验证码错」响应**

故意填错码（`000000`）。记录 response。

- [ ] **Step 8: 抓 follow continue → localhost:1455 跳转**

filled validate 通过后看 OpenAI 怎么 redirect 到 `localhost:1455?code=...`。记录 redirect chain。

- [ ] **Step 9: 写报告**

`docs/superpowers/research/2026-05-26-openai-add-phone-http.md` 必须包含以下章节：

```markdown
# OpenAI add_phone HTTP 协议（抓包报告 2026-05-26）

## 1. phone-start 端点

**URL:** POST https://auth.openai.com/api/accounts/...
**Sentinel flow 名:** ...
**Request headers:** ...
**Request body schema:** {"...": "..."}
**Success response (200):** body schema + 关键字段
**Reject response (红字拒号):** HTTP status / body schema / 关键 error 字段
**判定函数伪代码:**
def is_phone_rejected(resp):
    return ...
def has_sms_prompt(resp):
    return ...

## 2. phone-validate 端点
（同 1）

## 3. follow continue → callback chain
（redirect 序列）

## 4. token exchange
（如果 OpenAI 改了 oauth/token 调用方式则补充，否则确认与既有 `_do_pkce_flow` line 379 一致）

## 5. 全流程时序图
（mermaid）
```

- [ ] **Step 10: Commit 报告**

```bash
git add docs/superpowers/research/2026-05-26-openai-add-phone-http.md
git commit -m "docs(research): OpenAI add_phone HTTP 协议抓包报告 (Phase 0)"
```

---

## Task 1: 创建 `_pkce_common.py` 公共模块骨架

**Files:**
- Create: `_pkce_common.py`

- [ ] **Step 1: 创建 `_pkce_common.py` 基础**

```python
# _pkce_common.py — PKCE / add-phone 公共函数
# 从 protocol_register.py 抽出，共享给 protocol_phone_verify.py
import json
import re
import sys
from urllib.parse import parse_qs, urlparse

AUTH = "https://auth.openai.com"
BASE = "https://chatgpt.com"


def _log(msg):
    print(json.dumps({"log": msg}))
    sys.stdout.flush()
```

- [ ] **Step 2: 验证文件可 import**

```bash
py -3 -c "import _pkce_common; print(_pkce_common.AUTH)"
```

Expected output:
```
https://auth.openai.com
```

- [ ] **Step 3: Commit**

```bash
git add _pkce_common.py
git commit -m "feat(pkce): 新建 _pkce_common.py 公共模块骨架"
```

---

## Task 2: 抽 `get_sentinel_token` 到 `_pkce_common.py`

**Files:**
- Modify: `_pkce_common.py` (添加函数)
- Modify: `protocol_register.py:48` (改 from `def get_sentinel_token` 为 import)

- [ ] **Step 1: 把 `protocol_register.py:48` 起的 `get_sentinel_token` 函数定义复制到 `_pkce_common.py`**

打开 `protocol_register.py` 找 line 48 开始的 `def get_sentinel_token(session, device_id, flow="authorize_continue", user_agent=""):`，把整个函数体复制到 `_pkce_common.py`，**不改一个字符**。

- [ ] **Step 2: `protocol_register.py` 删除原函数定义 + import**

`protocol_register.py:48` 起的函数定义删掉，文件顶部 `import` 区加：

```python
from _pkce_common import get_sentinel_token
```

- [ ] **Step 3: 跑既有 Python 测试验证未破**

```bash
py -3 -m unittest discover tests
```

Expected: 所有既有测试通过（H1 fallback 等）。

- [ ] **Step 4: Commit**

```bash
git add _pkce_common.py protocol_register.py
git commit -m "refactor(pkce): 抽 get_sentinel_token 到 _pkce_common.py"
```

---

## Task 3: 抽 `_post_with_h1_fallback` 到 `_pkce_common.py`

**Files:**
- Modify: `_pkce_common.py`
- Modify: `protocol_register.py:109` (改为 import)

- [ ] **Step 1: 复制 `protocol_register.py:109` 起的 `_post_with_h1_fallback` 到 `_pkce_common.py`**

整个函数体不动地复制。

- [ ] **Step 2: `protocol_register.py` 改为 import**

删除原函数定义，import 加：

```python
from _pkce_common import get_sentinel_token, _post_with_h1_fallback
```

- [ ] **Step 3: 跑测试**

```bash
py -3 -m unittest discover tests
```

Expected: pass。

- [ ] **Step 4: Commit**

```bash
git add _pkce_common.py protocol_register.py
git commit -m "refactor(pkce): 抽 _post_with_h1_fallback 到 _pkce_common.py"
```

---

## Task 4: 在 `_pkce_common.py` 加 `follow_continue_for_auth_code`

`protocol_register.py` 内 `_do_pkce_flow` 重复 4 处「跟 continue_url → 提 localhost:1455 code=」的逻辑（line 278-286 / 291-299 / 342-357 / 362-369）。合并成一个公共函数。

**Files:**
- Modify: `_pkce_common.py`
- Test: 内嵌单元测试（Task 6 一起跑）

- [ ] **Step 1: 写函数到 `_pkce_common.py`**

```python
def follow_continue_for_auth_code(session, continue_url):
    """跟 continue_url 的 redirect chain，从 localhost:1455 重定向中提取 code= 参数。
    OpenAI 内部 redirect 到 localhost:1455 会触发 ConnectionError（本机没监听），
    需要从 exception 字符串里 regex 提 code。
    """
    auth_code = None
    try:
        r = session.get(
            continue_url,
            headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"},
            allow_redirects=True,
            timeout=30,
        )
        redir_url = str(r.url)
        if "localhost:1455" in redir_url and "code=" in redir_url:
            auth_code = parse_qs(urlparse(redir_url).query).get("code", [None])[0]
        # 也检查 response history（有时 final url 不带 code 但中间 redirect 带）
        if not auth_code and hasattr(r, 'history') and r.history:
            for hr in r.history:
                loc = hr.headers.get("location", "") if hasattr(hr, 'headers') else ""
                if "localhost:1455" in loc and "code=" in loc:
                    auth_code = parse_qs(urlparse(loc).query).get("code", [None])[0]
                    break
    except Exception as e:
        # ConnectionError 文本里抓 code
        err_str = str(e)
        import traceback
        tb = traceback.format_exc()
        code_match = re.search(r'code=([^&\s\'"]+)', tb + err_str)
        if code_match:
            auth_code = code_match.group(1)
    return auth_code
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest discover tests
```

Expected: pass。

- [ ] **Step 3: Commit**

```bash
git add _pkce_common.py
git commit -m "feat(pkce): _pkce_common 加 follow_continue_for_auth_code 公共函数"
```

---

## Task 5: 在 `_pkce_common.py` 加 `exchange_code` 和 `rebuild_session`

**Files:**
- Modify: `_pkce_common.py`

- [ ] **Step 1: 写 `exchange_code` 函数**

```python
def exchange_code(session, auth_code, code_verifier, client_id, redirect_uri):
    """POST /oauth/token 用 authorization_code 换 tokens。返回 dict（含 access_token / refresh_token / id_token），失败时返回 {}。"""
    try:
        r = session.post(
            f"{AUTH}/oauth/token",
            json={
                "grant_type": "authorization_code",
                "code": auth_code,
                "code_verifier": code_verifier,
                "client_id": client_id,
                "redirect_uri": redirect_uri,
            },
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=30,
        )
        if r.ok:
            return r.json()
        _log(f"exchange_code failed: HTTP {r.status_code} {r.text[:120]}")
        return {}
    except Exception as e:
        _log(f"exchange_code exception: {str(e)[:80]}")
        return {}
```

- [ ] **Step 2: 写 `rebuild_session` 函数**

```python
def rebuild_session(session_state, proxy_url=None):
    """根据 session_state（cookies + UA + device_id）重建 curl_cffi.Session。"""
    from curl_cffi import requests as curl_requests
    ua = session_state.get("user_agent", "")
    # impersonate 选项：从 UA 提 Chrome 版本号；找不到就用通用 chrome120
    m = re.search(r"Chrome/(\d+)", ua)
    chrome_major = int(m.group(1)) if m else 120
    # curl_cffi 接受的 impersonate 形如 "chrome120"
    impersonate = f"chrome{chrome_major}"
    proxies = None
    if proxy_url:
        if proxy_url.startswith("http://"):
            proxy_url = "socks5h://" + proxy_url[len("http://"):]
        proxies = {"http": proxy_url, "https": proxy_url}
    try:
        s = curl_requests.Session(impersonate=impersonate)
    except Exception:
        s = curl_requests.Session(impersonate="chrome120")
    if proxies:
        s.proxies.update(proxies)
    if ua:
        s.headers.update({"User-Agent": ua})
    # 注入 cookies
    for c in session_state.get("cookies", []):
        s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
    return s
```

- [ ] **Step 3: 写 `_serialize_cookies` 函数**

```python
def _serialize_cookies(session):
    """把 curl_cffi Session 的 cookies jar 序列化为 [{name,value,domain,path}, ...] 列表，
    供 Node 端 stdin JSON 传给下一个 spawn 的 Python 脚本恢复 session。"""
    out = []
    try:
        for c in session.cookies.jar:
            out.append({
                "name": c.name,
                "value": c.value,
                "domain": getattr(c, "domain", ".openai.com") or ".openai.com",
                "path": getattr(c, "path", "/") or "/",
            })
    except Exception:
        # curl_cffi 不同版本 jar 接口可能差异，回退取 .cookies 字典
        try:
            for k, v in session.cookies.items():
                out.append({"name": k, "value": v, "domain": ".openai.com", "path": "/"})
        except Exception:
            pass
    return out
```

- [ ] **Step 4: 跑测试**

```bash
py -3 -m unittest discover tests
```

Expected: pass。

- [ ] **Step 5: 验证 import**

```bash
py -3 -c "from _pkce_common import exchange_code, rebuild_session, _serialize_cookies, follow_continue_for_auth_code; print('ok')"
```

Expected: `ok`。

- [ ] **Step 6: Commit**

```bash
git add _pkce_common.py
git commit -m "feat(pkce): _pkce_common 加 exchange_code + rebuild_session + _serialize_cookies"
```

---

## Task 6: 替换 `protocol_register.py` 4 处 follow continue 为公共函数

**Files:**
- Modify: `protocol_register.py` (line 278-286 / 291-299 / 342-357 / 362-369)

- [ ] **Step 1: import**

`protocol_register.py` 顶部 import 加：

```python
from _pkce_common import (
    get_sentinel_token,
    _post_with_h1_fallback,
    follow_continue_for_auth_code,
)
```

（合并原有 import）

- [ ] **Step 2: 替换 4 处**

把每处 try/except 块改成：

```python
auth_code = follow_continue_for_auth_code(session, continue_url)
# 或 otp_continue / final_continue 视上下文
```

具体 4 处对应：

- `protocol_register.py:278-286` 用 `otp_continue` 变量
- `protocol_register.py:291-299` 用 `continue_url` 变量
- `protocol_register.py:342-357` 用 `continue_url` 变量
- `protocol_register.py:362-369` 这个是 "Last resort" 不用替换（已经在 follow_continue_for_auth_code 内做了同样的 history 扫描）

- [ ] **Step 3: 跑既有测试**

```bash
py -3 -m unittest discover tests
```

Expected: pass。

- [ ] **Step 4: 手动 smoke test：跑一个既有协议账号的 PKCE，确认没破**

```bash
# 用 server/index.js 启起来后 UI 触发 一个已知能成功 PKCE 的账号 → 确认 status=plus
```

不行就回滚这个 commit 重做。

- [ ] **Step 5: Commit**

```bash
git add protocol_register.py
git commit -m "refactor(pkce): protocol_register 4 处 follow continue 改用公共函数"
```

---

## Task 7: 给 `protocol_register.py` 3 处 `needsPhone` 加 sessionState 输出

**Files:**
- Modify: `protocol_register.py:273-275, 338-339, 359-360`

- [ ] **Step 1: 在 `_do_pkce_flow` 函数定义处加局部变量**

找 `_do_pkce_flow(session, email, password, ms_client_id, ms_refresh_token)` 函数（line 153 起），在函数体顶部、`auth_url = ...` 之前 verify 拿到了以下变量：
- `code_verifier`、`code_challenge`、`redirect_uri`、`client_id`、`device_id`

如果某个变量在原函数里是不同的命名，统一改名以一致。

- [ ] **Step 2: 写 sessionState 构造 helper（局部）**

`protocol_register.py` 在 `_do_pkce_flow` 函数里、return needsPhone 之前加 helper（内嵌即可）：

```python
def _build_session_state(current_resp=None):
    from _pkce_common import _serialize_cookies
    return {
        "cookies": _serialize_cookies(session),
        "device_id": device_id,
        "user_agent": session.headers.get("User-Agent", ""),
        "code_verifier": code_verifier,
        "code_challenge": code_challenge,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "current_url": str(current_resp.url) if current_resp is not None else "",
        "authorize_continue_url": (current_resp.json().get("continue_url", "") if (current_resp is not None and current_resp.ok and current_resp.headers.get("content-type", "").startswith("application/json")) else ""),
    }
```

- [ ] **Step 3: 替换 line 273-275 的 needsPhone return**

原：

```python
if "add_phone" in otp_page_type or "add-phone" in otp_continue or "phone-required" in otp_continue:
    _log("PKCE: Phone verification required")
    return {"needsPhone": True}
```

改为：

```python
if "add_phone" in otp_page_type or "add-phone" in otp_continue or "phone-required" in otp_continue:
    _log("PKCE: Phone verification required (choose-account branch)")
    return {"needsPhone": True, "session_state": _build_session_state(r)}
```

- [ ] **Step 4: 替换 line 338-339**

原：

```python
if "add_phone" in otp_page or "add-phone" in str(continue_url):
    return {"needsPhone": True}
```

改为：

```python
if "add_phone" in otp_page or "add-phone" in str(continue_url):
    _log("PKCE: Phone verification required (login branch)")
    return {"needsPhone": True, "session_state": _build_session_state(r)}
```

- [ ] **Step 5: 替换 line 359-360**

原：

```python
elif "add-phone" in final_path or "phone-required" in final_path:
    return {"needsPhone": True}
```

改为：

```python
elif "add-phone" in final_path or "phone-required" in final_path:
    _log("PKCE: Phone verification required (landing branch)")
    return {"needsPhone": True, "session_state": _build_session_state(r)}
```

- [ ] **Step 6: 验证语法**

```bash
py -3 -c "import protocol_register; print('ok')"
```

Expected: `ok`。

- [ ] **Step 7: 跑既有测试**

```bash
py -3 -m unittest discover tests
```

Expected: pass。

- [ ] **Step 8: Commit**

```bash
git add protocol_register.py
git commit -m "feat(pkce): protocol_register 3 处 needsPhone 附带 session_state"
```

---

## Task 8: 新建 `protocol_phone_verify.py` 骨架 + 第一个测试 (Python 测试 1: local 全成功)

**Files:**
- Create: `protocol_phone_verify.py`
- Create: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写第一个失败的测试**

`tests/test_protocol_phone_verify.py`：

```python
"""Tests for protocol_phone_verify.py — single-attempt add_phone HTTP flow."""
import io
import json
import sys
import unittest
from unittest.mock import patch, MagicMock


class TestProtocolPhoneVerify(unittest.TestCase):

    def _build_input(self, **overrides):
        base = {
            "session_state": {
                "cookies": [{"name": "oai-did", "value": "abc", "domain": ".openai.com", "path": "/"}],
                "device_id": "device-xyz",
                "user_agent": "Mozilla/5.0 Chrome/120.0",
                "code_verifier": "cv-xxx",
                "code_challenge": "cc-xxx",
                "redirect_uri": "http://localhost:1455/auth/callback",
                "client_id": "app_test",
                "current_url": "https://auth.openai.com/add-phone",
                "authorize_continue_url": "",
            },
            "phone": "+12282351427",
            "sms": {"provider": "local", "url": "https://sms.example.com/abc"},
            "proxy_url": None,
        }
        base.update(overrides)
        return base

    def _run_with_input(self, input_dict, **mock_kwargs):
        """Run protocol_phone_verify.main() with stdin patched and return parsed stdout JSON."""
        import protocol_phone_verify as pv
        with patch("sys.stdin", io.StringIO(json.dumps(input_dict))), \
             patch("sys.stdout", new_callable=io.StringIO) as fake_out:
            for k, v in mock_kwargs.items():
                setattr(pv, k, v) if not k.startswith("_") else None
            pv.main()
        # 取 stdout 最后一行（前面可能有 log JSON）
        last_line = fake_out.getvalue().strip().split("\n")[-1]
        return json.loads(last_line)

    def test_local_full_success(self):
        """phone-start 通过 → SMS 收到 code → validate 通过 → token exchange 成功 → status=ok"""
        # 见 Step 3 完整实现
        pass


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试，确认 fail（因为 protocol_phone_verify.py 不存在）**

```bash
py -3 -m unittest tests.test_protocol_phone_verify -v
```

Expected: `ModuleNotFoundError: No module named 'protocol_phone_verify'`。

- [ ] **Step 3: 写 `protocol_phone_verify.py` 骨架（最小实现，先让 test_local_full_success 通过）**

```python
# protocol_phone_verify.py — 协议模式 add_phone 单次 attempt HTTP 流程
# v2.40.0：与浏览器模式 utils.js v2.39.4 功能等价。
# 此脚本只跑一次 attempt，retry / phone-pool 操作全在 Node。
import json
import re
import sys
import time

from _pkce_common import (
    AUTH, _log,
    get_sentinel_token,
    follow_continue_for_auth_code,
    exchange_code,
    rebuild_session,
)


def is_phone_rejected(resp):
    """判定 phone-start 响应是否表示 OpenAI 拒号（红字"无法发送验证码"）。
    根据 Phase 0 抓包报告 docs/superpowers/research/2026-05-26-openai-add-phone-http.md
    判定条件填入此函数。占位实现：HTTP 4xx 一律算拒；JSON body 含 error/code 字段也算。"""
    if resp.status_code >= 400 and resp.status_code < 500:
        return True
    try:
        data = resp.json()
        # Phase 0 报告确认具体 error key — 占位用通用判定
        err = (data.get("error") or "").lower()
        code = (data.get("code") or "").lower()
        for kw in ["phone_send_failed", "unable_to_send", "cannot_send", "phone_rejected"]:
            if kw in err or kw in code:
                return True
    except Exception:
        pass
    return False


def has_sms_prompt(resp):
    """判定 phone-start 响应是否进入"等待 SMS 输入"状态。Phase 0 报告填入。"""
    if not resp.ok:
        return False
    try:
        data = resp.json()
        page_type = (data.get("page") or {}).get("type", "")
        if "sms" in page_type.lower() or "phone_verify" in page_type or "code" in page_type:
            return True
        # 或者根据 continue_url 路径判定
        cont = data.get("continue_url", "")
        if "sms" in cont or "verify-phone" in cont or "phone-code" in cont:
            return True
    except Exception:
        pass
    return False


def poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=None):
    """轮询 SMS provider 拿 6 位验证码。local 用 GET URL，zhusms 用 GET /api/order/status。"""
    import requests  # stdlib-friendly
    provider = sms_cfg.get("provider", "local")
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    for _ in range(max_attempts):
        try:
            if provider == "local":
                r = requests.get(sms_cfg["url"], proxies=proxies, timeout=10)
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", r.text)
                    if m:
                        return m.group(1)
            else:  # zhusms
                headers = {
                    "Cookie": sms_cfg.get("cookie", ""),
                    "Origin": sms_cfg["base_url"],
                    "Referer": sms_cfg["base_url"] + "/",
                }
                r = requests.get(
                    f"{sms_cfg['base_url']}/api/order/status?order_no={sms_cfg['order_no']}",
                    headers=headers,
                    proxies=proxies,
                    timeout=10,
                )
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", json.dumps(r.json()))
                    if m:
                        return m.group(1)
        except Exception:
            pass
        time.sleep(interval)
    return None


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        print(json.dumps({"status": "submit-error", "detail": f"bad stdin: {e}"}))
        return

    ss = inp.get("session_state") or {}
    phone = inp.get("phone", "")
    sms_cfg = inp.get("sms") or {}
    proxy_url = inp.get("proxy_url")

    s = rebuild_session(ss, proxy_url)

    # Step 1: phone-start
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_start", user_agent=ss["user_agent"]) or ""
    # NOTE: endpoint path 来自 Phase 0 报告 — 替换为真实 path
    PHONE_START_PATH = "/api/accounts/phone/start"
    r = s.post(
        f"{AUTH}{PHONE_START_PATH}",
        json={"phone": phone},  # payload schema 来自 Phase 0 报告
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
            "openai-sentinel-token": sentinel,
        },
        timeout=30,
    )
    if is_phone_rejected(r):
        print(json.dumps({"status": "phone-rejected", "detail": f"HTTP {r.status_code} {r.text[:120]}"}))
        return
    if not has_sms_prompt(r):
        print(json.dumps({"status": "submit-error", "detail": f"phone-start unexpected: {r.status_code} {r.text[:120]}"}))
        return

    # Step 2: poll SMS
    code = poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=proxy_url)
    if not code:
        print(json.dumps({"status": "sms-timeout"}))
        return

    # Step 3: phone-validate
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_validate", user_agent=ss["user_agent"]) or ""
    PHONE_VALIDATE_PATH = "/api/accounts/phone/validate"  # 来自 Phase 0
    r = s.post(
        f"{AUTH}{PHONE_VALIDATE_PATH}",
        json={"code": code},  # payload 来自 Phase 0
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": AUTH,
            "Referer": ss.get("current_url", AUTH + "/add-phone"),
            "oai-device-id": ss["device_id"],
            "openai-sentinel-token": sentinel,
        },
        timeout=30,
    )
    if not r.ok:
        print(json.dumps({"status": "validate-error", "detail": f"HTTP {r.status_code} {r.text[:120]}"}))
        return
    data = {}
    try:
        data = r.json()
    except Exception:
        pass
    continue_url = data.get("continue_url", "")
    if not continue_url:
        print(json.dumps({"status": "validate-error", "detail": "no continue_url in validate response"}))
        return

    # 至此 OpenAI 已接受号 + 验证码 → 之后失败属 post-validate-error（保留 binding）

    # Step 4: follow continue → localhost:1455 → 拿 auth_code
    auth_code = follow_continue_for_auth_code(s, continue_url)
    if not auth_code:
        print(json.dumps({"status": "post-validate-error", "detail": "no auth_code from continue_url"}))
        return

    # Step 5: oauth/token exchange
    tokens = exchange_code(s, auth_code, ss["code_verifier"], ss["client_id"], ss["redirect_uri"])
    if not tokens.get("access_token"):
        print(json.dumps({"status": "post-validate-error", "detail": "token exchange empty"}))
        return

    print(json.dumps({"status": "ok", "tokens": tokens}))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 完善 test_local_full_success**

回到 `tests/test_protocol_phone_verify.py`，填上 test_local_full_success 的实现：

```python
def test_local_full_success(self):
    """phone-start 通过 → SMS 收到 code → validate 通过 → token exchange 成功 → status=ok"""
    import protocol_phone_verify as pv

    # Mock curl_cffi session
    fake_session = MagicMock()
    # phone-start: 200 + sms prompt
    phone_start_resp = MagicMock(ok=True, status_code=200, text='{"page":{"type":"phone_sms_code"}}')
    phone_start_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    # phone-validate: 200 + continue_url
    validate_resp = MagicMock(ok=True, status_code=200, text='{"continue_url":"https://auth.openai.com/cont"}')
    validate_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
    fake_session.post.side_effect = [phone_start_resp, validate_resp]
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    # Mock rebuild_session 返回 fake_session
    # Mock follow_continue_for_auth_code 返回 "test-code"
    # Mock exchange_code 返回 tokens
    # Mock get_sentinel_token 返回 ""
    # Mock poll_sms 返回 "123456"
    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value="sentinel-tok"), \
         patch.object(pv, "follow_continue_for_auth_code", return_value="test-auth-code"), \
         patch.object(pv, "exchange_code", return_value={"access_token": "AT", "refresh_token": "RT", "id_token": "ID"}), \
         patch.object(pv, "poll_sms", return_value="123456"):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "ok")
    self.assertEqual(result["tokens"], {"access_token": "AT", "refresh_token": "RT", "id_token": "ID"})
    # 验证调用了 2 次 session.post（phone-start + phone-validate）
    self.assertEqual(fake_session.post.call_count, 2)
```

- [ ] **Step 5: 跑测试，确认 pass**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_local_full_success -v
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add protocol_phone_verify.py tests/test_protocol_phone_verify.py
git commit -m "feat(pkce): 新建 protocol_phone_verify.py + 测试 1 (local 全成功)"
```

---

## Task 9: 测试 2 — zhusms 全成功

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

加到 `TestProtocolPhoneVerify`：

```python
def test_zhusms_full_success(self):
    """zhusms provider: 与 local 同样的 add_phone 主流程，SMS 走 zhusms /api/order/status。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    ps_resp = MagicMock(ok=True, status_code=200)
    ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    val_resp = MagicMock(ok=True, status_code=200)
    val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
    fake_session.post.side_effect = [ps_resp, val_resp]
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    zhusms_input = self._build_input(sms={
        "provider": "zhusms",
        "order_no": "ord-123",
        "base_url": "https://zhusms.com",
        "card_key": "ZS-X",
        "cookie": "session=abc",
    })

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""), \
         patch.object(pv, "follow_continue_for_auth_code", return_value="code-x"), \
         patch.object(pv, "exchange_code", return_value={"access_token": "AT", "refresh_token": "RT", "id_token": "ID"}), \
         patch.object(pv, "poll_sms", return_value="654321"):
        result = self._run_with_input(zhusms_input)

    self.assertEqual(result["status"], "ok")
    self.assertEqual(result["tokens"]["refresh_token"], "RT")
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_zhusms_full_success -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 2 (zhusms 全成功)"
```

---

## Task 10: 测试 3 — phone-start 红字拒号

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_phone_start_rejected(self):
    """phone-start 返回 4xx → status=phone-rejected。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    reject_resp = MagicMock(ok=False, status_code=400, text='{"error":"phone_send_failed"}')
    reject_resp.json.return_value = {"error": "phone_send_failed"}
    fake_session.post.return_value = reject_resp
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "phone-rejected")
    self.assertIn("400", result["detail"])
    # phone-validate 不应被调用
    self.assertEqual(fake_session.post.call_count, 1)
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_phone_start_rejected -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 3 (phone-start 拒号)"
```

---

## Task 11: 测试 4 — SMS 超时

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_sms_timeout(self):
    """phone-start 通过但 poll_sms 30 次都没拿到码 → status=sms-timeout。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    ps_resp = MagicMock(ok=True, status_code=200)
    ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    fake_session.post.return_value = ps_resp
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""), \
         patch.object(pv, "poll_sms", return_value=None):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "sms-timeout")
    # validate 不应被调用
    self.assertEqual(fake_session.post.call_count, 1)
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_sms_timeout -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 4 (SMS 超时)"
```

---

## Task 12: 测试 5 — phone-validate 错码

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_validate_error(self):
    """phone-validate 返回 4xx → status=validate-error。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    ps_resp = MagicMock(ok=True, status_code=200)
    ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    val_resp = MagicMock(ok=False, status_code=400, text='{"error":"invalid_code"}')
    fake_session.post.side_effect = [ps_resp, val_resp]
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""), \
         patch.object(pv, "poll_sms", return_value="123456"):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "validate-error")
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_validate_error -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 5 (validate-error)"
```

---

## Task 13: 测试 6 — post-validate follow continue 失败

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_post_validate_follow_fail(self):
    """phone-validate 通过 + follow continue 拿不到 code → status=post-validate-error (binding 保留)。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    ps_resp = MagicMock(ok=True, status_code=200)
    ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    val_resp = MagicMock(ok=True, status_code=200)
    val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
    fake_session.post.side_effect = [ps_resp, val_resp]
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""), \
         patch.object(pv, "poll_sms", return_value="123456"), \
         patch.object(pv, "follow_continue_for_auth_code", return_value=None):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "post-validate-error")
    self.assertIn("auth_code", result["detail"])
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_post_validate_follow_fail -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 6 (post-validate follow 失败)"
```

---

## Task 14: 测试 7 — token exchange 失败

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_post_validate_token_exchange_fail(self):
    """validate 通过 + follow ok + token exchange empty → status=post-validate-error (binding 保留)。"""
    import protocol_phone_verify as pv

    fake_session = MagicMock()
    ps_resp = MagicMock(ok=True, status_code=200)
    ps_resp.json.return_value = {"page": {"type": "phone_sms_code"}}
    val_resp = MagicMock(ok=True, status_code=200)
    val_resp.json.return_value = {"continue_url": "https://auth.openai.com/cont"}
    fake_session.post.side_effect = [ps_resp, val_resp]
    fake_session.headers = {}
    fake_session.cookies = MagicMock()

    with patch.object(pv, "rebuild_session", return_value=fake_session), \
         patch.object(pv, "get_sentinel_token", return_value=""), \
         patch.object(pv, "poll_sms", return_value="123456"), \
         patch.object(pv, "follow_continue_for_auth_code", return_value="code-x"), \
         patch.object(pv, "exchange_code", return_value={}):
        result = self._run_with_input(self._build_input())

    self.assertEqual(result["status"], "post-validate-error")
    self.assertIn("token exchange", result["detail"])
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_post_validate_token_exchange_fail -v
```

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 7 (token exchange 失败)"
```

---

## Task 15: 测试 8 — session 重建正确

**Files:**
- Modify: `tests/test_protocol_phone_verify.py`

- [ ] **Step 1: 写测试**

```python
def test_rebuild_session_injects_cookies_and_ua(self):
    """rebuild_session 注入 cookies + UA + device_id 正确（直接测公共函数）。"""
    from _pkce_common import rebuild_session
    ss = {
        "cookies": [
            {"name": "oai-did", "value": "abc", "domain": ".openai.com", "path": "/"},
            {"name": "session", "value": "xyz", "domain": "auth.openai.com", "path": "/"},
        ],
        "user_agent": "Mozilla/5.0 Chrome/130.0 TestAgent",
        "device_id": "dev-zzz",
    }
    s = rebuild_session(ss)
    # UA 注入
    self.assertEqual(s.headers.get("User-Agent"), "Mozilla/5.0 Chrome/130.0 TestAgent")
    # cookies 注入
    cookie_names = set()
    try:
        for c in s.cookies.jar:
            cookie_names.add(c.name)
    except Exception:
        cookie_names = set(s.cookies.keys())
    self.assertIn("oai-did", cookie_names)
    self.assertIn("session", cookie_names)
```

- [ ] **Step 2: 跑测试**

```bash
py -3 -m unittest tests.test_protocol_phone_verify.TestProtocolPhoneVerify.test_rebuild_session_injects_cookies_and_ua -v
```

Expected: PASS。

- [ ] **Step 3: 跑全部 Python 测试确认无破**

```bash
py -3 -m unittest discover tests -v
```

Expected: 全部 PASS（既有 + 新 8 个）。

- [ ] **Step 4: Commit**

```bash
git add tests/test_protocol_phone_verify.py
git commit -m "test(pkce): protocol_phone_verify 测试 8 (session 重建注入)"
```

---

## Task 16: Node 端 — 新增 `runProtocolPhoneVerify` helper

**Files:**
- Modify: `protocol-engine.js` (在 line 88 `runProtocolPKCE` 后面追加)

- [ ] **Step 1: 在 `protocol-engine.js` 加常量**

`protocol-engine.js:21` 后面（PYTHON_SCRIPT 常量之后）加：

```js
const PYTHON_PHONE_VERIFY_SCRIPT = path.join(ROOT, 'protocol_phone_verify.py');
```

- [ ] **Step 2: 加 `runProtocolPhoneVerify` 函数**

在 `runProtocolPKCE` 函数之后（line 88 之后）插入：

```js
// v2.40.0: 协议模式 add_phone 单次 attempt（spawn protocol_phone_verify.py）
function runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, engine) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', PYTHON_PHONE_VERIFY_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    if (engine) engine._pyProc = py;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; try { py.kill('SIGKILL'); } catch {} resolve({ status: 'submit-error', detail: 'timeout 180s' }); }
    }, 180_000);
    const input = JSON.stringify({
      session_state: sessionState,
      phone, sms: smsConfig, proxy_url: proxyUrl,
    });
    let stdout = '', stderr = '';
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) { console.log(parsed.log); } else { stdout = line; }
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ status: 'submit-error', detail: stderr.slice(-200) || `python exit ${code}` });
      }
    });
    py.on('error', (e) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ status: 'submit-error', detail: `spawn failed: ${e.message}` });
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}
```

- [ ] **Step 3: 跑 Node 测试确认不破**

```bash
npm test
```

Expected: 既有 206 个测试全过（新文件未引用 runProtocolPhoneVerify 所以没影响）。

- [ ] **Step 4: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol): 加 runProtocolPhoneVerify spawn helper"
```

---

## Task 17: Node 端 — `_acquirePhoneForProtocol` 方法（含 local + zhusms 分支）

**Files:**
- Modify: `protocol-engine.js` (在 ProtocolEngine class 内加方法)

- [ ] **Step 1: 找 ProtocolEngine class 位置**

`protocol-engine.js:91` 是 `class ProtocolEngine extends EventEmitter {`。在 `_finalizePkce` 方法（line 123）**之前**加新方法。

- [ ] **Step 2: 在文件顶部 require 区加 phone-pool 和 zhusms-provider import**

`protocol-engine.js:18` 后追加：

```js
const phonePool = require('./server/phone-pool');
const zhusmsProvider = require('./server/zhusms-provider');
const { getRawDb, save } = require('./server/db');
const fs = require('fs');
```

（注意：`fs` 顶部可能已有 — 看 line 7。如果有就不重复 require。）

- [ ] **Step 3: 加方法**

在 ProtocolEngine class 内、`_finalizePkce` 方法**之前**加：

```js
  // v2.40.0: 协议模式 add_phone — 统一 local / zhusms provider 出参
  async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl) {
    if (provider === 'zhusms') {
      const z = cfg.phonePool.zhusms || {};
      if (!z.cardKey) return {};
      try {
        const order = await zhusmsProvider.takeOrder(
          z.cardKey, z.baseUrl || 'https://zhusms.com',
          z.service || 'codex', proxyUrl,
        );
        if (!order) return {};
        // 拿 session cookie 给 Python 用（避免 Python 再 activate 一次）
        let cookie = '';
        try {
          cookie = await zhusmsProvider.ensureSession(z.cardKey, z.baseUrl || 'https://zhusms.com', proxyUrl);
        } catch {}
        return {
          phone: order.phone,
          smsConfig: {
            provider: 'zhusms',
            order_no: order.order_no,
            base_url: z.baseUrl || 'https://zhusms.com',
            card_key: z.cardKey,
            cookie,
          },
          releaseFn: async () => {
            try { await zhusmsProvider.cancelOrder(order.order_no, z.baseUrl || 'https://zhusms.com', z.cardKey, proxyUrl); } catch {}
          },
        };
      } catch (e) {
        console.log(`[protocol] zhusms takeOrder failed: ${e?.message?.slice(0, 60)}`);
        return {};
      }
    }
    // local
    const max = cfg.phonePool.maxBindingsPerPhone || 5;
    const allotted = phonePool.acquirePhone(getRawDb(), email, max);
    if (!allotted) return {};
    return {
      phone: allotted.phone,
      smsConfig: { provider: 'local', url: allotted.smsApiUrl },
      releaseFn: async () => { phonePool.releaseBinding(getRawDb(), allotted.phone, email); },
    };
  }
```

- [ ] **Step 4: 跑 Node 测试确认不破**

```bash
npm test
```

Expected: 206 pass。

- [ ] **Step 5: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol): 加 _acquirePhoneForProtocol (local + zhusms 分支)"
```

---

## Task 18: Node 端 — `_finalizePhoneVerify` retry loop

**Files:**
- Modify: `protocol-engine.js` (在 ProtocolEngine class 内、`_acquirePhoneForProtocol` 之后)

- [ ] **Step 1: 加方法**

```js
  // v2.40.0: 协议模式 add_phone 主流程（retry 3 次，按 result.status 分流）
  async _finalizePhoneVerify(sessionState, account) {
    const CONFIG_PATH = path.join(ROOT, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
    if (!cfg?.phonePool?.enabled) {
      return { phoneVerifyFail: 'pool-disabled' };
    }

    let proxyUrl = null;
    try {
      const state = proxyMgr.getState?.();
      if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890';
    } catch {}

    const provider = cfg.phonePool.provider || 'local';
    const MAX_ATTEMPTS = 3;
    let lastReason = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const acq = await this._acquirePhoneForProtocol(provider, cfg, account.email, proxyUrl);
      const { phone, smsConfig, releaseFn } = acq;
      if (!phone) {
        return lastReason ? { phoneVerifyFail: lastReason } : { phonePoolEmpty: true };
      }
      // v2.39.4 hotfix 等价：拿号后立即落盘
      try { save(); } catch {}

      console.log(`[protocol] add-phone (attempt ${attempt}/${MAX_ATTEMPTS}): ${phone} (provider=${provider})`);
      const result = await runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, this);

      if (result.status === 'ok') {
        console.log(`[protocol] add-phone OK, tokens obtained`);
        return { tokens: result.tokens };
      }
      if (result.status === 'phone-rejected') {
        console.log(`[protocol] OpenAI rejected ${phone}: ${(result.detail || '').slice(0, 80)}, retry`);
        if (releaseFn) try { await releaseFn(); } catch {}
        try { save(); } catch {}
        lastReason = 'phone-rejected-by-openai';
        continue;
      }
      if (result.status === 'sms-timeout' || result.status === 'validate-error') {
        // OpenAI 那边号没真用 → release
        console.log(`[protocol] add-phone ${result.status}: ${(result.detail || '').slice(0, 80)}`);
        if (releaseFn) try { await releaseFn(); } catch {}
        try { save(); } catch {}
        return { phoneVerifyFail: result.status };
      }
      // post-validate-error: OpenAI 已接受号 + 验证码，binding 保留
      console.log(`[protocol] add-phone post-validate failure: ${(result.detail || '').slice(0, 80)}, binding kept`);
      return { phoneVerifyFail: 'post-validate-error' };
    }

    return { phoneVerifyFail: 'all-phones-rejected' };
  }
```

- [ ] **Step 2: 验证语法**

```bash
node --check protocol-engine.js
```

Expected: 无输出（成功）。

- [ ] **Step 3: 跑 Node 测试**

```bash
npm test
```

Expected: 206 pass。

- [ ] **Step 4: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol): 加 _finalizePhoneVerify retry loop (max 3)"
```

---

## Task 19: Node 端 — `_finalizePkce` 集成 add_phone

**Files:**
- Modify: `protocol-engine.js:123-143` (现有 `_finalizePkce` 方法)

- [ ] **Step 1: 替换 `_finalizePkce` 的 `pkce.needsPhone` 分支**

原代码（`protocol-engine.js:127-137`）：

```js
const pkce = pkceResult.pkce || {};
if (pkce.refresh_token) {
  console.log(`[${progress}] PKCE success, saving with refresh_token`);
  saveCPAAuthFile(account.email, pkce.access_token || loginResult.accessToken, { ...loginResult.session, refresh_token: pkce.refresh_token, id_token: pkce.id_token || '' });
  this.emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
} else {
  if (pkce.needsPhone) console.log(`[${progress}] PKCE requires phone verification`);
  else console.log(`[${progress}] PKCE no RT: ${pkce.error || 'unknown'}`);
  saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
  this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
}
```

改为：

```js
const pkce = pkceResult.pkce || {};
if (pkce.refresh_token) {
  console.log(`[${progress}] PKCE success, saving with refresh_token`);
  saveCPAAuthFile(account.email, pkce.access_token || loginResult.accessToken, { ...loginResult.session, refresh_token: pkce.refresh_token, id_token: pkce.id_token || '' });
  this.emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
} else if (pkce.needsPhone) {
  // v2.40.0: 协议模式 add_phone 自动化
  console.log(`[${progress}] PKCE requires phone verification, running protocol add-phone flow...`);
  const r = await this._finalizePhoneVerify(pkce.session_state || {}, account);
  if (r.tokens) {
    console.log(`[${progress}] add-phone success, saving with refresh_token`);
    saveCPAAuthFile(account.email, r.tokens.access_token || loginResult.accessToken, {
      ...loginResult.session,
      refresh_token: r.tokens.refresh_token,
      id_token: r.tokens.id_token || '',
    });
    this.emitStatus({ email: account.email, status: 'plus', phase: 'done', progress });
  } else {
    // failure 映射：phonePoolEmpty → phone_pool_empty；phoneVerifyFail/pool-disabled → 既有 status
    let failStatus;
    if (r.phonePoolEmpty) failStatus = 'phone_pool_empty';
    else if (r.phoneVerifyFail === 'pool-disabled') failStatus = 'plus_no_rt';
    else failStatus = 'phone_verify_fail';
    console.log(`[${progress}] add-phone failed: ${r.phoneVerifyFail || 'pool-empty'}, status=${failStatus}`);
    saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
    this.emitStatus({ email: account.email, status: failStatus, phase: 'done', progress });
  }
} else {
  console.log(`[${progress}] PKCE no RT: ${pkce.error || 'unknown'}`);
  saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
  this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
}
```

- [ ] **Step 2: 验证语法**

```bash
node --check protocol-engine.js
```

Expected: 无输出。

- [ ] **Step 3: 跑 Node 测试**

```bash
npm test
```

Expected: 206 pass。

- [ ] **Step 4: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(protocol): _finalizePkce 集成 _finalizePhoneVerify (status 映射)"
```

---

## Task 20: Node 测试骨架 + 测试 1 (local 1 attempt 成功)

**Files:**
- Create: `server/__tests__/protocol-phone-verify.test.js`

- [ ] **Step 1: 写测试骨架 + 测试 1**

```js
// server/__tests__/protocol-phone-verify.test.js
// v2.40.0: 协议模式 add_phone Node 端 _finalizePhoneVerify retry loop 测试

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 临时 config.json + data.db，每 test 隔离
function makeTempCfg(provider, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-verify-test-'));
  const cfg = {
    phonePool: { enabled: true, provider, maxBindingsPerPhone: 3, ...extra },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  return tmp;
}

async function loadEngineWithMocks({ runResult, phonePoolAvail = true, zhusmsAvail = true, cfgProvider = 'local', cfgExtra = {} }) {
  // 清模块缓存
  for (const k of Object.keys(require.cache)) {
    if (k.includes('protocol-engine') || k.includes('phone-pool') || k.includes('zhusms-provider')) {
      delete require.cache[k];
    }
  }
  // mock 三个依赖：runProtocolPhoneVerify / phone-pool / zhusms-provider
  // 简单做法：直接 require 之后 monkey-patch
  const tmpRoot = makeTempCfg(cfgProvider, cfgExtra);
  const ROOT = path.resolve(__dirname, '..', '..');
  // 把临时 config.json 软链 / copy 到 ROOT（仅本测试用）
  // 实际更简洁：直接 mock readFileSync — 但这会影响其它代码。改为 path.join 重定向：
  // 这里直接 patch fs.readFileSync 路径匹配 config.json 时返回 tmp 内容
  const realReadFile = fs.readFileSync;
  const origConfigPath = path.join(ROOT, 'config.json');
  fs.readFileSync = function (p, enc) {
    if (p === origConfigPath) {
      return realReadFile(path.join(tmpRoot, 'config.json'), enc);
    }
    return realReadFile.apply(this, arguments);
  };
  // ... 测试结束后调用 cleanup() 还原
  function cleanup() {
    fs.readFileSync = realReadFile;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  return { ROOT, tmpRoot, cleanup };
}

test('local 1 attempt 成功 → 返 {tokens}', async () => {
  const { cleanup } = await loadEngineWithMocks({});

  // 直接构造一个 ProtocolEngine 实例 + monkey-patch _acquirePhoneForProtocol + runProtocolPhoneVerify
  const protocolEngineMod = require('../../protocol-engine');
  // 注：protocol-engine.js 没用 module.exports — 需要先检查现状。
  // 临时方案：把 protocol-engine.js module.exports 加上 ProtocolEngine + runProtocolPhoneVerify
  // （Task 21 前置 step 处理这个）

  // 这个测试现在写不完，先 skip 等 Task 21 调整 exports 后再补
  cleanup();
  assert.ok(true, 'placeholder — see Task 21 for export adjustment');
});
```

- [ ] **Step 2: 跑测试确认 skip**

```bash
npm test
```

Expected: 测试 pass（占位）。

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/protocol-phone-verify.test.js
git commit -m "test(protocol): protocol-phone-verify.test.js 骨架"
```

---

## Task 21: 调整 `protocol-engine.js` exports 以便测试可注入 mock

**Files:**
- Modify: `protocol-engine.js` (底部 `module.exports`)

- [ ] **Step 1: 在 `protocol-engine.js` 底部 module.exports 加暴露**

找文件末尾的 `module.exports = { ProtocolEngine };` 或 `module.exports = ProtocolEngine` 行，改为：

```js
module.exports = {
  ProtocolEngine,
  // v2.40.0: 暴露给测试做 mock 注入
  __runProtocolPhoneVerify: runProtocolPhoneVerify,
  __setRunProtocolPhoneVerify: (fn) => { runProtocolPhoneVerify = fn; },
};
```

把 `function runProtocolPhoneVerify(...)` 顶部声明改为：

```js
let runProtocolPhoneVerify = function (sessionState, phone, smsConfig, proxyUrl, engine) {
  // ... 原实现
};
```

（`let` 而非 `function`，这样 `__setRunProtocolPhoneVerify` 才能替换）

- [ ] **Step 2: 验证语法 + Node 测试**

```bash
node --check protocol-engine.js && npm test
```

Expected: 206 pass。

- [ ] **Step 3: Commit**

```bash
git add protocol-engine.js
git commit -m "refactor(protocol): 暴露 runProtocolPhoneVerify 给测试可 mock 注入"
```

---

## Task 22: Node 测试 1-3（local 路径核心 3 个）

**Files:**
- Modify: `server/__tests__/protocol-phone-verify.test.js`

- [ ] **Step 1: 替换骨架，加 3 个完整测试**

把整个文件替换为：

```js
// server/__tests__/protocol-phone-verify.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

function setupTestEnv(cfg) {
  // 清模块缓存
  for (const k of Object.keys(require.cache)) {
    if (k.includes('protocol-engine') || k.includes('phone-pool') || k.includes('zhusms-provider') || k.includes('server/db')) {
      delete require.cache[k];
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-verify-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  const origReadFile = fs.readFileSync;
  fs.readFileSync = function (p, enc) {
    if (p === path.join(ROOT, 'config.json')) return origReadFile(path.join(tmp, 'config.json'), enc);
    return origReadFile.apply(this, arguments);
  };
  return {
    cleanup() {
      fs.readFileSync = origReadFile;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
  };
}

async function mkEngine(opts) {
  const { ProtocolEngine, __setRunProtocolPhoneVerify } = require('../../protocol-engine');
  __setRunProtocolPhoneVerify(opts.runResult);
  const engine = new ProtocolEngine();
  // mock phone-pool acquirePhone / releaseBinding
  if (opts.localQueue) {
    let i = 0;
    engine._acquirePhoneForProtocol = async (provider, cfg, email) => {
      if (provider !== 'local') throw new Error('expected local');
      const item = opts.localQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'local', url: 'http://test' },
        releaseFn: opts.releaseFn || (async () => {}),
      };
    };
  }
  return engine;
}

test('local 1 attempt 成功 → 返 {tokens}', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } }; },
      localQueue: [{ phone: '+1111' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 0, 'success 不应 release');
  } finally { env.cleanup(); }
});

test('local 1 拒 + 2 成功 → 返 {tokens}', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const responses = [
      { status: 'phone-rejected', detail: 'HTTP 400' },
      { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } },
    ];
    const engine = await mkEngine({
      runResult: async () => { return responses[spawnCount++]; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.ok(r.tokens);
    assert.equal(spawnCount, 2);
    assert.equal(releaseCount, 1, '只有第一次 phone-rejected 才 release');
  } finally { env.cleanup(); }
});

test('local 3 attempt 全拒 → all-phones-rejected', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'phone-rejected', detail: 'rej' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }, { phone: '+3' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'all-phones-rejected' });
    assert.equal(spawnCount, 3);
    assert.equal(releaseCount, 3);
  } finally { env.cleanup(); }
});
```

- [ ] **Step 2: 跑测试**

```bash
npm test
```

Expected: 总数 209 pass (206 + 新 3)。

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/protocol-phone-verify.test.js
git commit -m "test(protocol): _finalizePhoneVerify 测试 1-3 (local 路径)"
```

---

## Task 23: Node 测试 4-7（池空 / sms-timeout / validate-error / post-validate-error）

**Files:**
- Modify: `server/__tests__/protocol-phone-verify.test.js`

- [ ] **Step 1: 在文件末尾追加 4 个测试**

```js
test('池空 → phonePoolEmpty', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok' }; },
      localQueue: [],  // 拿不到号
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phonePoolEmpty: true });
    assert.equal(spawnCount, 0, '没拿到号不应 spawn');
  } finally { env.cleanup(); }
});

test('sms-timeout 单次 break → release + phoneVerifyFail', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'sms-timeout' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'sms-timeout' });
    assert.equal(spawnCount, 1, 'sms-timeout 不重试');
    assert.equal(releaseCount, 1);
  } finally { env.cleanup(); }
});

test('validate-error 单次 break → release', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'validate-error', detail: 'HTTP 400' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'validate-error' });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 1);
  } finally { env.cleanup(); }
});

test('post-validate-error 单次 break → 不 release (binding 保留)', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'local', maxBindingsPerPhone: 3 } });
  try {
    let spawnCount = 0;
    let releaseCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'post-validate-error', detail: 'token exchange empty' }; },
      localQueue: [{ phone: '+1' }, { phone: '+2' }],
      releaseFn: async () => { releaseCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'post-validate-error' });
    assert.equal(spawnCount, 1);
    assert.equal(releaseCount, 0, '*** 关键: post-validate-error 不 release，binding 保留 ***');
  } finally { env.cleanup(); }
});
```

- [ ] **Step 2: 跑测试**

```bash
npm test
```

Expected: 总数 213 pass。

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/protocol-phone-verify.test.js
git commit -m "test(protocol): _finalizePhoneVerify 测试 4-7"
```

---

## Task 24: Node 测试 8-9（zhusms 路径）

**Files:**
- Modify: `server/__tests__/protocol-phone-verify.test.js`

- [ ] **Step 1: 增加 zhusms mock 支持到 mkEngine**

修改 `mkEngine`：

```js
async function mkEngine(opts) {
  const { ProtocolEngine, __setRunProtocolPhoneVerify } = require('../../protocol-engine');
  __setRunProtocolPhoneVerify(opts.runResult);
  const engine = new ProtocolEngine();
  if (opts.localQueue) {
    let i = 0;
    engine._acquirePhoneForProtocol = async (provider, cfg, email) => {
      if (provider !== 'local') throw new Error('expected local');
      const item = opts.localQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'local', url: 'http://test' },
        releaseFn: opts.releaseFn || (async () => {}),
      };
    };
  }
  if (opts.zhusmsQueue) {
    let i = 0;
    engine._acquirePhoneForProtocol = async (provider) => {
      if (provider !== 'zhusms') throw new Error('expected zhusms');
      const item = opts.zhusmsQueue[i++];
      if (!item) return {};
      return {
        phone: item.phone,
        smsConfig: { provider: 'zhusms', order_no: item.order, base_url: 'https://zhusms.com', card_key: 'k', cookie: 'c' },
        releaseFn: opts.cancelOrderFn || (async () => {}),
      };
    };
  }
  return engine;
}
```

- [ ] **Step 2: 加 zhusms 测试 2 个**

```js
test('zhusms 1 attempt 成功', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'zhusms', maxBindingsPerPhone: 3, zhusms: { cardKey: 'ZS-X' } } });
  try {
    let spawnCount = 0;
    let cancelCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } }; },
      zhusmsQueue: [{ phone: '+9', order: 'o1' }],
      cancelOrderFn: async () => { cancelCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.ok(r.tokens);
    assert.equal(spawnCount, 1);
    assert.equal(cancelCount, 0);
  } finally { env.cleanup(); }
});

test('zhusms 1 拒 + 2 成功 → cancelOrder ×1', async () => {
  const env = setupTestEnv({ phonePool: { enabled: true, provider: 'zhusms', maxBindingsPerPhone: 3, zhusms: { cardKey: 'ZS-X' } } });
  try {
    let spawnCount = 0;
    let cancelCount = 0;
    const responses = [
      { status: 'phone-rejected', detail: 'HTTP 400' },
      { status: 'ok', tokens: { access_token: 'AT', refresh_token: 'RT', id_token: 'ID' } },
    ];
    const engine = await mkEngine({
      runResult: async () => responses[spawnCount++],
      zhusmsQueue: [{ phone: '+1', order: 'o1' }, { phone: '+2', order: 'o2' }],
      cancelOrderFn: async () => { cancelCount++; },
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.ok(r.tokens);
    assert.equal(spawnCount, 2);
    assert.equal(cancelCount, 1);
  } finally { env.cleanup(); }
});
```

- [ ] **Step 3: 跑测试**

```bash
npm test
```

Expected: 总数 215 pass。

- [ ] **Step 4: Commit**

```bash
git add server/__tests__/protocol-phone-verify.test.js
git commit -m "test(protocol): _finalizePhoneVerify 测试 8-9 (zhusms 路径)"
```

---

## Task 25: Node 测试 10（pool-disabled）

**Files:**
- Modify: `server/__tests__/protocol-phone-verify.test.js`

- [ ] **Step 1: 加测试**

```js
test('pool-disabled → phoneVerifyFail=pool-disabled，不调任何 acquire/spawn', async () => {
  const env = setupTestEnv({ phonePool: { enabled: false, provider: 'local' } });
  try {
    let spawnCount = 0;
    const engine = await mkEngine({
      runResult: async () => { spawnCount++; return { status: 'ok' }; },
      localQueue: [{ phone: '+1' }],
    });
    const r = await engine._finalizePhoneVerify({}, { email: 'a@b.c' });
    assert.deepEqual(r, { phoneVerifyFail: 'pool-disabled' });
    assert.equal(spawnCount, 0);
  } finally { env.cleanup(); }
});
```

- [ ] **Step 2: 跑全部测试**

```bash
npm test
```

Expected: **216 pass**（206 + 10 新 Node）。

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/protocol-phone-verify.test.js
git commit -m "test(protocol): _finalizePhoneVerify 测试 10 (pool-disabled)"
```

---

## Task 26: 集成 smoke test（手动 + 写 CHANGELOG）

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 准备未绑手机的真实账号**

参考 Task 0 Step 1 找一个未绑账号。**确保 `config.json` 的 `phonePool.enabled=true` + `provider='local'` + 池里至少 2 个未消耗的号**。

- [ ] **Step 2: 切到协议模式**

UI 上把 protocolMode 打开，重启服务。

- [ ] **Step 3: 跑一次 PKCE**

```bash
curl -s -X POST http://127.0.0.1:3000/api/execute -H "Content-Type: application/json" -d '{"emails":["<account@email>"]}'
```

监控日志（参考 v2.39.4 验证流程）。期望日志序列：

```
[1/1] Login OK, accessToken obtained.
[1/1] Plan: plus
[1/1] Running PKCE for already-Plus account...
PKCE: Phone verification required (...)
[protocol] add-phone (attempt 1/3): +xxxx (provider=local)
[protocol] add-phone OK, tokens obtained
[1/1] xxx → plus
```

- [ ] **Step 4: 验证 cpa-auth 文件含 refresh_token**

```bash
cat cpa-auth/codex-*<account-slug>*.json | python -c "import sys,json; d=json.load(sys.stdin); print('has RT:', bool(d.get('refresh_token')))"
```

Expected: `has RT: True`。

- [ ] **Step 5: 写 CHANGELOG v2.40.0**

在 `docs/CHANGELOG.md` 顶部追加：

```markdown
## v2.40.0 — 2026-05-26

### 协议模式 PKCE add_phone 自动化（与浏览器模式 v2.39.4 等价）

v2.39.4 浏览器模式（PipelineEngine + Playwright）完成 add_phone 自动化
后，协议模式（ProtocolEngine + Python curl_cffi）一直只检测 add_phone
就 fallback 到 plus_no_rt。本次补齐协议模式纯 HTTP add_phone 自动化，
两个模式功能对齐。

**架构**：Node 端 `_finalizePhoneVerify` retry loop 拿号 → spawn
`protocol_phone_verify.py` 单次 attempt HTTP 流程 → 按 5 个 status 分流：

- `ok` → tokens 入袋 → status=plus
- `phone-rejected` (OpenAI 红字拒号) → releaseBinding + 换号重试（最多 3 次）
- `sms-timeout` → release + break
- `validate-error` (OpenAI 拒验证码) → release + break
- `post-validate-error` (validate 通过后续步骤失败) → **保留 binding** + break

**新增**

- **`_pkce_common.py`** 公共 PKCE 函数（get_sentinel_token / _post_with_h1_fallback /
  follow_continue_for_auth_code / exchange_code / rebuild_session / _serialize_cookies）
- **`protocol_phone_verify.py`** 协议模式 add_phone 单次 attempt 脚本
- **`protocol-engine.js`** `_finalizePhoneVerify` retry loop + `_acquirePhoneForProtocol`
  (local + zhusms 并列) + `runProtocolPhoneVerify` spawn helper
- **`docs/superpowers/research/2026-05-26-openai-add-phone-http.md`** Phase 0 抓包报告

**修改**

- **`protocol_register.py`** 3 处 `return {needsPhone: True}` 改为附带 `session_state`
  （含 cookies / device_id / UA / code_verifier 等）；公共代码改用 `_pkce_common`
- **`protocol-engine.js:_finalizePkce`** `needsPhone` 分支不再 fallback plus_no_rt，
  改为调 `_finalizePhoneVerify` 走 add_phone 流程；status 映射跟浏览器侧对齐
  (phone_pool_empty / phone_verify_fail / plus / plus_no_rt)

**测试**

- Python 8 个新单测：`tests/test_protocol_phone_verify.py`
- Node 10 个新单测：`server/__tests__/protocol-phone-verify.test.js`
- 总数 224 pass（v2.39.4 baseline 206 + 18 新）

**不变式**

- 浏览器模式 PipelineEngine + `utils.js` v2.39.4 行为零改动
- 协议模式既有 PKCE 主流程（login OTP / choose-account / oauth/token）零改动
- phone-pool DB schema 零改动；`acquirePhone` / `releaseBinding` 签名零改动
- `zhusms-provider.js` 零改动（Node 端直接调用 takeOrder / cancelOrder / ensureSession）
- `engine.js` / `engine-singleton.js` / `routes/*` 零改动
- 配置 schema 零改动（`phonePool.provider` v2.39.0 已支持）

**Spec / Plan**：`docs/superpowers/specs/2026-05-26-protocol-add-phone-design.md` +
`docs/superpowers/plans/2026-05-26-protocol-add-phone.md`
```

- [ ] **Step 6: Commit**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.40.0 — 协议模式 PKCE add_phone 自动化"
```

- [ ] **Step 7: Merge → master + tag v2.40.0 + push**

```bash
git checkout master
git merge --ff-only dev
git tag -a v2.40.0 -m "v2.40.0 — 协议模式 PKCE add_phone 自动化 (与浏览器 v2.39.4 等价)"
git -c http.postBuffer=524288000 push origin master
git push origin v2.40.0
git checkout dev
```

Expected: `origin/master` 指向当前 HEAD；`v2.40.0` tag 已发布。

---

## 实施完成检查（manual）

- [ ] `docs/superpowers/research/2026-05-26-openai-add-phone-http.md` 已写 + Phase 0 报告完整
- [ ] `_pkce_common.py` 含 6 个函数（get_sentinel_token / _post_with_h1_fallback / follow_continue_for_auth_code / exchange_code / rebuild_session / _serialize_cookies）
- [ ] `protocol_register.py` import `_pkce_common`、3 处 needsPhone 附带 session_state
- [ ] `protocol_phone_verify.py` 完整 5 step 流程 + 5 status 返回值
- [ ] `tests/test_protocol_phone_verify.py` 8 测试 pass
- [ ] `protocol-engine.js` `_finalizePhoneVerify` + `_acquirePhoneForProtocol` + `runProtocolPhoneVerify` + `_finalizePkce` 集成
- [ ] `server/__tests__/protocol-phone-verify.test.js` 10 测试 pass
- [ ] 集成 smoke test 跑通真实账号 → status=plus + cpa-auth 文件含 RT
- [ ] `docs/CHANGELOG.md` v2.40.0 已写
- [ ] master 已 merge + tag v2.40.0 已 push 到 origin
