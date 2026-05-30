# BrowserEngine 行为清单（浏览器引擎迁移基线）

> **用途**：本文档是把 `PipelineEngine`（`server/engine.js`）单体循环迁移为共享步骤管道（`server/pipeline/steps/*.js`）时的**零逻辑丢失验证基线**，同时也是**与共享步骤的差异分析（diff）文档**。  
> 共享步骤已从 `ProtocolEngine` 提取，编码的是协议引擎行为。浏览器引擎若直接复用这些步骤，需逐个确认是否存在行为偏差，否则会静默改变浏览器模式的行为。  
> 本文档不修改任何源码，仅作分析与决策依据。
>
> 来源文件：`server/engine.js`（2026-05-30 快照，`PipelineEngine`，约 721 行）  
> 参照步骤：`server/pipeline/steps/{login,plan-check,paypal-fetch,paypal-verify,paypal-pay,paypal-pkce}.js`  
> 格式参照：`docs/superpowers/plans/inventory/protocol-engine.md`

---

## A. 浏览器引擎行为分支清单

| 源 engine.js:line | 现象 / 分支描述 | 对应 step | 备注 |
|---|---|---|---|
| **生命周期 / 构造函数** | | | |
| 42–51 | 构造函数初始化：`status='idle'`, `stopFlag=false`, `logCapture=new LogCapture()`, `_runId=''`, `_chromeProc=null`, `_browser=null`, `_abortController=null` | `engine-shell` | 与协议引擎类似；无 `_pyProc`（Python子进程在协议引擎中存在，浏览器引擎没有） |
| 75–118 | `stop()`: `status==='idle'` 时立即返回 | `engine-shell` | |
| 78 | `stop()`: 设 `stopFlag=true`，调 `_abortController.abort()` | `engine-shell` | |
| 84–87 | `stop()`: `await browser.close()` 优雅关闭 Playwright CDP | `engine-shell` | 先 close 再 kill，避免僵尸 chrome |
| 90–93 | `stop()`: `killTree(chromeProc.pid)` + `chromeProc.kill()` 双保险杀 Chrome | `engine-shell` | HX-13；browser engine stop() 内整合了 Chrome 清理 |
| 96–99 | `stop()`: `gw.cleanup()` 清 Discord Gateway 连接 | `engine-shell` | 仅 linkSource=discord 时 gw 非 null |
| 104–107 | `stop()`: `fs.promises.rm(tempDir, {recursive,force})` 清临时目录（异步） | `engine-shell` | |
| 110–113 | `stop()`: `statusDB.resetRunning()` 把 DB 中 running 账号重置为 idle | `engine-shell` | |
| 115–117 | `stop()`: `logCapture.stop()`，emit `log` 告知停止完成，`status='idle'` | `engine-shell` | |
| **runner-loop: 基础设施** | | | |
| 138 | `logsDB.cleanup()` 清理旧日志 | `runner-loop` | |
| 141–155 | `LogCapture` 启动：劫持 `console.log` → emit `log` 事件 + `logsDB.add()`（当 `currentEmail` 非空时） | `runner-loop` | 与协议引擎完全对称 |
| 163–171 | 加载账号列表（从 `accountsDB.list()`），字段映射：`loginType`（`google`/`outlook`），`totp_secret`，`client_id`，`refresh_token` | `runner-loop` | 协议引擎从同一 accountsDB 加载 |
| 173 | 账号列表为空 → 抛 `Error('No accounts in database')` → fatal | `runner-loop` | |
| 173 | `!findChrome()` → 抛 `Error('Chrome not found!')` → fatal | `runner-loop` | **浏览器特有**：协议引擎无 Chrome 可用性检查（Chrome 仅在 Phase 3 用到） |
| 177–180 | `filterEmails` 非空时过滤账号（大小写不敏感 emailSet） | `runner-loop` | |
| 181 | 过滤后为空 → 抛 `Error('No matching accounts to execute')` → fatal | `runner-loop` | |
| 187–189 | 读取 `config.json`（`linkSource`），一次性读取（非每账号重读） | `runner-loop` | |
| 192–198 | `linkSource==='discord'` 时在循环前连 Discord Gateway，存入 `gw` 和 `this._gw` | `runner-loop` | |
| **runner-loop: 账号循环** | | | |
| 201–205 | 每轮循环头：检查 `this.stopFlag`，为真则 `break` | `runner-loop` | |
| 209–216 | **prevPersisted 快照**：`statusDB.get(account.email) \|\| {}` 在 emitStatus 之前读取，保留上一轮状态 | `runner-loop` | 对应协议引擎 line 615-617 |
| 249–265 | Proxy rotate：若 `proxyMgr.getState().enabled`，每账号执行 `proxyMgr.rotate()`；失败仅 log | `runner-loop` | 与协议引擎对称 |
| 673–677 | 账号间随机延迟：`wait = 5 + Math.floor(Math.random() * 3)`（5–7s），`randomDelay(wait*1000, wait*1000+500)` | `runner-loop` | **差异**：协议引擎延迟 15–45s，浏览器引擎仅 5–7s；无 consecutiveErrors 冷却逻辑 |
| 679–716 | 外层 try/catch/finally：fatal 异常 log + emit `complete`；finally：cleanup gw/logCapture，build summary，emit `complete`，`status='idle'` | `runner-loop` + `engine-shell` | |
| 692–701 | finally 内 summary 构建：`total, success(plus+plus_no_rt), noLink, error(error+deactivated), noJpProxy, noPromo, verifyError, aborted` | `runner-loop` | aborted 非懒初始化（直接 filter），与协议引擎 summary.aborted 懒初始化不同 |
| **login: Phase 1 缓存快路径** | | | |
| 221–241 | `JWT_BUFFER_SEC_LOGIN=60`；若 `prevPersisted.last_access_token` 存在，解码 JWT exp；`exp > now/1000 + 60s` → 从 DB 重建 `loginResult`（accessToken + session）；emitStatus `running/cached-login` | `login` | 与协议引擎逐字对应；注意：浏览器引擎无 `planType` 字段在 loginResult 内（planType 在后面从 `loginResult.session` 提取） |
| 228–230 | session 解析失败时 `session=null`，缓存快路径不生效 | `login` | |
| 236–239 | 缓存命中时 log `Phase 1: reusing cached access token (exp in N min)` + emitStatus `running/cached-login` | `login` | |
| **login: Phase 1 Playwright 浏览器登录** | | | |
| 249–250 | `findFreePort()` + `tempDir` 生成（每账号循环顶部，在 try 外） | `login`（浏览器策略） | **浏览器特有**：Chrome 在 Phase 1 就启动，贯穿整条 pipeline，直到 finally 清理 |
| 252–253 | `this._chromeProc=null`, `this._browser=null` 重置（为本账号清理上一轮残留引用） | `login`（浏览器策略） | |
| 271–281 | 非缓存命中时：emitStatus `running/login`；`launchChrome(port, tempDir, {})` + `waitForCDP(port)`；存 `this._chromeProc`, `this._browser` | `login`（浏览器策略） | **差异**：phase 字符串是 `'login'` 而非 `'protocol-login'` |
| 283 | `await loginAccount(browser, account)` — Playwright 页面交互登录 | `login`（浏览器策略） | **差异**：协议引擎调 `runProtocolRegister()`（Python spawn）；浏览器引擎调 `loginAccount()`（Playwright browser） |
| 285–286 | `loginResult.status !== 'success' \|\| !loginResult.accessToken` → 登录失败分支 | `login`（浏览器策略） | |
| 287 | `loginResult.status === 'deactivated'` → `statusOut='deactivated'`；否则 `statusOut='error'` | `login`（浏览器策略） | |
| 290–298 | 登录失败 proxy 记账：网络类错误 → `recordBadAttempt('main','login_net_error')`；deactivated → `recordGoodAttempt`（账号问题，节点正常）（**T9**） | `login`（浏览器策略） | **差异**：协议引擎分支为 `isProxyNetError` → `recordBadAttempt('main','protocol_net_error')`（**T8**）；logic 等价，error tag 字符串不同（`login_net_error` vs `protocol_net_error`） |
| 300–311 | 登录失败：`allResults.push(finalResult)`；emitStatus `{statusOut}/{isDeactivated?'done':'login'}`；`continue` | `login`（浏览器策略） | **差异**：phase=`'login'`（非 `'protocol-login'`）；`deactivated` phase 为 `'done'`（与协议引擎一致） |
| 313–316 | 登录成功：`recordGoodAttempt(currentNode,'main')`（**G2**）；log login OK | `login`（浏览器策略） | |
| **login: Phase 1 后 DB 持久化** | | | |
| 325–333 | login 成功后 `statusDB.set(email, {status:'running', phase:'login', progress, accessToken, sessionJson})` | `login`（浏览器策略） | **差异**：phase=`'login'`（协议引擎为 `'protocol-login'`） |
| **plan-check: 套餐检查** | | | |
| 336–341 | 从 `loginResult.session` 提取 `planType`（`account.planType \|\| chatgpt_plan_type \|\| 'free'`）；`isPlusOrAbove` = planType in `['plus','pro','team','enterprise']` | `plan-check` | 与协议引擎 line 727 完全一致 |
| 343 | log `Plan: {planType} (Plus member / Not Plus)` | `plan-check` | 协议引擎仅 log `Already Plus`，不打印 planType；行为可接受但 log 格式有细微差异 |
| **plan-check → already-Plus 路径（PKCE + CPA）** | | | |
| 344 | `statusDB.clearPaymentLink(email)` + `statusDB.clearAccessToken(email)` | `paypal-pkce`（alreadyPlus 分支） | 与协议引擎一致 |
| 347–348 | `finalResult = {status:'plus_no_rt', ...}` | `runner-loop` | |
| 350–375 | 读 `latestCfg.enableOAuth`（每账号重读 config.json）；`enableOAuth=true` → `fetchTokensViaPKCE(browser, account, loginResult.lastOtp)` | `paypal-pkce`（alreadyPlus 分支） | **差异（关键）**：协议引擎调 `runProtocolPKCE()`（Python spawn）；浏览器引擎调 `fetchTokensViaPKCE()`（Playwright browser PKCE flow）；参数不同（`lastOtp` 仅浏览器引擎传） |
| 353–355 | PKCE `pkceTokens.refresh_token` 存在 → `saveCPAAuthFile(email, pkceTokens.access_token, pkceTokens)`；`finalResult.status='plus'` | `paypal-pkce`（alreadyPlus 分支） | 协议引擎：`saveCPAAuthFile(email, pkce.access_token\|loginResult.accessToken, {...session, refresh_token, id_token})` — 参数构造方式有细微差异 |
| 357–361 | `pkceTokens.phonePoolEmpty` → emitStatus `phone_pool_empty/pkce`；`saveCPAAuthFile(email, loginResult.accessToken, loginResult.session)`；`finalResult.status='phone_pool_empty'` | `paypal-pkce`（alreadyPlus 分支） | **差异**：浏览器引擎 emitStatus phase=`'pkce'`（协议引擎为 `'done'`）；saveCPAAuthFile 参数相同 |
| 362–365 | `pkceTokens.phoneVerifyFail` → emitStatus `phone_verify_fail/pkce`；`saveCPAAuthFile(loginResult.accessToken, loginResult.session)`；`finalResult.status='phone_verify_fail'` | `paypal-pkce`（alreadyPlus 分支） | **差异**：浏览器引擎 emitStatus phase=`'pkce'`（协议引擎为 `'done'`） |
| 367–372 | 其他非成功路径（`needsPhone` / 无 refresh_token）→ `saveCPAAuthFile(pkceTokens?.access_token\|loginResult.accessToken, pkceTokens\|loginResult.session)`；`finalResult.status` 保持 `'plus_no_rt'` 兜底 | `paypal-pkce`（alreadyPlus 分支） | **差异**：协议引擎 `needsPhone` 时进入 `_finalizePhoneVerify()` 自动化 add-phone 流程；浏览器引擎 `needsPhone` 时仅 log 并 saveCPAAuthFile 兜底，**不执行自动 add-phone** |
| 373–374 | `enableOAuth=false` → `saveCPAAuthFile(email, loginResult.accessToken, loginResult.session)` | `paypal-pkce`（alreadyPlus 分支） | 与协议引擎一致 |
| 377–387 | `enableCPA=true`（每账号重读 config）→ emitStatus `running/cpa`；调 `registerToCPA(browser, email, account)` | **浏览器专有（cpa 阶段）** | **协议引擎无此步骤**：CPA OAuth 注册是浏览器引擎独有功能，利用登录后的 browser context |
| **paypal-fetch: Phase 2 取支付链接** | | | |
| 391–393 | `currentPhase = linkSource==='discord' ? 'discord' : 'checkout'` | `paypal-fetch` | 与协议引擎一致 |
| 399–406 | `REUSE_STATUSES = new Set(['error','aborted','paypal_captcha','verify_error'])`；缓存链接快路径：`prevPersisted.payment_link` && status in REUSE_STATUSES → `discord={link, pk, title:'cached', raw:''}`；`usedCachedLink=true` | `paypal-fetch` | 与协议引擎一致（变量名用 `discord` 而非 `fetchResult`，但语义相同） |
| 401 | emitStatus `running/{currentPhase}` | `paypal-fetch` | 注意：浏览器引擎在缓存命中判断**之前**就 emitStatus；协议引擎同样如此（protocol-engine.js line 744–745 在缓存检查前） |
| 408–426 | 链接获取循环（最多 3 次）：Discord → `getPaymentLink(gw, accessToken)`；API → `fetchCheckoutLink(accessToken)`；Timeout/fetch 类错误 → 2s 后 retry；非 transient 或 3 次耗尽 → throw | `paypal-fetch` | 与协议引擎逻辑一致 |
| 429–446 | 链接获取结果路由：`discord.noJpProxy` → no_jp_proxy 分支；`!discord.link` → no_link 分支；else → 进入 Phase 2.5 | `paypal-fetch` | **差异**：浏览器引擎在此路由处不调用 `emitStatus`（noJpProxy/noLink 分支仅设 finalResult，不 emit）；协议引擎在 paypal-fetch step 内 `emitStatus no_jp_proxy/done` 和 `emitStatus no_link/done` |
| 454–458 | 非缓存命中时，link 获取成功后立即持久化：`statusDB.set(email, {status:'running', phase:'verify', paymentLink, paymentLinkPk})` | `paypal-fetch` | 与协议引擎一致 |
| **paypal-verify: Phase 2.5 Stripe $0 验证** | | | |
| 463–466 | Discord 路径跳过 Phase 2.5（`v = {ok:true, is_free:true, coupons:[]}`） | `paypal-verify`（shouldSkip） | 与协议引擎一致 |
| 468–470 | API 路径：emitStatus `running/verify`；调 `verifyCheckoutIsFree(discord.link, discord.pk)` | `paypal-verify` | 与协议引擎一致 |
| 473–481 | `!v.ok` → `finalResult = {status:'verify_error', paymentLink, reason:'Stripe init: {v.reason}'}`（不 emitStatus，不 continue；在外层 finally 后 emitStatus `done`） | `paypal-verify` | **差异**：浏览器引擎此处仅设 `finalResult`，不立即 emitStatus（状态在账号循环末尾 line 663-670 emit）；协议引擎 emitStatus `verify_error/done` 并 `summary.verifyError++` 然后 `continue` |
| 483–489 | `!v.is_free` → `finalResult = {status:'no_promo', ...}` | `paypal-verify` | **差异**：同上，浏览器引擎延迟到循环末尾 emitStatus |
| 492–494 | `v.ok && v.is_free` → log coupons，进入 Phase 3 | `paypal-verify` | 与协议引擎一致 |
| **paypal-pay: Phase 3 支付** | | | |
| 499–505 | **浏览器引擎懒启动 Chrome（缓存登录路径）**：若 `!browser`（cached login 跳过了 Phase 1 chrome init）→ 此处 `launchChrome` + `waitForCDP`，存 `this._chromeProc/_browser` | `paypal-pay`（浏览器策略） | **关键差异（结构性）**：浏览器引擎在 Phase 1 已持有 browser，Phase 3 复用它；协议引擎 Phase 3 总是新启 Chrome。见 C 节 |
| 507–510 | 从已有 `browser` 取 context + page（`browser.contexts()[0]`；pages 已有则复用第 0 个，否则 `newPage()`）；`page.goto(discord.link, ...)` | `paypal-pay`（浏览器策略） | **差异**：协议引擎/共享 paypal-pay step 总是在新 Chrome 里新建 page；浏览器引擎复用登录后的同一 browser context 和已有 page |
| 519–541 | chrome-error/about:blank retry-once：`recordBadAttempt` → `rotate()` → 第 2 次 goto；第 2 次仍失败 → `recordBadAttempt` → throw；成功 → `recordGoodAttempt`（**G3**） | `paypal-pay` | 逻辑与协议引擎/共享 paypal-pay step 完全一致（line 519–541 ↔ step line 141–165） |
| 547–548 | PayPal locator pre-warm + `randomDelay(2000,3000)` | `paypal-pay` | 与协议引擎一致 |
| 555–557 | 每账号重读 `config.json`（freshCfg），取 `freshCfg.phoneSlots?.[0]` 或 `{phone,smsApiUrl}` | `paypal-pay` | 与协议引擎一致（v2.43.3） |
| 557 | `autoPayment(page, {phone, smsApiUrl, email}, {signal: this._abortController.signal})` | `paypal-pay` | 与协议引擎一致 |
| 562–569 | `e.code==='NOT_FREE_TRIAL'` → `finalResult.status='no_link'`；emitStatus `no_link/done`；`summary.noLink++`；**`continue`（直接跳下一账号，绕过 finally cleanup！）** | `paypal-pay` | **差异（BUG 风险）**：浏览器引擎此处 `continue` 绕过了 try 块的 finally cleanup（但 finally 仍会执行，见 JS 语义）。与协议引擎行为等价（协议引擎 paypal-pay step 返 `{ok:false}` 不再 `continue`）；浏览器引擎这里还有 `summary.noLink` 的累计，但 `summary` 对象在浏览器引擎是 `allResults`（结果数组），与协议引擎的 summary 计数器模式不同 |
| 575–578 | `paymentOk=true` → `statusDB.clearPaymentLink` + `clearAccessToken`；`finalResult.status='plus_no_rt'` | `paypal-pkce` / `runner-loop` | 与协议引擎等价（成功后 clear，再进 PKCE） |
| 580–584 | `paymentStatus==='aborted'` → `finalResult.status='aborted'`；emitStatus `aborted/payment` | `paypal-pay` | 与协议引擎一致 |
| 585–589 | 其他失败 → `finalResult.status = paymentStatus\|'error'`；`finalResult.reason = paymentReason\|'Payment not completed'` | `paypal-pay` | 与协议引擎一致 |
| **paypal-pay: Phase 4 PKCE + CPA（仅支付成功后）** | | | |
| 592–638 | `paymentOk=true` → `currentPhase='oauth'`；读 `latestCfg.enableOAuth`；`enableOAuth=true` → `fetchTokensViaPKCE(browser, account, loginResult.lastOtp)` | `paypal-pkce`（post-payment 分支） | **差异（关键）**：同 alreadyPlus 路径，浏览器引擎用 `fetchTokensViaPKCE()`（Playwright PKCE），协议引擎用 `runProtocolPKCE()`（Python spawn） |
| 600–603 | `pkceTokens.refresh_token` → `saveCPAAuthFile`；`finalResult.status='plus'` | `paypal-pkce` | 与 alreadyPlus 路径一致；协议引擎 saveCPAAuthFile 参数构造略有差异（见 line 353） |
| 604–609 | `pkceTokens.phonePoolEmpty` → emitStatus `phone_pool_empty/pkce`；`saveCPAAuthFile(loginResult.accessToken, loginResult.session)`（v2.38.0 fix）；`finalResult.status='phone_pool_empty'` | `paypal-pkce` | **差异**：phase=`'pkce'`（协议引擎为 `'done'`） |
| 610–615 | `pkceTokens.phoneVerifyFail` → emitStatus `phone_verify_fail/pkce`；saveCPAAuthFile（v2.38.0 fix）；`finalResult.status='phone_verify_fail'` | `paypal-pkce` | **差异**：phase=`'pkce'`（协议引擎为 `'done'`） |
| 617–622 | 其他非成功（`needsPhone`/无 RT）→ `saveCPAAuthFile`；`finalResult.status` 保持 `plus_no_rt` 兜底 | `paypal-pkce` | **差异**：`needsPhone` 不触发 add-phone 流程（同 alreadyPlus 路径） |
| 624–625 | `enableOAuth=false` → `saveCPAAuthFile(loginResult.accessToken, loginResult.session)` | `paypal-pkce` | 与协议引擎一致 |
| 628–637 | `enableCPA=true` → `registerToCPA(browser, email, account)` | **浏览器专有（cpa 阶段）** | **协议引擎无此步骤**（同 alreadyPlus 路径的 CPA） |
| **finally: 每账号 Chrome 清理** | | | |
| 647–657 | `browser.close()` + `killTree(chromeProc.pid)` + `chromeProc.kill()` + `fs.rmSync(tempDir)` + 清空引用 | `engine-shell` / `paypal-pay`（浏览器策略） | **关键结构差异**：协议引擎每账号 Chrome 仅在 paypal-pay step 的 finally 清理；浏览器引擎整个账号有一个 Chrome，最终 finally 统一清理 |
| **账号循环末尾** | | | |
| 659–660 | `allResults.push(finalResult)`；log `{email} → {status}` | `runner-loop` | |
| 663–670 | emitStatus `{finalResult.status}/done`（phase='done'）；携带 paymentLink / reason | `runner-loop` | **差异**：浏览器引擎所有最终 status 都经由这里统一 emit（包括 `no_link`, `no_promo`, `verify_error` 等中间状态）；协议引擎这些状态在各自 step 内 emit |

