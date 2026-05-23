# ChatGPT Auto Login & Plus Activation Pipeline

批量 ChatGPT 账号登录、Plus 免费试用激活、PayPal 支付、OAuth 凭证生成的自动化流水线。

**v3.0.0 架构**：99% HTTP 协议化 + PayPal 独立 RPA 子进程（headed Chromium）。仅 PayPal sub-flow 用浏览器（PayPal 风控对 headless 敏感），其余环节（Stripe checkout、Stripe billing、PKCE OAuth、manual approval）全部 HTTP。Server 主进程零 Chrome 接触。

支持两套引擎，通过 `protocolMode` 配置切换：
- **协议模式**（`protocolMode: true`，v3.0.0 默认）：上述 99% HTTP + paypal_rpa.js 子进程
- **浏览器模式**（`protocolMode: false`）：Playwright Chrome 全流程（v2.19.1 baseline，保留）

## 快速开始

### Windows

```
双击 start.bat
```

脚本会自动：检测 Node.js / Python / Chrome、安装 npm 依赖、首次下载 playwright-core Chromium（~300MB）、构建前端、创建默认配置、启动服务并打开 `http://localhost:3000`。

### 手动启动

```bash
# 依赖
npm install
py -3 -m pip install curl_cffi
npx playwright install chromium   # 首次跑 v3 PayPal RPA 前必装
cd web && npm install && npm run build && cd ..

# 启动
node server/index.js
```

浏览器访问 `http://localhost:3000`（无需登录）。

## 环境要求

| 依赖 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 18 | 后端服务、所有引擎 |
| Python 3 | >= 3.8 | 协议模式 + v3 HTTP 模块 |
| curl_cffi (Python) | >= 0.15 | TLS/JA3 指纹模拟 HTTP（chrome JA3）|
| playwright-core Chromium | v1223 | v3 PayPal RPA 子进程（`npx playwright install chromium`）|
| Google Chrome（桌面）| 最新版 | 仅 `protocolMode=false` 时需要（PipelineEngine 用）|

## v3.0.0 执行流程（`protocolMode: true`）

```
Phase 1: protocol_register.py        — 协议登录 (curl_cffi, IMAP OTP)
   ↓ access_token + plan
Phase 2: checkout_link.py            — Stripe checkout API, 必须经 7891 JP-KDDI
   ↓ cs_live link + pk_live_*
Phase 2.5: stripe_init.py            — Stripe init 验证 amount_due=0 (经 7890 US)
   ↓ verified $0
Phase 3a: stripe_billing.py          — Stripe 3-POST: /init → /v1/payment_methods → /confirm
   ↓ paypal_redirect_url
Phase 3b: paypal_rpa.js              — 独立 Node 子进程，headed Chromium，无痕模式
   - PayPal login → checkout 12 字段 sequential 填表
   - SMS 自动 fetch + 填
   - 监听 pay.openai.com/redirect_status=succeeded
   ↓ chatgpt_approval_url
Phase 3c: manual_approval.py         — GET approval URL + poll /accounts/check/v4
   ↓ plan_type=plus
Phase 4: pkce_oauth.py               — HTTP PKCE code-flow（best-effort；失败降级 plus_no_rt）
   ↓ refresh_token (or fallback)
```

**fail-fast**：任意阶段失败 → 立即停账号、写 status、跳下一个，不浪费下游资源。

## 代理配置（v3 关键）

`config.proxy.jpCheckout.enabled: true` + 订阅源中含 KDDI 节点是 v3 的硬性要求 —— Phase 2 必须经 JP IP 调 OpenAI checkout 才能拿到 `plus-1-month-free` coupon 应用。

| 端口 | 用途 |
|---|---|
| 7890 (主入口) | US 节点池，用于 protocol login / Stripe init / PayPal RPA / manual approval / PKCE |
| 7891 (JP-Checkout 入口) | KDDI 节点，仅用于 Phase 2 OpenAI checkout API |

在 Config 页面填入订阅 URL + 勾选 jpCheckout，详见 v2.18.1 文档（`docs/superpowers/specs/2026-05-23-jp-checkout-whitelist-design.md`）。

## 配置说明

首次启动后通过 Web 仪表盘 **配置设置** 页面配置，或直接编辑 `config.json`：

