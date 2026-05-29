# GoPay 印尼 ChatGPT Plus 激活流水线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全自动把一个 Outlook 邮箱的 ChatGPT 账号激活为 Plus —— 印尼区 GoPay 支付（注册带 1Rp 的 GoPay 钱包 → 用同一个印尼号支付 Midtrans 长链）。

**Architecture:** 新增一条独立的 6 阶段流水线（`server/gopay-engine.js`），与现有美区 PayPal 流水线并行、互不干扰。GoPay 能力从 `E:\workspace\projects\gopay-deploy` 的 `opai` 包整包复制到 `gopay/`，由 Node spawn `gopay_activate.py`（合并注册+1Rp+支付的单脚本，同进程持有印尼号收 4 次 SMS）。Phase 3 走日本代理拿 IDR 链接，Phase 4/5 走印尼代理。

**Tech Stack:** Node.js (Express + Socket.IO + sql.js)、Python 3.11+ (`curl_cffi`, `tls_client`)、Vue 3 + Element Plus。测试：`node --test` + `py -3 -m unittest`。

**关键前置约束：**
- **里程碑 A（探针）是命门**。spec §9.1：整个方案押在"印尼 IDR 链接能提取出 Midtrans snap URL"这一假设上。Task 1-2 必须先跑通，探针失败则停止后续，回报用户重新设计。
- 凭证（SmsBower key、IPRoyal 代理、ChatGPT/GoPay token）绝不进 commit message / 日志回显 / 聊天回复。
- gopay Python 日志含 OTP/token，Node emit 前必须 redact。

---

## 里程碑 A：Phase 3 探针（命门验证 — 必须最先做）

### Task 1: checkout_link.py 加 Midtrans URL 提取

**Files:**
- Modify: `checkout_link.py`
- Test: `tests/test_checkout_midtrans_extract.py`

**背景：** `checkout_link.py` 当前从 ChatGPT checkout 响应里正则提取 `pay.openai.com` 链接（line 54）。印尼区结账最终走 Midtrans GoPay，需要额外提取 `app.midtrans.com/snap/v[34]/redirection/<uuid>`。提取逻辑是纯字符串处理，先用 TDD 写正则函数。

- [ ] **Step 1: 写失败测试**

Create `tests/test_checkout_midtrans_extract.py`:

```python
import unittest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from checkout_link import extract_midtrans_url


class TestMidtransExtract(unittest.TestCase):
    def test_extracts_v3_redirection_url(self):
        text = 'foo https://app.midtrans.com/snap/v3/redirection/8a7b6c5d-1234-4abc-9def-0123456789ab?lang=en bar'
        self.assertEqual(
            extract_midtrans_url(text),
            'https://app.midtrans.com/snap/v3/redirection/8a7b6c5d-1234-4abc-9def-0123456789ab',
        )

    def test_extracts_v4_redirection_url(self):
        text = '"redirect":"https://app.midtrans.com/snap/v4/redirection/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"'
        self.assertEqual(
            extract_midtrans_url(text),
            'https://app.midtrans.com/snap/v4/redirection/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        )

    def test_returns_empty_when_absent(self):
        self.assertEqual(extract_midtrans_url('no midtrans here, only https://pay.openai.com/c/pay/cs_live_x'), '')


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `py -3 -m unittest tests.test_checkout_midtrans_extract -v`
Expected: FAIL — `ImportError: cannot import name 'extract_midtrans_url'`

- [ ] **Step 3: 在 checkout_link.py 加提取函数**

在 `checkout_link.py` 顶部 import 区之后（`from curl_cffi import requests as cr` 之后）加：

```python
_MIDTRANS_RE = re.compile(r'https://app\.midtrans\.com/snap/v[34]/redirection/[0-9a-fA-F-]{36}')

def extract_midtrans_url(text):
    """从结账响应文本里提取 Midtrans snap redirection URL（去掉 query string）。"""
    m = _MIDTRANS_RE.search(text or '')
    return m.group(0) if m else ''
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `py -3 -m unittest tests.test_checkout_midtrans_extract -v`
Expected: PASS (3 tests)

- [ ] **Step 5: 把 Midtrans 提取接进 main() 输出**

在 `checkout_link.py` 的 `main()` 里，找到成功分支（当前 line 54-59 区域）：

```python
            m = re.search(r'https://pay\.openai\.com[^\s"\\)]+', text)
            if m:
                pk_match = re.search(r'pk_live_[A-Za-z0-9]+', text)
                pk = pk_match.group(0) if pk_match else ""
                print(json.dumps({"status": "success", "link": m.group(0), "pk": pk, "raw": text[:500]}))
                return
```

改为（额外输出 `midtrans_url` 字段）：

```python
            m = re.search(r'https://pay\.openai\.com[^\s"\\)]+', text)
            if m:
                pk_match = re.search(r'pk_live_[A-Za-z0-9]+', text)
                pk = pk_match.group(0) if pk_match else ""
                midtrans_url = extract_midtrans_url(text)
                _log(f"midtrans_url in checkout response: {'yes' if midtrans_url else 'no'}")
                print(json.dumps({"status": "success", "link": m.group(0), "pk": pk,
                                  "midtrans_url": midtrans_url, "raw": text[:500]}))
                return
```

- [ ] **Step 6: 提交**

```bash
git add checkout_link.py tests/test_checkout_midtrans_extract.py
git commit -m "feat: extract Midtrans snap URL from IDR checkout response"
```

---

### Task 2: Phase 3 探针 — 真实验证 IDR 链接走 Midtrans

**Files:**
- Create: `tools/probe_idr_checkout.py`

**背景：** 这是**命门验证**，不是单元测试 —— 用真实 IDR accessToken 调 ChatGPT checkout，看响应里是否含 Midtrans snap URL，以及 charge 金额（验证 1Rp 是否够）。spec §9.1/§9.2。**探针不通过则停止后续所有任务，回报用户。**

- [ ] **Step 1: 写探针脚本**

Create `tools/probe_idr_checkout.py`:

