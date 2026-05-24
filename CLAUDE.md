# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本项目所有交互、注释、文档默认使用简体中文（与用户全局 `~/.claude/CLAUDE.md` 一致）。

## 常用命令

```bash
# 首次启动（Windows 一键脚本，会检测 Node/Python/Chrome、装依赖、建默认 config.json、启服务）
start.bat

# 手动启动后端（serve web/dist + REST + Socket.IO）
node server/index.js                # 默认 http://localhost:3000
PORT=3001 node server/index.js      # 自定义端口

# 前端开发 / 构建
cd web && npm run dev               # Vite dev server，HMR
cd web && npm run build             # 产出 web/dist/，server/index.js 静态托管这个目录
                                    # 注意：node server/index.js 启动前 web/dist/index.html 必须存在

# 测试 —— Node.js 内置 node:test runner，无 jest/mocha
npm test                                                          # 跑全部 JS 测试（v2.29 起）
npm run test:py                                                   # 跑全部 Python 协议测试
# 单文件 / 按名字过滤仍用 node --test 直接调：
node --test server/__tests__/stripe-verify.test.js               # 跑单个文件
node --test --test-name-pattern='extractCsId' server/__tests__/stripe-verify.test.js
# 注意：node --test 接路径时必须带 `.test.js` glob，传纯目录会当 module 解析失败
node --test "server/__tests__/*.test.js"

# Python 依赖（仅协议模式需要）
pip install curl_cffi
```

仓库**没有**配置 lint/format 工具（无 eslint/prettier/black 配置）。

## 高层架构

这是一个 **ChatGPT Plus 免费试用激活批量流水线**，核心是同一份业务流程跑在两套登录后端 + 一个共享的 Web 仪表盘上。

### 两个执行引擎 + 路由切换

两套引擎实现同一组 EventEmitter 事件 (`log` / `account-status` / `complete`)，对外接口一致，由 `config.json` 的 `protocolMode` 决定每次启动哪一个：

- **`server/engine.js` `PipelineEngine`** —— 浏览器模式。整条链路用 Playwright 控 Chrome（含登录、Discord、支付、PKCE）。
- **`protocol-engine.js` `ProtocolEngine`** —— 协议模式（默认）。`spawn('py', ['-3', 'protocol_register.py'])` 用 Python `curl_cffi` 走 TLS 指纹模拟做协议登录 + OTP + PKCE；**仅支付阶段**起 Chrome。`server/routes/execute.js` 在每次 POST `/api/execute` 时读 `config.protocolMode` 决定 new 哪个类。

修改流水线行为时，凡是登录前/登录后能在两套引擎都触发的步骤（plan check、Discord、Phase 2.5、payment、PKCE 凭证写盘），都要 **同时改两个引擎**，否则两种模式会出现行为漂移。共享逻辑放在 `server/discord-gateway.js` / `server/chatgpt-checkout.js` / `server/stripe-verify.js` / `server/chrome.js` / `server/proxy/` / `payment.js` / `utils.js` 这些被双引擎都 require 的模块里。

### 五阶段流水线

无论哪个引擎，单账号执行的阶段都是：

1. **登录** — 浏览器/协议二选一。Outlook 走 `imapflow` IMAP 拉 OTP；Gmail 走 `otplib` 生成 TOTP。
2. **Plan check** — 若账号已是 Plus，跳过支付，仅做 PKCE。
3. **拿 $0 支付链接** — 两条来源由 `config.paymentLinkSource` 切换：
   - `discord`：连 Discord Gateway，点 `hub:chatgpt` → "US Plus (Free Trial)" 拿 Stripe link。
   - `api` (默认)：`server/chatgpt-checkout.js` 通过 **JP-KDDI 出口**直接调 OpenAI checkout API（这是 v2.19 的核心架构，见下）。
4. **Phase 2.5 Stripe 验证** — `server/stripe-verify.js` + `stripe_init.py` 用主代理调 Stripe `/v1/payment_pages/{cs}/init` 验证 `invoice.amount_due` 是否真为 0。$0 才进入 Phase 3，$20 → `no_promo` 早返回。Discord 路径信任 bot 判定，**跳过** Phase 2.5。
5. **支付 + 凭证** — `payment.js` Chrome 自动 PayPal 12 字段 + SMS 短信验证；成功后 `enableOAuth=true` 时跑 PKCE OAuth，`utils.saveCPAAuthFile` 写出 `cpa-auth/codex-{email}.json` 与 `sub2api-{email}.json`。

