# 协议模式 PKCE add_phone 自动化设计

> **状态**：设计完成，等待审查 → 后续转入 writing-plans 生成实施计划。
> **版本目标**：v2.40.0
> **关联前置**：v2.39.4（浏览器模式 add_phone retry/rollback）

---

## 1. 目标 / 背景

浏览器模式（PipelineEngine + Playwright，`utils.js:fetchTokensViaPKCE`）已在 v2.39.4 实现完整 add_phone 自动化：phone-pool acquirePhone + 填表 + SMS 接码 + 提交 + retry 3 次（红字拒号检测） + rollback。

协议模式（ProtocolEngine + Python `protocol_register.py`）的 PKCE 流程 **仅检测** add_phone，检测到后 `return {needsPhone: true}`，engine 兜底为 `plus_no_rt`（拿不到 refresh_token）。

**本设计的目标**：协议模式补齐 add_phone 自动化，与浏览器模式功能等价（**纯 HTTP 实现**，不引入 Chrome 子流程），支持 local + zhusms 两个 provider，与既有 retry / rollback / binding 语义对齐。

**对照表**：

| 维度 | 浏览器模式 (v2.39.4) | 协议模式（本设计 v2.40.0） |
|---|---|---|
| PKCE 主体 | Playwright DOM | Python curl_cffi HTTP |
| add_phone 入口 | URL / DOM 检测 | Python PKCE 检测 + 输出 sessionState |
| 拿号 | utils.js add_phone 分支 | Node `_finalizePhoneVerify` |
| 填手机 + 提交 | `page.fill` + `page.click` | `POST /api/accounts/phone/start`（端点占位，Phase 0 抓包确定）|
| SMS 框出现判定 | `waitForSelector(8s)` | response 解析（status code + body）|
| 红字拒号检测 | `page.locator(:text-matches(...))` | response error code（Phase 0 抓包确定）|
| 接码 | `phonePool.fetchSmsCode`（Node）| local: requests.get + regex / zhusms: requests.post status |
| 填验证码 + 提交 | `page.fill` + `page.click` | `POST /api/accounts/phone/validate` |
| 跳 callback | `waitForFunction` URL 离开 add-phone | response continue_url + follow redirect |
| consent / token | 主循环点 + `oauth/token` | follow → localhost:1455 + `oauth/token` |
| binding 计数语义 | SMS 框出现 ⇒ +1（保留）| phone-start 接受 ⇒ +1（保留）|

---

## 2. 架构总览

```
ProtocolEngine.start()
  │ Phase 1: 已实现 — protocol_register.py login HTTP → accessToken
  ▼
_finalizePkce()  [protocol-engine.js:123-143]
  │ runProtocolPKCE() → spawn protocol_register.py(pkce=true)
  │
  │ Python PKCE 跑到 add_phone 检测点（3 处之一，protocol_register.py:273/338/359）
  ▼
✨ 改动 #1（Python）
  return {needsPhone: true, sessionState: {cookies, device_id, sentinel_ctx, current_url, code_verifier, code_challenge, redirect_uri, client_id, user_agent}}
  ▼
Node 收到 needsPhone
  ▼
✨ 改动 #2（Node）_finalizePhoneVerify(sessionState, account):

  for attempt in 1..3:
    1. acquirePhone (local | zhusms) → { phone, smsConfig, releaseFn }
       null → return { phonePoolEmpty: true } 或 lastReason
    2. spawn protocol_phone_verify.py with {sessionState, phone, smsConfig}
    3. 按 status 分流：
       {status: 'ok', tokens}     → return {tokens}（上层 saveCPAAuthFile）✓
       {status: 'phone-rejected'} → releaseFn() + save() → 下一 attempt
       {status: 'sms-timeout'}    → releaseFn() + save() → break (返 phoneVerifyFail)
       {status: 'submit-error'}   → releaseFn() + save() → break (返 phoneVerifyFail)

  3 次全拒 → return {phoneVerifyFail: 'all-phones-rejected'}
```

**关键架构约束**：
- **Python 单次 attempt 跑完即退**，retry 在 Node。`protocol_phone_verify.py` 不含循环。
- **phone-pool 操作全在 Node**（acquirePhone / releaseBinding / save），Python 不碰 data.db，避免 Node sql.js in-memory 与磁盘并发脱同。
- **session 通过 stdin JSON 传递**，每次 attempt 独立 `curl_cffi.Session` 重建，cookies / device_id / UA 注入。

