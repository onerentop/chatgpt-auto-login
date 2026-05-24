# Deactivated 检测增强 + 搜索 UX 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v2.29.0 — 让测活独立识别 OpenAI 封号账号（Case 1 = 200 + is_deactivated；Case 2 = 401 + 轻量级登录验证），并把子进程运行时日志（每个 attempt、每个 Step）实时流到 UI 折叠面板；同时把 Accounts 页搜索/筛选改 multi-select、搜索字段拓展、加未测试快捷与一键重置。

**Architecture:** Part A 后端：`checker.mapPlanType` 加 `deactivated` 分支；新 `chatgpt_register/deactivated_check.py` 跑 `protocol_register.py` Step 0-2 副本，只看 `account_deactivated` 标记不要 OTP；`checker.verifyDeactivated` spawn 封装；runner.dispatchOne 在 probe 返 `token_expired` 后跑 verifyDeactivated；onLog 回调把 Python `{"log":...}` 转 `io.emit('liveness-log', {email, level, message})`。Part B 前端：`socket.js` 监听 `liveness-log`，pushLivenessLog 加 `source:'liveness'` 字段；`Accounts.vue` 状态/活性改 multi-select，搜索匹配 5 字段，新增"仅看未测试"/"7 天未测"/"重置筛选"按钮。

**Tech Stack:** Python curl_cffi、Node child_process.spawn、Vue 3 + Element Plus、`node:test`、socket.io。

**Spec:** `docs/superpowers/specs/2026-05-24-deactivated-detection-and-search-ux-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `chatgpt_register/deactivated_check.py` | 新建：Step 0-2 副本 + deactivated 标记扫描 + JSON-lines 协议 | 新建 |
| `server/liveness/checker.js` | mapPlanType 加 `'deactivated'` 分支；新 `verifyDeactivated`；`probe` 引入 `onLog` 回调替代 `console.log(p.log)`；export verifyDeactivated | 修改 |
| `server/liveness/runner.js` | dispatchOne 在 token_expired 后调 verifyDeactivated；构造 onLog 闭包 emit `liveness-log`；onLog 注入 probe + verifyDeactivated | 修改 |
| `server/liveness/__tests__/checker.test.js` | +2 测试（mapPlanType deactivated + mapTerminal deactivated） | 修改 |
| `server/liveness/__tests__/verify-deactivated.test.js` | 新建：5 测试（deactivated / active / error / timeout / ENOENT） | 新建 |
| `server/liveness/__tests__/runner.test.js` | +2 测试（probe token_expired + verifyDeactivated deactivated 路径；+ verifyDeactivated active 路径） | 修改 |
| `web/src/socket.js` | `pushLivenessLog` 加 `source:'liveness'` 字段；新 `socket.on('liveness-log')` handler | 修改 |
| `web/src/views/Accounts.vue` | 状态/活性 multi；搜索 5 字段；快捷 + 重置；`livenessLogs` 改按 `source` 过滤 | 修改 |
| `docs/CHANGELOG.md` | v2.29.0 节 | 修改 |

依赖：Task 1 → Task 2 串行（Task 2 测试 Task 1 emit 的事件）。Task 3 是 smoke + CHANGELOG 兜底。

---

## Task 1: 后端 Part A（deactivated 检测 + 实时日志后端）

**Files:**
- Create: `chatgpt_register/deactivated_check.py`
- Create: `server/liveness/__tests__/verify-deactivated.test.js`
- Modify: `server/liveness/checker.js`
- Modify: `server/liveness/runner.js`
- Modify: `server/liveness/__tests__/checker.test.js`
- Modify: `server/liveness/__tests__/runner.test.js`

### Step 1: 创建 `chatgpt_register/deactivated_check.py`

```python
#!/usr/bin/env python3
"""Verify whether an OpenAI account is deactivated, without going through OTP.

Spawned by server/liveness/checker.js whenever probe returns token_expired and
the caller wants to confirm "account banned" vs "token expired but account alive".
Runs protocol_register.py Step 0 (homepage) + Step 1 (signin) + Step 2 (authorize)
only, then scans the authorize-page HTML for account_deactivated / account_disabled
markers — same logic protocol_register.py:711 already uses for the full registration
path. No OTP, no SMS, no PKCE. Total wall time 5-10s per account.

Input (stdin JSON):
   { email, client_id, refresh_token, proxy_url, impersonate? }
   (client_id / refresh_token are Outlook IMAP OAuth creds; they only matter if
   Step 2 redirects to /email-verification — but we never get there in this script,
   so they're effectively unused. Kept in the input shape for symmetry with
   protocol_register.py.)

Output (JSON-lines stdout):
   {"log": "  [Deactivated] Step X: ..."}                                   (streaming)
   {"status": "deactivated", "reason": "account_deactivated"}                (terminal)
   {"status": "active",      "reason": null}                                 (terminal)
   {"status": "error",       "reason": "<msg>"}                              (terminal)

NB: Module-level imports must NOT print to stdout. curl_cffi import is safe.
"""
import sys, json, uuid, time, random
from curl_cffi import requests as curl_requests
from urllib.parse import urlparse