```python
#!/usr/bin/env python3
"""Phase 3 命门探针：验证印尼 IDR 结账链接是否走 Midtrans GoPay。
用法: 设 HTTPS_PROXY 为日本代理后:
    echo '{"access_token":"<真实IDR账号token>"}' | py -3 tools/probe_idr_checkout.py
观察输出: midtrans_url 是否非空。
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from checkout_link import extract_midtrans_url
from curl_cffi import requests as cr

def main():
    inp = json.loads(sys.stdin.read())
    token = inp['access_token']
    body = {
        "entry_point": "all_plans_pricing_modal",
        "plan_name": "chatgptplusplan",
        "billing_details": {"country": "ID", "currency": "IDR"},
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": "hosted",
        "promo_campaign": {"promo_campaign_id": "plus-1-month-free", "is_coupon_from_query_param": False},
    }
    r = cr.post(
        "https://chatgpt.com/backend-api/payments/checkout",
        json=body,
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
        impersonate='chrome131', timeout=30,
    )
    text = r.text
    print(f"HTTP {r.status_code}")
    print(f"pay.openai.com link: {'yes' if 'pay.openai.com' in text else 'NO'}")
    mt = extract_midtrans_url(text)
    print(f"midtrans_url (direct): {mt or 'NONE'}")
    # 如果 checkout 响应里没有，可能要跟随 pay.openai.com 页面再找
    print(f"--- first 800 chars ---\n{text[:800]}")

if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 运行探针（需要真实 IDR token + 日本代理）**

准备一个已登录、地区为印尼的 ChatGPT 账号 accessToken。设置日本代理后运行：

```bash
# Windows PowerShell，日本代理端口按实际 sing-box JP 通道（默认 7891）
$env:HTTPS_PROXY="http://127.0.0.1:7891"
echo '{"access_token":"<真实token>"}' | py -3 tools/probe_idr_checkout.py
```

Expected（命门判定）：
- **通过**：输出 `midtrans_url (direct): https://app.midtrans.com/snap/...`，继续 Task 3。
- **失败（midtrans_url NONE）**：检查 `--- first 800 chars ---`，确认 IDR 结账是否返回 pay.openai.com 页面而非直接 Midtrans。若结账走 Stripe 而非 Midtrans，**停止后续，回报用户重新设计**（gopay_payment_protocol.py 只支持 Midtrans）。

- [ ] **Step 3: 记录探针结论**

把探针输出（脱敏 token 后）记录到 `docs/superpowers/plans/probe-result.md`，注明 Midtrans URL 格式、charge 是否 $0/1Rp 可付。后续 Task 5 支付逻辑依赖此结论。

- [ ] **Step 4: 提交探针工具**

```bash
git add tools/probe_idr_checkout.py docs/superpowers/plans/probe-result.md
git commit -m "test: add Phase 3 probe for IDR Midtrans checkout (gate)"
```

> **GATE：Task 2 探针不通过则停止。以下所有任务假设探针确认了 Midtrans snap URL 可提取。**

---

## 里程碑 B：opai 包移植

### Task 3: 复制 opai 包到 gopay/ 并验证可导入

**Files:**
- Create: `gopay/app/src/opai/**`（整包复制）
- Create: `gopay/config/config.example.json`
- Create: `gopay/pyproject.toml`（复制）
- Modify: `.gitignore`

- [ ] **Step 1: 整包复制 opai**

```bash
# 在 chatgpt-auto-login 根目录
mkdir gopay
cp -r E:/workspace/projects/gopay-deploy/app gopay/app
cp E:/workspace/projects/gopay-deploy/app/pyproject.toml gopay/pyproject.toml
```

确认 `gopay/app/src/opai/core/` 含 `gopay_protocol_worker.py`、`gojek_client.py`、`gopay_payment_protocol.py`、`sms_provider.py`、`sms_bower.py` 等（含已验证的 login+consent→1Rp 修复）。

- [ ] **Step 2: 写 gopay 配置模板**

Create `gopay/config/config.example.json`:

```json
{
  "sms": {
    "provider": "smsbower",
    "smsbower": { "api_key": "", "service_code": "ni", "country_code": 6, "max_price": 0.15 },
    "smscloud": { "api_key": "", "service_code": "ni", "country_code": 6, "max_price": 3.2 },
    "nexsms": { "api_key": "", "service_code": "ni", "country_id": 6, "max_price": 0 }
  },
  "gopay": {
    "default_pin": "147258",
    "proxy_template": "",
    "register_proxy": "http://USER:PASS_country-id_session-{sid}@geo.iproyal.com:12321",
    "poll_interval": 10,
    "min_balance_rp": 1,
    "account_ttl_sec": 1200
  },
  "inbox": { "base_url": "", "basic_user": "", "basic_pass": "" }
}
```

- [ ] **Step 3: 创建真实配置（不进 git）**

```bash
cp gopay/config/config.example.json gopay/config/config.json
# 手动填入 smsbower.api_key 与 gopay.register_proxy 的真实值
```

- [ ] **Step 4: 更新 .gitignore**

在 `.gitignore` 末尾追加：

```
# gopay 子模块凭证与运行态
gopay/config/config.json
gopay/**/gopay_worker_accounts.json
gopay/**/__pycache__/
```

- [ ] **Step 5: 验证包可导入**

```bash
pip install tls_client
cd gopay/app
py -3 -c "import sys; sys.path.insert(0,'src'); from opai.core.gopay_protocol_worker import _register_one; from opai.core.gopay_payment_protocol import GoPayPayment; from opai.core.sms_provider import create_sms_provider; print('opai import OK')"
```

Expected: `opai import OK`

- [ ] **Step 6: 提交**

```bash
cd ../..
git add gopay/app gopay/pyproject.toml gopay/config/config.example.json .gitignore
git commit -m "feat: vendor opai GoPay package into gopay/ submodule"
```

---

## 里程碑 C：gopay_activate.py（注册+1Rp+支付单脚本）

### Task 4: gopay_activate.py 骨架 + stdin/stdout 协议 + mock 编排测试

**Files:**
- Create: `gopay_activate.py`
- Test: `tests/test_gopay_activate.py`