---

## 3. Phase 0：抓包前置（hard requirement）

**目标产出**：`docs/superpowers/research/2026-05-26-openai-add-phone-http.md`

**待确认项**：

| 字段 | 期望发现 | 确认来源 |
|---|---|---|
| 提交手机端点 path | 形如 `POST /api/accounts/phone/start`（占位） | Chrome DevTools Network 真实 add_phone 完整流程 |
| 提交手机 payload schema | `{phone:"+1..."}` / `{value, kind:"phone"}` / 其他 | request body |
| sentinel flow 名 | `phone_start` / `add_phone` / `phone_verification` 之一 | 对照现有 `get_sentinel_token(flow=...)` 调用 |
| 提交手机 - 成功响应 | 含 `continue_url` 或 `page.type=="phone_verify"` | response body |
| 提交手机 - 红字拒号响应 | HTTP 4xx 还是 200 + body error code（如 `phone_send_failed`）| 实测一个明确会被 OpenAI 拒的号 |
| 提交验证码端点 path | `POST /api/accounts/phone/validate`（占位） | 抓包 |
| 提交验证码 payload schema | `{code:"123456"}` | 同上 |
| 提交验证码 - 错码响应 | 4xx / 200+error_code | 故意填错码实测 |
| 提交验证码 - 成功响应 | `continue_url` → OAuth callback | 同上 |
| 跳 callback 的 redirect chain | 是否到 `localhost:1455`，是否带 `code=` | 跟随响应 |

**抓包工具**：Chrome DevTools Network（HAR export），不需要 mitmproxy / 装证书。

**实测账号要求**：使用**未绑过手机**的真实账号（已绑账号 OpenAI 不会再要 add_phone，无法触发流程）。

**done 标准**：Python 草稿能照报告复制 endpoint + payload + sentinel flow 名写出，不再猜测。

---

## 4. Python 端实现

### 4.1 新文件 `protocol_phone_verify.py`

与 `protocol_register.py` 同级。**只跑一次 attempt**，输出结果后退出。

**输入**（stdin JSON）：

```json
{
  "session_state": {
    "cookies": [{"name":"oai-did","value":"...","domain":".openai.com","path":"/"}, ...],
    "device_id": "...",
    "user_agent": "...",
    "code_verifier": "...",
    "code_challenge": "...",
    "redirect_uri": "http://localhost:1455/auth/callback",
    "client_id": "...",
    "current_url": "https://auth.openai.com/add-phone?...",
    "authorize_continue_url": "..."
  },
  "phone": "+12282351427",
  "sms": {
    "provider": "local",
    "url": "https://app.yuntl.cc/apisms/xxxxx"
  },
  "proxy_url": "http://127.0.0.1:7890"
}
```

或 zhusms：

```json
"sms": {
  "provider": "zhusms",
  "order_no": "...",
  "base_url": "https://zhusms.com",
  "card_key": "...",
  "cookie": "session=..."
}
```

**输出**（stdout JSON 单行 + exit 0）：

| status | 触发条件 | Node 后续 |
|---|---|---|
| `ok` | phone-start 通过 + SMS 拿码 + validate 通过 + token exchange 成功 | saveCPAAuthFile + break |
| `phone-rejected` | phone-start HTTP 4xx 或 200+error_code（Phase 0 报告确定） | releaseFn + 下一 attempt |
| `sms-timeout` | smsCodeFn 30 次轮询无 6 位数 | releaseFn + break |
| `validate-error` | phone-validate 4xx 或无 continue_url（OpenAI 拒验证码 = 号没真用）| releaseFn + break |
| `post-validate-error` | validate 通过后 follow continue / oauth-token 失败 | **保留 binding** + break |

**binding 保留 / 释放语义**（与浏览器 v2.39.4 一致）：
- "OpenAI 接受号 + 接受验证码" = `phone-validate` 200 + 有 continue_url，等同浏览器侧"URL 离开 add-phone" → binding 保留
- 此节点之后的失败（follow continue / token exchange）= 浏览器侧"主循环失败"路径 → binding 保留
- 此节点之前的失败 = OpenAI 没真正"用掉"号 → release

