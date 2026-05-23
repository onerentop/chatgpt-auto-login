# 协议模式注册：SOCKS5 + HTTP/1.1 兜底 + sing-box 升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复"内置代理走 HTTP CONNECT 时 `/api/accounts/create_account` 返回 400 invalid_request"问题。Phase 1（应用层）：curl_cffi 代理协议改 SOCKS5h + 关键 POST 加 HTTP/1.1 fallback。Phase 2（基础设施）：sing-box 1.10.7 → 1.13.12。

**Architecture:** 3 层独立改动。Phase 1 全部在 `protocol_register.py`，新增 module-level helper `_post_with_h1_fallback`，3 处关键 POST（create_account / authorize/continue v2 / email-otp/validate）走它，自动检测 HTTP/2 失败或 400 invalid_r 切到 HTTP/1.1 重试一次。SOCKS5h 替换 HTTP CONNECT 避免 sing-box mixed inbound 的帧 relay 问题。Phase 2 改 `server/proxy/singbox.js` 一行版本号，触发自动下载。

**Tech Stack:** Python 3 + curl_cffi（已有），unittest（标准库），Node.js sing-box wrapper

**Spec:** `docs/superpowers/specs/2026-05-23-protocol-register-proxy-fallback-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `protocol_register.py` | (B) 顶部新增 module-level `HTTP11` 导入；新增 `_post_with_h1_fallback` helper；(A) 3 处关键 POST 调用替换；SOCKS5 转换 | 修改 |
| `tests/test_protocol_register_h1_fallback.py` | mock-based 单元测试（4 case） | 新建 |
| `tests/__init__.py` | 让 `tests/` 成为 Python 包 | 新建（空文件） |
| `server/proxy/singbox.js` | 版本号 `1.10.7 → 1.13.12` | 修改（Phase 2） |
| `bin/sing-box.exe` | 旧二进制 | 删除（Phase 2，触发自动重下载） |

---

# Phase 1 — 应用层修复（A + B）

## Task 1: TDD scaffold `_post_with_h1_fallback` helper + 4 个单元测试

**Files:**
- Create: `tests/__init__.py`
- Create: `tests/test_protocol_register_h1_fallback.py`
- Modify: `protocol_register.py`（顶部加 module-level `HTTP11`；`_RetrySession` 后面加 `_post_with_h1_fallback`）

- [ ] **Step 1: 创建 `tests/__init__.py` 让目录变成 Python 包**

Create empty file `tests/__init__.py`:
```python
```
（内容为空，文件存在即可）

- [ ] **Step 2: 创建测试文件，4 个测试 case（先红）**

Create `tests/test_protocol_register_h1_fallback.py`:

```python
import unittest
from unittest.mock import MagicMock
import sys
import os
import types

# Stub curl_cffi BEFORE importing protocol_register so module-level HTTP11 is set
# to a sentinel object instead of None. Test cases identify HTTP/1.1 retries by
# matching this sentinel in the http_version kwarg.
HTTP11_SENTINEL = 'HTTP11_SENTINEL'
fake_curl_cffi = types.ModuleType('curl_cffi')
fake_curl_cffi.CurlHttpVersion = types.SimpleNamespace(V1_1=HTTP11_SENTINEL)
fake_curl_cffi.requests = types.SimpleNamespace(Session=MagicMock)
sys.modules.setdefault('curl_cffi', fake_curl_cffi)

# Also stub the vendored chatgpt_register package — protocol_register imports
# build_sentinel_token / get_sentinel_token_browser at module load time.
fake_chatgpt_register = types.ModuleType('chatgpt_register')
fake_cr_inner = types.ModuleType('chatgpt_register.chatgpt_register')
fake_cr_inner.build_sentinel_token = lambda *a, **kw: ''
fake_sb_inner = types.ModuleType('chatgpt_register.sentinel_browser')
fake_sb_inner.get_sentinel_token_browser = lambda *a, **kw: ''
sys.modules.setdefault('chatgpt_register', fake_chatgpt_register)
sys.modules.setdefault('chatgpt_register.chatgpt_register', fake_cr_inner)
sys.modules.setdefault('chatgpt_register.sentinel_browser', fake_sb_inner)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import protocol_register
# Silence _log so test output isn't polluted by JSON log lines.
protocol_register._log = lambda msg: None
from protocol_register import _post_with_h1_fallback