---

## B. 与共享步骤的差异分析（关键章节）

### B1. login 步骤

**行为 IDENTICAL（安全复用）：**
- JWT 缓存快路径（`JWT_BUFFER_SEC=60`，DB 重建 loginResult，`emitStatus running/cached-login`）
- 登录成功后 DB 持久化（`statusDB.set(email, {status:'running', ...})`）

**行为 DIFFER — 以下均需处理：**

| # | engine.js 的行为 | 共享 login.js step 的行为 | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-L1 | 登录机制：`loginAccount(browser, account)`（Playwright 页面交互，`login.js`） | `runProtocolRegister(account, engine)`（Python `curl_cffi` spawn） | **高** | (C) 需要 browser login strategy：在 `loginStep(cfg)` 中新增 `strategy='browser'` 分支，调 `loginAccount()`，挂在同一 step 接口下 |
| D-L2 | Chrome 在 Phase 1 启动（`launchChrome` + `waitForCDP` + `loginAccount` 后 browser 持有至 finally）；缓存登录路径 browser=null，Phase 3 懒启动 | Python 子进程无 browser 概念；Phase 3 独立启动 Chrome（paypal-pay step） | **高（结构性）** | (C) browser login strategy 负责：启动 Chrome，持有句柄，写入 resources.browser/chromeProc/tempDir；paypal-pay step 需感知 resources.browser 已存在则**复用**而非重启（见 C 节） |
| D-L3 | `emitStatus` phase=`'login'` | phase=`'protocol-login'` | **低** | (B) login step 的 strategy 分支按 strategy 决定 emitStatus phase 字符串 |
| D-L4 | `statusDB.set` phase=`'login'` | phase=`'protocol-login'` | **低** | (B) 同上，phase 字符串从 strategy 派生 |
| D-L5 | 代理记账 error tag：`'login_net_error'` | `'protocol_net_error'` | **低** | (B) login strategy 分支用各自 tag 字符串；tag 影响 debug 可读性但不影响业务决策 |
| D-L6 | `loginResult` 无 `planType` 字段（从 `loginResult.session` 另行提取）；共享 login step 在 result 中注入 `planType` | 共享 login step 主动注入 `planType: session?.account?.planType \|\| ...` | **低** | (B) browser strategy 在 run() 末尾同样计算并注入 `planType` 到 `ctx.outputs.login`，保持 plan-check step 的约定不变 |
| D-L7 | `loginResult.lastOtp`（从 `loginAccount()` 返回，PKCE 阶段传入 `fetchTokensViaPKCE`） | 协议引擎无 `lastOtp` 字段（PKCE 用 Python TOTP） | **低** | (B) browser login strategy 在 `ctx.outputs.login` 中额外携带 `lastOtp`；paypal-pkce step 浏览器分支读取此字段 |

