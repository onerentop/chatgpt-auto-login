# 测活 Python probe + 日志面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v2.26 测活的 Node fetch 换成 spawn Python (curl_cffi + impersonate=chrome131) 子进程绕过 Cloudflare TLS 指纹检测；Accounts 页底部加 `<el-collapse>` 折叠日志面板让用户能实时看到 `[liveness]` 日志流。

**Architecture:** 新建 `chatgpt_register/liveness_probe.py`（stdin JSON → curl_cffi GET /accounts/check → stdout JSON-lines）。`server/liveness/checker.js` 删 `_requestViaProxy`，改 spawn Python 子进程，套路完全照搬 `server/stripe-verify.js`。11 个 checker 单元测试中 5 个保留（decodeJwtExp + mapPlanType 无 spawn 依赖），6 个改造把 `fetchImpl` 替换成 `spawnImpl` 注入。`web/src/socket.js` 在 3 个 liveness handler 各加 1 行 push 到 `socketState.logs`；`web/src/views/Accounts.vue` 在 `</el-table>` 后追加 `<el-collapse>` 日志面板。

**Tech Stack:** Python curl_cffi、Node `child_process.spawn`、Vue 3 + Element Plus、`node:test`。

**Spec:** `docs/superpowers/specs/2026-05-24-liveness-python-probe-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `chatgpt_register/liveness_probe.py` | 单文件 Python 子进程：stdin JSON → curl_cffi GET → stdout JSON-lines | 新建 |
| `server/liveness/checker.js` | 删 `_requestViaProxy`；`probe()` 改 spawn Python；保留 `decodeJwtExp` / `mapPlanType` / `extractPlanType` 导出 | 修改 |
| `server/liveness/__tests__/checker.test.js` | 5 个保留 + 6 个改造（fetchImpl → spawnImpl）+ 新增 2 个 (cloudflare 403 vs account 403 分类、spawn ENOENT) = 13 测试 | 修改 |
| `web/src/socket.js` | 3 个 liveness handler 加 push 到 socketState.logs，前缀 `[liveness]` | 修改 |
| `web/src/views/Accounts.vue` | `</el-table>` 后追加 `<el-collapse>` 日志面板 + script 处理 livenessLogs / logsExpanded / 自动展开 | 修改 |
| `docs/CHANGELOG.md` | v2.28.0 节 | 修改 |

依赖链：Task 1 → Task 2 串行（Task 2 依赖 Task 1 的 checker.js 修改）。

---

## Task 1: Python probe + checker.js refactor + 11→13 单测

**Files:**
- Create: `chatgpt_register/liveness_probe.py`
- Modify: `server/liveness/checker.js`
- Modify: `server/liveness/__tests__/checker.test.js`

- [ ] **Step 1: 创建 `chatgpt_register/liveness_probe.py`**

完整内容如下（套路对照 `stripe_init.py:1-50`）：

```python
#!/usr/bin/env python3
"""Probe ChatGPT /backend-api/accounts/check via curl_cffi (Cloudflare bypass).

Input: JSON on stdin  { access_token, proxy_url, impersonate?, timeout_ms? }
   access_token: JWT bearer for /accounts/check
   proxy_url:    HTTP proxy URL, e.g. http://127.0.0.1:7890 (None for direct)
   impersonate:  curl_cffi browser fingerprint, default 'chrome131'
   timeout_ms:   request timeout in ms, default 10000

Output: JSON-lines on stdout — streaming {"log":"..."} and final terminal object:
   {"status":"ok",    "http":200, "plan_type":"plus|free|...", "reason":null}
   {"status":"error", "http":<int>, "plan_type":null,         "reason":"<msg>"}

NB: Module-level imports must NOT print to stdout (would pollute JSON-lines
protocol). curl_cffi import is safe — it doesn't print on import.
"""
import sys, json
from curl_cffi import requests as cr

CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'


