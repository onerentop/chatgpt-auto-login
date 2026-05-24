# v3.0.0 Protocol Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Stripe billing / PKCE OAuth / Manual approval 这三个目前走 Playwright 的环节协议化（HTTP 重放），同时把 PayPal sub-flow 抽到独立 Node RPA 子进程（headed Chromium），让 `protocolMode=true` 路径变成 99% HTTP + 1% 隔离浏览器。`engine.js` (PipelineEngine) 与 v2.19 协议基线完全不动。

**Architecture:** 沿用现有 spawn-Python 模式 (`checkout_link.py` ↔ `chatgpt-checkout.js` 的扁平布局)。每个新协议环节配一对：`*.py` (curl_cffi HTTP) + `server/*.js` (spawn 包装)。PayPal 抽为 `paypal_rpa.js` + `server/paypal-rpa.js`。`protocol-engine.js` Phase 3+4 重写。失败 fail-fast 沿 v2.19 风格。

**Tech Stack:** Node 22+ (`node:test`)、Python 3 + curl_cffi (chrome JA3)、playwright-core (Node, headed Chromium)、sing-box 双入口 (7890 US / 7891 JP-KDDI)、Vue 3 + Element Plus。

**Reference repo:** `E:\workspace\projects\Gpt-Agreement-Payment`（成熟的协议重放范本；line 7499 是 Stripe confirm endpoint，5253-5560 是 PKCE，7012/7351/6712 是 paypal redirect / confirm / agreement approve）。

---

## File Structure

**新建**：
- `stripe_billing.py` (Python curl_cffi)
- `pkce_oauth.py`
- `manual_approval.py`
- `paypal_rpa.js` (Node `playwright-core`，repo 根目录)
- `server/stripe-billing.js`
- `server/pkce-oauth.js`
- `server/manual-approval.js`
- `server/paypal-rpa.js`
- `server/__tests__/stripe-billing.test.js`
- `server/__tests__/pkce-oauth.test.js`
- `server/__tests__/manual-approval.test.js`
- `server/__tests__/paypal-rpa.test.js`

**修改**：
- `protocol-engine.js`：重写 Phase 3 + Phase 4（约 line 280-440）
- `payment.js`：把 `fetchAddress` 改为 module.exports 暴露（约新增 1 行 export）
- `web/src/status.js`：TYPE_MAP/LABEL_MAP 加 2 个 entry，ERROR_STATUSES 加 2 项
- `web/src/views/Dashboard.vue`：再加一行 2 个 KPI 卡片
- `web/src/views/Accounts.vue` / `Execute.vue` / `Results.vue`：状态筛选加 2 个 option
- `package.json`：依赖加 `playwright-core`
- `docs/CHANGELOG.md`：v3.0.0 entry

**不动**：
- `server/engine.js` (PipelineEngine)
- `server/chatgpt-checkout.js` / `server/stripe-verify.js`
- `checkout_link.py` / `stripe_init.py` / `protocol_register.py`
- `payment.js` 的 `autoPayment` 主函数（PipelineEngine 仍用它）
- `config.json` schema（沿用 `protocolMode`）

---

## Task 0: Setup — dev 分支 + playwright-core 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 从 v2.19.1 分出 dev 分支**

```bash
git checkout master
git pull
git checkout -b dev v2.19.1
```

Expected: branch `dev` 在 commit `382a089`（v2.19.1 tag 所在 commit）。

- [ ] **Step 2: 安装 playwright-core**

```bash
npm install --save playwright-core
```

Expected: `package.json` 的 `dependencies` 中出现 `playwright-core`，version pinned。同时已有的 `playwright`（重量级版本，PipelineEngine 还在用）保留。

- [ ] **Step 3: Commit setup**

```bash
git add package.json package-lock.json
git commit -m "chore(v3.0.0): branch off v2.19.1, add playwright-core for PayPal RPA subprocess

PayPal Phase 3b in v3.0.0 runs in an isolated Node subprocess using
playwright-core (lighter than full playwright bundle). PipelineEngine
keeps using the existing playwright dependency."
```

---

## Task 1: `stripe_billing.py` — Stripe 计费表 HTTP 提交

**Files:**
- Create: `stripe_billing.py`
- Reference: `E:\workspace\projects\Gpt-Agreement-Payment\CTF-pay\card\_monolith.py` line 7499 (`/v1/payment_pages/{session_id}/confirm`)

- [ ] **Step 1: 阅读参考实现，记笔记**

打开 `E:\workspace\projects\Gpt-Agreement-Payment\CTF-pay\card\_monolith.py`，找以下三段：
1. **line 7499 附近**（约 7400-7600）：`url = f"{STRIPE_API}/v1/payment_pages/{session_id}/confirm"` —— 找出完整的 POST 请求构造（headers、form data 字段）
2. **line 7012 附近** (`_handle_paypal_redirect`)：找出 `paypal_redirect_url` 从 response 哪个字段提取（很可能是 `next_action.redirect_to_url`）
3. **line 7351 附近** (`confirm_payment`)：看是否还有第二次 POST（订阅条款确认）

把发现写到这个 task 的 commit message 草稿里，不另外建文档（保持轻量）。

- [ ] **Step 2: 写 `stripe_billing.py`**

在仓库根目录新建 `stripe_billing.py`：

```python
#!/usr/bin/env python3
"""Submit Stripe checkout billing + select PayPal, return PayPal redirect URL.

Input: JSON on stdin  { cs_id, pk, country, currency, street, city, state, zip, proxy }
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

Mirrors the user-driven flow:
  POST https://api.stripe.com/v1/payment_pages/{cs_id}/confirm
       form data: key=pk, payment_method_type=paypal, billing_details[country/line1/city/postal_code/state], ...
  Response should contain next_action.redirect_to_url (PayPal URL).

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:7499 (confirm endpoint),
           7012 (_handle_paypal_redirect — how to extract redirect URL).
"""
import sys, json, random, re
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_STRIPE_API = "https://api.stripe.com"


def _log(m):
    print(json.dumps({"log": f"  [StripeBilling] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "bad_input", "detail": str(e)[:80]})
        return

    cs_id = inp.get('cs_id', '')
    pk = inp.get('pk', '')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not re.match(r'^cs_live_[A-Za-z0-9]+$', cs_id):
        _emit({"status": "error", "reason": "invalid_cs_id"})
        return
    if not re.match(r'^pk_live_[A-Za-z0-9]+$', pk):
        _emit({"status": "error", "reason": "invalid_pk"})
        return

    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, cs={cs_id[:25]}..., pk={pk[:15]}...")

    # POST /v1/payment_pages/{cs_id}/confirm
    # Form fields adapted from reference _monolith.py around line 7499.
    # If reference uses different fields, adjust per actual flow.
    form_data = {
        "key": pk,
        "payment_method_type": "paypal",
        "payment_method_data[type]": "paypal",
        "payment_method_data[billing_details][address][country]": inp.get('country', 'US'),
        "payment_method_data[billing_details][address][line1]": inp.get('street', ''),
        "payment_method_data[billing_details][address][city]": inp.get('city', ''),
        "payment_method_data[billing_details][address][state]": inp.get('state', ''),
        "payment_method_data[billing_details][address][postal_code]": inp.get('zip', ''),
        "terms_of_service_consentment": "accept",
        "eager_browser_locale": "en-US",
    }

    url = f"{_STRIPE_API}/v1/payment_pages/{cs_id}/confirm"
    try:
        resp = cr.post(url, data=form_data, impersonate=imp, proxies=proxies, timeout=20)
    except Exception as e:
        _emit({"status": "error", "reason": f"confirm_fetch: {str(e)[:80]}"})
        return
    if resp.status_code != 200:
        _emit({"status": "error", "reason": f"stripe_billing_{resp.status_code}", "body": resp.text[:300]})
        return

    try:
        data = resp.json()
    except Exception:
        _emit({"status": "error", "reason": "confirm_not_json", "body": resp.text[:300]})
        return

    # Extract PayPal redirect URL.
    # Reference _monolith.py:7012 (_handle_paypal_redirect) for the exact path.
    next_action = data.get("next_action") or {}
    redirect_to = next_action.get("redirect_to_url") or next_action.get("paypal_handle_redirect_to_url")
    paypal_url = None
    if isinstance(redirect_to, dict):
        paypal_url = redirect_to.get("url")
    elif isinstance(redirect_to, str):
        paypal_url = redirect_to

    if not paypal_url:
        _emit({"status": "error", "reason": "no_next_action", "body": json.dumps(data)[:400]})
        return

    payment_intent_id = (data.get("payment_intent") or {}).get("id") if isinstance(data.get("payment_intent"), dict) else None

    _log(f"PayPal URL obtained: {paypal_url[:60]}...")
    _emit({"status": "success", "data": {"paypal_redirect_url": paypal_url, "payment_intent_id": payment_intent_id}})


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke test with osxti6295**

启动 server (`node server/index.js`，让 sing-box 起 7890/7891)。在另一个终端：

```powershell
# 重用既有 token-osxti6295.txt + checkout_link.py 拿到 fresh cs_live + pk
$token = (Get-Content E:\workspace\projects\demo\chatgpt-auto-login\token-osxti6295.txt -Raw).Trim()
$body1 = @{ access_token=$token; country="US"; currency="USD"; promo_id="plus-1-month-free"; proxy="http://127.0.0.1:7891" } | ConvertTo-Json -Compress
$out1 = $body1 | py -3 E:\workspace\projects\demo\chatgpt-auto-login\checkout_link.py
$parsed = ($out1 -split "`n" | Where-Object { $_ -match '"status"' }) | ConvertFrom-Json
$cs = ([regex]::Match($parsed.link, "/c/pay/(cs_live_[A-Za-z0-9]+)")).Groups[1].Value
$pk = $parsed.pk
Write-Host "cs=$cs"
Write-Host "pk=$pk"