| 字段 | 说明 |
|---|---|
| `protocolMode` | 引擎选择 (`true` 走 v3 协议引擎；`false` 走 PipelineEngine 浏览器引擎) |
| `paymentLinkSource` | 支付链接来源 (`api` v2.18+ 协议直拿；`discord` 老 bot 路径) |
| `enableOAuth` | Phase 4 PKCE OAuth 开关（开启后试图拿 refresh_token，失败降 plus_no_rt） |
| `enableCPA` | CPA 外部注册开关（仅 PipelineEngine 用） |
| `phone` / `smsApiUrl` | PayPal 手机号 + 短信接收 API（PayPal RPA 用）|
| `phoneSlots` | 多手机槽（数组形式，protocol-engine 取 `[0]`） |
| `proxy.enabled` | sing-box 总开关 |
| `proxy.subscriptionUrl` | 订阅 URL（sing-box 自动拉节点） |
| `proxy.regionFilter` | 主入口节点过滤关键字（默认 "US"） |
| `proxy.rotationStrategy` | 主入口轮换策略（`sequential` / `random`） |
| `proxy.jpCheckout.enabled` | **v3 必开** JP-Checkout 通道（7891） |
| `proxy.jpCheckout.keyword` | JP 节点关键字（默认 "KDDI"） |
| `proxy.jpCheckout.whitelist` | 精确 tag 列表（优先级高于 keyword） |
| `discordToken` 等 | Discord bot 配置（仅 `paymentLinkSource: discord` 时需要）|

## 账户格式

通过 Web 仪表盘 **账户管理** 页面批量导入，每行一个账号：

```
email----password----clientId/TOTP----refreshToken
```

| 账号类型 | 第三列 | 第四列 |
|---|---|---|
| Outlook | Microsoft Client ID | OAuth Refresh Token |
| Gmail | TOTP 密钥 | 留空 |

域名自动识别：`@outlook.com` / `@hotmail.com` / `@live.com` / `@msn.com` → Outlook，`@gmail.com` → Google。

## 账户状态

| status | 标签 | 含义 | 可重试 |
|---|---|---|---|
| `plus` | Plus(有RT) | 完整成功 + refresh_token | — |
| `plus_no_rt` | Plus(无RT) | 已 Plus 但 PKCE 未拿到 RT（保留 v2 access_token）| 重跑 PKCE |
| `no_jp_proxy` | JP 节点不可用 | jpCheckout 通道 0 节点可用 | ✅ |
| `no_promo` | 无 0 元资格 | Phase 2.5 看到 amount_due > 0（账号在 OpenAI 服务端无资格）| ❌ |
| `verify_error` | Stripe 验证失败 | Phase 2.5 Stripe init 调用失败 | ✅ |
| `stripe_billing_error` | Stripe 计费失败 | Phase 3a confirm 失败 | ✅ |
| `activation_error` | 订阅激活超时 | Phase 3c 30s 内 ChatGPT 不返回 plus | ✅ |
| `no_link` | 无链接 | Phase 2 没拿到 cs_live | ✅ |
| `error` | 错误 | 其他失败（含 PayPal RPA 失败：card_declined / sms_fetch_fail / paypal_generic_error / paypal_form_unresponsive / approval_timeout）| 视 reason |
| `deactivated` | 已删除 | 账号被 OpenAI 停用 | ❌ |
| `idle` / `running` | 空闲 / 运行中 | — | — |

## 输出文件

凭证文件保存在 `cpa-auth/` 目录：

| 文件 | 格式 | 说明 |
|---|---|---|
| `codex-{email}.json` | CPA | Codex 格式凭证（access_token + refresh_token） |
| `sub2api-{email}.json` | Sub2API | Sub2API 导入格式凭证 |

可通过 Web 仪表盘的「下载选中」按钮按格式批量下载（zip）。

## 项目结构