class H1FallbackTest(unittest.TestCase):
    def test_h2_success_no_retry(self):
        # HTTP/2 returns 200 → no retry, return as-is
        resp = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)
        self.assertNotIn('http_version', session.post.call_args.kwargs)

    def test_h2_400_invalid_r_retries_h1(self):
        # HTTP/2 returns 400 with 'invalid_r' → retry with HTTP/1.1
        resp_h2 = MagicMock(status_code=400, text='{"error":{"type":"invalid_request"}}')
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [resp_h2, resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), HTTP11_SENTINEL)

    def test_h2_raises_retries_h1(self):
        # HTTP/2 raises TLS/curl exception → retry with HTTP/1.1
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [Exception('curl: TLS error'), resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), HTTP11_SENTINEL)

    def test_h2_400_other_error_no_retry(self):
        # 400 but body doesn't contain 'invalid_r' → no retry, return as-is
        resp = MagicMock(status_code=400, text='{"error":{"type":"too_many_requests"}}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a': 1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: 运行测试看到失败**

Run:
```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `ImportError: cannot import name '_post_with_h1_fallback' from 'protocol_register'`

- [ ] **Step 4: 在 `protocol_register.py` 顶部加 module-level `HTTP11` 导入**

Find this block at the top of `protocol_register.py`:
```python
import sys, os, json, uuid, time, random, re, string, hashlib, base64, secrets, imaplib
import email as email_lib
from urllib.parse import urlparse, parse_qs, urlencode, quote
```

After the `from urllib.parse...` line (around line 8), add:
```python

# HTTP/1.1 constant for HTTP/2 fallback retries (curl_cffi >= 0.5.9). Module-level
# so _post_with_h1_fallback (defined below) and protocol_login can both use it.
# Falls back to None if curl_cffi missing / older version — fallback then no-ops.
try:
    from curl_cffi import CurlHttpVersion
    HTTP11 = CurlHttpVersion.V1_1
except Exception:
    HTTP11 = None
```

- [ ] **Step 5: 删除 `protocol_login` 内部的旧 `HTTP11` 局部声明（去重）**

Find this block inside `protocol_login` (around line 549-557):
```python
        # HTTP/1.1 constant for TLS-retry fallback (curl_cffi >= 0.5.9).
        # Some unstable proxy paths break HTTP/2 framing mid-handshake — falling back
        # to HTTP/1.1 on retry often unblocks the request when the same node would
        # otherwise produce repeated "TLS connect error: invalid library" failures.
        try:
            from curl_cffi import CurlHttpVersion
            HTTP11 = CurlHttpVersion.V1_1
        except Exception:
            HTTP11 = None
```

Delete this entire block (the module-level `HTTP11` added in Step 4 now provides it).

- [ ] **Step 6: 在 `_RetrySession` 类定义之后加 `_post_with_h1_fallback` helper**

Find the end of `_RetrySession` class (around line 88, ends with `raise`). After that line, before `def _generate_password`, insert:

```python

def _post_with_h1_fallback(session, url, *, json=None, headers=None, timeout=30):
    """POST that retries once with HTTP/1.1 on transient HTTP/2 errors or 400
    risk-control responses. Returns the final Response.

    Triggers HTTP/1.1 retry on:
      (1) HTTP/2 raises a TLS/curl exception
      (2) HTTP/2 returns 400 with 'invalid_r' in body (sentinel-token / frame
          corruption marker observed with sing-box mixed inbound, ref:
          SagerNet/sing-box#3945)

    No retry on success or other non-400 status. If HTTP11 sentinel is None
    (older curl_cffi without CurlHttpVersion), no fallback happens — original
    behavior preserved.
    """
    try:
        r = session.post(url, json=json, headers=headers, timeout=timeout)
    except Exception as e:
        if HTTP11 is not None:
            _log(f"POST {url.rsplit('/', 1)[-1]} HTTP/2 raise: {str(e)[:60]} — retry HTTP/1.1")
            return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)
        raise

    if r.status_code == 400 and 'invalid_r' in (r.text or '') and HTTP11 is not None:
        _log(f"POST {url.rsplit('/', 1)[-1]} got 400 invalid_r on HTTP/2 — retry HTTP/1.1")
        return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)

    return r