# Now call stripe_billing.py
$body2 = @{ cs_id=$cs; pk=$pk; country="US"; currency="USD"; street="1234 Main St"; city="Austin"; state="TX"; zip="78701"; proxy="http://127.0.0.1:7890" } | ConvertTo-Json -Compress
$body2 | py -3 E:\workspace\projects\demo\chatgpt-auto-login\stripe_billing.py
```

Expected outcomes (任一即说明协议跑通)：
- `{"status":"success","data":{"paypal_redirect_url":"https://www.paypal.com/...","payment_intent_id":"pi_..."}}`
- 或 `{"status":"error","reason":"stripe_billing_4xx","body":"..."}` 含具体 Stripe 错误信息（说明请求到了 Stripe）

不期望：`{"status":"error","reason":"confirm_fetch: ..."}`（说明网络层没通；检查 7890 主代理）。

- [ ] **Step 4: 若 Smoke 出 4xx，迭代调整 form_data**

如果 step 3 拿到 4xx 但 body 显示 Stripe 报 "missing parameter X" 之类，回到 `card/_monolith.py:7499` 附近读更精确的 form 字段构造，调整 `form_data` 字典，重跑 step 3。允许迭代 3-5 次直到拿到 success 或确定 reason 是非协议问题（如 cs_live 已被消耗）。

- [ ] **Step 5: Commit**

```bash
git add stripe_billing.py
git commit -m "feat(v3.0.0): add stripe_billing.py for HTTP Stripe confirm + PayPal redirect

Submits Stripe checkout confirm endpoint with billing details, parses
next_action.redirect_to_url to get PayPal agreement URL. Replaces
Playwright OpenAI-page DOM fill + click PayPal flow.

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:7499 (confirm)
           + :7012 (_handle_paypal_redirect extraction)."
```

---

## Task 2: `server/stripe-billing.js` + 单测

**Files:**
- Create: `server/stripe-billing.js`
- Create: `server/__tests__/stripe-billing.test.js`

- [ ] **Step 1: 写测试 RED**

新建 `server/__tests__/stripe-billing.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { validateBillingInput, parseStripeResponse } = require('../stripe-billing');

test('validateBillingInput: 完整合法输入返回 null', () => {
  const input = { cs_id: 'cs_live_a1abc', pk: 'pk_live_51XYZ', country: 'US', street: '1', city: 'A', state: 'TX', zip: '78701' };
  assert.strictEqual(validateBillingInput(input), null);
});

test('validateBillingInput: 缺 cs_id 返回 invalid_link', () => {
  const input = { pk: 'pk_live_51XYZ', country: 'US' };
  assert.strictEqual(validateBillingInput(input), 'invalid_link');
});

test('validateBillingInput: pk 格式不对返回 invalid_pk', () => {
  const input = { cs_id: 'cs_live_a1abc', pk: 'sk_live_xxx' };
  assert.strictEqual(validateBillingInput(input), 'invalid_pk');
});

test('parseStripeResponse: success 含 paypal_redirect_url', () => {
  const r = parseStripeResponse({ status: 'success', data: { paypal_redirect_url: 'https://paypal.com/x', payment_intent_id: 'pi_1' } });
  assert.deepStrictEqual(r, { ok: true, paypal_redirect_url: 'https://paypal.com/x', payment_intent_id: 'pi_1' });
});