---

### B2. plan-check 步骤

**行为 IDENTICAL（安全复用）：**
- `isPlusOrAbove` 判断逻辑（planType 列表 `['plus','pro','team','enterprise']`）
- `ctx.flags.alreadyPlus=true` 设旗，供下游 skip

**行为 DIFFER：**

| # | engine.js 的行为 | 共享 plan-check.js step | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-P1 | log `Plan: {planType} (Plus member / Not Plus)`（无论是否 Plus） | log `Already Plus`（仅 Plus 时） | **无影响** | (A) log 格式差异不影响业务，可接受 |

---

### B3. paypal-fetch 步骤

**行为 IDENTICAL（安全复用）：**
- `REUSE_STATUSES` 集合（`'error','aborted','paypal_captcha','verify_error'`）
- 缓存链接快路径条件（`prevPersisted.payment_link && status in REUSE_STATUSES`）
- 3 次重试循环、Timeout/fetch 类 2s backoff
- Discord Gateway 重连逻辑
- link 获取成功后立即持久化（`statusDB.set`，`phase:'verify'`）

**行为 DIFFER：**

| # | engine.js 的行为 | 共享 paypal-fetch.js step | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-F1 | `noJpProxy` / `no_link` / 链接获取异常：仅设 `finalResult`，**不** emitStatus；状态在循环末尾统一 emit（`phase:'done'`） | step 内立即 emitStatus（`no_jp_proxy/done`，`no_link/done`，`error/{phaseTag}`）并 `summary.count++`，返 `{ok:false}` | **中** | (B) paypal-fetch step 需要条件：browser mode 下这些状态已在循环末尾 emit，step 内不再重复 emit。**或**：迁移后 browser engine 也直接复用 step 的行为（step 内 emit），循环末尾不再重复 emit。推荐后者（统一行为），但需确认 `summary` 计数与 `allResults.push` 的等价性 |