形如：`{"status":"ok","tokens":{"access_token":"...","refresh_token":"...","id_token":"..."}}`
或：`{"status":"phone-rejected","detail":"HTTP 400: phone_send_failed"}`

**核心流程**（伪代码）：

```python
def main():
    inp = json.loads(sys.stdin.read())
    s = rebuild_session(inp["session_state"], inp.get("proxy_url"))
    ss = inp["session_state"]
    phone = inp["phone"]
    sms_cfg = inp["sms"]

    # Step 1: phone-start
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_start", user_agent=ss["user_agent"]) or ""
    r = s.post(f"{AUTH}/api/accounts/phone/start",  # endpoint Phase 0 确定
               json={"phone": phone},
               headers={"Accept": "application/json", "Content-Type": "application/json",
                        "Origin": AUTH, "Referer": ss["current_url"],
                        "oai-device-id": ss["device_id"], "openai-sentinel-token": sentinel},
               timeout=30)
    if is_phone_rejected(r):  # Phase 0 确定判定条件
        print(json.dumps({"status": "phone-rejected", "detail": r.text[:200]}))
        return
    if not r.ok or not has_sms_prompt(r):  # 不进入接码状态
        print(json.dumps({"status": "submit-error", "detail": f"phone-start unexpected: {r.status_code} {r.text[:120]}"}))
        return

    # Step 2: SMS 接码
    code = poll_sms(sms_cfg, max_attempts=30, interval=3, proxy_url=inp.get("proxy_url"))
    if not code:
        print(json.dumps({"status": "sms-timeout"}))
        return

    # Step 3: phone-validate
    sentinel = get_sentinel_token(s, ss["device_id"], flow="phone_validate", user_agent=ss["user_agent"]) or ""
    r = s.post(f"{AUTH}/api/accounts/phone/validate",  # endpoint Phase 0 确定
               json={"code": code},
               headers={..., "openai-sentinel-token": sentinel},
               timeout=30)
    data = r.json() if r.ok else {}
    continue_url = data.get("continue_url", "")
    if not r.ok or not continue_url:
        # OpenAI 拒验证码 = 号没真用 → release
        print(json.dumps({"status": "validate-error", "detail": f"validate failed: {r.status_code} {r.text[:120]}"}))
        return

    # 至此 OpenAI 已接受号 + 验证码 → 之后任何失败都属 post-validate-error（保留 binding）

    # Step 4: follow continue → localhost:1455 → 提 auth_code
    auth_code = follow_continue_for_auth_code(s, continue_url)
    if not auth_code:
        print(json.dumps({"status": "post-validate-error", "detail": "no auth_code from continue_url"}))
        return

    # Step 5: token exchange
    tokens = exchange_code(s, auth_code, ss["code_verifier"], ss["client_id"], ss["redirect_uri"])
    if not tokens.get("access_token"):
        print(json.dumps({"status": "post-validate-error", "detail": "token exchange empty"}))
        return

    print(json.dumps({"status": "ok", "tokens": tokens}))
```

### 4.2 公共代码抽取：新文件 `_pkce_common.py`

把以下函数从 `protocol_register.py` 抽到 `_pkce_common.py`，两边复用：

- `get_sentinel_token(session, device_id, flow, user_agent)` — sentinel 计算
- `_post_with_h1_fallback(session, url, **kwargs)` — H2 失败回退 H1
- `follow_continue_for_auth_code(session, continue_url)` — 跟 redirect 提取 `code=` 参数（既有逻辑在 `protocol_register.py:278-286/291-299/342-357/362-369` 重复 4 次，本次合并）
- `exchange_code(session, code, code_verifier, client_id, redirect_uri)` — POST `/oauth/token`
- `rebuild_session(session_state, proxy_url)` — 用 cookies + UA + impersonate 重建 curl_cffi.Session

`protocol_register.py` 改为 `from _pkce_common import ...`，行为不变。`protocol_phone_verify.py` 也 import。

### 4.3 SMS poll 实现

`protocol_phone_verify.py` 内 helper：