**背景：** spec §6.1 方案 A。单脚本同进程：注册钱包（含 1Rp）→ 同 provider 实例支付 Midtrans URL。先用 mock 把"编排顺序"用 TDD 固定下来（不真注册），真实 E2E 在 Task 6。

- [ ] **Step 1: 写编排骨架（可注入依赖以便 mock）**

Create `gopay_activate.py`:

```python
#!/usr/bin/env python3
"""GoPay 印尼钱包激活 + 支付 单脚本（spec §6.1 方案 A）。
同进程持有印尼号收 4 次 SMS：signup / PIN / login-2FA / Midtrans-linking。

stdin:  {"midtrans_url": "...", "pin": "147258", "timeout": 600}
stdout: {"log": "..."} 实时进度行 + 最终 {"status": "success"|..., ...}
env:    HTTPS_PROXY=<印尼代理>, OPAI_CONFIG_FILE=<gopay/config/config.json>
"""
import sys, os, json, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'gopay', 'app', 'src'))


def _log(m):
    print(json.dumps({"log": f"  [GoPay] {m}"}), flush=True)


def _emit(obj):
    print(json.dumps(obj), flush=True)


def activate(inp, deps):
    """编排：注册钱包(含1Rp) → 等余额 → 支付 Midtrans URL。
    deps 提供可注入的依赖，便于测试：
      deps['create_provider']() -> provider
      deps['register'](provider, pin, proxy) -> {phone, aid, local, client} | str
      deps['check_balance'](client) -> int
      deps['make_payment'](proxy) -> payment(有 .pay 方法)
      deps['sleep'](sec)
    """
    midtrans_url = inp['midtrans_url']
    pin = inp.get('pin', '147258')
    proxy = os.environ.get('HTTPS_PROXY', '')

    provider = deps['create_provider']()

    _log("registering Indonesian GoPay wallet")
    reg = deps['register'](provider, pin, proxy)
    if not isinstance(reg, dict):
        return {"status": "gopay_reg_fail", "detail": str(reg)}
    phone, aid, local, client = reg['phone'], reg['aid'], reg['local'], reg['client']
    _log(f"wallet registered: {phone}")

    _log("waiting for 1 Rp credit")
    deadline = time.time() + 120
    balance = 0
    while time.time() < deadline:
        balance = deps['check_balance'](client)
        if balance >= 1:
            break
        deps['sleep'](10)
    if balance < 1:
        return {"status": "gopay_reg_fail", "detail": "1 Rp not credited within 120s", "phone": phone}
    _log(f"balance={balance} Rp")

    _log("paying Midtrans via GoPay")
    payment = deps['make_payment'](proxy)

    def wait_otp(full_phone, timeout=120):
        try:
            provider.request_another(aid)
        except Exception:
            pass
        deps['sleep'](2)
        return provider.wait_code(aid, timeout=timeout)

    pay_result = payment.pay(midtrans_url, local, "62", pin, wait_otp=wait_otp)
    detail = pay_result.get('detail', '')
    if pay_result.get('success'):
        return {"status": "success", "phone": phone,
                "transaction_status": pay_result.get('transaction_status', '')}
    if 'fraud' in detail.lower() or 'burned' in detail.lower():
        return {"status": "gopay_fraud", "detail": detail, "phone": phone}
    return {"status": "gopay_pay_fail", "detail": detail, "phone": phone}


def _real_deps():
    """真实依赖（生产用）。"""
    from opai.core.sms_provider import create_sms_provider
    from opai.core.gopay_protocol_worker import _register_one, _check_balance
    from opai.core.gopay_payment_protocol import GoPayPayment
    return {
        'create_provider': lambda: create_sms_provider("", ""),
        'register': lambda provider, pin, proxy: _register_one(provider, pin, proxy, ""),
        'check_balance': _check_balance,
        'make_payment': lambda proxy: GoPayPayment(proxy=proxy),
        'sleep': time.sleep,
    }


def main():
    inp = json.loads(sys.stdin.read())
    try:
        result = activate(inp, _real_deps())
    except Exception as e:
        result = {"status": "gopay_pay_fail", "detail": f"exception: {str(e)[:200]}"}
    _emit(result)


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: 写 mock 编排测试**

Create `tests/test_gopay_activate.py`:

```python
import unittest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import gopay_activate


class FakePayment:
    def __init__(self, result):
        self._result = result
        self.called_with = None
    def pay(self, url, local, cc, pin, wait_otp=None):
        self.called_with = (url, local, cc, pin)
        return self._result


def make_deps(reg_result, balances, pay_result):
    bal_iter = iter(balances)
    fake_pay = FakePayment(pay_result)
    return {
        'create_provider': lambda: object(),
        'register': lambda p, pin, proxy: reg_result,
        'check_balance': lambda c: next(bal_iter),
        'make_payment': lambda proxy: fake_pay,
        'sleep': lambda s: None,
    }, fake_pay


class TestActivateOrchestration(unittest.TestCase):
    def setUp(self):
        self.reg = {'phone': '+628123', 'aid': 'A1', 'local': '8123', 'client': object()}

    def test_success_path(self):
        deps, _ = make_deps(self.reg, [1], {'success': True, 'transaction_status': 'settlement'})
        r = gopay_activate.activate({'midtrans_url': 'u', 'pin': '147258'}, deps)
        self.assertEqual(r['status'], 'success')
        self.assertEqual(r['transaction_status'], 'settlement')

    def test_register_fail(self):
        deps, _ = make_deps('NO_STOCK', [], {})
        r = gopay_activate.activate({'midtrans_url': 'u'}, deps)
        self.assertEqual(r['status'], 'gopay_reg_fail')

    def test_balance_never_credited(self):
        deps, _ = make_deps(self.reg, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], {})
        # sleep is no-op; loop exits on time.time() deadline — patch time
        import time as _t
        orig = _t.time
        seq = iter([0, 1, 200])  # start, first-check, deadline-exceeded
        _t.time = lambda: next(seq, 999)
        try:
            r = gopay_activate.activate({'midtrans_url': 'u'}, deps)
        finally:
            _t.time = orig
        self.assertEqual(r['status'], 'gopay_reg_fail')

    def test_fraud_deny(self):
        deps, _ = make_deps(self.reg, [1], {'success': False, 'detail': 'fraud_deny -- phone burned'})
        r = gopay_activate.activate({'midtrans_url': 'u'}, deps)
        self.assertEqual(r['status'], 'gopay_fraud')

    def test_pay_fail_retryable(self):
        deps, _ = make_deps(self.reg, [1], {'success': False, 'detail': 'charge failed: 500'})
        r = gopay_activate.activate({'midtrans_url': 'u'}, deps)
        self.assertEqual(r['status'], 'gopay_pay_fail')


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `py -3 -m unittest tests.test_gopay_activate -v`
Expected: PASS (5 tests)

