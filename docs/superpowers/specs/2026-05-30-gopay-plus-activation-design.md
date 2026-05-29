# GoPay 印尼区 ChatGPT Plus 激活流水线设计

> 状态：与用户逐段确认（2026-05-30，Section 1/2/3 全部 confirmed）。
> 范围 = 在 `chatgpt-auto-login` 新增一条独立的印尼 GoPay 激活流水线，与现有美区 PayPal 流水线并行、互不干扰。原有 `engine.js` / `protocol-engine.js` / PayPal 流程零改动。
> 代码最终落在 `E:\workspace\projects\demo\chatgpt-auto-login`。GoPay 能力从 `E:\workspace\projects\gopay-deploy` 的 `opai` 包整包复制（含已验证的 register+login+consent→1Rp 修复）。

## 1. 目标

实现 6 步闭环，全自动把一个 Outlook 邮箱注册的 ChatGPT 账号激活为 Plus（印尼区 GoPay 支付）：

1. Outlook 邮箱登录 ChatGPT
2. 获取 accessToken
3. 生成印尼 IDR 支付长链（JP 代理 + currency=IDR），提取 Midtrans snap URL 并存储
4. 注册带 1 Rp 余额的 GoPay 钱包
5. 打开支付长链，用 GoPay 支付（输入 PIN + SMS OTP）
6. 验证是否成功变为 Plus 套餐

## 2. 关键决策（用户拍板）

| 决策点 | 选择 |
|---|---|
| 支付链接来源 | 改造 `checkout_link.py`，`country=ID/currency=IDR` 产出链接，代码自动从 pay.openai.com 提取 Midtrans snap URL |
| GoPay 代码集成 | 从 gopay-deploy 整包复制 `opai` 到 `chatgpt-auto-login/gopay/`，Node spawn Python 调用 |
| SMS provider | 配置可切换（`create_sms_provider` 工厂），默认 SmsBower + IPRoyal 印尼住宅代理 |
| 运行入口 | 接入现有 Web 仪表盘（新 Vue 视图 + 新路由 + 新 engine） |
| Phase 4/5 脚本 | 方案 A：合并为单脚本 `gopay_activate.py`，同进程同 provider 实例持有号码 |

## 3. 架构总览

新流水线 6 阶段（单账号线性闭环，**无需 inbox 队列**）：

```
Phase 1: Outlook 登录       复用 protocol_register.py（不改）  → accessToken + session
Phase 2: Plan 检查          session.planType，已是 plus 则跳过
Phase 3: 生成 IDR 链接       checkout_link.py 改造(country=ID,currency=IDR,JP代理)
                            → 从 pay.openai.com 提取 Midtrans snap URL → 存 DB
Phase 4: 注册 GoPay 钱包     gopay_activate.py 内：租印尼号→signup→PIN→login→consent→1Rp
Phase 5: GoPay 支付         gopay_activate.py 内：同号同 provider 支付 Midtrans URL
                            linking(PIN+SMS) → charge → challenge(PIN) → settlement
Phase 6: 验证 Plus          复用 session 检查 planType == plus
```

**核心约束**：Phase 4 注册的印尼手机号必须持有到 Phase 5 支付完成——支付时 Midtrans linking 还要用同一个号收第 4 次 SMS OTP。因此 Phase 4+5 合并为单脚本（方案 A），同进程同 provider 实例同 aid，中间不 release/cancel/done。

**号码 OTP 时序**（同一个印尼号收 4 次 SMS）：
1. signup OTP（Gojek 注册）
2. PIN setup OTP
3. login 2FA OTP（拿 login-session token 触发 1Rp consent）
4. Midtrans linking OTP（支付绑定）

## 4. 文件清单

### 4.1 复制（从 gopay-deploy 原样搬入）

```
chatgpt-auto-login/
  gopay/
    app/src/opai/              ← 整包复制（core/ cli/ __main__.py），含 login+consent→1Rp 已验证逻辑
    config/
      config.json              ← gopay 独立配置；进 .gitignore
      config.example.json      ← 脱敏模板
    pyproject.toml
```

### 4.2 新建脚本（chatgpt-auto-login 根目录）

| 文件 | 责任 | I/O |
|---|---|---|
| `gopay_activate.py` | Phase 4+5 合并：注册钱包(含1Rp) + 同号支付 Midtrans URL | stdin `{midtrans_url,pin,timeout}`；stdout JSON log lines + 最终 `{status,phone,transaction_status}` |

### 4.3 改造脚本

| 文件 | 改动 |
|---|---|
| `checkout_link.py` | `billing_details.country`/`currency` 从 stdin 读（默认仍 JP/JPY，不破坏现有调用）；成功后额外尝试提取 Midtrans snap URL，附加到输出 |

### 4.4 主项目新增

| 文件 | 责任 |
|---|---|
| `server/gopay-engine.js` | 新流水线编排器（6 阶段）。独立单例，组合现有 runProtocolRegister + fetchCheckoutLink + 新 gopay_activate.py。不进 engine-singleton |
| `server/routes/gopay-activate.js` | REST：`POST /start`、`POST /stop`、`GET /status`、`GET/POST /config` |
| `web/src/views/GoPayActivate.vue` | 新视图：账号列表 + 启停 + 6 阶段实时日志 + 结果表（参照 Execute.vue） |