```python
def poll_sms(sms_cfg, max_attempts, interval, proxy_url):
    provider = sms_cfg["provider"]
    proxies = {"https": proxy_url, "http": proxy_url} if proxy_url else None
    for _ in range(max_attempts):
        try:
            if provider == "local":
                r = requests.get(sms_cfg["url"], proxies=proxies, timeout=10)
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", r.text)
                    if m: return m.group(1)
            else:  # zhusms
                r = requests.get(
                    f"{sms_cfg['base_url']}/api/order/status?order_no={sms_cfg['order_no']}",
                    headers={"Cookie": sms_cfg["cookie"], "Origin": sms_cfg["base_url"],
                             "Referer": sms_cfg["base_url"] + "/"},
                    proxies=proxies, timeout=10)
                if r.ok:
                    m = re.search(r"\b(\d{6})\b", json.dumps(r.json()))
                    if m: return m.group(1)
        except Exception:
            pass
        time.sleep(interval)
    return None
```

注：与 Node 侧 `server/phone-pool.js:fetchSmsCode` 和 `server/zhusms-provider.js:pollOrderSms` 行为对齐（regex / origin headers / cookie / proxy）。

### 4.4 Python 端 sessionState 输出修改

`protocol_register.py` 3 个 `return {"needsPhone": True}` 点（line 273-275 / 338-339 / 359-360）改为：

```python
return {
    "needsPhone": True,
    "session_state": {
        "cookies": _serialize_cookies(session),
        "device_id": device_id,
        "user_agent": session.headers.get("User-Agent", ""),
        "code_verifier": code_verifier,
        "code_challenge": code_challenge,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "current_url": str(r.url) if r else "",
        "authorize_continue_url": continue_url or "",
    }
}
```

`_serialize_cookies` 在 `_pkce_common.py`，把 `session.cookies.jar` 序列化为 `[{name,value,domain,path}, ...]`。

---

## 5. Node 端实现

### 5.1 `protocol-engine.js:_finalizePhoneVerify`

新方法，挂在 `_finalizePkce` 后。`_finalizePkce` 现有 `if (pkce.needsPhone) {...}` 分支（line 133-141）改为先调 `_finalizePhoneVerify(pkce.session_state, account)`。

```js
async _finalizePhoneVerify(sessionState, account) {
  const cfg = readConfig();
  if (!cfg?.phonePool?.enabled) return { phoneVerifyFail: 'pool-disabled' };

  let proxyUrl = null;
  try {
    const state = require('./proxy').getState?.();
    if (state?.enabled) proxyUrl = 'http://127.0.0.1:7890';
  } catch {}

  const provider = cfg.phonePool.provider || 'local';
  const MAX_ATTEMPTS = 3;
  let lastReason = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { phone, smsConfig, releaseFn } = await this._acquirePhoneForProtocol(
      provider, cfg, account.email, proxyUrl
    );
    if (!phone) {
      return lastReason ? { phoneVerifyFail: lastReason } : { phonePoolEmpty: true };
    }
    save();  // v2.39.4 hotfix：拿号后立即落盘

    this._log(`[protocol] add-phone (attempt ${attempt}/${MAX_ATTEMPTS}): ${phone} (provider=${provider})`);
    const result = await runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl);

    if (result.status === 'ok') {
      this._log(`[protocol] add-phone OK, tokens obtained`);
      return { tokens: result.tokens };
    }
    if (result.status === 'phone-rejected') {
      this._log(`[protocol] OpenAI rejected ${phone}: ${result.detail?.slice(0, 80)}, retry`);
      await releaseFn(); save();
      lastReason = 'phone-rejected-by-openai';
      continue;
    }
    if (result.status === 'sms-timeout' || result.status === 'validate-error') {
      // OpenAI 那边号没真用 → release
      this._log(`[protocol] add-phone failed: ${result.status} ${result.detail?.slice(0, 80) || ''}`);
      await releaseFn(); save();
      return { phoneVerifyFail: result.status };
    }
    // post-validate-error：OpenAI 已接受号 + 验证码，binding 保留
    this._log(`[protocol] add-phone post-validate failure: ${result.detail?.slice(0, 80) || ''}, binding kept`);
    return { phoneVerifyFail: 'post-validate-error' };
  }

  return { phoneVerifyFail: 'all-phones-rejected' };
}
```

### 5.2 辅助 `_acquirePhoneForProtocol`

统一 local/zhusms 出参为 `{ phone, smsConfig, releaseFn }`：