- [ ] **Step 4: 提交**

```bash
git add gopay_activate.py tests/test_gopay_activate.py
git commit -m "feat: gopay_activate.py orchestration (register+1Rp+pay) with mock tests"
```

---

### Task 5: gopay_activate.py 真实单号 E2E（印尼代理 + SmsBower）

**Files:**
- 无新文件（验证 Task 4 的 `_real_deps` + Task 2 的 Midtrans URL 真实跑通）

**背景：** 用真实印尼代理 + SmsBower + Task 2 探针拿到的 Midtrans URL，跑通一次真实激活。这步验证注册+1Rp+支付全链路。

- [ ] **Step 1: 准备真实 Midtrans URL**

用 Task 2 探针对一个真实 IDR 账号产出一个 Midtrans snap URL（有效期内）。

- [ ] **Step 2: 真实运行 gopay_activate.py**

```bash
# 印尼代理（IPRoyal），OPAI_CONFIG_FILE 指向 gopay 配置
$env:HTTPS_PROXY="http://USER:PASS_country-id@geo.iproyal.com:12321"
$env:OPAI_CONFIG_FILE="E:\workspace\projects\demo\chatgpt-auto-login\gopay\config\config.json"
echo '{"midtrans_url":"<探针拿到的Midtrans URL>","pin":"147258","timeout":600}' | py -3 gopay_activate.py
```

Expected:
- 实时 `{"log":...}` 行：renting → signup OTP → PIN → login session → 1 Rp credited → Midtrans linking → charge settled
- 最终 `{"status":"success","phone":"+62...","transaction_status":"settlement"}`

- [ ] **Step 3: 记录结果**

若成功，在 `docs/superpowers/plans/probe-result.md` 追加 E2E 成功记录（脱敏）。
若 `gopay_pay_fail` 且 detail 显示金额 > 1Rp（spec §9.2 风险触发），回报用户：1Rp 不够，需确认 promo 是否生效。

- [ ] **Step 4: 无代码改动则跳过提交**（纯验证步骤）

---

## 里程碑 D：Node 编排

### Task 6: server/gopay-engine.js — redact 工具 + 单测

**Files:**
- Create: `server/gopay-engine.js`
- Test: `server/__tests__/gopay-engine-redact.test.js`

**背景：** spec §9.5 硬性要求。gopay Python 日志含 OTP/token，emit 前必须脱敏。先 TDD 把 redact 做对，再搭引擎骨架。

- [ ] **Step 1: 写 redact 失败测试**

Create `server/__tests__/gopay-engine-redact.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { redactGopayLine } = require('../gopay-engine');

test('redacts signup OTP digits', () => {
  assert.strictEqual(
    redactGopayLine('[GoPay] Signup OTP: 3176'),
    '[GoPay] Signup OTP: ****'
  );
});

test('redacts PIN OTP digits', () => {
  assert.strictEqual(
    redactGopayLine('PIN OTP: 8264 received'),
    'PIN OTP: **** received'
  );
});

test('redacts access_token value', () => {
  const line = 'access_token=eyJhbGciOiJkaXIiLCJ.foo.bar saved';
  assert.ok(!redactGopayLine(line).includes('eyJhbGciOiJkaXIiLCJ'));
});

test('redacts Bearer token', () => {
  assert.ok(!redactGopayLine('Authorization: Bearer eyJabc.def.ghi').includes('eyJabc'));
});

test('leaves normal lines untouched', () => {
  assert.strictEqual(redactGopayLine('Midtrans linking...'), 'Midtrans linking...');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test server/__tests__/gopay-engine-redact.test.js`
Expected: FAIL — Cannot find module or `redactGopayLine` undefined

- [ ] **Step 3: 写 gopay-engine.js 骨架 + redact**

Create `server/gopay-engine.js`:

```javascript
// 独立的印尼 GoPay 激活流水线引擎（spec §3.1）。
// 不进 engine-singleton，组合现有 runProtocolRegister + fetchCheckoutLink + gopay_activate.py。
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// spec §9.5: gopay Python 日志含 OTP/token，emit 前必须脱敏。
function redactGopayLine(line) {
  if (!line) return line;
  return String(line)
    // OTP 邻接数字（4-6 位）：OTP: 1234 / PIN OTP: 123456
    .replace(/(OTP[:\s]+)\d{4,6}/gi, '$1****')
    // access/refresh/id_token=<JWE/JWT>
    .replace(/((?:access|refresh|id)_token["'=:\s]+)[\w-]+\.?[\w.-]*/gi, '$1****')
    // Bearer <token>
    .replace(/(Bearer\s+)[\w-]+\.?[\w.-]*/g, '$1****')
    // 裸 JWT/JWE 三段（eyJ 开头）
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '****');
}

module.exports = { redactGopayLine };
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test server/__tests__/gopay-engine-redact.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add server/gopay-engine.js server/__tests__/gopay-engine-redact.test.js
git commit -m "feat: gopay-engine redact for OTP/token in subprocess logs"
```

---

### Task 7: gopay-engine.js — 6 阶段编排 + spawn gopay_activate.py

**Files:**
- Modify: `server/gopay-engine.js`
- Test: `server/__tests__/gopay-engine-spawn.test.js`

**背景：** 把 6 阶段串起来。Phase 1 复用 `runProtocolRegister`（从 protocol-engine.js 导出），Phase 3 复用 `fetchCheckoutLink({country:'ID',currency:'IDR'})`，Phase 4/5 spawn `gopay_activate.py`（印尼代理）。spawn 包装成可单测的函数。