def _log(m):
    print(json.dumps({"log": f"  [Liveness] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _extract_plan_type(body):
    """Mirror the JS extractPlanType fallback chain."""
    a = (body.get('accounts') or {}).get('default') or body.get('account_plan') or body or {}
    return (
        a.get('plan_type')
        or (a.get('entitlement') or {}).get('subscription_plan')
        or (((a.get('entitlement') or {}).get('plan') or {}).get('name'))
        or a.get('subscription_plan')
        or 'unknown'
    )


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": f"stdin parse: {str(e)[:60]}"})
        return

    access_token = inp.get('access_token', '')
    proxy_url = inp.get('proxy_url') or None
    impersonate = inp.get('impersonate', 'chrome131')
    timeout_s = (inp.get('timeout_ms', 10000)) / 1000.0

    if not access_token:
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": "no access_token"})
        return

    proxies = {'http': proxy_url, 'https': proxy_url} if proxy_url else None
    _log(f"GET /accounts/check via {impersonate}, proxy={'on' if proxy_url else 'off'}")

    try:
        res = cr.get(
            CHECK_URL,
            headers={'Authorization': f'Bearer {access_token}'},
            proxies=proxies,
            impersonate=impersonate,
            timeout=timeout_s,
        )
    except Exception as e:
        msg = str(e)[:80]
        _emit({"status": "error", "http": 0, "plan_type": None, "reason": f"exception: {msg}"})
        return

    http = res.status_code

    if http == 200:
        try:
            body = res.json()
        except Exception as e:
            _emit({"status": "error", "http": 200, "plan_type": None, "reason": f"json parse: {str(e)[:60]}"})
            return
        plan_type = _extract_plan_type(body)
        _emit({"status": "ok", "http": 200, "plan_type": plan_type, "reason": None})
        return

    if http == 401:
        _emit({"status": "error", "http": 401, "plan_type": None, "reason": "token_expired"})
        return

    if http == 403:
        text = res.text[:200] if res.text else ''
        if '__cf_chl' in text or 'cf-mitigated' in text or 'Cloudflare' in text:
            reason = 'cloudflare blocked'
        else:
            reason = 'account forbidden'
        _emit({"status": "error", "http": 403, "plan_type": None, "reason": reason})
        return

    if http == 429:
        _emit({"status": "error", "http": 429, "plan_type": None, "reason": "rate limited"})
        return

    _emit({"status": "error", "http": http, "plan_type": None, "reason": f"http {http}"})


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Verify Python script smoke-runs**

Run:

```bash
echo '{"access_token":"bad","proxy_url":null,"timeout_ms":3000}' | py -3 chatgpt_register/liveness_probe.py
```

Expected output (single JSON line, status error, http=403/401 depending on Cloudflare verdict for a bad token — what matters is the JSON-lines protocol works and curl_cffi import succeeds):

```
{"log": "  [Liveness] GET /accounts/check via chrome131, proxy=off"}
{"status": "error", "http": ..., "plan_type": null, "reason": "..."}
```

If it fails with `ModuleNotFoundError: curl_cffi`, install: `pip install curl_cffi`. If it prints anything before the JSON-lines, the script has a stray print — fix it.

- [ ] **Step 3: Read current `server/liveness/checker.js` to know what to delete**

Read the file. Key sections to replace:
- `_requestViaProxy` function (added in commit `7b65000`, the bulk of lines 7-39 of the current file)
- `probe()` async function — the entire body needs to switch from fetch to spawn

`decodeJwtExp` / `mapPlanType` / `extractPlanType` stay unchanged — they're still useful for unit tests and as helpers.

- [ ] **Step 4: Rewrite `server/liveness/checker.js`**

Replace the entire file with this content:

```js
// server/liveness/checker.js
// Probes a ChatGPT access_token against /backend-api/accounts/check via the
// Python curl_cffi sub-process (chatgpt_register/liveness_probe.py).
//
// Why Python? Cloudflare's TLS fingerprint check blocks Node's https.request
// regardless of proxy. curl_cffi with impersonate='chrome131' is the same
// approach used by stripe_init.py / protocol_register.py / checkout_link.py
// everywhere else in this project.

const { spawn } = require('child_process');
const path = require('path');
let proxyMgr;  // lazy require to avoid cycle at module load
function getProxyUrl() {
  try {
    proxyMgr = proxyMgr || require('../proxy');
    return proxyMgr.getProxyUrl() || '';
  } catch { return ''; }
}

const SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'liveness_probe.py');
const FETCH_TIMEOUT_MS = 10_000;
const SPAWN_TIMEOUT_MS = 12_000;  // 10s request + 2s startup grace

function decodeJwtExp(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

function mapPlanType(planType) {
  if (planType === 'plus') return { alive_status: 'plus', alive_reason: 'check ok' };
  if (planType === 'free') return { alive_status: 'canceled', alive_reason: 'no plus' };
  return { alive_status: 'canceled', alive_reason: `plan: ${planType}` };
}

function extractPlanType(json) {
  const a = json?.accounts?.default || json?.account_plan || json || {};
  return (
    a?.plan_type ||
    a?.entitlement?.subscription_plan ||
    a?.entitlement?.plan?.name ||
    a?.subscription_plan ||
    'unknown'
  );
}

// Translate Python terminal object → alive_status/alive_reason per spec §3.3.
function mapTerminal(parsed) {
  if (parsed.status === 'ok' && parsed.http === 200) {
    return mapPlanType(parsed.plan_type || 'unknown');
  }
  const http = parsed.http;
  const reason = parsed.reason || '';
  if (http === 401) return { alive_status: 'token_expired', alive_reason: 'check 401' };
  if (http === 403 && /cloudflare/i.test(reason)) {
    return { alive_status: 'proxy_error', alive_reason: 'cloudflare blocked' };
  }
  if (http === 403) return { alive_status: 'login_fail', alive_reason: 'check 403 forbidden' };
  if (http === 429) return { alive_status: 'network_error', alive_reason: 'check 429' };
  if (http >= 500) return { alive_status: 'network_error', alive_reason: `check ${http}` };
  if (http === 0 && /exception/i.test(reason)) {
    return { alive_status: 'network_error', alive_reason: reason.slice(0, 60) };
  }
  return { alive_status: 'network_error', alive_reason: reason.slice(0, 60) || `check ${http}` };
}

async function probe(accessToken, opts = {}) {
  const { signal, spawnImpl, proxyUrl } = opts;

  // Local JWT exp check — short-circuit expired tokens (no Python spawn).
  const exp = decodeJwtExp(accessToken);
  if (exp && exp * 1000 < Date.now()) {
    return { alive_status: 'token_expired', alive_reason: 'jwt expired' };
  }

  const doSpawn = spawnImpl || ((cmd, args, options) => spawn(cmd, args, options));
  const effectiveProxy = (proxyUrl !== undefined) ? proxyUrl : getProxyUrl();

  return new Promise((resolve) => {
    let settled = false;
    let stdoutLast = '';
    let stderrBuf = '';
    const py = doSpawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { py.kill(); } catch {}
      resolve({ alive_status: 'network_error', alive_reason: 'probe timeout' });
    }, SPAWN_TIMEOUT_MS);

    if (signal) signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { py.kill(); } catch {}
      resolve({ alive_status: 'network_error', alive_reason: 'aborted' });
    }, { once: true });

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdoutLast = line;
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
      resolve({ alive_status: 'network_error', alive_reason: `spawn error: ${(e.code || e.message || '').toString().slice(0, 40)}` });
    });

    py.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdoutLast); }
      catch {
        resolve({ alive_status: 'network_error', alive_reason: `probe unparsable: ${stderrBuf.slice(-60).trim()}` });
        return;
      }
      resolve(mapTerminal(parsed));
    });

    const stdinPayload = JSON.stringify({
      access_token: accessToken,
      proxy_url: effectiveProxy || null,
      impersonate: 'chrome131',
      timeout_ms: FETCH_TIMEOUT_MS,
    });
    try { py.stdin.write(stdinPayload); py.stdin.end(); } catch {}
  });
}

module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType, mapTerminal };
```

- [ ] **Step 5: Rewrite `server/liveness/__tests__/checker.test.js`**

Replace the entire file with this content (5 unit tests for helpers + 6 probe tests with spawnImpl mock + 2 new edge cases = 13 tests):

```js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { probe, decodeJwtExp, mapPlanType, mapTerminal } = require('../checker');

function jwtWithExp(expSec) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

// Build a fake child-process that emits the given JSON-lines on stdout
// then closes. Mirrors enough of the real ChildProcess interface for checker.js.
function fakeChild({ stdoutLines = [], stderr = '', errorEvent = null, holdOpen = false }) {
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
      if (holdOpen) return;  // never close — used for timeout test
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

// === Pure helper unit tests (no spawn) ===

test('decodeJwtExp parses exp from JWT payload', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.strictEqual(decodeJwtExp(jwtWithExp(exp)), exp);
});

test('decodeJwtExp returns 0 on malformed JWT', () => {
  assert.strictEqual(decodeJwtExp('not-a-jwt'), 0);
  assert.strictEqual(decodeJwtExp(''), 0);
});

test('mapPlanType: plus → alive_status=plus', () => {
  assert.deepStrictEqual(mapPlanType('plus'), { alive_status: 'plus', alive_reason: 'check ok' });
});

test('mapPlanType: free → canceled', () => {
  assert.deepStrictEqual(mapPlanType('free'), { alive_status: 'canceled', alive_reason: 'no plus' });
});

test('mapPlanType: team/enterprise → canceled w/ plan name', () => {
  assert.deepStrictEqual(mapPlanType('team'), { alive_status: 'canceled', alive_reason: 'plan: team' });
});

// === probe() tests with spawnImpl injection ===

test('probe: JWT already expired returns token_expired without spawning', async () => {
  let spawnCalls = 0;
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) - 10), {
    spawnImpl: () => { spawnCalls++; return fakeChild({ stdoutLines: [] }); },
  });
  assert.strictEqual(r.alive_status, 'token_expired');
  assert.strictEqual(spawnCalls, 0, 'spawn should NOT be called for locally-expired JWT');
});

test('probe: ok 200 plan_type=plus → plus', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"ok","http":200,"plan_type":"plus","reason":null}'] }),
  });
  assert.strictEqual(r.alive_status, 'plus');
});

test('probe: ok 200 plan_type=free → canceled', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"ok","http":200,"plan_type":"free","reason":null}'] }),
  });
  assert.strictEqual(r.alive_status, 'canceled');
});

test('probe: error 401 → token_expired', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":401,"plan_type":null,"reason":"token_expired"}'] }),
  });
  assert.strictEqual(r.alive_status, 'token_expired');
});

test('probe: error 403 cloudflare → proxy_error (network layer, not account)', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":403,"plan_type":null,"reason":"cloudflare blocked"}'] }),
  });
  assert.strictEqual(r.alive_status, 'proxy_error');
  assert.match(r.alive_reason, /cloudflare/);
});

test('probe: error 403 account_forbidden → login_fail', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":403,"plan_type":null,"reason":"account forbidden"}'] }),
  });
  assert.strictEqual(r.alive_status, 'login_fail');
});

test('probe: error 503 → network_error', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['{"status":"error","http":503,"plan_type":null,"reason":"http 503"}'] }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
});

test('probe: spawn ENOENT (Python not in PATH) → network_error', async () => {
  const err = new Error('spawn py ENOENT');
  err.code = 'ENOENT';
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ errorEvent: err }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
  assert.match(r.alive_reason, /spawn error/);
});

test('probe: stdout unparsable → network_error with stderr tail', async () => {
  const r = await probe(jwtWithExp(Math.floor(Date.now() / 1000) + 3600), {
    spawnImpl: fakeSpawn({ stdoutLines: ['this is not json'], stderr: 'Traceback ModuleNotFoundError curl_cffi' }),
  });
  assert.strictEqual(r.alive_status, 'network_error');
  assert.match(r.alive_reason, /unparsable/);
});
```

That's 13 tests total (5 helper + 8 probe scenarios). One spec test was redundant (mapPlanType team and entire mapTerminal repeat the same mapping) — kept 13 covering the distinct paths.

- [ ] **Step 6: Run new tests, expect 13 pass**

Run:

```bash
node --test server/liveness/__tests__/checker.test.js
```

Expected: `# pass 13`, `# fail 0`. Total run time < 1s (no real spawn).

If a test fails because the EventEmitter-based fakeChild doesn't quite match how checker.js consumes events, inspect the failure and tweak the fake (NOT the production code) until parity is reached. Common gotchas:
- `setImmediate` ordering: stdout 'data' must fire before 'close'
- stdin.write may be called synchronously; if checker.js writes after attaching listeners, no issue

- [ ] **Step 7: Run full regression**

Run:

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 148 pass (146 baseline + 13 new − 11 old = 148). If any unrelated test regressed, investigate; the only file you touched outside `checker.js` / `checker.test.js` / `liveness_probe.py` should be untouched.

- [ ] **Step 8: Manual integration smoke (1 account)**

In the shell:

```bash
# Pick any account from cpa-auth/codex-*.json that has a non-expired JWT.
# This script Reads token from that file, calls probe(), prints result.
node -e "
const fs = require('fs');
const { probe } = require('./server/liveness/checker');
const j = JSON.parse(fs.readFileSync('./cpa-auth/codex-AlexisOlsen5333-at-outlook-com.json'));
probe(j.access_token).then(r => console.log('Result:', r));
"
```

Expected output: `Result: { alive_status: 'plus', alive_reason: 'check ok' }` (assuming the account is still Plus and the main proxy is running). If you see `proxy_error: cloudflare blocked`, restart the main proxy via `curl -X POST http://localhost:3000/api/proxy/refresh`. If `network_error: spawn error: ENOENT`, ensure `py` is in PATH on Windows or `python3` if porting to *nix.

- [ ] **Step 9: Commit**

```bash
git add chatgpt_register/liveness_probe.py server/liveness/checker.js server/liveness/__tests__/checker.test.js
git commit -m "feat(liveness): replace Node fetch probe with Python curl_cffi sub-process

Cloudflare returns 403 for any /accounts/check request that isn't
TLS-fingerprinted as a real browser. Node 22's undici (and the
HttpsProxyAgent + https.request fallback we added in 7b65000) both
fail the same check. The whole project already solves this problem
for stripe_init.py, protocol_register.py, and checkout_link.py:
spawn Python, use curl_cffi with impersonate='chrome131'. Apply the
same recipe to liveness.

New chatgpt_register/liveness_probe.py reads a JSON config from stdin,
hits /backend-api/accounts/check via curl_cffi, and emits JSON-lines
on stdout — log streams as {\"log\":...} and the terminal row is a
{status,http,plan_type,reason} object. Module-level imports are
print-free (would corrupt the protocol).

server/liveness/checker.js drops _requestViaProxy entirely and mirrors
stripe-verify.js's spawn wiring: same stdout JSON-lines parser, same
12s spawn timeout (10s request + 2s startup), same stderr capture.
AbortSignal kills the child cleanly. spawnImpl is injectable for tests.

Status-code mapping picks up a new distinction: cloudflare-flavored 403
maps to proxy_error (network layer — change node), while OpenAI
account-flavored 403 stays login_fail (account banned). The Python
script discriminates by scanning the 403 body for __cf_chl / cf-mitigated
/ 'Cloudflare' markers before reporting reason.

11 unit tests rewired and 2 added: 5 pure-helper tests (decodeJwtExp +
mapPlanType) keep the same shape; 8 probe tests inject fakeChild
EventEmitters instead of fakeFetch. Coverage includes spawn ENOENT,
unparsable stdout with stderr tail, and the cloudflare-vs-account
403 discriminator. 148 tests total pass."
```

---

## Task 2: socket.js liveness log push + Accounts.vue 折叠日志面板 + CHANGELOG

**Files:**
- Modify: `web/src/socket.js`
- Modify: `web/src/views/Accounts.vue`
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 在 `web/src/socket.js` 加 push helper + 3 个 handler 各 1 行**

Find the existing `socket.on('execution-complete', ...)` block. AFTER the existing 3 liveness handlers (`socket.on('liveness-status'`, `'liveness-progress'`, `'liveness-complete'`), refactor each to also push to `socketState.logs`.

Add this helper near the top of `connectSocket()` body (before the existing socket.on handlers):

```js
  function pushLivenessLog(email, level, message) {
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: email || '',
      level,
      message: `[liveness] ${message}`,
    });
    if (socketState.logs.length > 500) {
      socketState.logs.splice(0, socketState.logs.length - 500);
    }
  }
```

Then modify the 3 existing handlers — wrap them with one additional `pushLivenessLog(...)` line each:

```js
  socket.on('liveness-status', (data) => {
    socketState.aliveStatuses[data.email] = {
      alive_status: data.alive_status,
      alive_reason: data.alive_reason || '',
      alive_checked_at: data.alive_status === 'checking' ? '' : new Date().toISOString(),
    }
    const level = data.alive_status === 'plus' ? 'success'
                : data.alive_status === 'checking' ? 'info'
                : data.alive_status === 'canceled' ? 'warning'
                : data.alive_status === 'token_expired' || data.alive_status === 'login_fail' ? 'error'
                : 'warning'
    pushLivenessLog(data.email, level, `${data.alive_status}${data.alive_reason ? ': ' + data.alive_reason : ''}`)
  })

  socket.on('liveness-progress', (data) => {
    socketState.liveness.done = data.done || 0
    socketState.liveness.total = data.total || 0
    socketState.liveness.failed = data.failed || 0
    socketState.liveness.running = (data.done || 0) < (data.total || 0)
  })

  socket.on('liveness-complete', (data) => {
    socketState.liveness.running = false
    socketState.liveness.summary = data.summary || null
    const s = data.summary || {}
    pushLivenessLog('', 'success', `done (${Math.round((data.durationMs||0)/1000)}s): plus=${s.plus||0} canceled=${s.canceled||0} login_fail=${s.login_fail||0} token_expired=${s.token_expired||0} proxy_error=${s.proxy_error||0} network_error=${s.network_error||0}`)
  })
```

Note: liveness-progress doesn't push to logs (would flood — 100 accounts = 100 lines of "12/100 done"). Only per-account status changes (`liveness-status`) and the final summary (`liveness-complete`) get logged.

Also remove the older `socketState.logs.push` call inside the `liveness-complete` handler if it duplicates the new one — there should be exactly one log entry per complete event.

- [ ] **Step 2: 在 `web/src/views/Accounts.vue` 表格后加日志面板**

Find `</el-table>` (around line 115). IMMEDIATELY AFTER `</el-table>` (and before the existing `<el-dialog>` blocks), insert:

```vue
    <el-collapse v-model="logsExpanded" style="margin-top: 12px">
      <el-collapse-item :title="`测活日志 (${livenessLogs.length})`" name="liveness-logs">
        <div class="liveness-log-list">
          <div v-for="(log, i) in livenessLogs" :key="i" :class="'log-' + log.level">
            <span class="log-time">{{ log.timestamp.slice(11, 19) }}</span>
            <span v-if="log.email" class="log-email">{{ log.email }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="livenessLogs.length === 0" style="color:#c0c4cc; padding: 8px;">暂无测活日志</div>
        </div>
      </el-collapse-item>
    </el-collapse>
```

- [ ] **Step 3: Add `<style scoped>` block before the closing `</script>` or after `</template>`**

Find the existing `<style>` block in Accounts.vue if any, OR add a new one before `</template>`'s closing scope. Append these rules:

```vue
<style scoped>
.liveness-log-list { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; padding: 4px 8px; background: #fafafa; border-radius: 4px; }
.liveness-log-list > div { padding: 2px 0; }
.log-time { color: #909399; margin-right: 8px; }
.log-email { color: #409EFF; margin-right: 8px; }
.log-msg { color: #303133; }
.log-success .log-msg { color: #67C23A; }
.log-warning .log-msg { color: #E6A23C; }
.log-error .log-msg { color: #F56C6C; }
.log-info .log-msg { color: #909399; }
</style>
```

(If a `<style scoped>` block already exists, append the rules inside it instead of creating a duplicate block.)

- [ ] **Step 4: Wire up the script — imports + reactive state + auto-expand watch**

In the `<script setup>` block of Accounts.vue:

a. If `watch` and `computed` aren't already imported from 'vue', add them. The existing import line should become:

```js
import { ref, computed, onMounted, nextTick, watch } from 'vue'
```

(Note: `watch` is already there from v2.26 work — keep this idempotent.)

b. After the existing `aliveFilter` / `aliveFilterOptions` declarations (around the `socketState` import area), add:

```js
const logsExpanded = ref([])
const livenessLogs = computed(() =>
  socketState.logs.filter(l => l.message?.startsWith('[liveness]')).slice(-200)
)

// Auto-expand log panel when liveness starts; user controls collapsing afterwards.
watch(() => socketState.liveness.running, (now) => {
  if (now && !logsExpanded.value.includes('liveness-logs')) {
    logsExpanded.value = ['liveness-logs']
  }
})
```

- [ ] **Step 5: Verify front-end builds**

Run:

```bash
cd web && npm run build
```

Expected: build completes without syntax errors. Output goes to `web/dist/`.

If you see Vue compile errors about `logsExpanded` not defined or `livenessLogs` not defined, you missed Step 4. If it complains about a duplicate `<style>` block, merge them per Step 3's parenthetical note.

- [ ] **Step 6: Server-side regression**

Run:

```bash
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 148 pass. Front-end changes don't touch tests; this is a sanity check that nothing leaked.

- [ ] **Step 7: Restart server + manual UI smoke**

Restart server:

```bash
# In the running shell (if you have one):
# Ctrl-C the existing node server/index.js, then:
node server/index.js
```

In a browser at `http://localhost:3000/accounts`:

1. Verify the new "测活日志 (0)" collapsible row appears below the table.
2. Click "测活选中" with 2-3 accounts selected.
3. Panel should auto-expand. You should see:
   - `HH:MM:SS  alice@x.com  [liveness] checking`
   - `HH:MM:SS  alice@x.com  [liveness] plus: check ok` (a few seconds later)
   - When all done: `HH:MM:SS  [liveness] done (Ns): plus=2 canceled=1 ...`
4. The "活性" column on each row should update synchronously.

If the panel never auto-expands, check the `watch` source — should be `() => socketState.liveness.running`. If logs flood with 100s of "checking" / "plus" entries even though only 3 accounts ran, you've got duplicate handlers — Step 1's modifications should *replace* existing logic, not append.

- [ ] **Step 8: Update CHANGELOG**

Open `docs/CHANGELOG.md`. Insert a new section IMMEDIATELY AFTER the `# Changelog` line:

```markdown
# Changelog

## v2.28.0 — 2026-05-24

### Liveness Probe Cloudflare Bypass + 日志面板

v2.26 测活在 2026-05-24 实测中发现 **100% 失败**：Node `globalThis.fetch` 调 `/accounts/check` 被 Cloudflare 的 TLS 指纹检测一律拦截返 403，即便走 :7890 主代理也无法绕过（验证 commit `7b65000` 的 `HttpsProxyAgent + https.request` 路径仍中招）。同时用户反馈"测活看不到日志"。

**核心改动：**

- **Python curl_cffi probe**：新建 `chatgpt_register/liveness_probe.py`，套路对照 `stripe_init.py` / `protocol_register.py` / `checkout_link.py`，spawn 出来用 `impersonate='chrome131'` 模拟真实浏览器 TLS 指纹过 Cloudflare。
- **`server/liveness/checker.js` 重构**：删 v2.26 的 `globalThis.fetch` 和 `7b65000` 的 `_requestViaProxy`；改 `spawn('py', ['-3', 'liveness_probe.py'])`，套路对照 `server/stripe-verify.js`。`decodeJwtExp` / `mapPlanType` / `extractPlanType` 保留导出。
- **Cloudflare 403 区分账号 403**：Python 端扫返回体里的 `__cf_chl` / `cf-mitigated` / `Cloudflare` 标记。Cloudflare → `alive_status='proxy_error'`（网络层、提示切节点）；账号 → `alive_status='login_fail'`（账号问题）。
- **测试改造**：11 → 13 测试。5 个纯 helper unit 保留；6 个 probe 测试从 `fetchImpl` 注入改成 `spawnImpl` 注入（fakeChild EventEmitter）；2 个新增（spawn ENOENT、stdout unparsable）。
- **Accounts 页底部折叠日志面板**：表格下方加 `<el-collapse>`，订阅 `socketState.logs` 过滤 `[liveness]` 前缀。测活启动时自动展开、结束后保留展开供回看。`socket.js` 3 个 liveness handler 各加一条 push（liveness-progress 不打日志避免 flood）。

**预期效果：** 测活通过率从 0% 回到 ~100%（JWT 未过期 + 账号是 Plus 的真实账号），用户能实时看到逐账号 `[liveness] checking → plus: check ok` 日志流。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-python-probe-design.md` + `docs/superpowers/plans/2026-05-24-liveness-python-probe.md`。

**测试**：148 个测试通过。

```

(Keep the existing `## v2.27.0` section and everything below it intact.)

- [ ] **Step 9: Commit**

```bash
git add web/src/socket.js web/src/views/Accounts.vue docs/CHANGELOG.md
git commit -m "feat(ui): liveness log panel on Accounts page + socket.js push

socketState.logs now receives one entry per liveness-status event
(checking + terminal) and one summary entry per liveness-complete.
liveness-progress stays silent — 100 accounts would flood the panel
with done-count noise.

Accounts.vue gets an <el-collapse> below the table titled 测活日志
(N). The panel auto-expands when liveness.running flips true; users
control collapsing after. Visual style matches Execute.vue's log
list (monospace, 3 columns time/email/message, success=green
warning=yellow error=red).

CHANGELOG documents v2.28.0 as the fix for the Cloudflare-503 issue
introduced (latently) in v2.26 — the liveness module shipped without
ever being tested against the real /accounts/check endpoint because
all 11 unit tests used fetchImpl injection. Going forward the same
spawnImpl injection covers the new code path, but a smoke test
against a real Plus account is included as Task 1 Step 8."
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 (background): informational, no task.
- Spec §2 (Python probe): Task 1 Steps 1-2.
- Spec §3 (checker.js refactor): Task 1 Steps 3-5.
- Spec §4 (Socket.IO log push): Task 2 Step 1.
- Spec §5 (Accounts.vue panel): Task 2 Steps 2-4.
- Spec §6 (error handling 10 boundaries): covered by Task 1 implementation + 13 unit tests + the Step 8 integration smoke.
- Spec §7 (test strategy): Task 1 Steps 6-8.
- Spec §8 (YAGNI): nothing in plan exceeds the listed scope.
- Spec §9 (v2.28.0): Task 2 Step 8 CHANGELOG.

**2. Placeholder scan:** no "TBD" / "implement later" / "fill in" — every step has exact code, exact paths, exact commands.

**3. Type / symbol consistency:**

- `liveness_probe.py` / `mapTerminal` / `mapPlanType` / `extractPlanType` / `decodeJwtExp` / `spawnImpl` / `livenessLogs` / `logsExpanded` / `pushLivenessLog` — same identifiers used everywhere they appear.
- Plan-type discrimination strings (`'plus'` / `'free'` / `'team'`) match between Python `_extract_plan_type` and Node `extractPlanType`.
- Cloudflare detection markers (`__cf_chl` / `cf-mitigated` / `Cloudflare`) appear in Python (Task 1) and the regex in Node `mapTerminal` (`/cloudflare/i`).
- AbortSignal handling shape (`signal.addEventListener('abort', ..., { once: true })`) matches v2.26's runner conventions.

No issues found in self-review.