### 4.5 主项目改动（最小侵入）

- `server/index.js`：注册 `routes/gopay-activate.js`；SIGINT/SIGTERM 清理链加 `await gopayEngine.stop()`（现有 5s 硬 deadline 内）。
- `web/src/router`（或等价路由表）+ 侧栏导航：加 GoPay 激活入口。
- `web/src/status.js`：加新状态码映射（§7）。
- `server/db.js`：`account_status` 表加 3 个 nullable 新列（§6），现有列/路径不动。
- `.gitignore`：加 `gopay/config/config.json`、`gopay/**/gopay_worker_accounts.json`。

### 4.6 不改

主 `config.json` schema、`server/engine.js`、`protocol-engine.js`、PayPal `payment.js`、现有 Stripe/Discord 流程、现有 sql.js 列与读写路径。

## 5. 代理分离（易踩坑）

两个阶段用**不同国家**的代理，Node spawn 时分别注入 `HTTPS_PROXY`：

| 阶段 | 代理 | 原因 |
|---|---|---|
| Phase 3 checkout | 日本（现有 sing-box JP 通道 :7891） | OpenAI 要日本 IP 拿 promo |
| Phase 4/5 gopay | 印尼（IPRoyal `geo.iproyal.com:12321`，已验证） | Gojek/Midtrans 要印尼 IP |

两代理完全独立。gopay 脚本继承印尼代理，不是主 sing-box 美区代理。IPRoyal 用 HTTP CONNECT 隧道（端口 12321，不支持 SOCKS5）；本机若开 TUN 全局代理需把 `geo.iproyal.com` 加直连白名单。

## 6. Python 脚本接口

### 6.1 `gopay_activate.py` stdin/stdout 协议

```
stdin:  {"midtrans_url":"https://app.midtrans.com/snap/v3/redirection/<uuid>",
         "pin":"147258", "timeout":600}
stdout: {"log":"  [GoPay] renting Indonesian number"}     ← 实时进度
        {"log":"  [GoPay] signup OTP received"}
        {"log":"  [GoPay] PIN set, login session token acquired"}
        {"log":"  [GoPay] 1 Rp credited"}
        {"log":"  [GoPay] Midtrans linking..."}
        {"log":"  [GoPay] charge settled"}
        {"status":"success","phone":"+62...","transaction_status":"settlement"}  ← 最终行
        # 失败: {"status":"gopay_reg_fail"|"gopay_pay_fail"|"gopay_fraud","detail":"..."}
env:    HTTPS_PROXY=<印尼代理>, OPAI_CONFIG_FILE=<abs>/gopay/config/config.json
```

内部流程：`_register_one(provider,pin,proxy,...)` → login(GoPay creds) → `accept_consents` → 轮询余额≥1 → `GoPayPayment(proxy).pay(midtrans_url, phone, "62", pin, wait_otp=provider.wait_code(aid))`。SMS provider 实例和 aid 全程复用，注册成功后**不 release**。

### 6.2 `checkout_link.py` 改动

`body.billing_details.country/currency` 从 stdin 读（`inp.get('country','JP')` / `inp.get('currency','JPY')`，默认不变，向后兼容）。成功提取 `pay.openai.com` 链接后，额外用 curl_cffi 跟随到结账页尝试提取 `app.midtrans.com/snap/v[34]/redirection/<uuid>`，附加 `midtrans_url` 字段到输出（提取不到则该字段为空，由 Node 侧判 `no_midtrans`）。

### 6.3 SMS provider 切换

复用 gopay-deploy 已有 `create_sms_provider(name, key)` 工厂（smsbower/smscloud/nexsms/herosms）。`gopay/config/config.json` 的 `sms.provider` 切换，默认 `smsbower`。无需新代码。

### 6.4 子进程模式（对齐现有 checkout_link.py）

Python 解释器查找 `py -3`/`python`；`cwd=gopay/app` 或 `env.PYTHONPATH=<abs>/gopay/app/src`；JSON log lines 协议；超时 600s（注册+支付需几分钟）。

## 7. DB 持久化与状态码

### 7.1 account_status 新增列（nullable，sql.js 迁移安全）

| 列 | 用途 |
|---|---|
| `midtrans_url` | Phase 3 产出，重试复用 |
| `gopay_phone` | Phase 4 注册的印尼号 |
| `gopay_result` | Phase 5/6 最终状态 |

现有列与现有流水线读写路径完全不动。

### 7.2 新状态码（status.js 加映射，不改现有）

| 状态 | 含义 |
|---|---|
| `no_idr_link` | Phase 3 IDR checkout 失败 |
| `no_midtrans` | 链接非 Midtrans（头号风险触发） |
| `gopay_reg_fail` | Phase 4 注册失败（风控/号库存/429） |
| `gopay_pay_fail` | Phase 5 支付失败（可重试） |
| `gopay_fraud` | fraud deny，号烧了，不重试 |
| `plus_gopay` | 成功，Plus 激活 |

