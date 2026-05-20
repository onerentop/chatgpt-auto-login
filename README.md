# ChatGPT Auto Login & Plus Activation Pipeline

批量 ChatGPT 账号登录、Plus 免费试用激活、PayPal 支付、OAuth 凭证生成的自动化流水线。

支持**浏览器模式**（Playwright Chrome 全流程自动化）和**协议模式**（Python curl_cffi 协议登录 + 仅支付时开浏览器），通过 Web 仪表盘统一管理。

## 快速开始

### Windows

```
双击 start.bat
```

自动检测环境、安装依赖、构建前端、启动服务，浏览器打开 `http://localhost:3000`。

### 手动启动

```bash
# 安装依赖
npm install
cd web && npm install && npm run build && cd ..

# 启动服务
node server/index.js
```

浏览器访问 `http://localhost:3000`，默认密码 `admin`。

## 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | >= 18 | 后端服务、引擎 |
| Google Chrome | 最新版 | 浏览器自动化（CDP） |
| Python 3 | >= 3.8（协议模式） | 协议登录注册 |
| curl_cffi | >= 0.15（协议模式） | TLS 指纹模拟 |

## 两种模式

### 浏览器模式（默认）

Chrome 全流程自动化：登录 → Discord → 支付 → PKCE → 生成凭证。

适合需要完整浏览器会话的场景。

### 协议模式

Python curl_cffi 协议登录（无浏览器），仅支付环节启动 Chrome。

登录速度更快，资源占用低。在配置页开启「协议注册模式」。

## 配置说明

首次启动后通过 Web 仪表盘 **配置设置** 页面配置，或直接编辑 `config.json`：

| 字段 | 说明 |
|------|------|
| `webPassword` | Web 登录密码（默认 `admin`） |
| `protocolMode` | 协议模式开关 |
| `enableOAuth` | PKCE OAuth 开关（获取 refresh_token） |
| `enableCPA` | CPA 外部注册开关 |
| `phone` | PayPal 绑定的美国手机号 |
| `smsApiUrl` | 短信验证码接口 URL |
| `discordToken` | Discord 用户 Token |
| `channelId` | Discord 频道 ID |
| `messageId` | Bot Hub 消息 ID |
| `guildId` | Discord 服务器 ID |
| `appId` | Bot 应用 ID |
| `cpaUrl` | CPA 管理面板 URL |
| `cpaKey` | CPA 管理密钥 |

## 账户格式

通过 Web 仪表盘 **账户管理** 页面批量导入，每行一个账号：

```
email----password----clientId/TOTP----refreshToken
```

| 账号类型 | 第三列 | 第四列 |
|----------|--------|--------|
| Outlook | Microsoft Client ID | OAuth Refresh Token |
| Gmail | TOTP 密钥 | 留空 |

邮箱域名自动识别类型：`@outlook.com` / `@hotmail.com` / `@live.com` → Outlook，`@gmail.com` → Google。

## 执行流程

```
账户列表 (选中/全部)
  │
  ├── Step 1: 登录
  │     浏览器模式: Chrome → chatgpt.com → Google/Outlook 登录
  │     协议模式:   Python curl_cffi → 协议注册/登录 → OTP(IMAP)
  │
  ├── Plan Check: 检测是否已是 Plus
  │     ├── 已是 Plus → 跳过支付，直接生成凭证
  │     └── Free → 继续 Step 2
  │
  ├── Step 2: Discord Bot → $0 支付链接
  │     连接 Discord Gateway → 点击 hub:chatgpt
  │     → 选择 "US Plus (Free Trial)" → 提交 accessToken
  │     → 获取 Stripe $0 支付链接
  │
  ├── Step 3: 自动支付
  │     Chrome 打开支付链接 → 选择 PayPal → 填写美国地址
  │     → PayPal 登录 → 填写卡信息 → SMS 验证（自动）
  │     → 等待 redirect_status=succeeded 确认支付成功
  │
  ├── Step 4: 凭证生成 (enableOAuth 开启时)
  │     PKCE OAuth 流程 → 获取 refresh_token
  │     → 生成 CPA + Sub2API 格式 JSON
  │
  └── 关闭浏览器 → 下一个账户
```

## 账户状态

| 状态 | 标签 | 含义 |
|------|------|------|
| `plus` | Plus(有RT) | Plus 激活成功，PKCE 获取到 refresh_token |
| `plus_no_rt` | Plus(无RT) | Plus 激活成功，但无 refresh_token（未开 OAuth / PKCE 失败） |
| `no_link` | 无链接 | Discord 未返回支付链接 |
| `error` | 错误 | 登录/支付/其他环节失败 |
| `idle` | 空闲 | 未执行 |
| `running` | 运行中 | 正在执行 |

## 输出文件

凭证文件保存在 `cpa-auth/` 目录：

| 文件 | 格式 | 说明 |
|------|------|------|
| `codex-{email}.json` | CPA | Codex 格式凭证（access_token + refresh_token） |
| `sub2api-{email}.json` | Sub2API | Sub2API 导入格式凭证 |

可通过 Web 仪表盘的「下载选中」按钮选择格式批量下载。

## 项目结构

```
chatgpt-auto-login/
├── start.bat               # Windows 一键启动
├── server/
│   ├── index.js            # Express 服务入口
│   ├── engine.js           # 浏览器模式执行引擎
│   ├── db.js               # SQLite 数据持久化
│   └── routes/             # API 路由
├── protocol-engine.js      # 协议模式执行引擎
├── protocol_register.py    # Python 协议登录（curl_cffi）
├── payment.js              # PayPal 自动支付 + SMS 验证
├── utils.js                # PKCE、auth 文件生成、TOTP、工具函数
├── index.js                # CLI 入口（独立于 Web）
├── web/
│   ├── src/views/
│   │   ├── Execute.vue     # 执行控制页
│   │   ├── Accounts.vue    # 账户管理页
│   │   ├── Config.vue      # 配置设置页
│   │   ├── Dashboard.vue   # 仪表盘
│   │   └── Results.vue     # 执行结果页
│   └── dist/               # 构建产物
├── config.json             # 运行配置（gitignored）
├── data.db                 # SQLite 数据库（gitignored）
├── cpa-auth/               # 生成的凭证文件（gitignored）
├── sessions/               # 会话数据（gitignored）
└── package.json
```

## 主要依赖

| 包 | 用途 |
|----|------|
| `playwright` | 浏览器自动化 |
| `express` + `socket.io` | Web 服务 + 实时日志 |
| `sql.js` | SQLite WASM 数据库 |
| `ws` | Discord Gateway WebSocket |
| `imapflow` | Outlook IMAP 邮件读取 |
| `otplib` | TOTP 验证码生成 |
| `curl_cffi` (Python) | TLS 指纹模拟协议请求 |

## 安全提示

- `config.json`、`data.db`、`cpa-auth/`、`sessions/` 均已 gitignore
- Discord Token、CPA Key 等敏感信息仅存在 config.json 中
- Web 仪表盘通过密码保护，Token 存储在 localStorage