- [ ] **Step 1: 确认 runProtocolRegister 已导出**

检查 `protocol-engine.js` 末尾 `module.exports`。若未导出 `runProtocolRegister`，加上：

```javascript
module.exports = { ProtocolEngine, runProtocolRegister };
```

（不改函数本身，只确保可被 gopay-engine 引用。）

- [ ] **Step 2: 写 spawn 函数失败测试**

Create `server/__tests__/gopay-engine-spawn.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { runGopayActivate } = require('../gopay-engine');

// 用一个 stub python 脚本替身验证 spawn 协议：传入 stdin、收 JSON 行、印尼代理 env。
test('runGopayActivate parses final status line', async () => {
  const stubScript = path.join(__dirname, 'fixtures', 'stub_activate.py');
  const result = await runGopayActivate(
    { midtrans_url: 'u', pin: '147258' },
    { scriptPath: stubScript, proxy: 'http://id-proxy', timeoutMs: 10000, onLog: () => {} }
  );
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.phone, '+628999');
});

test('runGopayActivate forwards log lines to onLog (redacted)', async () => {
  const stubScript = path.join(__dirname, 'fixtures', 'stub_activate.py');
  const logs = [];
  await runGopayActivate(
    { midtrans_url: 'u' },
    { scriptPath: stubScript, proxy: 'http://id-proxy', timeoutMs: 10000, onLog: (l) => logs.push(l) }
  );
  assert.ok(logs.some(l => l.includes('OTP: ****')));  // stub prints "OTP: 1234", must be redacted
});
```

Create `server/__tests__/fixtures/stub_activate.py`:

```python
import sys, json
sys.stdin.read()
print(json.dumps({"log": "  [GoPay] Signup OTP: 1234"}), flush=True)
print(json.dumps({"status": "success", "phone": "+628999", "transaction_status": "settlement"}), flush=True)
```

- [ ] **Step 3: 运行，确认失败**

Run: `node --test server/__tests__/gopay-engine-spawn.test.js`
Expected: FAIL — `runGopayActivate` undefined

- [ ] **Step 4: 实现 runGopayActivate + 阶段编排**

在 `server/gopay-engine.js` 的 `redactGopayLine` 之后、`module.exports` 之前加：

```javascript
// spawn gopay_activate.py（印尼代理），按行解析 JSON，log 行经 redact 后回调。
function runGopayActivate(input, opts = {}) {
  const scriptPath = opts.scriptPath || path.join(ROOT, 'gopay_activate.py');
  const proxy = opts.proxy || '';
  const timeoutMs = opts.timeoutMs || 600000;
  const onLog = opts.onLog || (() => {});
  const configFile = opts.configFile ||
    path.join(ROOT, 'gopay', 'config', 'config.json');
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', scriptPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NO_PROXY: '127.0.0.1,localhost',
        OPAI_CONFIG_FILE: configFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let finalLine = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { py.kill(); } catch {}
      resolve({ status: 'gopay_pay_fail', detail: 'activate timeout' });
    }, timeoutMs);
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log !== undefined) onLog(redactGopayLine(p.log));
          else finalLine = line;
        } catch {
          finalLine = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ status: 'gopay_pay_fail', detail: `spawn failed: ${e.message?.slice(0, 120)}` });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(finalLine));
      } catch {
        resolve({ status: 'gopay_pay_fail', detail: redactGopayLine(stderr.slice(-200)) || 'parse failed' });
      }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { redactGopayLine, runGopayActivate };
```

注意：`module.exports` 那行替换掉 Task 6 里只导出 `redactGopayLine` 的旧行。

- [ ] **Step 5: 运行，确认通过**

Run: `node --test server/__tests__/gopay-engine-spawn.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: 实现 GoPayActivateEngine 类（6 阶段编排）**

在 `runGopayActivate` 之后、`module.exports` 之前加引擎类：

```javascript
const { runProtocolRegister } = require('../protocol-engine');
const { fetchCheckoutLink } = require('./chatgpt-checkout');

class GoPayActivateEngine {
  constructor({ io, statusDB, getConfig } = {}) {
    this.io = io;
    this.statusDB = statusDB;
    this.getConfig = getConfig || (() => ({}));
    this.running = false;
    this._abort = null;
  }

  _emitLog(email, line) {
    if (this.io) this.io.emit('gopay-activate-log', { email, line, ts: Date.now() });
  }
  _emitStatus(email, status, phase) {
    if (this.io) this.io.emit('gopay-activate-status', { email, status, phase, ts: Date.now() });
    if (this.statusDB) {
      try { this.statusDB.set(email, { status, phase }); } catch {}
    }
  }

  async activateOne(account) {
    const email = account.email;
    // Phase 1: Outlook 登录（复用，零改动）
    this._emitStatus(email, 'running', 'login');
    const login = await runProtocolRegister(account, null);
    if (login.status !== 'success') {
      this._emitStatus(email, 'error', 'login');
      return { email, status: 'error', detail: 'login failed' };
    }
    const token = login.accessToken;
    const planType = (login.session?.account?.planType || 'free').toLowerCase();

    // Phase 2: 已是 plus 则跳过
    if (['plus', 'pro', 'team'].includes(planType)) {
      this._emitStatus(email, 'plus_gopay', 'already-plus');
      return { email, status: 'plus_gopay', detail: 'already plus' };
    }

    // Phase 3: IDR Midtrans 链接（日本代理，fetchCheckoutLink 内部走 JP 通道）
    this._emitStatus(email, 'running', 'checkout');
    const co = await fetchCheckoutLink(token, { country: 'ID', currency: 'IDR' });
    if (co.noJpProxy) { this._emitStatus(email, 'no_jp_proxy', 'checkout'); return { email, status: 'no_jp_proxy' }; }
    if (!co.link) { this._emitStatus(email, 'no_idr_link', 'checkout'); return { email, status: 'no_idr_link' }; }
    if (!co.midtrans_url) { this._emitStatus(email, 'no_midtrans', 'checkout'); return { email, status: 'no_midtrans' }; }
    const midtransUrl = co.midtrans_url;
    if (this.statusDB) { try { this.statusDB.set(email, { midtransUrl }); } catch {} }

    // Phase 4+5: 注册 GoPay 钱包 + 支付（印尼代理，单脚本）
    this._emitStatus(email, 'running', 'gopay-pay');
    const cfg = this.getConfig();
    const idProxy = cfg?.gopay?.register_proxy || '';
    const pin = cfg?.gopay?.default_pin || '147258';
    const res = await runGopayActivate(
      { midtrans_url: midtransUrl, pin, timeout: 600 },
      { proxy: idProxy, onLog: (l) => this._emitLog(email, l) }
    );

    // Phase 6: 状态落地
    this._emitStatus(email, res.status, 'done');
    return { email, ...res };
  }