```js
async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl) {
  if (provider === 'zhusms') {
    const zhusms = require('./zhusms-provider');
    const z = cfg.phonePool.zhusms || {};
    if (!z.cardKey) return {};
    const order = await zhusms.takeOrder(z.cardKey, z.baseUrl || 'https://zhusms.com', z.service || 'codex', proxyUrl);
    if (!order) return {};
    const cookie = await zhusms.ensureSession(z.cardKey, z.baseUrl || 'https://zhusms.com', proxyUrl);
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
        try { await zhusms.cancelOrder(order.order_no, z.baseUrl || 'https://zhusms.com', z.cardKey, proxyUrl); } catch {}
      },
    };
  }
  // local
  const phonePool = require('./phone-pool');
  const { getRawDb } = require('./db');
  const max = cfg.phonePool.maxBindingsPerPhone || 5;
  const allotted = phonePool.acquirePhone(getRawDb(), email, max);
  if (!allotted) return {};
  return {
    phone: allotted.phone,
    smsConfig: { provider: 'local', url: allotted.smsApiUrl },
    releaseFn: async () => phonePool.releaseBinding(getRawDb(), allotted.phone, email),
  };
}
```

### 5.3 `runProtocolPhoneVerify` helper

新 helper（与现有 `runProtocolPKCE` 同风格，位于 `server/protocol-engine.js` 顶部模块函数）：