---

### B4. paypal-verify 步骤

**行为 IDENTICAL（安全复用）：**
- Discord 路径跳过（`shouldSkip linkSource==='discord'`）
- `verifyCheckoutIsFree(link, pk)` 调用
- `!v.ok` 分支（reason 格式 `'Stripe init: {v.reason}'`）
- `!v.is_free` 分支（reason 格式 `'amount_due={v.amount_due} {v.currency}'`）
- Coupons log

**行为 DIFFER：**

| # | engine.js 的行为 | 共享 paypal-verify.js step | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-V1 | `verify_error` / `no_promo`：仅设 `finalResult`，不 emitStatus（同 D-F1，在循环末尾统一 emit `phase:'done'`） | step 内立即 emitStatus `verify_error/done` / `no_promo/done`，`summary.verifyError++` / `summary.noPromo++`，返 `{ok:false}` | **中** | (B) 同 D-F1 建议：迁移后统一用 step 内 emit 行为（移除循环末尾重复 emit）；或在 step 内添加 browser mode 标记跳过 emit |

---

### B5. paypal-pay 步骤

**行为 IDENTICAL（安全复用）：**
- `autoPayment(page, {...}, {signal})` 调用及参数
- `freshCfg.phoneSlots?.[0]` 读取逻辑
- chrome-error/about:blank retry-once 逻辑（`recordBadAttempt` + `rotate()` + 再试）
- PayPal locator pre-warm + `randomDelay(2000,3000)`
- `NOT_FREE_TRIAL` catch 处理
- `aborted` / `status passthrough` / `else error` 五路结果分流

