# Protocol Register Mode Design Spec

## Goal

新增协议注册模式：用 Python curl_cffi 批量注册 Outlook 邮箱的 ChatGPT 账号，获取 accessToken，通过 Discord 拿 $0 Plus 支付链接，浏览器自动支付后生成无 refresh_token 的 CPA JSON 文件。支持多并发（协议登录并行 + 支付串行）。

## 约束

- **不修改**现有逻辑文件（engine.js、login.js、payment.js、utils.js、cpa.js）
- 新逻辑全部在**新文件**中实现
- 仅在配置页面加一个开关 `protocolMode`
- 只支持 Outlook 账号（有 client_id + refresh_token 用于 IMAP 读 OTP）

## Architecture

```
protocol-engine.js (Node.js)
  ├── 并行区：N 个 Python 子进程
  │   └── protocol_register.py (curl_cffi)
  │       chatgpt.com → csrf → signin → authorize
  │       → register/login → OTP(IMAP) → about-you
  │       → callback → accessToken
  │
  └── 串行区：共用 1 个 Discord + 1 个 Chrome
      ├── Discord Gateway → $0 支付链接
      ├── Chrome → PayPal 自动支付
      └── 生成 CPA JSON (无 rt)
```

## 新文件

### 1. `protocol_register.py`

Python 脚本，接收 JSON stdin，输出 JSON stdout。

**输入**：
```json
{
  "email": "user@outlook.com",
  "password": "xxx",
  "client_id": "dbc8e03a-...",
  "refresh_token": "M.C538_..."
}
```

**流程**（参考 cliproxyaccountcleaner 的 chatgpt_register.py）：
1. 创建 curl_cffi session（Chrome TLS 指纹）
2. `GET chatgpt.com` → 建立 cookie
3. `GET /api/auth/csrf` → CSRF token
4. `POST /api/auth/signin/openai` → authorize URL
5. `GET authorize URL` → 跟随重定向到 auth.openai.com
6. 根据页面状态处理：
   - `/email-verification` → 直接走 OTP
   - `/log-in` → `POST /api/accounts/authorize/continue` 提交邮箱
   - `/create-account/password` → `POST /api/accounts/user/register` 注册新账号
7. OTP 验证：IMAP 读取 Outlook 邮箱验证码
8. about-you：`POST /api/accounts/create_account`（如需要）
9. 回到 chatgpt.com，获取 session accessToken
10. 生成 checkout 链接（`POST /backend-api/payments/checkout`）

**输出**：
```json
{
  "status": "success",
  "accessToken": "eyJ...",
  "session": {...},
  "checkoutUrl": "https://pay.openai.com/...",
  "checkoutError": ""
}
```

**错误输出**：
```json
{
  "status": "error",
  "error": "reason"
}
```

### 2. `protocol-engine.js`

Node.js 执行引擎，EventEmitter 模式（与 engine.js 相同接口）。

**并行区**：
- 用 `Promise.allSettled()` 并行启动 N 个 Python 子进程
- 每个子进程独立执行 protocol_register.py
- 收集所有 accessToken + checkoutUrl

**串行区**：
- 连接 Discord Gateway（共用 1 个连接）
- 对每个成功获取 accessToken 的账号：
  - 如果没有 checkoutUrl → Discord 拿支付链接
  - 启动 Chrome → 打开支付页面
  - autoPayment() 自动填充支付
  - 生成 CPA JSON（无 refresh_token）

**CPA JSON 格式**（无 rt）：
```json
{
  "type": "codex",
  "email": "user@outlook.com",
  "access_token": "eyJ...",
  "id_token": "",
  "refresh_token": "",
  "account_id": "user-xxx",
  "expired": "2026-05-21T12:00:00Z",
  "last_refresh": "2026-05-20T12:00:00Z"
}
```

### 3. 现有文件最小改动

**`config.json`**：新增 `"protocolMode": false`

**`web/src/views/Config.vue`**：新增开关
```html
<el-form-item label="协议注册模式">
  <el-switch v-model="form.protocolMode" />
  <span>开启后使用协议注册（不开浏览器登录，仅支付时开浏览器）</span>
</el-form-item>
```

**`server/routes/execute.js`**：
```javascript
// 根据 config.protocolMode 选择引擎
const engine = config.protocolMode
  ? new ProtocolEngine(io)
  : new PipelineEngine(io);
```

**`server/routes/config.js`**：protocolMode 字段验证

## 并发模型

```
并行区（协议登录）：
  Account 1 → Python process 1 → accessToken + checkoutUrl
  Account 2 → Python process 2 → accessToken + checkoutUrl
  Account 3 → Python process 3 → accessToken + checkoutUrl
  Account N → Python process N → accessToken + checkoutUrl
  
串行区（Discord + 支付）：
  → Discord Gateway (共用)
  → Account 1: 拿链接 → Chrome 支付 → CPA JSON
  → Account 2: 拿链接 → Chrome 支付 → CPA JSON
  → Account 3: 拿链接 → Chrome 支付 → CPA JSON
```

## 状态流转

| 阶段 | status | phase |
|------|--------|-------|
| 开始协议登录 | running | protocol-login |
| 协议登录成功 | running | discord |
| Discord 拿链接 | running | payment |
| 支付进行中 | running | payment |
| 支付完成 | success | done |
| 协议登录失败 | error | protocol-login |
| Discord 无链接 | no_link | done |
| 需要手机验证 | needs_phone | done |

## Dependencies

- Python 3 + curl_cffi（已安装在系统上）
- 现有的 payment.js autoPayment 函数（通过 require 复用）
- 现有的 Discord Gateway 逻辑（从 engine.js 复制到 protocol-engine.js，因为不能修改 engine.js）