```js
async function runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', 'protocol_phone_verify.py'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdinPayload = JSON.stringify({
      session_state: sessionState,
      phone, sms: smsConfig, proxy_url: proxyUrl,
    });
    let stdout = '', stderr = '';
    py.stdout.on('data', d => { stdout += d.toString(); });
    py.stderr.on('data', d => { stderr += d.toString(); });
    py.on('close', (code) => {
      if (code !== 0) {
        resolve({ status: 'submit-error', detail: `python exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        const last = stdout.trim().split(/\r?\n/).pop();  // 取最后一行（其他可能是 _log 输出）
        resolve(JSON.parse(last));
      } catch (e) {
        resolve({ status: 'submit-error', detail: `parse failed: ${e.message}` });
      }
    });
    py.on('error', (e) => resolve({ status: 'submit-error', detail: `spawn failed: ${e.message}` }));
    py.stdin.write(stdinPayload);
    py.stdin.end();

    // 180s timeout（覆盖 SMS 30×3s + 网络余量）
    setTimeout(() => {
      try { py.kill('SIGKILL'); } catch {}
      resolve({ status: 'submit-error', detail: 'timeout 180s' });
    }, 180_000);
  });
}
```

### 5.4 集成点：`_finalizePkce` 改造

现有 `_finalizePkce`（`protocol-engine.js:123-143`）逻辑：

```js
// 现状
if (pkce.needsPhone) {
  this._log('PKCE requires phone verification');
  // fallback to plus_no_rt
  await this._saveAuthFile(account, /* accessToken only */);
  return;
}
```

改为：

```js
// 新设计
if (pkce.needsPhone) {
  this._log('PKCE requires phone verification, running protocol add-phone flow...');
  const r = await this._finalizePhoneVerify(pkce.session_state, account);
  if (r.tokens) {
    await this._saveAuthFile(account, r.tokens, /* status= */'plus');
    return;
  }
  // 失败映射到 status
  const statusMap = {
    'all-phones-rejected': 'phone_verify_fail',
    'sms-timeout': 'phone_verify_fail',
    'submit-error': 'phone_verify_fail',
    'phone-rejected-by-openai': 'phone_verify_fail',
    'pool-disabled': 'plus_no_rt',
  };
  const failStatus = r.phonePoolEmpty ? 'phone_pool_empty'
    : (statusMap[r.phoneVerifyFail] || 'plus_no_rt');
  this._log(`[protocol] add-phone failed: ${r.phoneVerifyFail || 'pool-empty'}, status=${failStatus}`);
  await this._saveAuthFile(account, /* accessToken only */null, failStatus);
  return;
}
```

**最终 status 映射**（与浏览器侧对齐）：

| `_finalizePhoneVerify` 返回 | account status |
|---|---|
| `{tokens}` | `plus` |
| `{phonePoolEmpty: true}` | `phone_pool_empty` |
| `{phoneVerifyFail: 'all-phones-rejected'\|'sms-timeout'\|'validate-error'\|'post-validate-error'\|'phone-rejected-by-openai'}` | `phone_verify_fail` |
| `{phoneVerifyFail: 'pool-disabled'}` | `plus_no_rt` |

---

## 6. 测试

### 6.1 Python `tests/test_protocol_phone_verify.py`（`unittest`）

| # | 用例 | mock 策略 | 期望返回 |
|---|---|---|---|
| 1 | local 全成功 | `phone/start` 200 + SMS prompt body；SMS GET 返回 `your code: 123456`；`phone/validate` 200 + continue_url；follow → localhost:1455?code=abc；`oauth/token` 200 + RT/AT/id | `{status:'ok',tokens:{access_token,refresh_token,id_token}}` |
| 2 | zhusms 全成功 | 同 1，SMS 改 `/api/order/status` body 含 `"sms":"123456"` | 同 1 |
| 3 | phone-start 红字拒号 | `phone/start` 4xx 或 200+error_code（按 Phase 0 报告） | `{status:'phone-rejected',detail:...}` |
| 4 | SMS 超时 | `phone/start` ok；SMS 30 次轮询都没 6 位数 | `{status:'sms-timeout'}` |
| 5 | validate 错码 | `phone/start` ok、SMS ok、`phone/validate` 4xx | `{status:'validate-error',detail:...}` |
| 6 | post-validate follow 失败 | 全成功直到 validate；follow continue 拿不到 code | `{status:'post-validate-error',detail:...}` |
| 7 | token exchange 失败 | 上游全成功；`oauth/token` 500 | `{status:'post-validate-error',detail:...}` |
| 8 | session 重建正确 | spy on session.cookies / headers / UA | cookies / device_id / UA 注入完整 |

### 6.2 Node `server/__tests__/protocol-phone-verify.test.js`（`node:test`）

mock `runProtocolPhoneVerify` + phone-pool + zhusms-provider。

| # | 用例 | 期望调用次数 | 返回 |
|---|---|---|---|
| 1 | local 1 attempt 成功 | acquirePhone ×1, spawn ×1, release ×0, save ×1 | `{tokens}` |
| 2 | local 1 拒 + 2 成功 | acquirePhone ×2, spawn ×2, release ×1, save ×3 | `{tokens}` |
| 3 | local 3 attempt 全拒 | acquirePhone ×3, spawn ×3, release ×3, save ×6 | `{phoneVerifyFail:'all-phones-rejected'}` |
| 4 | 池空 | acquirePhone ×1 (null), spawn ×0 | `{phonePoolEmpty:true}` |
| 5 | sms-timeout 单次 break | acquirePhone ×1, spawn ×1, release ×1, save ×2 | `{phoneVerifyFail:'sms-timeout'}` |
| 6 | validate-error 单次 break | acquirePhone ×1, spawn ×1, release ×1, save ×2 | `{phoneVerifyFail:'validate-error'}` |
| 7 | **post-validate-error 单次 break（binding 保留）** | acquirePhone ×1, spawn ×1, **release ×0**, save ×1 | `{phoneVerifyFail:'post-validate-error'}` |
| 8 | zhusms 1 attempt 成功 | takeOrder ×1, spawn ×1, cancelOrder ×0 | `{tokens}` |
| 9 | zhusms 1 拒 + 2 成功 | takeOrder ×2, spawn ×2, cancelOrder ×1 | `{tokens}` |
| 10 | pool-disabled | `cfg.phonePool.enabled=false`，无任何调用 | `{phoneVerifyFail:'pool-disabled'}` |

### 6.3 集成 smoke test（手动 / 不进 CI）

- 找一个**未绑过手机的真实账号** → protocol mode 跑 → final status = `plus`（拿到 RT）
- 已绑账号（如 cmdxps7772）二跑 → 不进 phone 流程，直接 PKCE 完成
- 故意配全部已绑的号池 + 新账号 → final status = `phone_pool_empty`

### 6.4 测试总数

- Python 8 个新单测
- Node 10 个新单测
- 共 **18 个新测试**，叠加现有 206 个 → 总计 224 pass 目标

---

## 7. 不变式

实施过程中**不能破坏**以下既有行为：

1. 浏览器模式 PipelineEngine + `utils.js` v2.39.4 行为零改动
2. 协议模式既有 PKCE 主流程（login OTP / choose-account / oauth/token）行为不变 — 仅 add_phone 检测点附加 sessionState 输出
3. phone-pool DB schema 不变；`acquirePhone` / `releaseBinding` 签名不变
4. zhusms-provider.js 不动（Node 端直接复用 `takeOrder` / `pollOrderSms`（不复用——见下）/ `cancelOrder` / `ensureSession`）
   - 注：协议侧 `protocol_phone_verify.py` 自行 poll zhusms `/api/order/status`，不通过 Node。Node 端 takeOrder + ensureSession 拿订单号 + cookie 一次性传给 Python。
5. `engine.js` / `engine-singleton.js` / `routes/*` 零改动
6. 配置文件 schema：`phonePool.provider` 已在 v2.39.0 支持，本设计零新增字段

---

## 8. 风险与不确定性

| 风险 | 影响 | 缓解 |
|---|---|---|
| Phase 0 抓包发现 OpenAI 加了新风控（Cloudflare Turnstile / device fingerprint） | Python 纯 HTTP 实现不可行 | 抓包时优先验证；若不可行，回到 brainstorming 重选 hybrid 降级方案 |
| OpenAI 后续改 phone API（端点 / payload） | 协议侧 add_phone 全挂；浏览器侧不影响 | 文档清晰标注"端点来自 Phase 0 抓包"；将来加 reverse-engineer 维护成本 |
| Python 端 sentinel flow 名错 → 拒接 | phone-start 一律返 sentinel 错误 | Phase 0 报告必须确认 flow 名；单测覆盖 sentinel 头存在性 |
| Node spawn timeout 180s 不够（SMS 接码 30 轮 × 3s = 90s + 网络）| 误判 submit-error | 留 90s 余量；接码方异常时 90s 内能拿到结果或全 timeout |
| 接码方返回多个 6 位数字（一个是验证码、一个是订单号噪声） | regex 提到错码 | 同浏览器侧；多发现案例后改进 regex（如优先取最近一个 / 加 context anchor）|

---

## 9. 不在本次范围

- 协议模式 add_phone 流程的"中断恢复"（Python 跑到一半挂了不会续传 session）— 失败即重来一整次 attempt
- 不抓包就盲写代码（明令禁止，见 Phase 0）
- 浏览器模式回归改造 — v2.39.4 保持不动
- phone-pool DB schema 变更（如新增 binding 失效时间）— 留给后续 v2.41+
- HTTP 端口监听 add_phone 状态的 SSE/WS 实时通知 — 当前 stdout JSON 一次性返回即可

---

## 10. 实施阶段（writing-plans 时拆 task）

| Phase | 内容 | 阻塞 |
|---|---|---|
| 0 | 抓包，写 `docs/superpowers/research/2026-05-26-openai-add-phone-http.md` | 后续所有 Phase |
| 1 | `_pkce_common.py` 抽公共代码 + `protocol_register.py` 替换 import + 现有测试不破 | Phase 2 |
| 2 | `protocol_register.py` add_phone 检测点附加 sessionState 输出 | Phase 3 |
| 3 | `protocol_phone_verify.py` 新脚本 + 7 个 Python 单测 | Phase 4 |
| 4 | `protocol-engine.js` `_finalizePhoneVerify` + `_acquirePhoneForProtocol` + `runProtocolPhoneVerify` + `_finalizePkce` 集成 | Phase 5 |
| 5 | 8 个 Node 单测 | Phase 6 |
| 6 | 集成 smoke test（手动）+ CHANGELOG v2.40.0 + merge → master + tag | — |

---

## 11. 关联文档

- v2.37.0 phone-pool 基础设施 spec：`docs/superpowers/specs/2026-05-25-phone-pool-infrastructure-design.md` + plan `docs/superpowers/plans/2026-05-25-phone-pool-infrastructure.md`
- v2.38.0 浏览器模式 add_phone spec：`docs/superpowers/specs/2026-05-25-pkce-add-phone-browser-mode-design.md` + plan `docs/superpowers/plans/2026-05-25-pkce-add-phone-browser-mode.md`
- v2.39.0 zhusms provider spec：`docs/superpowers/specs/2026-05-25-zhusms-remote-provider-design.md` + plan `docs/superpowers/plans/2026-05-25-zhusms-remote-provider.md`
- CHANGELOG：`docs/CHANGELOG.md` 当前最新 v2.39.4
- 浏览器侧关键代码：`utils.js:fetchTokensViaPKCE` add_phone 分支（v2.39.4 retry/rollback）
- 协议侧关键代码：`protocol_register.py:_do_pkce_flow` 内 `return {"needsPhone": True}` 3 处