```
chatgpt-auto-login/
├── start.bat                       # Windows 一键启动
├── server/
│   ├── index.js                    # Express 服务入口
│   ├── engine.js                   # PipelineEngine (protocolMode=false)
│   ├── chatgpt-checkout.js         # Phase 2 spawner (checkout_link.py)
│   ├── stripe-verify.js            # Phase 2.5 spawner (stripe_init.py)
│   ├── stripe-billing.js           # Phase 3a spawner (stripe_billing.py) [v3.0.0]
│   ├── paypal-rpa.js               # Phase 3b spawner (paypal_rpa.js)    [v3.0.0]
│   ├── manual-approval.js          # Phase 3c spawner (manual_approval.py) [v3.0.0]
│   ├── pkce-oauth.js               # Phase 4 spawner (pkce_oauth.py)     [v3.0.0]
│   ├── proxy/                      # sing-box 双入口 (7890 main + 7891 JP)
│   ├── discord-gateway.js          # Discord Gateway (legacy, paymentLinkSource=discord)
│   ├── chrome.js                   # Chrome 启动 + CDP（仅 PipelineEngine 用）
│   ├── db.js                       # sql.js + statusDB
│   ├── logger.js                   # 日志捕获
│   └── routes/                     # API 路由
├── protocol-engine.js              # v3 协议引擎 (protocolMode=true)
├── protocol_register.py            # Phase 1 协议登录 + IMAP OTP
├── checkout_link.py                # Phase 2 OpenAI checkout (curl_cffi, JP)
├── stripe_init.py                  # Phase 2.5 Stripe init verify (curl_cffi, US)
├── stripe_billing.py               # Phase 3a Stripe 3-POST chain      [v3.0.0]
├── paypal_rpa.js                   # Phase 3b PayPal RPA (playwright-core) [v3.0.0]
├── manual_approval.py              # Phase 3c subscription poll        [v3.0.0]
├── pkce_oauth.py                   # Phase 4 PKCE OAuth (HTTP)          [v3.0.0]
├── payment.js                      # PipelineEngine 的 autoPayment (v2.14 baseline)
├── login.js                        # PipelineEngine 浏览器登录
├── cpa.js                          # CPA OAuth 注册（可选）
├── utils.js                        # PKCE, auth file, TOTP 等工具
├── web/                            # Vue 3 + Element Plus 前端
│   └── src/views/                  # Dashboard / Accounts / Execute / Results / Config
├── config.json                     # 运行配置 (gitignored)
├── data.db                         # SQLite WASM (gitignored)
└── cpa-auth/                       # 凭证输出 (gitignored)
```

## 主要依赖

| 包 | 用途 |
|---|---|
| `playwright` | PipelineEngine 浏览器自动化（CDP） |
| `playwright-core` | v3 PayPal RPA 子进程（轻量版，需 `npx playwright install chromium`） |
| `express` + `socket.io` | Web 服务 + 实时日志推送 |
| `sql.js` | SQLite WASM 数据库 |
| `ws` | Discord Gateway WebSocket（legacy） |
| `imapflow` | Outlook IMAP OTP 读取 |
| `otplib` | Gmail TOTP 验证码生成 |
| `curl_cffi` (Python) | TLS/JA3 指纹模拟 HTTP（v3 + 协议登录共用） |

## 版本演进

| 版本 | 主要变化 |
|---|---|
| v2.18.0 | JP-KDDI 双入口（7890 US + 7891 JP）|
| v2.18.1 | jpCheckout 节点白名单 |
| v2.18.2 | body.country=US + currency=USD 解锁 PayPal + USD 计价 |
| v2.19.0 | 强制 JP（移除静默回退）+ Stripe init verify Phase 2.5 |
| v2.19.1 | payment.js 回滚到 v2.14 已知能用基线 |
| **v3.0.0** | 99% HTTP 协议化 + isolated PayPal RPA 子进程；新 status `stripe_billing_error` / `activation_error` |

详见 `docs/CHANGELOG.md`。

## 安全提示

- `config.json` / `data.db` / `cpa-auth/` / `token-*.txt` 均已 gitignored，不要提交
- Discord Token、CPA Key、IMAP token 等敏感数据仅存在本地 `config.json`
- 服务默认监听 `localhost:3000`，不暴露公网；如需远程访问请自行加反向代理 + 认证
- PayPal RPA 子进程以 headed Chromium 启动（PayPal 风控对 headless 敏感），运行时会看到浏览器窗口；窗口默认位于屏幕左上角 1/4 大小

## 已知限制

- **PayPal reCAPTCHA**：偶发，需手动点 checkbox（headed Chromium 可手解）
- **PKCE HTTP-only**：OpenAI Ory Hydra 需要 cookies，Bearer 单独不够 → 多数情况降级 `plus_no_rt`，账号本身仍是 Plus
- **PayPal 风控 genericError**：账号 / 卡 / IP 触发 PayPal 自身风控 → 立即标记 error 并 reason=`paypal_generic_error`
- **Stripe payment_method_types_mismatch**：偶发（账号 / session 状态相关），重试即可
- **Chromium 版本**：必须 playwright-core@1.60.0 对应的 chromium-1223（首次跑 `npx playwright install chromium`）