test('parseStripeResponse: error 透传 reason', () => {
  const r = parseStripeResponse({ status: 'error', reason: 'stripe_billing_400', body: 'oops' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stripe_billing_400');
});

test('parseStripeResponse: 缺 status 字段返回 ok=false reason=unparsable', () => {
  const r = parseStripeResponse({ data: { paypal_redirect_url: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unparsable');
});
```

- [ ] **Step 2: Run tests verify RED**

Run: `node --test server/__tests__/stripe-billing.test.js`
Expected: 6 tests FAIL with `Cannot find module '../stripe-billing'`.

- [ ] **Step 3: 写 `server/stripe-billing.js`**

新建 `server/stripe-billing.js`：

```js
// Spawn stripe_billing.py to POST Stripe confirm endpoint via main proxy (7890 US).
// Returns the PayPal redirect URL for Phase 3b RPA.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'stripe_billing.py');
const TIMEOUT_MS = 25000;

function validateBillingInput(input) {
  if (!input || typeof input !== 'object') return 'invalid_link';
  const cs = input.cs_id;
  const pk = input.pk;
  if (typeof cs !== 'string' || !/^cs_live_[A-Za-z0-9]+$/.test(cs)) return 'invalid_link';
  if (typeof pk !== 'string' || !/^pk_live_[A-Za-z0-9]+$/.test(pk)) return 'invalid_pk';
  return null;
}

function parseStripeResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return {
      ok: true,
      paypal_redirect_url: data.paypal_redirect_url,
      payment_intent_id: data.payment_intent_id || null,
    };
  }
  return { ok: false, reason: parsed.reason || 'stripe_billing_error', raw: parsed.body };
}

function submitStripeBilling(payLink, pk, billing) {
  return new Promise((resolve) => {
    const csMatch = (payLink || '').match(/\/c\/pay\/(cs_live_[A-Za-z0-9]+)/);
    if (!csMatch) {
      resolve({ ok: false, reason: 'invalid_link' });
      return;
    }
    const input = {
      cs_id: csMatch[1],
      pk,
      country: billing.country || 'US',
      currency: billing.currency || 'USD',
      street: billing.street,
      city: billing.city,
      state: billing.state,
      zip: billing.zip,
      proxy: proxyMgr.getProxyUrl() || '',
    };
    const validation = validateBillingInput(input);
    if (validation) {
      resolve({ ok: false, reason: validation });
      return;
    }

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parseStripeResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { validateBillingInput, parseStripeResponse, submitStripeBilling };
```

- [ ] **Step 4: Run tests verify GREEN**

Run: `node --test server/__tests__/stripe-billing.test.js`
Expected: `# pass 6, # fail 0`.

- [ ] **Step 5: 跑回归测试**

```powershell
node --test server/__tests__/stripe-verify.test.js server/__tests__/chatgpt-checkout.test.js server/__tests__/stripe-billing.test.js server/proxy/__tests__/index.test.js server/proxy/__tests__/subscription.test.js
```

Expected: `# pass 37, # fail 0`（v2.19 既有 31 + 新增 6）。

- [ ] **Step 6: Commit**

```bash
git add server/stripe-billing.js server/__tests__/stripe-billing.test.js
git commit -m "feat(v3.0.0): add server/stripe-billing.js with validateBillingInput/parseStripeResponse

submitStripeBilling(payLink, pk, billing) spawns stripe_billing.py via
main proxy. Pure helpers tested by 6 node:test cases. The spawn/IO
path is exercised by E2E in Task 12."
```

---

## Task 3: `pkce_oauth.py` — PKCE OAuth HTTP 流

**Files:**
- Create: `pkce_oauth.py`
- Reference: `Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:5253-5254` (code_challenge) + `:5560` (code_verifier), 现有 `engine.js fetchTokensViaPKCE` (找 client_id 常量)

- [ ] **Step 1: 找现有 fetchTokensViaPKCE 的常量**

`grep -rn "fetchTokensViaPKCE\|client_id\|app_X" server/ *.js` 找到当前 Playwright 路径里写的 `client_id`、`redirect_uri`、`scope`，复制到下面的 Python 脚本里。如果 grep 没命中，去 `Gpt-Agreement-Payment/CTF-pay/card/_monolith.py` 找 `client_id` 字符串常量。

- [ ] **Step 2: 写 `pkce_oauth.py`**

```python
#!/usr/bin/env python3
"""Perform PKCE OAuth code-flow against auth.openai.com to exchange access_token for refresh_token.

Input: JSON on stdin  { access_token, client_id, redirect_uri, scope, proxy }
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

PKCE protocol:
  1. Generate code_verifier (32 random bytes, base64url) + code_challenge (sha256, base64url)
  2. GET https://auth.openai.com/authorize?... &code_challenge=...&code_challenge_method=S256
     Header: Authorization: Bearer <access_token>
     Expect 302 redirect to redirect_uri?code=<auth_code>&state=<state>
  3. POST https://auth.openai.com/oauth/token (form-urlencoded)
     grant_type=authorization_code, code=<auth_code>, code_verifier=<verifier>, client_id, redirect_uri
     Response: { access_token, refresh_token, id_token, ... }

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:5253-5560.
"""
import sys, json, hashlib, base64, secrets, random
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_AUTH_HOST = "https://auth.openai.com"


def _log(m):
    print(json.dumps({"log": f"  [PKCE] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def _gen_pkce():
    verifier_bytes = secrets.token_bytes(32)
    verifier = _b64url(verifier_bytes)
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "bad_input", "detail": str(e)[:80]})
        return

    access_token = inp.get('access_token', '')
    client_id = inp.get('client_id', '')
    redirect_uri = inp.get('redirect_uri', '')
    scope = inp.get('scope', 'openid email profile offline_access')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None

    if not access_token or not access_token.startswith("eyJ"):
        _emit({"status": "error", "reason": "invalid_access_token"})
        return
    if not client_id or not redirect_uri:
        _emit({"status": "error", "reason": "missing_oauth_config"})
        return

    verifier, challenge = _gen_pkce()
    state = secrets.token_urlsafe(16)
    imp = random.choice(_CHROME)
    _log(f"impersonate={imp}, client_id={client_id[:20]}...")

    # Step 1: GET /authorize, expect 302 redirect with code
    auth_params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scope,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    try:
        auth_resp = cr.get(
            f"{_AUTH_HOST}/authorize",
            params=auth_params,
            headers={"Authorization": f"Bearer {access_token}"},
            impersonate=imp,
            proxies=proxies,
            timeout=15,
            allow_redirects=False,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"authorize_fetch: {str(e)[:80]}"})
        return

    if auth_resp.status_code not in (301, 302, 303):
        _emit({"status": "error", "reason": f"authorize_{auth_resp.status_code}", "body": auth_resp.text[:300]})
        return
    redirect_location = auth_resp.headers.get("location") or auth_resp.headers.get("Location")
    if not redirect_location:
        _emit({"status": "error", "reason": "no_redirect_location"})
        return
    _log(f"authorize redirect: {redirect_location[:80]}...")

    # Parse code from redirect URL fragment or query
    import re as _re
    code_match = _re.search(r"[?&]code=([^&]+)", redirect_location)
    if not code_match:
        _emit({"status": "error", "reason": "no_code_in_redirect", "body": redirect_location[:200]})
        return
    auth_code = code_match.group(1)

    # Step 2: POST /oauth/token
    token_form = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "code_verifier": verifier,
        "client_id": client_id,
        "redirect_uri": redirect_uri,
    }
    try:
        token_resp = cr.post(
            f"{_AUTH_HOST}/oauth/token",
            data=token_form,
            impersonate=imp,
            proxies=proxies,
            timeout=15,
        )
    except Exception as e:
        _emit({"status": "error", "reason": f"token_fetch: {str(e)[:80]}"})
        return

    if token_resp.status_code != 200:
        _emit({"status": "error", "reason": f"token_exchange_{token_resp.status_code}", "body": token_resp.text[:300]})
        return
    try:
        tokens = token_resp.json()
    except Exception:
        _emit({"status": "error", "reason": "token_not_json", "body": token_resp.text[:300]})
        return

    rt = tokens.get("refresh_token")
    at = tokens.get("access_token")
    if not rt:
        _emit({"status": "error", "reason": "no_refresh_token", "body": json.dumps(tokens)[:300]})
        return

    _log(f"refresh_token obtained: {rt[:20]}...")
    _emit({"status": "success", "data": {
        "access_token": at,
        "refresh_token": rt,
        "id_token": tokens.get("id_token"),
    }})


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke test**

```powershell
$token = (Get-Content E:\workspace\projects\demo\chatgpt-auto-login\token-osxti6295.txt -Raw).Trim()
# Replace with the actual client_id / redirect_uri found in step 1.
$body = @{
  access_token = $token
  client_id    = "<paste from grep>"
  redirect_uri = "<paste from grep>"
  scope        = "openid email profile offline_access"
  proxy        = "http://127.0.0.1:7890"
} | ConvertTo-Json -Compress
$body | py -3 E:\workspace\projects\demo\chatgpt-auto-login\pkce_oauth.py
```

Expected:
- success with refresh_token: `{"status":"success","data":{"refresh_token":"..." ...}}`
- 或 `{"status":"error","reason":"authorize_4xx",...}` 含 OpenAI 错误信息（说明协议触达了；可能 osxti 的 access_token 已被消耗或 OAuth client_id 写错）

- [ ] **Step 4: Commit**

```bash
git add pkce_oauth.py
git commit -m "feat(v3.0.0): add pkce_oauth.py for HTTP PKCE OAuth code flow

Generates code_verifier+challenge, GETs auth.openai.com/authorize with
Bearer access_token to receive 302 redirect with auth code, POSTs
auth.openai.com/oauth/token with code+verifier to exchange for
refresh_token.

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:5253-5560
+ existing fetchTokensViaPKCE constants (client_id/redirect_uri/scope)."
```

---

## Task 4: `server/pkce-oauth.js` + 单测

**Files:**
- Create: `server/pkce-oauth.js`
- Create: `server/__tests__/pkce-oauth.test.js`

- [ ] **Step 1: 写测试 RED**

```js
const test = require('node:test');
const assert = require('node:assert');
const { extractAuthCode, parsePkceResponse } = require('../pkce-oauth');

test('extractAuthCode: 标准 query 提取 code', () => {
  assert.strictEqual(extractAuthCode('https://app/cb?code=abc123&state=xyz'), 'abc123');
});

test('extractAuthCode: code 在 fragment 也能拿到', () => {
  assert.strictEqual(extractAuthCode('https://app/cb#code=abc123'), 'abc123');
});

test('extractAuthCode: 无 code 返回 null', () => {
  assert.strictEqual(extractAuthCode('https://app/cb?error=denied'), null);
});

test('extractAuthCode: 空/null 安全返回 null', () => {
  assert.strictEqual(extractAuthCode(''), null);
  assert.strictEqual(extractAuthCode(null), null);
});

test('parsePkceResponse: success → ok:true + refresh_token', () => {
  const r = parsePkceResponse({ status: 'success', data: { access_token: 'a', refresh_token: 'b', id_token: 'c' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refresh_token, 'b');
});

test('parsePkceResponse: error 透传 reason', () => {
  const r = parsePkceResponse({ status: 'error', reason: 'token_exchange_400' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'token_exchange_400');
});
```

- [ ] **Step 2: Run tests RED**

Run: `node --test server/__tests__/pkce-oauth.test.js`
Expected: 6 FAIL with `Cannot find module '../pkce-oauth'`.

- [ ] **Step 3: 写 `server/pkce-oauth.js`**

```js
// Spawn pkce_oauth.py to perform PKCE OAuth code flow via main proxy.
// Returns refresh_token compatible with existing saveCPAAuthFile() shape.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'pkce_oauth.py');
const TIMEOUT_MS = 25000;

// OAuth client constants — paste from grep result in Task 3 Step 1.
// If those aren't yet known, leave as env-var fallback for ops to set.
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || '';
const OAUTH_SCOPE = process.env.OAUTH_SCOPE || 'openid email profile offline_access';

function extractAuthCode(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/[?&#]code=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function parsePkceResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return {
      ok: true,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      id_token: data.id_token,
    };
  }
  return { ok: false, reason: parsed.reason || 'pkce_error', raw: parsed.body };
}

function fetchPkceTokensProtocol(accessToken, account) {
  return new Promise((resolve) => {
    if (!OAUTH_CLIENT_ID || !OAUTH_REDIRECT_URI) {
      resolve({ ok: false, reason: 'missing_oauth_config' });
      return;
    }
    const input = {
      access_token: accessToken,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPE,
      proxy: proxyMgr.getProxyUrl() || '',
    };

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parsePkceResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { extractAuthCode, parsePkceResponse, fetchPkceTokensProtocol };
```

- [ ] **Step 4: Run tests verify GREEN**

Run: `node --test server/__tests__/pkce-oauth.test.js`
Expected: `# pass 6, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/pkce-oauth.js server/__tests__/pkce-oauth.test.js
git commit -m "feat(v3.0.0): add server/pkce-oauth.js with extractAuthCode/parsePkceResponse

fetchPkceTokensProtocol(accessToken, account) spawns pkce_oauth.py.
Return shape aligns with existing fetchTokensViaPKCE so downstream
saveCPAAuthFile() needs no change."
```

---

## Task 5: `manual_approval.py` — HTTP 订阅激活确认

**Files:**
- Create: `manual_approval.py`
- Reference: `Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:6712-7092` (agreements/approve), `/backend-api/me` 或 `/billing/subscription` 端点

- [ ] **Step 1: 写 `manual_approval.py`**

```python
#!/usr/bin/env python3
"""Confirm ChatGPT Plus subscription activation after PayPal redirect.

Input: JSON on stdin  { access_token, approval_url, proxy, poll_interval_ms, max_wait_ms }
Output: JSON line on stdout — log lines as {"log":"..."}, final as {"status":...}

Flow:
  1. GET approval_url with Bearer access_token (follow redirects within reason).
  2. Poll https://chatgpt.com/backend-api/me every poll_interval_ms (default 2000)
     until plan_type == 'plus' or max_wait_ms (default 30000) elapsed.

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:6712-7092.
"""
import sys, json, time, random
from curl_cffi import requests as cr

_CHROME = ['chrome146', 'chrome142', 'chrome136', 'chrome133a', 'chrome131', 'chrome124']
_CHATGPT_API = "https://chatgpt.com/backend-api"


def _log(m):
    print(json.dumps({"log": f"  [Approval] {m}"}), flush=True)


def _emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    try:
        inp = json.loads(sys.stdin.read())
    except Exception as e:
        _emit({"status": "error", "reason": "bad_input", "detail": str(e)[:80]})
        return

    access_token = inp.get('access_token', '')
    approval_url = inp.get('approval_url', '')
    proxy = inp.get('proxy') or None
    proxies = {'http': proxy, 'https': proxy} if proxy else None
    poll_interval_ms = int(inp.get('poll_interval_ms', 2000))
    max_wait_ms = int(inp.get('max_wait_ms', 30000))

    if not access_token or not access_token.startswith("eyJ"):
        _emit({"status": "error", "reason": "invalid_access_token"})
        return
    if not approval_url:
        _emit({"status": "error", "reason": "missing_approval_url"})
        return

    imp = random.choice(_CHROME)
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}

    # Step 1: GET approval URL to trigger ChatGPT-side commit.
    try:
        r = cr.get(approval_url, headers=headers, impersonate=imp, proxies=proxies,
                   timeout=15, allow_redirects=True)
    except Exception as e:
        _emit({"status": "error", "reason": f"approve_fetch: {str(e)[:80]}"})
        return
    _log(f"approval HTTP {r.status_code}, final URL: {r.url[:80]}")
    if r.status_code >= 400:
        _emit({"status": "error", "reason": f"approve_http_{r.status_code}", "body": r.text[:300]})
        return

    # Step 2: Poll /backend-api/me until plan flips to plus.
    deadline = time.time() + max_wait_ms / 1000.0
    last_plan = None
    while time.time() < deadline:
        try:
            me = cr.get(f"{_CHATGPT_API}/me", headers=headers, impersonate=imp,
                        proxies=proxies, timeout=10)
        except Exception as e:
            _log(f"me poll error (continuing): {str(e)[:60]}")
            time.sleep(poll_interval_ms / 1000.0)
            continue
        if me.status_code != 200:
            _log(f"me HTTP {me.status_code} (continuing)")
            time.sleep(poll_interval_ms / 1000.0)
            continue
        try:
            data = me.json()
        except Exception:
            time.sleep(poll_interval_ms / 1000.0)
            continue
        # The exact field varies. Try common shapes; reference _monolith.py for current truth.
        plan = (data.get("plan_type") or data.get("chatgpt_plan_type") or
                (data.get("accounts") or [{}])[0].get("plan_type") or "")
        last_plan = plan
        _log(f"poll plan_type={plan}")
        if plan and plan.lower() in ("plus", "pro", "team", "enterprise"):
            _emit({"status": "success", "data": {"plan_type": plan, "is_subscribed": True}})
            return
        time.sleep(poll_interval_ms / 1000.0)

    _emit({"status": "error", "reason": "no_plus_after_timeout", "body": f"last_plan={last_plan}"})


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Commit**

```bash
git add manual_approval.py
git commit -m "feat(v3.0.0): add manual_approval.py for HTTP subscription activation polling

GETs the chatgpt.com agreement approval URL with Bearer access_token
to trigger ChatGPT-side commit, then polls /backend-api/me every 2s
(up to 30s) until plan_type flips to plus.

Reference: Gpt-Agreement-Payment/CTF-pay/card/_monolith.py:6712-7092.
Smoke test requires a real PayPal-approved session, deferred to E2E
in Task 12."
```

---

## Task 6: `server/manual-approval.js` + 单测

**Files:**
- Create: `server/manual-approval.js`
- Create: `server/__tests__/manual-approval.test.js`

- [ ] **Step 1: 写测试 RED**

```js
const test = require('node:test');
const assert = require('node:assert');
const { validateApprovalInput, parseApprovalResponse } = require('../manual-approval');

test('validateApprovalInput: 合法返回 null', () => {
  assert.strictEqual(
    validateApprovalInput({ access_token: 'eyJ123', approval_url: 'https://chatgpt.com/agreements/approve?token=x' }),
    null
  );
});

test('validateApprovalInput: 缺 access_token 返回 invalid_access_token', () => {
  assert.strictEqual(
    validateApprovalInput({ approval_url: 'https://x' }),
    'invalid_access_token'
  );
});

test('validateApprovalInput: 缺 approval_url 返回 missing_approval_url', () => {
  assert.strictEqual(
    validateApprovalInput({ access_token: 'eyJ123' }),
    'missing_approval_url'
  );
});

test('parseApprovalResponse: success → ok=true + plan_type', () => {
  const r = parseApprovalResponse({ status: 'success', data: { plan_type: 'plus', is_subscribed: true } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plan_type, 'plus');
  assert.strictEqual(r.is_subscribed, true);
});

test('parseApprovalResponse: timeout 失败透传', () => {
  const r = parseApprovalResponse({ status: 'error', reason: 'no_plus_after_timeout', body: 'last_plan=free' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_plus_after_timeout');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test server/__tests__/manual-approval.test.js`
Expected: 5 FAIL.

- [ ] **Step 3: 写 `server/manual-approval.js`**

```js
// Spawn manual_approval.py to confirm ChatGPT Plus subscription activation.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'manual_approval.py');
const TIMEOUT_MS = 45000;  // > Python's 30s poll cap, gives margin

function validateApprovalInput(input) {
  if (!input || typeof input !== 'object') return 'invalid_access_token';
  if (typeof input.access_token !== 'string' || !input.access_token.startsWith('eyJ')) {
    return 'invalid_access_token';
  }
  if (typeof input.approval_url !== 'string' || !input.approval_url) {
    return 'missing_approval_url';
  }
  return null;
}

function parseApprovalResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return { ok: true, plan_type: data.plan_type, is_subscribed: !!data.is_subscribed };
  }
  return { ok: false, reason: parsed.reason || 'approval_error', raw: parsed.body };
}

function confirmSubscriptionActivation(accessToken, approvalUrl) {
  return new Promise((resolve) => {
    const input = {
      access_token: accessToken,
      approval_url: approvalUrl,
      proxy: proxyMgr.getProxyUrl() || '',
      poll_interval_ms: 2000,
      max_wait_ms: 30000,
    };
    const validation = validateApprovalInput(input);
    if (validation) {
      resolve({ ok: false, reason: validation });
      return;
    }

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parseApprovalResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { validateApprovalInput, parseApprovalResponse, confirmSubscriptionActivation };
```

- [ ] **Step 4: Run tests GREEN**

Run: `node --test server/__tests__/manual-approval.test.js`
Expected: `# pass 5, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/manual-approval.js server/__tests__/manual-approval.test.js
git commit -m "feat(v3.0.0): add server/manual-approval.js with validateApprovalInput/parseApprovalResponse"
```

---

## Task 7: `paypal_rpa.js` — 隔离的 PayPal Node RPA

**Files:**
- Create: `paypal_rpa.js`
- Reference: `payment.js` 当前的 PayPal 段落 (v2.14 baseline 已 confirmed working); `Gpt-Agreement-Payment/CTF-pay/scripts/paypal_node_rpa.js`

- [ ] **Step 1: 找 payment.js 的 PayPal 段**

打开 `payment.js`，定位 "PayPal login page detected" 开头到 "redirect_status=succeeded" 之间的整段（约 200-400 行，含 PayPal email 填、submit、checkout 12 字段填、SMS poll/fill、approve 等待）。复制成下面 paypal_rpa.js 的内部逻辑模板。

- [ ] **Step 2: 写 `paypal_rpa.js`**

```js
#!/usr/bin/env node
/**
 * paypal_rpa.js — Isolated PayPal sub-flow RPA via headed Chromium.
 *
 * Spawned as a Node subprocess by server/paypal-rpa.js. Owns its own
 * Chromium instance with playwright-core, isolated profile dir per
 * invocation. Returns the chatgpt.com agreement approval URL once
 * PayPal completes its handoff back.
 *
 * stdin:  JSON  { paypal_url, phone, sms_api_url, proxy, worker_id, approval_url_pattern }
 * stdout: single JSON line  { status:'success'|'error', data?:{chatgpt_approval_url}, reason? }
 * stderr: human log lines
 *
 * Reference: Gpt-Agreement-Payment/CTF-pay/scripts/paypal_node_rpa.js
 *            payment.js v2.14 baseline (current repo) for PayPal selector logic.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

function log(msg) { console.error(`[PayPalRPA] ${msg}`); }

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.on('data', (chunk) => { buf += chunk.toString(); });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function fetchSmsCode(smsApiUrl, attemptsMax = 30, intervalMs = 4000) {
  for (let i = 0; i < attemptsMax; i++) {
    try {
      const r = await fetch(smsApiUrl);
      const text = await r.text();
      const m = text.match(/(\d{6})/);
      if (m) {
        log(`SMS attempt ${i + 1}: got ${m[1]}`);
        return m[1];
      }
    } catch (e) {
      log(`SMS attempt ${i + 1} error: ${e.message?.slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function runPayPalFlow(page, opts) {
  log('Phase: navigate to PayPal URL');
  await page.goto(opts.paypal_url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // === PayPal login (transcribed from payment.js v2.14 PayPal section) ===
  // The transcription below is a structural skeleton. Detailed selectors
  // come from payment.js's autoPayment PayPal section — paste-adapt them here.
  log('Phase: PayPal login');
  // example structure:
  // await page.fill('#email', randomEmail());
  // await page.click('#btnNext');
  // ... password, login submit ...

  // === PayPal checkout 12 fields ===
  log('Phase: PayPal checkout 12 fields');
  // await page.selectOption('#country', 'US');
  // await page.fill('#email', ...);
  // await page.fill('#phone', opts.phone);
  // await page.fill('#cardNumber', randCard().number);
  // ... fill all 12 fields sequentially (the v2.14 known-good order) ...
  // await page.click('button[type=submit]');

  // === SMS verification ===
  log('Phase: SMS verification');
  const smsDialog = await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: 30000 }).catch(() => null);
  if (smsDialog) {
    const code = await fetchSmsCode(opts.sms_api_url);
    if (!code) throw new Error('sms_fetch_fail');
    // Fill individual code boxes (v2.14 logic)
    // await page.fill('input[name=otp]', code) -- adapt to actual selectors
    log('SMS code filled');
  }

  // === Wait for redirect back to chatgpt.com ===
  log(`Phase: waiting for ${opts.approval_url_pattern}`);
  const approvalUrlPattern = new RegExp(opts.approval_url_pattern);
  await page.waitForURL(approvalUrlPattern, { timeout: 120000 });
  const approvalUrl = page.url();
  log(`Got approval URL: ${approvalUrl.slice(0, 80)}`);
  return approvalUrl;
}

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', reason: 'bad_input', detail: e.message }));
    process.exit(0);
  }

  const tempDir = path.join(
    os.tmpdir(),
    `paypal-rpa-${(input.worker_id || '').replace(/[^A-Za-z0-9_-]/g, '') || Date.now()}`
  );

  let context;
  try {
    context = await chromium.launchPersistentContext(tempDir, {
      headless: false,
      proxy: input.proxy ? { server: input.proxy } : undefined,
      viewport: { width: 1280, height: 800 },
    });
    const page = context.pages()[0] || (await context.newPage());
    const approvalUrl = await runPayPalFlow(page, input);
    console.log(JSON.stringify({ status: 'success', data: { chatgpt_approval_url: approvalUrl } }));
  } catch (e) {
    let reason = 'paypal_rpa_error';
    if (/sms_fetch_fail/.test(e.message)) reason = 'sms_fetch_fail';
    else if (/Timeout.*waiting for navigation/.test(e.message)) reason = 'approval_timeout';
    console.log(JSON.stringify({ status: 'error', reason, detail: e.message?.slice(0, 200) }));
  } finally {
    if (context) await context.close().catch(() => {});
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
})();
```

> **Implementer 任务**: 在 `runPayPalFlow` 内的 3 个 phase 段（`// === ...`）里，把 `payment.js` 当前 PayPal 部分的**完整 selectors + 顺序逻辑**移植进来。不要并行 `Promise.all` —— 用 v2.14 baseline 的 SEQUENTIAL 顺序填法。其他选择器（如 `randomEmail()`, `randCard()` 等）也从 `payment.js` 抽进 paypal_rpa.js 自包含。

- [ ] **Step 3: Smoke 跳过（依赖完整 E2E，留 Task 12）**

paypal_rpa.js 的 smoke test 需要真 PayPal session — deferred to E2E in Task 12。

- [ ] **Step 4: Commit**

```bash
git add paypal_rpa.js
git commit -m "feat(v3.0.0): add paypal_rpa.js for isolated PayPal sub-flow RPA

Runs in a separate Node subprocess via playwright-core (headed Chromium,
fresh profile dir each invocation). Ported from payment.js v2.14 baseline
PayPal section (sequential field fills, SMS polling, redirect detection).

Server main process now has zero Chrome contact for the PayPal stage —
crashes of the PayPal flow no longer destabilize the server.

Reference: Gpt-Agreement-Payment/CTF-pay/scripts/paypal_node_rpa.js."
```

---

## Task 8: `server/paypal-rpa.js` + 单测

**Files:**
- Create: `server/paypal-rpa.js`
- Create: `server/__tests__/paypal-rpa.test.js`

- [ ] **Step 1: 写测试 RED**

```js
const test = require('node:test');
const assert = require('node:assert');
const { validateRpaInput, parseRpaResponse } = require('../paypal-rpa');

test('validateRpaInput: 合法 input 返回 null', () => {
  assert.strictEqual(
    validateRpaInput({ paypal_url: 'https://www.paypal.com/agreements/approve?ba=x', phone: '4642840651', sms_api_url: 'http://...', proxy: 'http://127.0.0.1:7890', approval_url_pattern: 'chatgpt\\.com' }),
    null
  );
});

test('validateRpaInput: 缺 paypal_url 返回 missing_paypal_url', () => {
  assert.strictEqual(validateRpaInput({ phone: '1', sms_api_url: 'x', approval_url_pattern: 'y' }), 'missing_paypal_url');
});

test('validateRpaInput: paypal_url 非 paypal.com 返回 invalid_paypal_url', () => {
  assert.strictEqual(
    validateRpaInput({ paypal_url: 'https://example.com/x', phone: '1', sms_api_url: 'x', approval_url_pattern: 'y' }),
    'invalid_paypal_url'
  );
});

test('parseRpaResponse: success → ok=true + chatgpt_approval_url', () => {
  const r = parseRpaResponse({ status: 'success', data: { chatgpt_approval_url: 'https://chatgpt.com/agreements/approve?token=x' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.chatgpt_approval_url, 'https://chatgpt.com/agreements/approve?token=x');
});

test('parseRpaResponse: error 透传 reason', () => {
  const r = parseRpaResponse({ status: 'error', reason: 'sms_fetch_fail' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'sms_fetch_fail');
});
```

- [ ] **Step 2: Run tests RED**

Run: `node --test server/__tests__/paypal-rpa.test.js`
Expected: 5 FAIL.

- [ ] **Step 3: 写 `server/paypal-rpa.js`**

```js
// Spawn paypal_rpa.js (Node child) for isolated PayPal sub-flow.
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'paypal_rpa.js');
const TIMEOUT_MS = 180000;  // 3 min cap; PayPal SMS + approval can take 30-90s

function validateRpaInput(input) {
  if (!input || typeof input !== 'object') return 'missing_paypal_url';
  if (typeof input.paypal_url !== 'string' || !input.paypal_url) return 'missing_paypal_url';
  if (!/^https?:\/\/(www\.)?paypal\.com\//.test(input.paypal_url)) return 'invalid_paypal_url';
  if (!input.phone) return 'missing_phone';
  if (!input.sms_api_url) return 'missing_sms_api_url';
  if (!input.approval_url_pattern) return 'missing_approval_url_pattern';
  return null;
}

function parseRpaResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'unparsable' };
  }
  if (parsed.status === 'success') {
    return { ok: true, chatgpt_approval_url: (parsed.data || {}).chatgpt_approval_url };
  }
  return { ok: false, reason: parsed.reason || 'paypal_rpa_error', raw: parsed.detail };
}

function runPayPalRpa(opts) {
  return new Promise((resolve) => {
    const validation = validateRpaInput(opts);
    if (validation) {
      resolve({ ok: false, reason: validation });
      return;
    }

    const node = spawn('node', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      node.kill();
      resolve({ ok: false, reason: 'rpa_timeout' });
    }, TIMEOUT_MS);

    node.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        stdout = line;
      }
    });
    node.stderr.on('data', (d) => {
      stderr += d.toString();
      const text = d.toString().trim();
      if (text) console.log(`  ${text}`);  // surface RPA log lines to server log
    });
    node.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    node.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parseRpaResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'rpa_parse_fail', raw: stderr.slice(-200) }); }
    });
    node.stdin.write(JSON.stringify(opts));
    node.stdin.end();
  });
}

module.exports = { validateRpaInput, parseRpaResponse, runPayPalRpa };
```

- [ ] **Step 4: Run tests GREEN**

Run: `node --test server/__tests__/paypal-rpa.test.js`
Expected: `# pass 5, # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/paypal-rpa.js server/__tests__/paypal-rpa.test.js
git commit -m "feat(v3.0.0): add server/paypal-rpa.js spawner for isolated PayPal RPA Node child

runPayPalRpa(opts) spawns paypal_rpa.js, streams its stderr log lines
into the server log, and parses its single-line JSON stdout result.
Timeout 3 min, fail-fast on validation/spawn errors."
```

---

## Task 9: `payment.js` — fetchAddress export

**Files:**
- Modify: `payment.js`

- [ ] **Step 1: 暴露 fetchAddress (or randomAddress)**

打开 `payment.js`，找到 `fetchAddress` (或同名 `randomAddress` / `getAddress`) 函数定义。在文件末尾的 `module.exports` 中加 export：

如果原来是：
```js
module.exports = { autoPayment };
```
改为：
```js
module.exports = { autoPayment, fetchAddress };
```

如果函数名是别的（如 `randomAddress`），统一暴露并保持原名。

- [ ] **Step 2: 跑全部测试无回归**

Run: `node --test server/__tests__/stripe-verify.test.js server/__tests__/chatgpt-checkout.test.js server/__tests__/stripe-billing.test.js server/__tests__/pkce-oauth.test.js server/__tests__/manual-approval.test.js server/__tests__/paypal-rpa.test.js server/proxy/__tests__/index.test.js server/proxy/__tests__/subscription.test.js`

Expected: 全 PASS。

- [ ] **Step 3: Commit**

```bash
git add payment.js
git commit -m "refactor(v3.0.0): export fetchAddress from payment.js for stripe-billing.js reuse"
```

---

## Task 10: `protocol-engine.js` Phase 3 + Phase 4 重写

**Files:**
- Modify: `protocol-engine.js`

- [ ] **Step 1: 引入 4 个新模块**

打开 `protocol-engine.js`，找到顶部 imports（line 10-15 附近，跟 `fetchCheckoutLink`, `verifyCheckoutIsFree` 同区）。在 `verifyCheckoutIsFree` import 下方加：

```js
const { submitStripeBilling } = require('./server/stripe-billing');
const { runPayPalRpa } = require('./server/paypal-rpa');
const { confirmSubscriptionActivation } = require('./server/manual-approval');
const { fetchPkceTokensProtocol } = require('./server/pkce-oauth');
const { fetchAddress } = require('./payment');
```

- [ ] **Step 2: 更新 summary buckets**

找到 line ~186 的：
```js
const summary = { total: accounts.length, success: 0, noLink: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0 };
```
改为：
```js
const summary = { total: accounts.length, success: 0, noLink: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0, stripeBillingError: 0, activationError: 0 };
```

- [ ] **Step 3: 替换 Phase 3 + Phase 4 整段**

定位 Phase 2.5 之后的整个 Phase 3 (`// Step 3: Payment (fresh Chrome for each account)` 那段)。**整段替换**为：

```js
        // === Phase 3a: Stripe billing (HTTP) ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'stripe-billing', progress });
        console.log(`[${progress}] Phase 3a: Stripe billing (HTTP)...`);
        const billing = fetchAddress();  // reuse payment.js random US address
        const b = await submitStripeBilling(link, fetchResult.pk, billing);
        if (!b.ok) {
          console.log(`[${progress}] Stripe billing failed: ${b.reason}`);
          this.emitStatus({ email: account.email, status: 'stripe_billing_error', phase: 'done', progress, reason: b.reason });
          summary.stripeBillingError++;
          continue;
        }
        console.log(`[${progress}] PayPal URL obtained: ${b.paypal_redirect_url.slice(0, 60)}...`);

        // === Phase 3b: PayPal RPA (isolated Node subprocess) ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'paypal-rpa', progress });
        console.log(`[${progress}] Phase 3b: PayPal RPA...`);
        const phoneSlot = runtimeCfg.phoneSlots?.[0] || { phone: runtimeCfg.phone, smsApiUrl: runtimeCfg.smsApiUrl };
        const payResult = await runPayPalRpa({
          paypal_url: b.paypal_redirect_url,
          phone: phoneSlot.phone,
          sms_api_url: phoneSlot.smsApiUrl,
          proxy: proxyMgr.getProxyUrl(),
          worker_id: `wk-${Date.now()}-${i}`,
          approval_url_pattern: 'chatgpt\\.com/agreements/approve',
        });
        if (!payResult.ok) {
          console.log(`[${progress}] PayPal RPA failed: ${payResult.reason}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'paypal-rpa', progress, reason: payResult.reason });
          summary.error++;
          continue;
        }
        console.log(`[${progress}] PayPal approved, got approval URL`);

        // === Phase 3c: HTTP manual approval ===
        this.emitStatus({ email: account.email, status: 'running', phase: 'activation', progress });
        console.log(`[${progress}] Phase 3c: Confirming subscription activation (HTTP)...`);
        const c = await confirmSubscriptionActivation(result.accessToken, payResult.chatgpt_approval_url);
        if (!c.ok || (c.plan_type || '').toLowerCase() !== 'plus') {
          console.log(`[${progress}] Activation failed: ${c.reason || ('plan_type=' + c.plan_type)}`);
          this.emitStatus({ email: account.email, status: 'activation_error', phase: 'done', progress, reason: c.reason });
          summary.activationError++;
          continue;
        }
        console.log(`[${progress}] ✓ Subscription activated: plan_type=${c.plan_type}`);

        // === Phase 4: HTTP PKCE OAuth ===
        let finalStatus = 'plus_no_rt';
        if (runtimeCfg.enableOAuth) {
          this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
          console.log(`[${progress}] Phase 4: PKCE OAuth (HTTP)...`);
          const pkceTokens = await fetchPkceTokensProtocol(result.accessToken, account);
          if (pkceTokens.ok && pkceTokens.refresh_token) {
            saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
            finalStatus = 'plus';
            console.log(`[${progress}] PKCE success with refresh_token`);
          } else {
            saveCPAAuthFile(account.email, result.accessToken, result.session);
            console.log(`[${progress}] PKCE no refresh_token (${pkceTokens.reason || 'unknown'}), saved without`);
          }
        } else {
          saveCPAAuthFile(account.email, result.accessToken, result.session);
        }

        this.emitStatus({ email: account.email, status: finalStatus, phase: 'done', progress });
        summary.success++;
```

> **Implementer 注意**: 移除原 Phase 3 整段（launchChrome / waitForCDP / page.goto / autoPayment / 等）。Phase 3 的 Chrome 不再由 protocol-engine 管，全部下放到 `paypal_rpa.js` 子进程内自管。也移除 `this._chromeProc` / `this._browser` / `this._tempDir` 在 Phase 3 阶段的相关赋值/清理（这些字段保留在文件其他位置即可）。

- [ ] **Step 4: syntax check**

```bash
node --check protocol-engine.js
```
Expected: 无输出，exit 0。

- [ ] **Step 5: Commit**

```bash
git add protocol-engine.js
git commit -m "feat(v3.0.0): rewrite protocol-engine.js Phase 3+4 with HTTP protocols and PayPal RPA

Phase 3a: HTTP Stripe billing via submitStripeBilling → PayPal URL
Phase 3b: isolated PayPal RPA subprocess via runPayPalRpa
Phase 3c: HTTP subscription activation via confirmSubscriptionActivation
Phase 4: HTTP PKCE via fetchPkceTokensProtocol

Server main process no longer launches Chrome at all in protocolMode=true;
only paypal_rpa.js subprocess does. Two new status codes wired into the
summary: stripe_billing_error, activation_error."
```

---

## Task 11: Web Dashboard 2 新状态

**Files:**
- Modify: `web/src/status.js`
- Modify: `web/src/views/Dashboard.vue`
- Modify: `web/src/views/Accounts.vue`
- Modify: `web/src/views/Execute.vue`
- Modify: `web/src/views/Results.vue`

- [ ] **Step 1: web/src/status.js 加 2 entry**

TYPE_MAP 末尾追加：
```js
  stripe_billing_error: 'danger',
  activation_error: 'danger',
```

LABEL_MAP 末尾追加：
```js
  stripe_billing_error: 'Stripe计费失败',
  activation_error: '订阅激活超时',
```

ERROR_STATUSES 不动（这两个可重试，跟 no_jp_proxy/verify_error 一类，不归入默认 error 集）。

- [ ] **Step 2: Dashboard.vue 加 KPI 第三行（2 卡）**

在 v2.19 加的"第二行 3 卡"`</el-row>` 之后，插入：

```html
    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="12">
        <el-card shadow="hover">
          <div style="font-size:28px;font-weight:bold;color:#f56c6c">{{ stats.stripeBillingError }}</div>
          <div style="color:#909399;margin-top:8px">Stripe 计费失败</div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="hover">
          <div style="font-size:28px;font-weight:bold;color:#f56c6c">{{ stats.activationError }}</div>
          <div style="color:#909399;margin-top:8px">订阅激活超时</div>
        </el-card>
      </el-col>
    </el-row>
```

`stats` reactive 加 2 字段：
```js
const stats = reactive({ total: 0, plus: 0, success: 0, error: 0, noJpProxy: 0, noPromo: 0, verifyError: 0, stripeBillingError: 0, activationError: 0 })
```

`onMounted` 内统计加：
```js
    stats.stripeBillingError = statuses.filter(r => r.status === 'stripe_billing_error').length
    stats.activationError = statuses.filter(r => r.status === 'activation_error').length
```

- [ ] **Step 3: Accounts.vue / Execute.vue / Results.vue 加 2 option**

各 `.vue` 文件的 statusFilter `<el-select>` 在 v2.19 加的 3 个之后追加：

```html
          <el-option label="Stripe计费失败" value="stripe_billing_error" />
          <el-option label="订阅激活超时" value="activation_error" />
```

- [ ] **Step 4: 前端 build**

```powershell
cd web; npm run build; cd ..
```
Expected: build 成功，无 Vue 编译错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/status.js web/src/views/Dashboard.vue web/src/views/Accounts.vue web/src/views/Execute.vue web/src/views/Results.vue
git commit -m "feat(v3.0.0): web dashboard support for stripe_billing_error / activation_error

- status.js: 2 new TYPE_MAP/LABEL_MAP entries (both 'danger')
- Dashboard.vue: third KPI row with 2 cards (span 12 each)
- Accounts/Execute/Results.vue: 2 new status filter options"
```

---

## Task 12: CHANGELOG + 端到端验证 + tag v3.0.0

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 写 CHANGELOG v3.0.0 entry**

在 `# Changelog` 标题之下、`## v2.19.1` 之上插入：

```markdown
## v3.0.0 — 2026-05-23

### Protocol Expansion: 99% HTTP + isolated PayPal RPA

参考 `Gpt-Agreement-Payment` 的协议重放范式，把 Stripe billing / manual approval / PKCE OAuth 三个原本走 Playwright 的环节协议化为 HTTP（curl_cffi），同时把 PayPal sub-flow 抽到独立 Node 子进程 (`paypal_rpa.js`) 用 `playwright-core` headed Chromium 跑。

**核心改动**（仅作用于 `protocolMode: true` 路径，PipelineEngine 完全不动）：

- **Phase 3a HTTP Stripe billing**：`stripe_billing.py` + `server/stripe-billing.js` 调用 Stripe `/v1/payment_pages/{cs}/confirm`，提取 `next_action.redirect_to_url` 拿 PayPal URL。**消除 Chrome 在 OpenAI Stripe 页 5-10s 启动+填表开销**。
- **Phase 3b PayPal RPA 隔离**：`paypal_rpa.js` 独立 Node 子进程，自管 headed Chromium 生命周期。Server 主进程零 Chrome 接触；子进程崩溃不影响 server。
- **Phase 3c HTTP manual approval**：`manual_approval.py` + `server/manual-approval.js` GET PayPal 回调 URL + Poll `/backend-api/me`，节省 Chrome 等 ChatGPT 激活的 5-15s。
- **Phase 4 HTTP PKCE OAuth**：`pkce_oauth.py` + `server/pkce-oauth.js` 标准 PKCE code-flow，全 HTTP。

**新增 status**：
| status | type | label | retryable |
|---|---|---|---|
| `stripe_billing_error` | danger | Stripe 计费失败 | ✅ |
| `activation_error` | danger | 订阅激活超时 | ✅ |

**单测**：4 个新模块各 5-6 cases（共 ~22 新测），既有 v2.19 测试无回归。

**对照 v2.x**：
- v2.18.x: JP-KDDI 双入口 + country=US/USD
- v2.19.0/.1: Stripe init verify + payment.js v2.14 rollback
- **v3.0.0**: HTTP-first，主进程零 Chrome（仅 paypal_rpa 子进程）

**架构灵感**：`E:\workspace\projects\Gpt-Agreement-Payment` (9551 行 monolith + RPA 隔离范本)。

**E2E 验证清单**（待运维实际跑）：
- [ ] `osxti6295` → `protocolMode=true` → 预期 `plus` 或 `plus_no_rt`（完整链路成功）
- [ ] `gexi4056685` → 预期 `no_promo`（Phase 2.5 仍正确拦截，未受 v3 影响）
- [ ] `protocolMode=false` → PipelineEngine 跑 osxti → 行为等同 v2.19.1（验证 engine.js 未被影响）
- [ ] 故障注入 Stripe 不可达 → `stripe_billing_error`
```

- [ ] **Step 2: 跑全部测试**

```powershell
node --test server/__tests__/stripe-verify.test.js server/__tests__/chatgpt-checkout.test.js server/__tests__/stripe-billing.test.js server/__tests__/pkce-oauth.test.js server/__tests__/manual-approval.test.js server/__tests__/paypal-rpa.test.js server/proxy/__tests__/index.test.js server/proxy/__tests__/subscription.test.js
```

Expected: 全 PASS（v2.19 既有 31 + v3 新增 ~22 = ~53 通过）。

- [ ] **Step 3: 启动 server 验证 syntax + 启动正常**

```powershell
$proc = Start-Process -FilePath "node" -ArgumentList "server/index.js" -NoNewWindow -PassThru -RedirectStandardOutput "v3-final-stdout.log" -RedirectStandardError "v3-final-stderr.log"
Start-Sleep -Seconds 4
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Content "v3-final-stdout.log","v3-final-stderr.log" -ErrorAction SilentlyContinue
Remove-Item "v3-final-stdout.log","v3-final-stderr.log" -ErrorAction SilentlyContinue
```

Expected: 启动到 "Server running" / "sing-box running"；无 SyntaxError 或 module-not-found。

- [ ] **Step 4: Commit CHANGELOG**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(v3.0.0): CHANGELOG entry for Protocol Expansion release"
```

- [ ] **Step 5: Tag v3.0.0 (local-only)**

```bash
git tag v3.0.0 -m "v3.0.0: Protocol Expansion — 99% HTTP + isolated PayPal RPA

Stripe billing, manual approval, PKCE OAuth all moved from Playwright to
HTTP (curl_cffi). PayPal sub-flow isolated in paypal_rpa.js Node subprocess
with headed Chromium via playwright-core. protocolMode=true path now has
zero Chrome touch in server main process.

PipelineEngine (protocolMode=false) unchanged. See docs/CHANGELOG.md."
```

**Do NOT push** — leave to user. Same for merging dev → master.

---

## Self-Review

### Spec coverage
- ✅ Component 1 (Stripe billing): Tasks 1, 2
- ✅ Component 2 (PKCE OAuth): Tasks 3, 4
- ✅ Component 3 (Manual approval): Tasks 5, 6
- ✅ Component 4 (PayPal RPA isolation): Tasks 7, 8
- ✅ Integration (protocol-engine.js): Task 10
- ✅ payment.js fetchAddress export: Task 9
- ✅ Web frontend (status.js + 4 Vue views): Task 11
- ✅ Branch (dev from v2.19.1): Task 0
- ✅ playwright-core dependency: Task 0
- ✅ CHANGELOG + tag: Task 12
- ✅ Acceptance Criteria 1-7: covered across Tasks 1-12

### Placeholder scan
- ✅ 无裸 "TBD"/"TODO"/"implement later" 占位符
- ⚠ `paypal_rpa.js` (Task 7) 有"transcribed from payment.js v2.14"骨架，实现者需要把 selectors 完整移植 — 是有意识的设计（避免在 plan 里复制 200+ 行 PayPal selector 逻辑），骨架 + 明确指针已足够
- ⚠ `pkce_oauth.py` (Task 3) 的 `client_id` / `redirect_uri` 需要从 grep 现有代码拿 — Step 1 显式说明了

### Type consistency
- ✅ `fetchResult.pk` / `discord.pk` 一致传到 stripe-billing / verify
- ✅ `result.accessToken` 一致传到 manual-approval / pkce-oauth
- ✅ `summary.stripeBillingError` / `summary.activationError` 拼写一致（Task 10 / 11）
- ✅ status 字符串 `stripe_billing_error` / `activation_error` 全文一致 snake_case