```

- [ ] **Step 7: 运行测试看到全部通过**

Run:
```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `Ran 4 tests in ...s` `OK` — all 4 tests pass.

- [ ] **Step 8: 验证 Python 语法（防止顶层改动有 typo）**

Run:
```bash
py -3 -c "import ast; ast.parse(open('protocol_register.py', encoding='utf-8').read()); print('SYNTAX OK')"
```
Expected: `SYNTAX OK`

- [ ] **Step 9: Commit**

```bash
git add tests/__init__.py tests/test_protocol_register_h1_fallback.py protocol_register.py
git commit -m "feat(protocol-register): HTTP/1.1 fallback helper for HTTP/2 framing failures

Add _post_with_h1_fallback module-level helper that wraps session.post and
retries once with HTTP/1.1 when (1) HTTP/2 raises a TLS/curl exception or
(2) HTTP/2 returns 400 with 'invalid_r' in the body — both markers of
sing-box mixed inbound corrupting HTTP/2 frames (SagerNet/sing-box#3945).
The retry preserves all request params and headers, only swapping the
transport version. No retry on success or other non-400 status, so the
overhead on the happy path is zero.

Also lift HTTP11 from a protocol_login local to module-level so the helper
can reference it.

Tests: 4 unittest cases mock session.post and assert (1) happy-path no
retry, (2) 400-invalid_r retries with http_version=HTTP11, (3) exception
retries with http_version=HTTP11, (4) 400 with different error body does
not retry."
```

---

## Task 2: B — `proxy_url` 改写为 socks5h

**Files:**
- Modify: `protocol_register.py`（around line 559，紧接 `proxy_url = input_data.get("proxy", "")` 之后）

- [ ] **Step 1: 找到当前代码块**

In `protocol_register.py`, find (around line 559-562):

```python
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        if proxy_url:
            _log(f"Using proxy: {proxy_url}")
```

- [ ] **Step 2: 替换为 socks5h 转换 + 用同样的 _log**

Replace the block above with:

```python
        # Convert http://... → socks5h://... since sing-box's mixed inbound serves
        # both HTTP CONNECT and SOCKS5 on the same port. SOCKS5 has less framing
        # overhead than HTTP CONNECT and avoids HTTP/2-over-CONNECT-tunnel issues
        # with sing-box mixed inbound (SagerNet/sing-box#3945). 'socks5h' offloads
        # DNS to the proxy, matching TUN-mode behavior so hostname and IP origin
        # stay consistent (no IP/DNS mismatch as a risk-control signal).
        if proxy_url and proxy_url.startswith('http://'):
            proxy_url = 'socks5h://' + proxy_url[len('http://'):]
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
        if proxy_url:
            _log(f"Using proxy: {proxy_url}")
```

- [ ] **Step 3: 验证语法**

Run:
```bash
py -3 -c "import ast; ast.parse(open('protocol_register.py', encoding='utf-8').read()); print('SYNTAX OK')"
```
Expected: `SYNTAX OK`

- [ ] **Step 4: 跑单元测试确认没回归**

Run:
```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `OK` — 4 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add protocol_register.py
git commit -m "feat(protocol-register): use socks5h:// instead of http:// for sing-box proxy

sing-box mixed inbound serves both HTTP CONNECT and SOCKS5 on the same
port (peeks first byte to dispatch). SOCKS5 has less framing overhead
than HTTP CONNECT, and avoids the HTTP/2-over-CONNECT-tunnel issues
observed with sing-box's mixed inbound relay layer
(SagerNet/sing-box#3945).

'socks5h' (not 'socks5') offloads DNS resolution to the proxy, matching
TUN-mode behavior. This keeps the request's source IP and DNS resolution
path consistent (both come from the exit node), avoiding an IP/DNS
mismatch that some risk-control systems flag."
```