CHROME_POOL = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
USER_AGENTS = {
    'chrome146': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36', '"Chromium";v="146"'),
    'chrome142': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', '"Chromium";v="142"'),
    'chrome136': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36', '"Chromium";v="136"'),
    'chrome133a': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36', '"Chromium";v="133"'),
    'chrome131': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', '"Chromium";v="131"'),
    'chrome124': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', '"Chromium";v="124"'),
}

BASE = "https://chatgpt.com"


def _log(msg):
    print(json.dumps({"log": f"  [Deactivated] {msg}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _build_session(impersonate, proxies):
    ua, sec_ch_ua = USER_AGENTS.get(impersonate, USER_AGENTS['chrome131'])
    session = curl_requests.Session(impersonate=impersonate)
    if proxies:
        session.proxies = proxies
    session.headers.update({
        "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": sec_ch_ua, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    })
    device_id = str(uuid.uuid4())
    for d in ("chatgpt.com", "auth.openai.com", ".auth.openai.com"):
        session.cookies.set("oai-did", device_id, domain=d)
    return session, device_id


def _step0_homepage(session):
    """Visit BASE/, retry on TLS failures up to 5 times. Returns True on 200."""
    for attempt in range(5):
        try:
            r = session.get(f"{BASE}/",
                headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1"},
                allow_redirects=True, timeout=15)
            if r.status_code == 200:
                return True
            _log(f"Homepage status {r.status_code} attempt {attempt+1}/5")
        except Exception as e:
            _log(f"Homepage exception attempt {attempt+1}/5: {str(e)[:60]}")
        time.sleep(1.5 * (attempt + 1))
    return False


def _step1_signin(session, email, device_id):
    """CSRF + signin/openai. Returns auth_url or '' on failure."""
    r = session.get(f"{BASE}/api/auth/csrf", headers={"Accept": "application/json"}, timeout=10)
    csrf = (r.json() or {}).get("csrfToken", "")
    if not csrf:
        return ""
    time.sleep(random.uniform(0.3, 0.7))
    signin_params = {
        "prompt": "login", "ext-oai-did": device_id,
        "auth_session_logging_id": str(uuid.uuid4()),
        "screen_hint": "login_or_signup", "login_hint": email,
    }
    r = session.post(f"{BASE}/api/auth/signin/openai", params=signin_params,
        data={"callbackUrl": f"{BASE}/", "csrfToken": csrf, "json": "true"},
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        timeout=15)
    return (r.json() or {}).get("url", "")


def _step2_authorize_and_classify(session, auth_url):
    """GET auth_url, scan response body for deactivated markers.
    Returns: 'deactivated' | 'active' | 'error'."""
    try:
        r = session.get(auth_url,
            headers={"Accept": "text/html", "Upgrade-Insecure-Requests": "1", "Referer": f"{BASE}/"},
            allow_redirects=True, timeout=20)
    except Exception as e:
        _log(f"Authorize exception: {str(e)[:60]}")
        return 'error'

    page_html = r.text or ""
    if "account_deactivated" in page_html or "account_disabled" in page_html:
        _log("Account deactivated/deleted detected on authorize page")
        return 'deactivated'

    final_path = urlparse(str(r.url)).path
    _log(f"Authorize -> {final_path} (not deactivated)")
    return 'active'


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": f"stdin parse: {str(e)[:60]}"})
        return

    email = inp.get('email', '')
    proxy_url = inp.get('proxy_url') or None
    impersonate = inp.get('impersonate', 'chrome131')

    if not email:
        _emit({"status": "error", "reason": "no email"})
        return

    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None
    session, device_id = _build_session(impersonate, proxies)
    _log(f"Profile: {impersonate}, Device: {device_id[:8]}..., proxy={'on' if proxy_url else 'off'}")

    _log("Step 0: Homepage...")
    if not _step0_homepage(session):
        _emit({"status": "error", "reason": "homepage failed"})
        return
    time.sleep(random.uniform(0.4, 0.9))

    _log("Step 1: CSRF + Signin...")
    auth_url = _step1_signin(session, email, device_id)
    if not auth_url:
        _emit({"status": "error", "reason": "signin failed"})
        return
    time.sleep(random.uniform(0.4, 0.9))

    _log("Step 2: Authorize...")
    verdict = _step2_authorize_and_classify(session, auth_url)
    if verdict == 'deactivated':
        _emit({"status": "deactivated", "reason": "account_deactivated"})
    elif verdict == 'active':
        _emit({"status": "active", "reason": None})
    else:
        _emit({"status": "error", "reason": "authorize step failed"})


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Smoke the new script standalone**

Run:

```bash
echo "{\"email\":\"nonexistent@example.com\",\"proxy_url\":\"http://127.0.0.1:7890\"}" | py -3 chatgpt_register/deactivated_check.py
```

Expected output: 2-4 JSON lines, terminal status one of `active` (signin somehow proceeded), `error` (most likely — no such account / Cloudflare), or `deactivated`. The actual verdict doesn't matter — we're verifying the script doesn't blow up importing curl_cffi and the JSON-lines protocol works.

If `ModuleNotFoundError: curl_cffi`, install: `pip install curl_cffi`. If stdout contains anything before `{"log":...}`, fix the offending print.

- [ ] **Step 3: Modify `server/liveness/checker.js` — mapPlanType deactivated branch**

Find `function mapPlanType(planType)` (around line 33). Replace the function body:

```js
function mapPlanType(planType) {
  if (planType === 'plus') return { alive_status: 'plus', alive_reason: 'check ok' };
  if (planType === 'free') return { alive_status: 'canceled', alive_reason: 'no plus' };
  if (planType === 'deactivated') return { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
  return { alive_status: 'canceled', alive_reason: `plan: ${planType}` };
}
```

- [ ] **Step 4: Modify `server/liveness/checker.js` — probe `onLog` callback**

Find the `py.stdout.on('data', ...)` block inside `probe()` (around line 103-113). Replace `console.log(p.log)` with the onLog hook:

```js
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) {
            if (opts.onLog) opts.onLog('info', p.log);
            else console.log(p.log);
          } else stdoutLast = line;
        } catch {
          stdoutLast = line;
        }
      }
    });
```

(`opts` is already destructured at the top of `probe()` from `opts = {}`; we keep `opts` accessible to read `opts.onLog`. If the existing code unconditionally destructures `const { signal, spawnImpl, proxyUrl } = opts;` — keep that line but also let `opts.onLog` be read later. The destructure does not prevent reading other keys directly from the original opts variable.)

- [ ] **Step 5: Add `verifyDeactivated` to `server/liveness/checker.js`**

Append before `module.exports`:

```js
const VERIFY_DEACTIVATED_SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'deactivated_check.py');
const VERIFY_DEACTIVATED_TIMEOUT_MS = 14_000;  // 12s wall + 2s startup grace

async function verifyDeactivated(account, opts = {}) {
  const { signal, spawnImpl, proxyUrl, onLog } = opts;
  const doSpawn = spawnImpl || ((cmd, args, options) => spawn(cmd, args, options));
  const effectiveProxy = (proxyUrl !== undefined) ? proxyUrl : getProxyUrl();

  return new Promise((resolve) => {
    let settled = false;
    let stdoutLast = '';
    let stderrBuf = '';
    const py = doSpawn('py', ['-3', VERIFY_DEACTIVATED_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { py.kill(); } catch {}
      resolve({ status: 'error', reason: 'verifyDeactivated timeout' });
    }, VERIFY_DEACTIVATED_TIMEOUT_MS);

    if (signal) signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { py.kill(); } catch {}
      resolve({ status: 'error', reason: 'aborted' });
    }, { once: true });

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) {
            if (onLog) onLog('info', p.log);
            else console.log(p.log);
          } else stdoutLast = line;
        } catch {
          stdoutLast = line;
        }
      }
    });
    py.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    py.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 'error', reason: `spawn error: ${(e.code || e.message || '').toString().slice(0, 40)}` });
    });

    py.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdoutLast); }
      catch {
        resolve({ status: 'error', reason: `unparsable: ${stderrBuf.slice(-60).trim()}` });
        return;
      }
      resolve(parsed);
    });

    const stdinPayload = JSON.stringify({
      email: account.email,
      client_id: account.client_id || '',
      refresh_token: account.refresh_token || '',
      proxy_url: effectiveProxy || null,
    });
    try { py.stdin.write(stdinPayload); py.stdin.end(); } catch {}
  });
}
```

Update the `module.exports` line at the bottom of the file:

```js
module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType, mapTerminal, verifyDeactivated };
```

- [ ] **Step 6: Modify `server/liveness/runner.js` — emit `liveness-log` + verifyDeactivated integration**

In `dispatchOne(email)`, find the existing line (around line 53):

```js
      if (tok) probeRes = await checker.probe(tok, { signal: state.abortCtrl.signal });
```

Replace from there through the start of the `if (needsRelogin)` block (line 56) with:

```js
      // Stream every Python {"log": "..."} line to the UI panel as a real-time
      // socket event. Each liveness check spawns up to two Python subprocesses
      // (probe + verifyDeactivated), both feed through the same callback so
      // the user sees the full progression: chrome impersonate attempts,
      // HTTP 200/401, Step 0/1/2, deactivated detection.
      const onLog = (level, message) => {
        io.emit('liveness-log', { email, level: level || 'info', message });
      };

      if (tok) probeRes = await checker.probe(tok, { signal: state.abortCtrl.signal, onLog });

      // Case 2 deactivated detection: when probe returns token_expired, spawn a
      // lightweight Step 0-2 signin (no OTP) to discriminate "token genuinely
      // expired" from "OpenAI revoked the token because they banned the account".
      // verifyDeactivated network errors do NOT override the probe verdict —
      // we stay with token_expired in that case.
      if (probeRes && probeRes.alive_status === 'token_expired') {
        const verifyRes = await checker.verifyDeactivated(account, { signal: state.abortCtrl.signal, onLog });
        if (verifyRes.status === 'deactivated') {
          probeRes = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
        }
        // verifyRes.status === 'active' → keep probeRes as token_expired
        // verifyRes.status === 'error'  → keep probeRes as token_expired
      }

      const needsRelogin = !tok || (probeRes && probeRes.alive_status === 'token_expired');
```

Also find the second `await checker.probe(...)` call (around line 67, after lightLogin) and add `onLog`:

```js
          probeRes = await checker.probe(fresh.accessToken, { signal: state.abortCtrl.signal, onLog });
```

- [ ] **Step 7: Modify `server/liveness/__tests__/checker.test.js` — +2 deactivated tests**

Locate the existing `mapPlanType: team/enterprise → canceled` test and add IMMEDIATELY AFTER it:

```js
test('mapPlanType: deactivated → alive_status=deactivated', () => {
  assert.deepStrictEqual(mapPlanType('deactivated'), { alive_status: 'deactivated', alive_reason: 'account_deactivated' });
});

test('mapTerminal: ok 200 + plan_type=deactivated → alive_status=deactivated', () => {
  const r = mapTerminal({ status: 'ok', http: 200, plan_type: 'deactivated', reason: null });
  assert.strictEqual(r.alive_status, 'deactivated');
});
```

- [ ] **Step 8: Create `server/liveness/__tests__/verify-deactivated.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { verifyDeactivated } = require('../checker');

function fakeChild({ stdoutLines = [], stderr = '', errorEvent = null }) {
  const cp = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.stdin = {
    write: () => {},
    end: () => {
      if (errorEvent) {
        setImmediate(() => cp.emit('error', errorEvent));
        return;
      }
      setImmediate(() => {
        for (const line of stdoutLines) cp.stdout.emit('data', Buffer.from(line + '\n'));
        if (stderr) cp.stderr.emit('data', Buffer.from(stderr));
        cp.emit('close');
      });
    },
  };
  cp.kill = () => {};
  return cp;
}

function fakeSpawn(opts) {
  return () => fakeChild(opts);
}

const account = { email: 'a@x.com', client_id: 'c', refresh_token: 'r' };

test('verifyDeactivated: stdout deactivated → status deactivated', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"deactivated","reason":"account_deactivated"}'] }),
  });
  assert.strictEqual(r.status, 'deactivated');
  assert.strictEqual(r.reason, 'account_deactivated');
});

test('verifyDeactivated: stdout active → status active', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"active","reason":null}'] }),
  });
  assert.strictEqual(r.status, 'active');
});

test('verifyDeactivated: stdout error → status error', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","reason":"homepage failed"}'] }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /homepage failed/);
});

test('verifyDeactivated: spawn ENOENT → status error spawn error', async () => {
  const err = new Error('spawn py ENOENT'); err.code = 'ENOENT';
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ errorEvent: err }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /spawn error/);
});

test('verifyDeactivated: stdout unparsable → status error unparsable', async () => {
  const r = await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({ stdoutLines: ['not json'], stderr: 'Traceback no curl_cffi' }),
  });
  assert.strictEqual(r.status, 'error');
  assert.match(r.reason, /unparsable/);
});

test('verifyDeactivated: onLog callback forwards Python {"log": ...} lines', async () => {
  const logs = [];
  await verifyDeactivated(account, {
    spawnImpl: fakeSpawn({
      stdoutLines: [
        '{"log":"  [Deactivated] Step 0: Homepage..."}',
        '{"log":"  [Deactivated] Step 2: Authorize -> /email-verification (not deactivated)"}',
        '{"status":"active","reason":null}',
      ],
    }),
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  assert.strictEqual(logs.length, 2);
  assert.strictEqual(logs[0].level, 'info');
  assert.match(logs[0].msg, /Step 0: Homepage/);
  assert.match(logs[1].msg, /Step 2: Authorize/);
});
```

- [ ] **Step 9: Modify `server/liveness/__tests__/runner.test.js` — +2 verifyDeactivated integration tests**

At the bottom of the file, append:

```js
test('runner: probe token_expired + verifyDeactivated deactivated → terminal deactivated', async () => {
  const env = mkEnv({
    accounts: [{ email: 'banned@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'deactivated', reason: 'account_deactivated' }),
    },
    codexFile: { read: async () => ({ access_token: 'eyJ.dead.tok' }), write: async () => {} },
  });
  const runner = createRunner(env);
  runner.start(['banned@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  const dbCall = env.dbCalls.find(c => c.email === 'banned@x.com' && c.alive_status !== 'checking');
  assert.ok(dbCall, 'terminal setAlive call exists');
  assert.strictEqual(dbCall.alive_status, 'deactivated');
});

test('runner: probe token_expired + verifyDeactivated active → falls through to lightLogin', async () => {
  let lightLoginCalls = 0;
  const env = mkEnv({
    accounts: [{ email: 'maybe@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'token_expired', alive_reason: 'check 401' }),
      verifyDeactivated: async () => ({ status: 'active', reason: null }),
    },
    codexFile: { read: async () => ({ access_token: 'eyJ.expired.tok' }), write: async () => {} },
    lightLogin: async () => { lightLoginCalls++; throw new Error('liveness not yet supported in protocol mode'); },
  });
  const runner = createRunner(env);
  runner.start(['maybe@x.com']);
  await new Promise(r => setTimeout(r, 2000));
  assert.strictEqual(lightLoginCalls, 1, 'lightLogin was attempted after verifyDeactivated=active');
  const dbCall = env.dbCalls.find(c => c.email === 'maybe@x.com' && c.alive_status !== 'checking');
  // Per existing v2.28 hotfix 1aead83: token_expired is preserved when light-login is the protocol-mode stub
  assert.strictEqual(dbCall.alive_status, 'token_expired');
});
```

Also update the existing `mkEnv` helper (in the same file) — find where the `checker` default is defined, and add `verifyDeactivated` to it so older tests don't break:

```js
    checker: opts.checker || {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'mock not configured' }),
    },
```

- [ ] **Step 10: Run new tests**

Run:

```bash
node --test server/liveness/__tests__/checker.test.js server/liveness/__tests__/verify-deactivated.test.js server/liveness/__tests__/runner.test.js
```

Expected: all pass. Specifically:
- checker.test.js: 16 (was 14, +2 mapPlanType/mapTerminal deactivated)
- verify-deactivated.test.js: 6 (5 spawn outcomes + 1 onLog forwarding)
- runner.test.js: 10 (was 8, +2 verifyDeactivated integration)

If a test fails with `checker.verifyDeactivated is not a function`, you forgot to export it from checker.js (Step 5).

- [ ] **Step 11: Run full regression**

Run:

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: **158** tests pass (149 baseline + 2 checker + 6 verify-deactivated + 2 runner − 1 if any existing test changes count = 158 ± 1).

- [ ] **Step 12: Manual integration smoke — one Case 2 account**

Pick a known-deactivated account from DB (e.g. SeanRamirez9038 if you've followed the v2.28 hotfix chain). Trigger it via API:

```bash
curl -X POST http://localhost:3000/api/liveness/start -H 'Content-Type: application/json' -d '{"emails":["SeanRamirez9038@outlook.com"]}'
```

Watch server log for the new `[Deactivated] Step 0/1/2` lines. After ~10s check DB:

```bash
node -e "const{initDB,statusDB}=require('./server/db');initDB().then(()=>{const r=statusDB.get('SeanRamirez9038@outlook.com');console.log(r.alive_status,r.alive_reason)})"
```

Expected: `deactivated account_deactivated` — but reached via verifyDeactivated, not just the v2.28 hotfix `3f9c437` DB-status override. To prove that, you can temporarily reset the DB row's `status` to `idle` before retesting:

```bash
node -e "const{initDB,statusDB}=require('./server/db');initDB().then(()=>{statusDB.set('SeanRamirez9038@outlook.com',{status:'idle'})})"
```

Then re-run the liveness API. The `3f9c437` override won't fire (status='idle'); only Task 1's verifyDeactivated path can produce `alive_status='deactivated'`.

- [ ] **Step 13: Commit**

```bash
git add chatgpt_register/deactivated_check.py server/liveness/checker.js server/liveness/runner.js server/liveness/__tests__/checker.test.js server/liveness/__tests__/verify-deactivated.test.js server/liveness/__tests__/runner.test.js
git commit -m "feat(liveness): deactivated detection (Case 1 mapPlanType + Case 2 verifyDeactivated) + onLog hook

Two paths for surfacing an OpenAI-banned account independently of
whether the execution pipeline ran first:

Case 1 (token still valid, account banned): /accounts/check returns
HTTP 200 with body.accounts.<UUID>.account.is_deactivated=true.
v2.28 already had the Python side mapping that to plan_type=
'deactivated', but Node mapPlanType fell through to the canceled
default. Add an explicit branch -> alive_status='deactivated'.

Case 2 (token revoked, account banned): /accounts/check returns
HTTP 401 — indistinguishable from a routine token expiry. New
chatgpt_register/deactivated_check.py runs the first three steps
of protocol_register.py (homepage + signin + authorize), reusing
the same logic protocol_register.py:711 already uses to detect
account_deactivated / account_disabled markers in the authorize
response. No OTP, no SMS — 5-10s per account.

Runner spawns verifyDeactivated whenever probe returns
token_expired, before falling through to lightLogin. Active accounts
keep flowing into the existing lightLogin path; deactivated accounts
short-circuit immediately with the correct verdict.

Verifying the Case 2 path independently of the v2.28 hotfix 3f9c437
DB-status fallback is tricky because the fallback also produces
alive_status='deactivated'. The runner.test.js coverage uses the
spawnImpl injection to assert that verifyDeactivated.deactivated
DOES produce that terminal status, separately from any DB write.

Real-time logging: runner constructs an onLog(level, message)
closure that emits 'liveness-log' socket events. Both probe and
verifyDeactivated accept opts.onLog and forward every Python
{\"log\": \"...\"} line. The Python script names line up
([Liveness] from liveness_probe.py, [Deactivated] from the new
script) so the panel filter on the frontend can still tell them
apart.

158 tests pass: 16 checker (+2 deactivated mapping) + 6
verify-deactivated (new) + 10 runner (+2 verifyDeactivated
integration) + 124 elsewhere unchanged."
```

---

## Task 2: 前端 Part A.3（socket.js liveness-log handler）+ Part B（搜索 UX）

**Files:**
- Modify: `web/src/socket.js`
- Modify: `web/src/views/Accounts.vue`

### Step 1: Modify `web/src/socket.js` — pushLivenessLog source field + liveness-log handler

Find `function pushLivenessLog(...)` (added in v2.28 `ed1100e`). Replace its body:

```js
  function pushLivenessLog(email, level, message) {
    const prefixed = message?.startsWith('[') ? message : `[liveness] ${message}`;
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: email || '',
      level,
      message: prefixed,
      source: 'liveness',
    });
    if (socketState.logs.length > 500) {
      socketState.logs.splice(0, socketState.logs.length - 500);
    }
  }
```

Add IMMEDIATELY AFTER the existing `socket.on('liveness-complete', ...)` block:

```js
  socket.on('liveness-log', (data) => {
    pushLivenessLog(data.email, data.level || 'info', data.message);
  });
```

### Step 2: Modify `web/src/views/Accounts.vue` — livenessLogs filter by source

Find `const livenessLogs = computed(...)`. Replace the body:

```js
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.source === 'liveness').slice(-200)
)
```

### Step 3: Modify `web/src/views/Accounts.vue` — status & alive filters multi-select

Find `const statusFilter = ref('')` and `const aliveFilter = ref('')` (~line 119 and 172). Replace both:

```js
const statusFilter = ref([])
// ...
const aliveFilter = ref([])
```

Find the `<el-select v-model="statusFilter" ...>` template block (~line 13-25). Replace with:

```vue
        <el-select v-model="statusFilter" placeholder="状态" clearable multiple collapse-tags collapse-tags-tooltip style="width:180px;margin-left:8px">
          <el-option label="Plus(有RT)" value="plus" />
          <el-option label="Plus(无RT)" value="plus_no_rt" />
          <el-option label="错误" value="error" />
          <el-option label="已删除" value="deactivated" />
          <el-option label="无链接" value="no_link" />
          <el-option label="空闲" value="idle" />
          <el-option label="运行中" value="running" />
          <el-option label="已停止" value="aborted" />
          <el-option label="JP节点不可用" value="no_jp_proxy" />
          <el-option label="无0元资格" value="no_promo" />
          <el-option label="Stripe验证失败" value="verify_error" />
        </el-select>
```

Find the `<el-select v-model="aliveFilter" ...>` template (in the toolbar near the 测活 buttons). Replace with:

```vue
        <el-select v-model="aliveFilter" placeholder="活性" clearable multiple collapse-tags collapse-tags-tooltip size="small" style="width:180px;margin-left:8px">
          <el-option v-for="o in aliveFilterOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
```

### Step 4: Modify `Accounts.vue` filteredAccounts computed — multi + extended search

Find the `const filteredAccounts = computed(...)` block (~line 122-137). Replace the body:

```js
const filteredAccounts = computed(() => {
  const q = search.value.toLowerCase()
  return accounts.value.filter(a => {
    if (q) {
      const haystack = [a.email, a.refresh_token, a.client_id, a.totp_secret, a.password]
        .map(s => (s || '').toLowerCase()).join(' ')
      if (!haystack.includes(q)) return false
    }
    if (a._status === 'running') return true
    if (statusFilter.value.length && !statusFilter.value.includes(a._status)) return false
    if (planFilter.value) {
      if (planFilter.value === 'unknown' && a._plan) return false
      if (planFilter.value !== 'unknown' && a._plan !== planFilter.value) return false
    }
    if (authFilter.value === 'yes' && !a._hasAuth) return false
    if (authFilter.value === 'no' && a._hasAuth) return false
    if (aliveFilter.value.length && !aliveFilter.value.includes(a._aliveStatus || 'unknown')) return false
    if (staleOnly.value) {
      const cutoff = Date.now() - 7 * 86400_000
      const checkedAt = a._aliveCheckedAt ? Date.parse(a._aliveCheckedAt) : 0
      if (checkedAt && checkedAt > cutoff) return false  // tested within 7d → out
    }
    return true
  })
})
```

### Step 5: Modify `Accounts.vue` — add staleOnly + shortcut handlers + resetFilters

Find the `const aliveFilter = ref([])` declaration (just edited in Step 3). IMMEDIATELY AFTER it, add:

```js
const staleOnly = ref(false)

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

### Step 6: Modify `Accounts.vue` — search placeholder + toolbar shortcut buttons

Find `<el-input v-model="search" placeholder="搜索邮箱..." ...>` (~line 12). Replace:

```vue
        <el-input v-model="search" placeholder="搜索 (邮箱/RT/Client ID/TOTP/密码)" clearable style="width:240px;margin-left:12px" />
```

Find the `<el-tag>{{ filteredAccounts.length }} / {{ accounts.length }}</el-tag>` line (~line 35). IMMEDIATELY BEFORE it, add:

```vue
        <el-button size="small" text @click="aliveFilter = ['unknown']">仅看未测试</el-button>
        <el-button size="small" :type="staleOnly ? 'primary' : ''" text @click="staleOnly = !staleOnly">7天未测</el-button>
        <el-button size="small" text :disabled="!hasAnyFilter" @click="resetFilters">重置筛选</el-button>
```

### Step 7: Verify front-end builds

Run:

```bash
cd web && npm run build
```

Expected: build succeeds; Vue compile errors mean a referenced var (`staleOnly`, `hasAnyFilter`, `resetFilters`) wasn't declared correctly in Step 5.

### Step 8: Server-side regression sanity

Run:

```bash
cd .. && node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 158 still pass.

### Step 9: Manual UI smoke

Restart the server (kill + relaunch), open `http://localhost:3000/accounts` after hard refresh (Ctrl+Shift+R).

1. Verify the search input placeholder reads `搜索 (邮箱/RT/Client ID/TOTP/密码)`.
2. Verify status / 活性 dropdowns show checkboxes for multi-select.
3. Type a partial Client ID into the search — accounts with that fragment should appear.
4. Click `7天未测` — accounts with `_aliveCheckedAt` within 7 days should disappear; never-tested ones remain.
5. Click `重置筛选` — all filter chips clear; full account list returns.
6. Trigger a liveness check (`测活选中` on 1 row). Bottom log panel auto-expands and shows multiple `[liveness] ...` lines including chrome impersonate attempts and (if probed account is token_expired) the `[Deactivated] Step 0/1/2` lines from the new Python script.

### Step 10: Commit

```bash
git add web/src/socket.js web/src/views/Accounts.vue
git commit -m "feat(ui): liveness-log streaming + Accounts page search UX upgrades

Part A.3 frontend half — socket.js gets a new socket.on('liveness-log')
handler that pushes every Python {log:...} line through the same
pushLivenessLog path. pushLivenessLog gains a source:'liveness'
field so livenessLogs filter no longer depends on the message text
starting with the right prefix — Python's [Deactivated] and
[Liveness] lines both flow through unchanged.

Part B Accounts.vue search/filter rewrite:
- 状态 + 活性 dropdowns become multi-select with collapse-tags
- Search input matches against email + refresh_token + client_id +
  totp_secret + password (haystack join with single Array.includes)
- Two shortcut buttons:
  - 仅看未测试 (alive_status='unknown')
  - 7天未测 (alive_checked_at older than 7d, or never tested)
- 重置筛选 wipes all six dimensions (search + 3 multi + 2 single +
  staleOnly) and stays disabled until any filter is active

filteredAccounts uses Array.includes for the two multi filters and
checks staleOnly via Date.parse(alive_checked_at) vs Date.now() -
7d.

158 tests still pass server-side; build green."
```

---

## Task 3: CHANGELOG + 最终回归 smoke

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.29.0 entry

Open `docs/CHANGELOG.md` and insert IMMEDIATELY AFTER the `# Changelog` line:

```markdown
# Changelog

## v2.29.0 — 2026-05-24

### Liveness Deactivated Detection + Search UX Overhaul

**Part A — deactivated 检测**

- **Case 1 修复**：`mapPlanType('deactivated')` 直接返 `alive_status='deactivated', reason='account_deactivated'`。v2.28 hotfix `3b64727` 已经让 Python 端在 HTTP 200 + `is_deactivated=true` 时报 `plan_type='deactivated'`，但 Node 端 mapPlanType 误归 `canceled` — 本次打通。
- **Case 2 新增**：新建 `chatgpt_register/deactivated_check.py`，跑 `protocol_register.py` 的 Step 0-2（homepage / signin / authorize），扫描响应体里的 `account_deactivated` / `account_disabled` 标记。无 OTP，5-10s/账号。`server/liveness/checker.js` 新 `verifyDeactivated` 包装 spawn；`runner.dispatchOne` 在 probe 返 `token_expired` 后调它。
- **实时日志**：v2.26 spec §6.2 定义了 `liveness-log` 事件名但 runner 当时没真发。本次正式实现：runner 注入 `onLog(level, message)` 闭包 → `io.emit('liveness-log', {email, level, message})` → 前端 `socket.on('liveness-log')` → `pushLivenessLog`。`pushLivenessLog` 加 `source:'liveness'` 字段，`Accounts.vue` 的 `livenessLogs` computed 改用该字段过滤（不再靠 message 前缀字符串）。

**Part B — Accounts 页搜索 UX**

- 状态、活性筛选改 `<el-select multiple collapse-tags>`，可同时选多项；filter 用 `Array.includes(a._status)`。
- 搜索框 placeholder 改 `搜索 (邮箱/RT/Client ID/TOTP/密码)`，匹配五个字段的 haystack join。
- toolbar 新增 3 个按钮：
  - `仅看未测试` 一键设 `aliveFilter=['unknown']`
  - `7天未测` 切换 `staleOnly`，按 `alive_checked_at` 时间过滤
  - `重置筛选` 一键清 6 个 filter 维度（含 staleOnly），任意 filter 激活时才可用

**测试**：158 tests pass —— 16 checker（+2 deactivated 映射）+ 6 verify-deactivated（新）+ 10 runner（+2 verifyDeactivated 集成）+ 124 elsewhere unchanged。Python `deactivated_check.py` 沿用 stripe_init.py 模式不写单测，集成 smoke 验证。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-deactivated-detection-and-search-ux-design.md` + `docs/superpowers/plans/2026-05-24-deactivated-detection-and-search-ux.md`。
```

(Keep `## v2.28.0` section and everything below intact.)

### Step 2: Run final regression

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 158 pass.

### Step 3: Manual end-to-end smoke (5 accounts mix)

Pick 5 accounts representing different states (use the DB query below to find them):

```bash
node -e "
const {initDB,statusDB} = require('./server/db');
const fs = require('fs');
const path = require('path');
initDB().then(() => {
  const rows = statusDB.list();
  // categorize
  const cats = { plus: [], deactivated: [], unknown_with_codex: [], unknown_no_codex: [] };
  for (const r of rows) {
    const codexPath = './cpa-auth/codex-' + r.email.replace(/@/g, '-at-').replace(/\./g, '-') + '.json';
    const hasCodex = fs.existsSync(codexPath);
    if (r.status === 'plus' && hasCodex) cats.plus.push(r.email);
    else if (r.status === 'deactivated') cats.deactivated.push(r.email);
    else if (hasCodex) cats.unknown_with_codex.push(r.email);
    else cats.unknown_no_codex.push(r.email);
  }
  for (const [k, v] of Object.entries(cats)) console.log(k + ':', v.slice(0, 2).join(', '));
});
"
```

Trigger liveness on a 5-account selection that covers as many categories as possible:

```bash
curl -X POST http://localhost:3000/api/liveness/start -H 'Content-Type: application/json' -d '{"emails":["a","b","c","d","e"]}'
```

(Replace a-e with real emails.)

In the UI:

| Account type | Expected alive_status | Expected log lines |
|---|---|---|
| Plus | plus | attempt 1/3 via chromeXX + plus / check ok |
| Plus + is_deactivated=true (rare) | deactivated | attempt + HTTP 200 + plan_type=deactivated → mapPlanType → deactivated |
| token expired, account active | token_expired | attempt + 401 + [Deactivated] Step 0/1/2 + active → preserve token_expired |
| token revoked, account banned | deactivated | attempt + 401 + [Deactivated] Step 0/1/2 + Account deactivated detected |
| 无 codex 文件 + 协议模式 | login_fail | direct lightLogin → LivenessLoginNotImplementedError |

All 5 should produce visible log lines in the panel.

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.29.0 — liveness deactivated detection + search UX"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 background: informational, no task.
- Spec §2 Part A backend:
  - §2.1 mapPlanType deactivated → Task 1 Step 3
  - §2.2 deactivated_check.py → Task 1 Step 1
  - §2.3 verifyDeactivated → Task 1 Step 5
  - §2.4 runner integration → Task 1 Step 6
  - §2.5 onLog + §2.6 liveness-log socket event → Task 1 Steps 4-6 (backend) + Task 2 Step 1 (frontend handler) + Task 2 Step 2 (source field filter)
- Spec §3 Part B frontend:
  - §3.1 multi-select → Task 2 Steps 3-4
  - §3.2 search field haystack → Task 2 Steps 4 + 6
  - §3.3 shortcut buttons → Task 2 Steps 5 + 6
  - §3.4 reset → Task 2 Steps 5 + 6
  - §3.5 layout → covered by Step 6's button order
- Spec §4 boundaries (10 rows): mostly covered by impl + tests in Task 1 (timeout 12s, ENOENT, unparsable, abort, JSON-line parse) + frontend null safety in Task 2.
- Spec §5 testing: Task 1 Steps 7-9 (5+ verify-deactivated tests, +2 checker, +2 runner integration).
- Spec §6 file list: matches Task 1 + Task 2 file list above.
- Spec §7 YAGNI: nothing planned in this plan exceeds the listed scope.
- Spec §8 v2.29.0: Task 3 Step 1 CHANGELOG.

**2. Placeholder scan:** no "TBD" / "implement later" / "fill in" — every step has exact code and exact commands.

**3. Type / symbol consistency:**

- `deactivated_check.py` / `verifyDeactivated` / `onLog` / `pushLivenessLog` / `livenessLogs` / `staleOnly` / `hasAnyFilter` / `resetFilters` — same identifiers across tasks.
- Python `_log` helper writes `[Deactivated] ...` strings — preserved as-is in stream; UI doesn't pattern-match on these strings (uses `source` field).
- `liveness-log` socket event shape `{ email, level, message }` matches between runner.js emit (Task 1 Step 6), socket.js handler (Task 2 Step 1), and the test in Task 1 Step 8 (`onLog` callback signature).
- `alive_status='deactivated'` value flows through mapPlanType (Task 1 Step 3), runner verifyDeactivated branch (Task 1 Step 6), DB column (already exists since v2.26), UI ALIVE_LABEL_MAP (already exists since v2.28 hotfix `3f9c437`).

No issues found in self-review.