**行为 DIFFER：**

| # | engine.js 的行为 | 共享 paypal-pay.js step | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-Pay1 | **Chrome 复用**：browser 在 Phase 1 已存在，Phase 3 直接 `browser.contexts()[0]`；缓存登录时懒启动 Chrome | paypal-pay step 总是 `launchChrome + waitForCDP` 新起一个 Chrome | **高（结构性）** | (B) paypal-pay step 增加一个"browser already exists"路径：若 `ctx.deps.resources.browser` 非 null（由 browser login strategy 写入），跳过 launch，直接复用；仅在 `resources.browser` 为 null 时才 `launchChrome + waitForCDP`（此为 protocol 路径） |
| D-Pay2 | Page 复用：`browser.contexts()[0]` 的第 0 个已有 page（登录后的页面），`pages.length>0 ? pages[0] : newPage()` | step 同样用 `bCtx.pages()[0] \|\| newPage()`，代码逻辑相同 | **无** | (A) 逻辑完全等价 |
| D-Pay3 | `findFreePort()` + `tempDir` 在账号循环**顶部**（try 块外）生成；Chrome 可能在 Phase 1 用此 port+tempDir | paypal-pay step 在 `run()` 内自行生成 port+tempDir | **中** | (B) browser mode 下：login strategy 生成并持有 port+tempDir；paypal-pay step 若已有 `resources.browser` 则不需要重新 `findFreePort`（tempDir 亦已存在）；cleanup 路径需统一（见 C 节） |
| D-Pay4 | `NOT_FREE_TRIAL` 分支：`finalResult.status='no_link'`；emitStatus `no_link/done`；`summary.noLink++`；`continue`（浏览器引擎内联 `allResults` 而非 `summary.noLink++`） | step 返 `{ok:false, reason:'not_free_trial'}` 并在内部 `emitStatus no_link/done + summary.noLink++` | **低** | (A) 迁移后统一使用 step 行为，移除浏览器引擎内联逻辑 |