---

## Task 3: A — 接入 `create_account`

**Files:**
- Modify: `protocol_register.py`（around line 829-830）

- [ ] **Step 1: 找到当前 create_account POST**

In `protocol_register.py`, find (around line 829-830):

```python
                r = session.post(f"{AUTH}/api/accounts/create_account",
                    json={"name": name, "birthdate": bdate}, headers=headers_ca, timeout=30)
```

- [ ] **Step 2: 替换为 `_post_with_h1_fallback`**

Replace with:
```python
                r = _post_with_h1_fallback(session, f"{AUTH}/api/accounts/create_account",
                    json={"name": name, "birthdate": bdate}, headers=headers_ca, timeout=30)
```

- [ ] **Step 3: 语法 + 测试**

Run:
```bash
py -3 -c "import ast; ast.parse(open('protocol_register.py', encoding='utf-8').read()); print('SYNTAX OK')"
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `SYNTAX OK` + `OK`

- [ ] **Step 4: Commit**

```bash
git add protocol_register.py
git commit -m "feat(protocol-register): create_account uses HTTP/1.1 fallback

The most-impacted endpoint — observed user report of 400 invalid_request
on this exact call when going through sing-box mixed inbound HTTP CONNECT,
while TUN mode succeeded. Now retries once with HTTP/1.1 on that signature."
```

---

## Task 4: A — 接入 `authorize/continue` (v2 flow only)

**Files:**
- Modify: `protocol_register.py`（around line 693-697 — v2 流的 Step 3b 邮件提交）

- [ ] **Step 1: 找到当前 authorize/continue v2 POST**

In `protocol_register.py`, find (around line 693-697):

```python
            r = session.post(f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel, "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
```

- [ ] **Step 2: 替换为 `_post_with_h1_fallback`**

Replace with:
```python
            r = _post_with_h1_fallback(session, f"{AUTH}/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": email}},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": final_url, "oai-device-id": device_id,
                    "openai-sentinel-token": sentinel, "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
```

Note: This **only** changes the v2 flow's email-submit call at line 693. **Do not** modify the older PKCE flow's authorize/continue calls (around line 259, 335) — they have different failure semantics and are not in scope for this fix.

- [ ] **Step 3: 语法 + 测试**

Run:
```bash
py -3 -c "import ast; ast.parse(open('protocol_register.py', encoding='utf-8').read()); print('SYNTAX OK')"
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `SYNTAX OK` + `OK`

- [ ] **Step 4: Commit**

```bash
git add protocol_register.py
git commit -m "feat(protocol-register): authorize/continue (v2) uses HTTP/1.1 fallback

Same HTTP/2 framing risk as create_account — sentinel-token validation
on this endpoint can hit 400 invalid_request when frames are corrupted
in the sing-box mixed inbound relay. Only the v2 flow's email-submit
call is changed; PKCE-flow authorize/continue calls remain unchanged."
```

---

## Task 5: A — 接入 `email-otp/validate`

**Files:**
- Modify: `protocol_register.py`（around line 758-763）

- [ ] **Step 1: 找到当前 email-otp/validate POST**

In `protocol_register.py`, find (around line 758-763):

```python
            r = session.post(f"{AUTH}/api/accounts/email-otp/validate",
                json={"code": otp},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
```

- [ ] **Step 2: 替换为 `_post_with_h1_fallback`**

Replace with:
```python
            r = _post_with_h1_fallback(session, f"{AUTH}/api/accounts/email-otp/validate",
                json={"code": otp},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                    "Origin": AUTH, "Referer": f"{AUTH}/email-verification",
                    "oai-device-id": device_id, "openai-sentinel-token": sentinel,
                    "ext-passkey-client-capabilities": "conditional-create,conditional-get"}, timeout=30)
```

- [ ] **Step 3: 语法 + 测试**

Run:
```bash
py -3 -c "import ast; ast.parse(open('protocol_register.py', encoding='utf-8').read()); print('SYNTAX OK')"
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
```
Expected: `SYNTAX OK` + `OK`

- [ ] **Step 4: Commit**