### 双通道 sing-box 代理（v2.18+）

`server/proxy/` 是一个把 V2Ray/Reality 订阅 → sing-box 配置 → Clash API 轮换的迷你编排器。**两条独立 HTTP 入口**：

- **`7890` 主代理** —— 跟随 `config.proxy.regionFilter`（默认 `US`），用于登录、PKCE、Stripe verify、payment.js。
- **`7891` JP 通道** —— 跟随 `config.proxy.jpCheckout.whitelist` 精确 tag 列表（白名单优先于关键字），**仅**用于 OpenAI checkout API 调用。

**关键不变式**：`server/chatgpt-checkout.js` **禁止** `jpUrl || mainUrl` 静默回退。JP 池不可用时必须立刻 resolve `{noJpProxy:true}` 让 engine 把账号标 `no_jp_proxy`。这是 v2.19 的 fail-fast 设计 —— 用 US 出口拿到的永远是 \$20 link，silently 跑下去会浪费整条 PayPal pipeline。详见 `docs/CHANGELOG.md` 的 v2.19 节与 `docs/superpowers/specs/2026-05-23-v2.19-reliable-checkout-design.md`。

`server/proxy/index.js` 导出的 `buildSingboxConfig` / `pickJpNodes` 是纯函数，单测覆盖在 `server/proxy/__tests__/`。`bin/sing-box.exe` 由 `ensureBinary` 自动下载并校验版本（`d521d06` commit）。

### 持久化 + 实时

- **`server/db.js`** —— `sql.js`（WASM SQLite）+ `data.db` 文件。三张表：`accounts` / `account_status` / `execution_logs`。**v2.29 起**每次 `save()` 同步 `db.export()` 抓快照，异步串行通过 `_saveQueue` 走 `tmp + rename` 落盘，断电不会再留半截 `data.db`，并发 set() 也不会互相覆盖快照；测试 / shutdown 可 `await save.flush()` 等队尾。包含从老 status 值到当前命名（`plus` / `plus_no_rt` / `no_link` / `error` / `idle` / `running` + v2.19 新增 `no_jp_proxy` / `no_promo` / `verify_error`）的一次性迁移逻辑。
- **状态名是单一来源** —— `web/src/status.js` 是 status code → 中文 label / type 的唯一映射。新增/改名状态时同步：
  1. `server/db.js` 迁移逻辑（若改老值含义）
  2. `web/src/status.js`
  3. `web/src/views/Dashboard.vue` 的 KPI 卡 + `Accounts.vue` / `Execute.vue` / `Results.vue` 的状态筛选下拉
- **Socket.IO** —— 引擎事件直接 `io.emit` 到前端；CORS 锁死 `localhost:3000` / `127.0.0.1:3000`（v2.29 起允许 `http://${HOST}:3000` 自定义），不做认证（设计上仅本机用）。
- **HTTP 监听地址（v2.29）** —— 默认绑 `127.0.0.1`。**远程访问必须显式** `set HOST=0.0.0.0`（Windows）/ `HOST=0.0.0.0 node server/index.js`；启动横幅会大字警告"dashboard 无认证，任何本网络机器都能驱动 PayPal pipeline 和读取明文密码"。绑了非 loopback 后请自行加反代 + 认证。
- **敏感信息日志兜底（v2.29）** —— `server/logger.js#LogCapture` 统一过 `redact()`：JWT 三段、`access_token=…` / `refresh_token=…` / `id_token=…` URL 参数、`Bearer <token>`、`OTP|code|verification code|sms code` 紧邻数字。业务管道的 `console.log` 不动也安全，但**新加打印敏感字段的代码不要依赖 redact 兜底**——优先在业务侧脱敏（保留前 6 后 4）。
- **代理 `getState()` 字段白名单（v2.29）** —— `server/proxy/index.js#getState` 是显式字段 return（不是 `{ ..._state }`）；`subscriptionUrl`、`outbounds`、`failCount/Reasons` Map 不暴露给前端。新增前端要消费的代理状态字段时必须显式加到 `getState` 白名单。前端看"是否配置订阅"用 `hasSubscription` + `subscriptionHost`。v2.30 又加了 `probeResults` / `probeSummary` 暴露主动健康检查结果。
- **主动健康检查 + dead 节点跳过（v2.30）** —— `refresh()` 末尾 fire-and-forget 调 `runHealthProbe()`：通过 `clashApi.testNodeDelay()` 并发探活全池，写 `_state.probeResults`。`rotate / rotateJp` 内先看是否有 alive 节点；有则跳 dead-by-probe；全 dead 回退原逻辑。`config.proxy.activeHealthCheck = false` 可关。Probe 用 Clash `/proxies/{name}/delay`，不动 active selector，可与业务流量并发。
- **优雅退出 / 进程清理（v2.30）** —— `server/index.js` SIGINT/SIGTERM 处理：flush logs → `save.flush()` → exit(0)，5s 硬 deadline。引擎 `stop()` 中 chrome/python 子进程改用 `server/process-utils.js#killTree(pid)`：Windows `taskkill /T /F`，POSIX 进程组 SIGKILL。改任何引擎清理路径前先看 v2.29 HX-3 + v2.30 HX-13 的约束。
- **`/api/health`（v2.30）** —— 运维探活端点。返回 `{ ok, db, proxy: { 字段子集 }, engine, uptimeSec, version }`。代码加新 health 数据时仅暴露非敏感字段。engine 实例通过 `server/engine-singleton.js` 单例暴露给非 execute 路由，避免 cyclic require。