---

### B6. paypal-pkce 步骤

**行为 DIFFER（浏览器 PKCE 机制完全不同）：**

| # | engine.js 的行为 | 共享 paypal-pkce.js step | 严重度 | 调和方案 |
|---|---|---|---|---|
| D-K1 | **PKCE 机制**：`fetchTokensViaPKCE(browser, account, lastOtp)`（Playwright browser，`utils.js`） | `runProtocolPKCE(account, engineShim)`（Python spawn `protocol_register.py --pkce`） | **高** | (C) paypal-pkce step 需增加 browser-pkce 策略分支：若 `ctx.deps.resources.browser` 存在则调 `fetchTokensViaPKCE`；否则调 `runProtocolPKCE`（protocol 路径）。`lastOtp` 需从 `ctx.outputs.login.lastOtp` 读取 |
| D-K2 | **add-phone 不触发**：`needsPhone` 时浏览器引擎 saveCPAAuthFile 兜底，不执行自动 add-phone 流程 | `needsPhone=true` → `_finalizePhoneVerify()` 自动化 add-phone（3 次 attempt，4 provider） | **高** | (C) 浏览器 PKCE 策略分支：`needsPhone` 保持当前浏览器行为（不 add-phone）；protocol 路径保持 `_finalizePhoneVerify` 路径。两种模式行为本身是合理分叉，非 bug，需显式在代码中标注 |
| D-K3 | emitStatus `phone_pool_empty/pkce`（phase=`'pkce'`） | emitStatus `phone_pool_empty/done`（phase=`'done'`） | **低** | (B) browser 策略分支使用 phase=`'pkce'`；protocol 路径用 phase=`'done'` |
| D-K4 | emitStatus `phone_verify_fail/pkce`（phase=`'pkce'`） | emitStatus `phone_verify_fail/done`（phase=`'done'`） | **低** | (B) 同 D-K3 |
| D-K5 | **CPA 阶段**：`registerToCPA(browser, email, account)`，需要 browser 持有，paymentOk 和 alreadyPlus 两路均有 | **无 CPA 阶段**：协议引擎无 CPA 注册 | **高（浏览器专有）** | (C) paypal-pkce step 末尾增加 browser-only CPA 块：若 `runtimeCfg.enableCPA && ctx.deps.resources.browser`，执行 `registerToCPA()`，emitStatus `running/cpa` |
| D-K6 | `saveCPAAuthFile(email, pkceTokens.access_token, pkceTokens)` | `saveCPAAuthFile(email, pkce.access_token\|loginResult.accessToken, {...loginResult.session, refresh_token, id_token})` | **低** | (B) 浏览器引擎把完整 pkceTokens 作为第三参数；协议引擎解构合并 session。`saveCPAAuthFile` 内部需兼容两种参数形状，或在各自分支各自传 |
| D-K7 | `clearPaymentLink` + `clearAccessToken` 在支付成功的结果处理块内（line 576–577），**在 Phase 4 之前**；already-Plus 路径也在 plan-check 后立即 clear（line 344） | paypal-pkce step 统一在 `run()` 开头 clear | **无** | (A) 时序等价（均在 PKCE 开始前 clear） |