## 8. 错误处理语义（失败不连锁烧资源）

- **Phase 3 失败** → `no_idr_link`/`no_midtrans`，accessToken 还在，可重试，不烧 ChatGPT 账号。
- **Phase 4 失败**（WAF 403 / 号库存空 / 429）→ `gopay_reg_fail`，ChatGPT 账号无损，换印尼 IP/号重试；复用已验证的 429-IP轮转 + 递增延迟逻辑。
- **Phase 5 fraud deny** → `gopay_fraud`，该印尼号烧了（不退号、不重试该号），Midtrans URL 仍有效，下次换新号重试。
- **Phase 5 普通失败** → `gopay_pay_fail`，Midtrans URL 存 DB 复用，重试跳过 Phase 3。
- **1Rp 不够扣款** → 明确报 `gopay_pay_fail` + 金额，不谎报成功。

## 9. 风险（头号未知数）

### 9.1 Midtrans URL 提取（命门，未验证）

整个方案假设印尼 IDR 结账链接最终走 Midtrans GoPay。依据：`gopay_payment_protocol.py` 的 HAR 来源正是 `chatgpt.com.free.plus.gopay.har`（ChatGPT Plus 印尼区结账确实走 Midtrans GoPay）。但 pay.openai.com → Midtrans snap URL 的**具体提取链路未经本项目验证**。**实施第一步必须是 Phase 3 探针**：用真实 IDR accessToken 调 checkout，确认能拿到 `app.midtrans.com/snap/.../redirection/<uuid>`。探针失败则整个方案需重新设计，如实报告，不强推。

### 9.2 1Rp 是否够支付（次号风险）

ChatGPT Plus 印尼区免费试用若为 $0 promo，Midtrans charge 金额为 0，1Rp 仅"激活钱包让其能 link"；若实际扣 IDR 金额，1Rp 远不够。与 9.1 探针一起验证（看 charge 阶段 amount）。

### 9.3 区域风控

Gojek/GoPay/Midtrans 要印尼 IP。已用 IPRoyal 印尼住宅代理验证注册+1Rp 通过。但大规模可能撞 WAF/fraud；`gopay.register_proxy` 逃生口可换代理。代码不保证业务跑通；风控失败如实报告。

### 9.4 共享出口 IP

gopay（印尼）与主流水线（美区/日本）出口 IP 不同，互不叠加 rate-limit。gopay 内部多账号串行，复用 429-IP轮转。

### 9.5 日志脱敏（硬性）

gopay Python 会打印 OTP（`Signup OTP: %s`、`PIN OTP: %s`）与 token。`gopay-engine.js` 在 `io.emit` 前必须对每行 redact（复用 `server/logger.js#redact`），覆盖 OTP 邻接数字、access/refresh/id_token、`Bearer <token>`、JWT 三段。

### 9.6 凭证落盘

`gopay/config/config.json`（SmsBower key、IPRoyal 代理）、`gopay_worker_accounts.json`（token）、ChatGPT token 全进 `.gitignore`，绝不进 commit/日志回显/聊天回复。

## 10. 范围外

- 美区 PayPal 流水线任何改动（保持零改动）。
- inbox 队列 / worker 多线程（单账号线性闭环不需要）。
- gopay 改用主项目 sql.js DB（gopay 用自己的 JSON/SQLite 存储）。

## 11. 测试

- **Python**（`py -3 -m unittest`）：`gopay_activate.py` 用 mock SmsProvider + mock GoPayPayment 测 6 阶段编排（不真注册）；`checkout_link.py` 的 Midtrans URL 提取正则单测。
- **Node**（`node --test`）：gopay-engine 状态机转移；redact 覆盖 OTP/token；`routes/gopay-activate.js` config 脱敏读写。
- **手动 E2E**（不跑通不报成功）：① 先跑 Phase 3 探针确认 Midtrans URL（§9.1）；② 真实 Outlook 账号跑完 6 步，验证 chatgpt.com 显示 Plus。区域风控/promo 失效按业务问题如实报告。

## 12. 实施顺序（供 writing-plans 细化）

1. **Phase 3 探针**（最高优先）：改 `checkout_link.py` 加 country/currency + Midtrans 提取；用真实 IDR token 验证能拿到 snap URL + charge 金额。探针通过才继续。
2. 复制 `opai` 包到 `gopay/`，加 config.example.json / .gitignore；`pip install tls_client` 后 `py -m opai pay --help` 跑通（验证包可导入）。
3. 写 `gopay_activate.py`（合并注册+1Rp+支付），mock 单测 + 真实单号 E2E（印尼代理 + SmsBower）。
4. `server/gopay-engine.js`（6 阶段编排 + redact）+ 状态机单测。
5. `server/routes/gopay-activate.js` + `server/index.js` 注册 + 退出清理。
6. `web/src/views/GoPayActivate.vue` + 路由 + 导航 + status.js 映射。
7. 全链路手动 E2E：Outlook 账号 → 6 步 → Plus 验证。