  async start(accounts) {
    if (this.running) return { error: 'already running' };
    this.running = true;
    this._abort = new AbortController();
    const results = [];
    try {
      for (const acct of accounts) {
        if (this._abort.signal.aborted) break;
        results.push(await this.activateOne(acct));
      }
    } finally {
      this.running = false;
    }
    return { results };
  }

  async stop() {
    if (this._abort) this._abort.abort();
    this.running = false;
  }
  getStatus() { return { running: this.running }; }
}

module.exports = { redactGopayLine, runGopayActivate, GoPayActivateEngine };
```

替换掉上一步的 `module.exports` 行。

- [ ] **Step 7: 运行全部 gopay-engine 测试**

Run: `node --test server/__tests__/gopay-engine-redact.test.js server/__tests__/gopay-engine-spawn.test.js`
Expected: PASS (7 tests total)

- [ ] **Step 8: 提交**

```bash
git add server/gopay-engine.js server/__tests__/gopay-engine-spawn.test.js server/__tests__/fixtures/stub_activate.py protocol-engine.js
git commit -m "feat: GoPayActivateEngine 6-phase orchestration + spawn wrapper"
```

---

### Task 8: server/db.js 加 nullable 列 + status.js 映射

**Files:**
- Modify: `server/db.js`
- Modify: `web/src/status.js`
- Test: `server/__tests__/gopay-db-columns.test.js`

**背景：** spec §7.1 加 3 个 nullable 列（迁移安全）；§7.2 加新状态码映射。

- [ ] **Step 1: 写列存在性失败测试**

Create `server/__tests__/gopay-db-columns.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

test('account_status has gopay columns', async () => {
  const tmp = path.join(os.tmpdir(), `gopay-db-${Date.now()}.db`);
  process.env.DB_PATH = tmp;
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  await db.ready;
  const cols = db.getColumns ? db.getColumns('account_status') : [];
  assert.ok(cols.includes('midtrans_url'));
  assert.ok(cols.includes('gopay_phone'));
  assert.ok(cols.includes('gopay_result'));
  try { fs.unlinkSync(tmp); } catch {}
});
```

> 注意：若 `db.js` 无 `getColumns`/`ready`/`DB_PATH` 支持，按其实际 API 调整断言（读 `db.js` 现有导出与初始化方式后对齐）。本测试目的是确认迁移加了列。

- [ ] **Step 2: 运行，确认失败**

Run: `node --test server/__tests__/gopay-db-columns.test.js`
Expected: FAIL — 列不存在

- [ ] **Step 3: 在 db.js 迁移里加列**

在 `server/db.js` 的表迁移区（找到 `account_status` 的 `ALTER TABLE ... ADD COLUMN` 模式或建表后的迁移段），追加幂等迁移：

```javascript
// gopay 印尼激活流水线列（spec §7.1，nullable 迁移安全）
const gopayCols = [
  ['midtrans_url', 'TEXT'],
  ['gopay_phone', 'TEXT'],
  ['gopay_result', 'TEXT'],
];
for (const [col, type] of gopayCols) {
  try { db.run(`ALTER TABLE account_status ADD COLUMN ${col} ${type} DEFAULT NULL`); } catch {}
}
```

（对齐 `db.js` 现有的迁移写法——若它用 `try/catch` 包 ALTER，照抄；若有列存在检测 helper，复用。）

- [ ] **Step 4: 运行，确认通过**

Run: `node --test server/__tests__/gopay-db-columns.test.js`
Expected: PASS

- [ ] **Step 5: status.js 加映射**

在 `web/src/status.js` 的状态映射对象里加（找到现有 `plus`/`no_link` 等映射，照其结构追加）：

```javascript
  no_idr_link:   { label: 'IDR链接失败', type: 'danger' },
  no_midtrans:   { label: '非Midtrans链接', type: 'danger' },
  gopay_reg_fail:{ label: 'GoPay注册失败', type: 'warning' },
  gopay_pay_fail:{ label: 'GoPay支付失败', type: 'warning' },
  gopay_fraud:   { label: 'GoPay风控拒付', type: 'danger' },
  plus_gopay:    { label: 'Plus(GoPay)', type: 'success' },
```

- [ ] **Step 6: 提交**

```bash
git add server/db.js web/src/status.js server/__tests__/gopay-db-columns.test.js
git commit -m "feat: add gopay columns + status mappings (non-breaking)"
```

---

### Task 9: server/routes/gopay-activate.js + index.js 注册

**Files:**
- Create: `server/routes/gopay-activate.js`
- Modify: `server/index.js`
- Test: `server/__tests__/gopay-routes.test.js`

**背景：** spec §3.5。REST 控制 + config 脱敏读写。config 脱敏（apiKey 保留前 6 后 4）是纯函数，先 TDD。

- [ ] **Step 1: 写 config 脱敏失败测试**

Create `server/__tests__/gopay-routes.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { maskApiKey } = require('../routes/gopay-activate');