---

## C. 浏览器专有结构性问题

### C1. Chrome 生命周期（最重要）

**问题描述**：浏览器引擎在 Phase 1（login）就启动 Chrome，一个 browser 实例贯穿 login → plan-check → paypal-fetch → paypal-verify → paypal-pay → paypal-pkce → CPA 全阶段，最终在账号循环的 `finally` 块统一清理。

共享 paypal-pay step 假设"每次都需要新启 Chrome"（按协议引擎的行为），会在 `run()` 内执行 `launchChrome + waitForCDP`，并在 step 的 `finally` 清理。

**矛盾点**：
1. **重复启动**：若 browser login strategy 已在 Phase 1 启动 Chrome 并写入 `resources.browser`，paypal-pay step 在 `resources.browser !== null` 时不应再 `launchChrome`。
2. **清理冲突**：paypal-pay step 的 `finally` 会 `browser.close()` + `killTree`，释放掉登录后持有的 browser——这意味着 CPA（paypal-pkce 之后）拿不到 browser。
3. **缓存登录懒启动**：缓存登录跳过了 Phase 1，`resources.browser=null`。此时 paypal-pay step 需要新启 Chrome（与协议路径等价）。启动后，paypal-pkce 的 CPA 仍需要 browser，故 **paypal-pay 的 finally 清理不应在 CPA 之前执行**。

**建议调和方案（(C) 需要 browser-specific 策略）**：

`paypal-pay` step 增加 `browserMode` 参数（或从 `ctx.deps.resources.browser != null` 推断）：
- **有 resources.browser（Phase 1 已启动）**：跳过 `launchChrome`，复用 `resources.browser`；`finally` **不** close/kill（改为 no-op）；关闭由 engine-shell 账号循环 finally 负责。
- **无 resources.browser（缓存登录懒启动路径）**：`launchChrome`，写入 `resources.browser`；`finally` 保持 close/kill（同协议路径），但需注意后续 CPA 已无 browser（与现行浏览器引擎行为一致：缓存登录路径 paymentOk 后 pkce 内 browser 已通过懒启动存在）。

实际上，检查现有代码（engine.js line 499–505）：缓存登录路径在 Phase 3 懒启动时，`this._browser` 被写入，最终 finally 统一 close。CPA 依赖同一 browser，在 Phase 4 内执行完后，finally 才 close。**顺序是正确的**，关键是 step 模型中不能让 paypal-pay 的 `finally` 提前 close。

### C2. CPA 阶段（`registerToCPA`）

`registerToCPA(browser, email, account)` 是浏览器引擎独有的步骤，在 paypal-pkce 之后，需要：
- 持有已登录的 browser context（关闭额外标签页后复用登录页）
- 在 alreadyPlus 路径和 post-payment 路径两处均可触发
- `enableCPA` 由每账号重读的 config.json 控制