```bash
git add protocol_register.py
git commit -m "feat(protocol-register): email-otp/validate uses HTTP/1.1 fallback

Third and final endpoint where sentinel-token validation runs server-side
and a 400 invalid_request can be returned when HTTP/2 frames are corrupted
through sing-box mixed inbound. Completes the Phase 1 A+B fallback set."
```

---

## Task 6: Phase 1 验证（全量 tests + 重启 server）

**Files:** None (verification only)

- [ ] **Step 1: 跑 Python + JS 全量单元测试**

Run:
```bash
py -3 -m unittest tests.test_protocol_register_h1_fallback -v
node --test __tests__/payment-readiness.test.js server/proxy/__tests__/index.test.js
```
Expected:
- Python: `Ran 4 tests in ...s OK`
- Node: `# pass 17` (readiness 17 — 16 base + 1 args regression) `+` `# pass 11` (proxy) = total 28 passing

- [ ] **Step 2: 杀掉旧 server**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force; "Killed PID $($p.OwningProcess)" }
```

- [ ] **Step 3: 启动新 server（后台）**

Bash:
```bash
cd chatgpt-auto-login
node server/index.js > server.log 2>&1 &
sleep 5
```

- [ ] **Step 4: 确认 server 监听 :3000 + sing-box 启动**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { "OK Server PID=$($p.OwningProcess)" } else { 'Not listening'; Get-Content server.log -Tail 30 }
Get-Content server.log -Tail 15
```
Expected: `OK Server PID=...` + log shows `[Proxy] sing-box running: main=:7890(N) ...`

- [ ] **Step 5: 触发一次协议模式注册做 dry-run（人工执行）**

Through the web dashboard at http://localhost:3000, add or select one account and run the protocol-mode register flow. Observe the server log for:

1. `[Proto] create_account: 200 ...` — should succeed (not 400)
2. If fallback fires, you'll see `[Proto] POST create_account got 400 invalid_r on HTTP/2 — retry HTTP/1.1` followed by a second attempt
3. `[Proto] Using proxy: socks5h://127.0.0.1:7890` — confirms B took effect

If `create_account: 200` happens directly without fallback → ideal (B alone resolved it).
If fallback fires and second attempt succeeds → A's safety net working as intended.
If still 400 after fallback → escalate to user; Phase 2 (sing-box upgrade) may be needed.

This is a verification-only task — no commit needed.

---

# Phase 2 — sing-box 升级（C）

## Task 7: 升级 `SINGBOX_VERSION` 到 1.13.12

**Files:**
- Modify: `server/proxy/singbox.js:13`
- Delete: `bin/sing-box.exe`（触发自动重下载）

- [ ] **Step 1: 改 SINGBOX_VERSION**

In `server/proxy/singbox.js`, find line 13:
```js
const SINGBOX_VERSION = '1.10.7';
```

Change to:
```js
const SINGBOX_VERSION = '1.13.12';
```

- [ ] **Step 2: 删除旧二进制（让 ensureBinary 自动下载新版）**

Bash:
```bash
cd chatgpt-auto-login
rm -f bin/sing-box.exe
ls bin/ 2>&1 || echo "bin dir is empty or absent (will be recreated on next start)"
```

- [ ] **Step 3: 杀掉旧 server**

PowerShell:
```powershell
$p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($p) { Stop-Process -Id $p.OwningProcess -Force; "Killed PID $($p.OwningProcess)" }
```

- [ ] **Step 4: 启动 server，观察下载过程**

Bash:
```bash
cd chatgpt-auto-login
node server/index.js > server.log 2>&1 &
sleep 15   # download + extract takes ~10s on a normal connection
```

- [ ] **Step 5: 确认下载成功 + sing-box 启动**

PowerShell:
```powershell
Get-Content 'E:\workspace\projects\demo\chatgpt-auto-login\server.log' -Tail 30
```
Expected: log contains
- `[sing-box] Downloading https://github.com/SagerNet/sing-box/releases/download/v1.13.12/sing-box-1.13.12-windows-amd64.zip ...`
- `[sing-box] Ready at ...sing-box.exe`
- `[Proxy] sing-box running: main=:7890(N) jp=:7891(M)`