### 前端

`web/` 是 Vue 3 + vue-router + Element Plus + axios + socket.io-client，Vite 构建。视图就 5 个（`Dashboard` / `Accounts` / `Execute` / `Results` / `Config`），与后端 `/api/{accounts,config,execute,results,proxy}` 一一对应。开发时 `npm run dev` 起 Vite，生产时跑 `npm run build` 后由 `server/index.js` 静态托管 `web/dist/`。

## 项目特定约束 / 注意点

- **Python 子进程协议** —— `protocol_register.py` 和 `stripe_init.py` 通过 stdin 收 JSON 配置、stdout 输出 **JSON-lines**（`{"log": "..."}` 是流式日志，最后一行非 log 的对象是 final result）。任何会在导入期 print 的代码必须把 stdout 重定向到 stderr，否则会污染 JSON 协议。`protocol_register.py` 顶部已用 `_orig_stdout` 把 chatgpt_register 包的 side-effect prints 切到 stderr。
- **Chrome 由 Node 启动，Playwright 用 CDP 连** —— `server/chrome.js` 用 `spawn` 启 `chrome.exe --remote-debugging-port=...`（找路径优先级见 `CHROME_PATHS`），然后 `chromium.connectOverCDP`。**v2.29 起** `engine.stop()` 是 `async`：先 `await browser.close()`、再 `chromeProc.kill()`、最后 `await fs.promises.rm(tempDir)`，避免新一轮 engine 撞上一轮残留资源；构造新 engine 前 `/execute` 路由会 `await engine.stop()` 兜底。
- **`config.json` 含真实凭证** —— `.gitignore` 已忽略，且默认 `Discord Token` / `CPA Key` / `phone` 都在里面。**永远**不要在示例、commit message、日志输出里贴 `config.json` 内容。`config.example.json` 是脱敏模板。
- **根目录的散落脚本** —— `dump-token-*.js` / `get-checkout-*.js` / `retest-*.js` / `test-3way-*.js` / `test-error-account.js` / `batch-test-eligibility.js` 等是临时调试脚本（多数已在 git 中 untracked），**不是测试套件**，也**不要**作为参考实现。真正的测试在 `__tests__/` / `server/__tests__/` / `server/proxy/__tests__/` / `tests/`。
- **Plans / Specs** —— `docs/superpowers/plans/` 和 `docs/superpowers/specs/` 按日期命名存放结构化方案/设计文档，文件名格式 `YYYY-MM-DD-{feature}.md` / `-design.md`。修改架构时优先在这里留 spec，commit message 引用文件名。
- **CHANGELOG** —— `docs/CHANGELOG.md` 是项目实际的演进记录（按 v2.x.y 版本），每个版本有「核心改动 / 端到端验证 / 对照前版」结构。新增主要功能/回归时追加新版本节，而不是改老条目。