在共享步骤管道中，CPA 可以作为 paypal-pkce step 内的条件块，或作为独立的 `cpa` step 紧跟 paypal-pkce 之后。推荐独立 step（protocol 模式 `shouldSkip` 返 true），以保持 separation of concerns。

### C3. 账号间延迟（与协议引擎差异）

浏览器引擎：固定 5–7s 延迟（`5 + Math.floor(Math.random()*3)` 秒）。
协议引擎：15–45s 基础延迟 + `consecutiveErrors>=3` 时 5–10min 冷却。

迁移时需确认浏览器模式是否也需要 consecutiveErrors 冷却机制。这是有意为之的差异（浏览器模式每账号需要的 Chrome 启动时间较长，账号间间隔已有自然延迟），建议在 engine-shell 的 runner-loop 配置中区分两种模式。

### C4. Chrome 可用性前置检查

浏览器引擎在 `start()` 入口处（line 173）就检查 `!findChrome()` 并 fail-fast。协议引擎无此检查（Chrome 仅在 Phase 3 按需检查）。迁移后，browser engine-shell 需保留此前置检查。

### C5. `summary.aborted` 初始化差异

浏览器引擎 summary 在 finally 块内用 `allResults.filter` 构建（不依赖运行时计数器），`aborted` 字段在 `allResults` 有 aborted 结果时自然存在。协议引擎 `summary.aborted` 是懒初始化计数器（运行时 `++`）。前者在 emit `complete` 时始终包含 `aborted: 0`（即使无 aborted 账号），后者可能缺少该字段。迁移后若使用共享 summary 计数器，需统一初始化。

---

## SUSPECT_DEAD

1. **`engine.js line 569`：`continue` 在 `try` 块内，`NOT_FREE_TRIAL` 分支**  
   JavaScript `continue` 在 `try...finally` 内部会先执行 `finally`，再跳下一轮循环。因此 `finally`（line 646–657）的 Chrome 清理**会正确执行**，不是死代码，但代码结构容易让人误以为 `continue` 跳过了 `finally`，值得加注释。

2. **`engine.js line 580`：`paymentStatus = payResult.status || ''` 后续检查 `paymentStatus === 'aborted'`**  
   若 `payResult.status` 为 falsy（undefined/null），`paymentStatus` 为 `''`，后续 `else` 分支走 `finalResult.status = paymentStatus || 'error'` → `'error'`。此为有意兜底，行为正确。

3. **`engine.js line 236`：`loginResult.lastOtp = ''`（缓存命中时）**  
   缓存命中时 `loginResult.lastOtp` 被设为空字符串。`fetchTokensViaPKCE(browser, account, loginResult.lastOtp)` 以空字符串作为 lastOtp 传入。`utils.js#fetchTokensViaPKCE` 内部若 `lastOtp` 为空则生成新 TOTP（Gmail 路径）或跳过（Outlook）。行为正确，但与非缓存路径（lastOtp 来自 loginAccount 返回值）语义略有不同，可复核。

4. **`engine.js line 400`：emitStatus `running/{currentPhase}` 在缓存链接命中前**  
   即使此账号将使用缓存链接（跳过实际 fetch），前端仍会看到一次 `running/checkout` 或 `running/discord` 状态，随后可能直接跳到 `running/verify`。对用户体验无害，与协议引擎行为相同（protocol-engine.js 744–745 同样在缓存检查前 emit）。

---

## 覆盖自检

- **Section A 行数**：**69 行**
- **Section B diff 条目**：共 **24 条 diff**，分类：
  - **(A) 安全复用（IDENTICAL）**：隐含在 IDENTICAL 块内，约 **30+ 个子行为**安全复用
  - **(B) 需要小改 conditional**：D-L3, D-L4, D-L5, D-L6, D-L7, D-P1(可接受), D-F1, D-V1, D-Pay3, D-Pay4, D-K3, D-K4, D-K6 — 共 **11 条**
  - **(C) 需要 browser-specific 策略/变体**：D-L1, D-L2（browser login strategy）, D-K1, D-K2（browser PKCE strategy）, D-K5（CPA step）, D-Pay1（Chrome 复用逻辑）— 共 **6 条**
- **emitStatus 调用覆盖**（engine.js 内）：272, 304–308, 238, 272, 338（cached-login）, 359, 364, 379, 401, 469, 499, 584, 598, 606, 612（共约 **15 处**业务调用，循环末尾统一 emit 的 line 663–670 覆盖了 verify_error/no_promo/no_jp_proxy/no_link 等中间态）
- **statusDB 操作覆盖**：set（line 325–333, 455–458）、clearPaymentLink（line 344, 576）、clearAccessToken（line 344, 577）、get（通过 prevPersisted 快照 line 216）—— 全部覆盖
- **proxyMgr 调用覆盖**：rotate（line 259–264）、recordBadAttempt（line 291, 523, 529）、recordGoodAttempt（line 314, 535, 539）、isProxyNetError（line 290）—— 全部覆盖
- **最大结构性问题**：Chrome 生命周期（C1 节），涉及 paypal-pay step 的 launch/cleanup 策略，需要 browser-mode 条件分支
- **login 策略**：完全独立，共享 login.js 当前仅实现 `protocol` 策略，`browser` 策略需要新增（抛出 `Error: not implemented yet` 的 TODO 已在 login.js line 101–103 标注）