Verify the binary version:
```bash
./bin/sing-box.exe version
```
Expected: `sing-box version 1.13.12`

- [ ] **Step 6: Commit**

```bash
git add server/proxy/singbox.js
git commit -m "chore(proxy): bump sing-box 1.10.7 → 1.13.12

1.13.x series addresses mixed inbound relay-layer issues (ref:
SagerNet/sing-box#3945, milestone 1.13). 1.13.12 is the latest stable
release at the time of this change (2026-05-15).

Migration: ensureBinary auto-downloads the new version when bin/sing-box.exe
is absent. Existing buildSingboxConfig uses only stable fields (mixed
inbound, selector outbound, experimental.clash_api) — no config changes
needed. Old-style outbound 'sniff: true' is still backward-compatible
in 1.13 (emits deprecation warning, harmless).

Rollback: set SINGBOX_VERSION back to '1.10.7', delete bin/sing-box.exe,
restart server."
```

---

## Task 8: Phase 2 验证（节点握手 + dry-run）

**Files:** None (verification only)

- [ ] **Step 1: 验证节点正常握手**

After Task 7 Step 5, the log should already show `main=:7890(N)` where N is the US node count. Additionally check:

PowerShell:
```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/api/proxy/status' | ConvertTo-Json -Depth 4
```
Expected JSON shows `enabled: true`, `available: N` (N matches subscription's US node count), `currentNode: <some tag>`.

- [ ] **Step 2: 触发一次协议模式注册做 dry-run**

Through web dashboard, run one account through protocol-mode register. Watch server log for:
- No new errors compared to Phase 1
- `create_account: 200` (Phase 1's A+B fallback may still occasionally fire — that's fine)
- Account reaches `plus_no_rt` or `plus` final status

If VLESS-Reality node handshake fails (look for `tls handshake failed` or `connection reset` in sing-box stderr), **roll back**:

```bash
# Rollback procedure
git revert HEAD --no-edit   # revert Task 7 commit
rm -f bin/sing-box.exe
# kill server, restart
```

- [ ] **Step 3: Commit rollback (only if rollback was needed)**

This step is conditional. Skip if Task 7 verified successfully.

```bash
git push origin dev   # only if rolling back, otherwise leave for batch push later
```

This task has no code commit of its own — it's a verification checkpoint.

---

## 完成判定

**Phase 1 (Tasks 1-6):**
- ✅ 4 个 Python 单元测试 pass
- ✅ Node tests 全 pass（无回归）
- ✅ Python 语法 OK
- ✅ Server 在 :3000 监听，sing-box 启动正常
- ✅ Dry-run 协议模式注册无 400 invalid_request（或触发 fallback 后第二次成功）
- ✅ 日志显示 `Using proxy: socks5h://...`

**Phase 2 (Tasks 7-8):**
- ✅ `bin/sing-box.exe version` 显示 1.13.12
- ✅ 节点握手成功 + selector 切换正常
- ✅ Dry-run 完整流程通过

---

## Self-Review Checklist（写完后已自审）

**Spec 覆盖：**
- §4.1 SOCKS5 转换 → Task 2 ✓
- §4.2 `_post_with_h1_fallback` helper → Task 1 ✓
- §4.3 3 个接入点 → Tasks 3, 4, 5 ✓
- §4.4 4 个单元测试 → Task 1 Step 2 ✓
- §5 sing-box 升级 → Task 7 ✓
- §6 错误处理（不静默吞错、日志可观测）→ helper 实现已含 ✓
- §7 测试策略 → Tasks 1, 6, 8 ✓
- §9 完成判据 → 文档底部 ✓
- §10 非目标（不接入 PKCE 旧流）→ Task 4 Step 2 注释明示 ✓

**Placeholder 扫描：** 无 TBD / TODO；所有代码块完整；所有命令含 expected output。

**类型/方法一致性：** `_post_with_h1_fallback(session, url, *, json=None, headers=None, timeout=30)` 签名 + `HTTP11` 引用方式贯穿 Tasks 1, 3, 4, 5；`HTTP11_SENTINEL` 字符串在测试 fixtures 与断言中一致。