test('maskApiKey keeps first6 last4', () => {
  assert.strictEqual(maskApiKey('QAPFrFrcUdbUoFVCtJ4bpx6rwnt2wqRS'), 'QAPFrF...wqRS');
});
test('maskApiKey short key fully masked', () => {
  assert.strictEqual(maskApiKey('abc'), '****');
});
test('maskApiKey empty stays empty', () => {
  assert.strictEqual(maskApiKey(''), '');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test server/__tests__/gopay-routes.test.js`
Expected: FAIL — Cannot find module

- [ ] **Step 3: 写路由 + 脱敏**

Create `server/routes/gopay-activate.js`:

```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');

const GOPAY_CONFIG = path.join(__dirname, '..', '..', 'gopay', 'config', 'config.json');

function maskApiKey(k) {
  if (!k) return '';
  if (k.length <= 12) return '****';
  return `${k.slice(0, 6)}...${k.slice(-4)}`;
}

function createGopayRouter({ engine, getAccounts }) {
  const router = express.Router();

  router.post('/start', async (req, res) => {
    const emails = req.body?.emails || null;
    const all = getAccounts();
    const accounts = emails ? all.filter(a => emails.includes(a.email)) : all;
    engine.start(accounts);  // 不 await，异步跑，日志走 Socket.IO
    res.json({ started: true, count: accounts.length });
  });

  router.post('/stop', async (req, res) => {
    await engine.stop();
    res.json({ stopped: true });
  });

  router.get('/status', (req, res) => {
    res.json(engine.getStatus());
  });

  router.get('/config', (req, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(GOPAY_CONFIG, 'utf-8'));
      const sms = cfg.sms || {};
      const provider = sms.provider || 'smsbower';
      res.json({
        provider,
        apiKeyMasked: maskApiKey(sms[provider]?.api_key || ''),
        defaultPin: cfg.gopay?.default_pin || '',
        hasProxy: Boolean(cfg.gopay?.register_proxy),
      });
    } catch (e) {
      res.status(500).json({ error: 'config read failed' });
    }
  });

  router.post('/config', (req, res) => {
    // 白名单字段，原子写
    const allowed = ['provider', 'apiKey', 'defaultPin', 'registerProxy'];
    const body = req.body || {};
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(GOPAY_CONFIG, 'utf-8')); } catch {}
    cfg.sms = cfg.sms || {};
    cfg.gopay = cfg.gopay || {};
    if (body.provider) cfg.sms.provider = body.provider;
    if (body.apiKey) {
      const p = cfg.sms.provider || 'smsbower';
      cfg.sms[p] = cfg.sms[p] || {};
      cfg.sms[p].api_key = body.apiKey;
    }
    if (body.defaultPin) cfg.gopay.default_pin = body.defaultPin;
    if (body.registerProxy) cfg.gopay.register_proxy = body.registerProxy;
    const tmp = `${GOPAY_CONFIG}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, GOPAY_CONFIG);
    res.json({ saved: true });
  });

  return router;
}

module.exports = { createGopayRouter, maskApiKey };
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test server/__tests__/gopay-routes.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: 在 index.js 注册路由 + 退出清理**

在 `server/index.js` 里（找到现有 `app.use('/api/...', ...)` 注册区）加：

```javascript
const { GoPayActivateEngine } = require('./gopay-engine');
const { createGopayRouter } = require('./routes/gopay-activate');
const statusDB = require('./db');  // 若已 require 则复用现有变量
const gopayEngine = new GoPayActivateEngine({
  io,                                   // 现有 Socket.IO 实例
  statusDB,
  getConfig: () => {
    try { return JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'gopay', 'config', 'config.json'), 'utf-8')); }
    catch { return {}; }
  },
});
app.use('/api/gopay-activate', createGopayRouter({
  engine: gopayEngine,
  getAccounts: () => statusDB.getAllAccounts ? statusDB.getAllAccounts() : [],
}));
```

> `io`、`statusDB`、`getAllAccounts` 用 index.js 现有的实际变量名/方法名对齐（读 index.js 后填准）。

在现有 SIGINT/SIGTERM 优雅退出链里（找到 `process.on('SIGINT'`）加一行（纳入既有 5s deadline）：

```javascript
  try { await gopayEngine.stop(); } catch {}
```

- [ ] **Step 6: 跑全部 server 测试确认无回归**

Run: `node --test server/__tests__/`
Expected: 全部 PASS（含原有测试）

- [ ] **Step 7: 提交**

```bash
git add server/routes/gopay-activate.js server/index.js server/__tests__/gopay-routes.test.js
git commit -m "feat: gopay-activate REST routes + engine registration"
```

---

## 里程碑 E：前端

### Task 10: web/src/views/GoPayActivate.vue + 路由 + 导航

**Files:**
- Create: `web/src/views/GoPayActivate.vue`
- Modify: `web/src/router/index.js`（或等价路由表）
- Modify: 侧栏导航组件（`web/src/App.vue` 或 Layout 组件）

**背景：** spec §3.5。参照现有 `Execute.vue` 风格。前端无单测（项目惯例：Vue 视图靠手动 E2E）。

- [ ] **Step 1: 写视图组件**

Create `web/src/views/GoPayActivate.vue`:

```vue
<template>
  <div class="gopay-activate">
    <el-card>
      <template #header>
        <div class="header">
          <span>GoPay 印尼 Plus 激活</span>
          <el-tag :type="running ? 'success' : 'info'">{{ running ? '运行中' : '空闲' }}</el-tag>
        </div>
      </template>
      <el-space>
        <el-button type="primary" :disabled="running" @click="start">启动</el-button>
        <el-button :disabled="!running" @click="stop">停止</el-button>
        <el-button @click="loadConfig">刷新配置</el-button>
      </el-space>
      <el-descriptions :column="2" border style="margin-top:12px">
        <el-descriptions-item label="SMS Provider">{{ cfg.provider }}</el-descriptions-item>
        <el-descriptions-item label="API Key">{{ cfg.apiKeyMasked }}</el-descriptions-item>
        <el-descriptions-item label="默认 PIN">{{ cfg.defaultPin }}</el-descriptions-item>
        <el-descriptions-item label="印尼代理">{{ cfg.hasProxy ? '已配置' : '未配置' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card style="margin-top:16px">
      <template #header>实时日志</template>
      <div class="log-box" ref="logBox">
        <div v-for="(l, i) in logs" :key="i" class="log-line">
          <span class="ts">{{ l.email }}</span> {{ l.line }}
        </div>
      </div>
    </el-card>

    <el-card style="margin-top:16px">
      <template #header>激活结果</template>
      <el-table :data="results" size="small">
        <el-table-column prop="email" label="邮箱" />
        <el-table-column prop="status" label="状态" />
        <el-table-column prop="phase" label="阶段" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import axios from 'axios';
import { io } from 'socket.io-client';

const running = ref(false);
const cfg = ref({ provider: '', apiKeyMasked: '', defaultPin: '', hasProxy: false });
const logs = ref([]);
const results = ref([]);
const logBox = ref(null);
let socket = null;

async function loadConfig() {
  const { data } = await axios.get('/api/gopay-activate/config');
  cfg.value = data;
}
async function loadStatus() {
  const { data } = await axios.get('/api/gopay-activate/status');
  running.value = data.running;
}
async function start() {
  await axios.post('/api/gopay-activate/start', {});
  running.value = true;
}
async function stop() {
  await axios.post('/api/gopay-activate/stop');
  running.value = false;
}

onMounted(() => {
  loadConfig();
  loadStatus();
  socket = io();
  socket.on('gopay-activate-log', (m) => {
    logs.value.push(m);
    if (logs.value.length > 500) logs.value.shift();
    nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
  });
  socket.on('gopay-activate-status', (m) => {
    const idx = results.value.findIndex(r => r.email === m.email);
    if (idx >= 0) results.value[idx] = { ...results.value[idx], ...m };
    else results.value.push(m);
    if (m.status && m.status !== 'running') running.value = false;
  });
});
onUnmounted(() => { if (socket) socket.disconnect(); });
</script>

<style scoped>
.header { display: flex; justify-content: space-between; align-items: center; }
.log-box { height: 360px; overflow-y: auto; background: #1e1e1e; color: #ddd;
  font-family: monospace; font-size: 12px; padding: 8px; border-radius: 4px; }
.log-line { white-space: pre-wrap; }
.ts { color: #6cf; }
</style>
```

- [ ] **Step 2: 加路由**

在 `web/src/router/index.js`（或等价）的 routes 数组加（对齐现有路由写法）：

```javascript
  { path: '/gopay-activate', name: 'GoPayActivate',
    component: () => import('../views/GoPayActivate.vue') },
```

- [ ] **Step 3: 加侧栏导航入口**

在侧栏菜单组件（找到现有 `Execute`/`Accounts` 菜单项）追加一个 menu-item 指向 `/gopay-activate`，文案"GoPay激活"。

- [ ] **Step 4: 构建前端确认无错**

Run: `cd web && npm run build`
Expected: 构建成功，无报错

- [ ] **Step 5: 提交**

```bash
cd ..
git add web/src/views/GoPayActivate.vue web/src/router web/src/App.vue
git commit -m "feat: GoPayActivate dashboard view + route + nav"
```

---

## 里程碑 F：全链路 E2E

### Task 11: 端到端手动验证（不跑通不报成功）

**Files:** 无

**背景：** spec §11。真实 Outlook 账号跑完 6 步，验证 chatgpt.com 显示 Plus。

- [ ] **Step 1: 准备**

- 一个有效 Outlook ChatGPT 账号（email/password/client_id/refresh_token）导入 Accounts。
- `gopay/config/config.json` 填好 SmsBower key + IPRoyal 印尼代理。
- sing-box JP 通道可用（Phase 3 需要日本 IP）。
- SmsBower 余额充足（注册要 3 次 + 支付 1 次 SMS）。

- [ ] **Step 2: 启动服务，打开 GoPay 激活页**

```bash
# 项目既有启动方式
npm start   # 或 start.bat
```
浏览器打开仪表盘 → GoPay激活 → 点"启动"。

- [ ] **Step 3: 观察 6 阶段日志**

逐阶段确认（日志已脱敏，无明文 OTP/token）：
1. login → accessToken
2. plan check → free（继续）
3. checkout → 产出 midtrans_url（非空，否则 `no_midtrans`）
4. gopay 注册 → signup/PIN/login OTP → 1 Rp credited
5. gopay 支付 → Midtrans linking OTP → charge settled
6. 结果 → `plus_gopay`

- [ ] **Step 4: 验证 Plus**

用该账号登录 chatgpt.com，确认显示 ChatGPT Plus。或调 `/api/auth/session` 看 `planType === 'plus'`。

- [ ] **Step 5: 记录结论**

成功：在 `docs/superpowers/plans/probe-result.md` 记 E2E 成功（脱敏）。
失败：按 spec §8 状态码定位（`no_midtrans`/`gopay_reg_fail`/`gopay_pay_fail`/`gopay_fraud`），如实回报，不谎报成功。区域风控/promo 失效是业务问题，照实说明。

---

## Self-Review 结论

**Spec 覆盖：** §1目标→全 Task；§3架构→Task7 引擎；§4文件→Task1/3/4/7/9/10；§5代理分离→Task7(JP via fetchCheckoutLink)+Task7 runGopayActivate(印尼 proxy)；§6接口→Task4(stdin/stdout)+Task1(checkout改造)；§7DB/状态→Task8；§8错误处理→Task4(状态分支)+Task7(引擎落地)；§9.1探针→Task2(GATE)；§9.2 1Rp→Task5 Step3 检查；§9.5脱敏→Task6；§11测试→各 Task TDD+Task11 E2E。

**类型一致：** `redactGopayLine`/`runGopayActivate`/`GoPayActivateEngine`/`maskApiKey`/`extract_midtrans_url`/`activate(inp,deps)` 跨 Task 命名一致；`midtrans_url`(Python/JSON) ↔ `midtransUrl`(Node 变量) ↔ `midtrans_url`(DB 列) 边界清晰。

**已知需对齐项（执行时读现有代码填准）：** index.js 的 `io`/`statusDB`/`getAllAccounts` 实际变量名；db.js 迁移写法与 `getColumns`/`ready` API；status.js 映射对象结构；router 与侧栏组件的实际路径。这些是"按现有模式对齐"，非占位符。
