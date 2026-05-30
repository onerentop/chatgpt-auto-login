# ProtocolEngine 行为清单（迁移基线）

> **用途**：本文档是把 `ProtocolEngine.start()` 单体循环重构为共享步骤管道时的"零逻辑丢失"验证基线。  
> 每一行代表一个**独立可测的行为分支**。迁移完成后，每行应在"去处 step"列标注对应的新步骤函数，并打勾表示"已落地"。  
> 若本文档缺少某个分支，该分支在迁移中可能被静默丢弃。

来源文件：`protocol-engine.js`（2026-05-30 快照，总计约 1016 行）

---

## 行为分支总表

| 源 file:line | 现象 / 分支描述 | 去处 step | 备注 |
|---|---|---|---|
| **engine-shell: 构造函数 / 生命周期** | | | |
| 162–171 | 构造函数初始化 `status='idle'`, `stopFlag=false`, `_gw=null`, `_chromeProc=null`, `_browser=null`, `_tempDir=null`, `_abortController=null` | `engine-shell` | 所有资源句柄设为 null 基态 |
| 503–547 | `stop()`: `status==='idle'` 时立即返回 | `engine-shell` | 防止重复停止 |
| 505 | `stop()`: 设 `stopFlag=true`，调 `_abortController.abort()` | `engine-shell` | 主循环 stopFlag 检查点会感知 |
| 513–517 | `stop()`: `killTree(py.pid)` + `py.kill()` 双保险杀 Python 子进程 | `engine-shell` | Windows taskkill /T 确保 curl_cffi 子线程也清理（HX-13） |
| 520–523 | `stop()`: `await browser.close()` 优雅关闭 Playwright | `engine-shell` | 先 close 再 kill（见 PipelineEngine 注释） |
| 524–528 | `stop()`: `killTree(chromeProc.pid)` + `chromeProc.kill()` 杀 Chrome | `engine-shell` | belt-and-suspenders |
| 529–532 | `stop()`: `gw.cleanup()` 清 Discord Gateway 连接 | `engine-shell` | linkSource=discord 时有值 |
| 533–536 | `stop()`: `fs.promises.rm(tempDir, {recursive,force})` 清临时目录 | `engine-shell` | 异步删目录 |
| 541–543 | `stop()`: `statusDB.resetRunning()` 把 DB 中 running 账号重置为 idle | `engine-shell` | 防崩溃后 UI 永久显示 running |
| 545–546 | `stop()`: 设 `status='idle'`，emit `log` 告知停止完成 | `engine-shell` | |
| **runner-loop: LogCapture / 账号循环基础设施** | | | |
| 554–566 | LogCapture 启动：劫持 `console.log` → emit `log` 事件 + `logsDB.add()`（当 `currentEmail` 非空时） | `runner-loop` | 与 PipelineEngine 完全对称 |
| 569–577 | 加载账号列表；`filterEmails` 非空时过滤（大小写不敏感） | `runner-loop` | |
| 578 | 账号列表为空时抛出 `Error('No accounts')` → 外层 catch → fatal，`summary.error=summary.total` | `runner-loop` | |
| 580 | 读取 `config.json`（`runtimeCfg`） | `runner-loop` | 运行时配置，不含每账号重读 |
| 581 | 初始化 `summary` 计数器：`{total, success:0, noLink:0, error:0, noJpProxy:0, noPromo:0, verifyError:0}` | `runner-loop` | `aborted` 字段懒初始化（line 931） |
| 584–589 | 冷却参数常量：`COOLDOWN_THRESHOLD=3`，`COOLDOWN_MS_MIN=300000`（5min），`COOLDOWN_MS_MAX=600000`（10min），`ACCOUNT_DELAY_MIN=15000`（15s），`ACCOUNT_DELAY_MAX=45000`（45s），`consecutiveErrors=0` | `runner-loop` | |
| 596–603 | `linkSource` 决定（`runtimeCfg.paymentLinkSource \|\| 'api'`）；若 `linkSource==='discord'` 则在循环前连 Discord Gateway | `runner-loop` | Discord Gateway 连接失败会抛异常 → fatal |
| 606 | 每轮循环头：检查 `this.stopFlag`，为真则 `break` 退出账号循环 | `runner-loop` | |
| 610 | 记录 `errorsBefore = summary.error`（用于后续 consecutiveErrors 判断） | `runner-loop` | |
| 962–968 | 账号处理完毕后：若 `summary.error > errorsBefore` 则 `consecutiveErrors++`，否则 `consecutiveErrors=0` | `runner-loop` | |
| 970–989 | 非最后一个账号时做账号间延迟：若 `consecutiveErrors >= 3` → 随机冷却 5–10min（1s 分片，stopFlag 可中断），重置 `consecutiveErrors=0`；否则 → 随机延迟 15–45s（1s 分片，stopFlag 可中断） | `runner-loop` | 冷却后 `consecutiveErrors` 归零 |
| 992–994 | 外层 try/catch：捕获 fatal 异常（如 Gateway 连接失败），log `[Proto-Engine] Fatal`，`summary.error=summary.total` | `runner-loop` | |
| 995–1006 | finally 块：清理 `_browser`, `_chromeProc`, `_gw`, `_tempDir`，停止 LogCapture，emit `complete`，`status='idle'` | `runner-loop` + `engine-shell` | |
| **login: Phase 1 缓存快路径** | | | |
| 615–617 | 读 `prevPersisted = statusDB.get(account.email) \|\| {}` 快照（在本轮任何 emitStatus 前读，保留上一轮状态） | `login` | |
| 624–643 | 若 `prevPersisted.last_access_token` 存在，解码 JWT exp；若 `exp > now + 60s`（`JWT_BUFFER_SEC=60`），则从 DB 重建 `result`（accessToken + session + planType），跳过 Phase 1 Python 调用，emitStatus `running/cached-login` | `login` | 缓存命中时仍会做 proxy rotate（line 649） |
| 643 | session 解析失败（`JSON.parse` 抛异常）时 `session=null`，缓存快路径不生效 | `login` | |
| **runner-loop: Proxy Rotate（每账号）** | | | |
| 649–656 | 若 `proxyMgr.getState().enabled`，每账号（含缓存命中）执行 `proxyMgr.rotate()`；失败仅 log，不阻断 | `runner-loop` | 确保 Phase 3 PayPal 也走新节点 |
| **login: Phase 1 协议登录** | | | |
| 659–660 | 非缓存命中时，emitStatus `running/protocol-login` | `login` | |
| 663 | 调 `runProtocolRegister(account, this)` → 内部最多 2 次 Python spawn（passkey retry） | `login` | |
| 664–685 | **TLS retry-once**：`result.status==='tls_failure'` → `recordBadAttempt(badNode,'main','tls_failure')` → `rotate()` → 第 2 次调 `runProtocolRegister`；第 2 次仍 tls_failure → `recordBadAttempt` → emitStatus `error/protocol-login` → `summary.error++` → `continue` | `login` | |
| 688–690 | **G1** 代理健康：任何业务返回（success/deactivated）视为节点正常 → `recordGoodAttempt(currentNode,'main')` | `login` | |
| 691–695 | `result.status==='deactivated'` → emitStatus `deactivated/done`（reason='account_deactivated'）→ `summary.error++` → `continue` | `login` | |
| 697 | login OK：log access token（脱敏由 `server/logger.js#redact()` 兜底） | `login` | |
| 699–706 | login 抛异常：若 `isProxyNetError` 则 `recordBadAttempt(currentNode,'main','protocol_net_error')`（**T8**）；emitStatus `error/protocol-login` → `summary.error++` → `continue` | `login` | |
| **login: Phase 1 后 DB 持久化** | | | |
| 713–724 | login 成功（或缓存命中）后，`statusDB.set(email, {status:'running', phase:'protocol-login', accessToken, sessionJson})` — 为下次缓存快路径写入 `last_access_token` + `last_session_json` | `login` | 缓存快路径分支的 result 此处不重复写（result 已从 DB 读出，无需再写） |
| **plan-check: 已 Plus 分支** | | | |
| 727 | 判断 `isPlusOrAbove`：planType 在 `['plus','pro','team','enterprise']`（toLowerCase）中 | `plan-check` | |
| 729–730 | 已 Plus → `statusDB.clearPaymentLink(email)` + `statusDB.clearAccessToken(email)` | `plan-check` | 清掉旧支付链接和 token 缓存 |
| 732–738 | 已 Plus + `runtimeCfg.enableOAuth=true` → 调 `_finalizePkce` | `plan-check` → `paypal-pkce` | |
| 735–738 | 已 Plus + `enableOAuth=false` → `saveCPAAuthFile` + emitStatus `plus_no_rt/done` → `summary.success++` | `plan-check` | |
| **paypal-fetch: Phase 2 取支付链接** | | | |
| 744–745 | emitStatus `running/discord`（Discord路径）或 `running/checkout`（API路径） | `paypal-fetch` | |
| 751–756 | **Discord 路径**：Gateway ws 非 OPEN 状态（`readyState !== 1`）→ `cleanup()` + `connectGateway()` 重连 | `paypal-fetch` | |
| 763 | `REUSE_STATUSES = new Set(['error','aborted','paypal_captcha','verify_error'])` — 精确 5 个值 | `paypal-fetch` | `paypal_captcha` 实际由 autoPayment 返回，非直接 emitStatus |
| 765–770 | **链接缓存快路径**：`prevPersisted.payment_link` 存在 && `prevPersisted.status` 在 `REUSE_STATUSES` 中 → 复用缓存链接，跳过 Phase 2 + Phase 2.5 | `paypal-fetch` | usedCachedLink=true，fetchResult.title='cached' |
| 773–808 | **链接获取循环（最多 3 次）**：非缓存命中时进入 `for(dRetry=0; dRetry<3; dRetry++)` | `paypal-fetch` | |
| 777–780 | 循环内：Discord 路径 → `getPaymentLink(gw, accessToken)`；API 路径 → `fetchCheckoutLink(accessToken)` | `paypal-fetch` | |
| 785–788 | 链接获取返回 `fetchResult.noJpProxy=true` → emitStatus `no_jp_proxy/done` → `summary.noJpProxy++`；`linkFetchOk=true`；`break` | `paypal-fetch` | |
| 789–793 | 链接获取成功但 `link` 为空/falsy → emitStatus `no_link/done` → `summary.noLink++`；`linkFetchOk=true`；`break` | `paypal-fetch` | |
| 796–800 | 链接获取抛异常且 `dRetry<2` 且是 Timeout/fetch 类错误 → 等待 2s 后 `continue` 重试 | `paypal-fetch` | |
| 801–805 | 链接获取抛异常且非 transient 或已到第 3 次 → emitStatus `error/phaseTag` → `summary.error++`；`linkFetchOk=true`；`break` | `paypal-fetch` | |
| 809 | `!link`（noJpProxy/noLink/error 分支均不 continue，依赖 `if (!link) continue`）→ 跳过 Phase 2.5 和 Phase 3 | `paypal-fetch` | 关键 gate：确保无有效 link 时不进支付 |
| 815–820 | 非缓存命中时，link 获取成功后立即持久化：`statusDB.set(email, {status:'running', phase:'verify', paymentLink:link, paymentLinkPk:pk})` | `paypal-fetch` | 在 verify 之前写盘，verify_error 重试时可复用 |
| **paypal-verify: Phase 2.5 Stripe $0 验证** | | | |
| 823 | 仅 `linkSource !== 'discord'` 时进入 Phase 2.5（Discord 路径信任 bot 判断，直接跳到 Phase 3） | `paypal-verify` | |
| 824 | emitStatus `running/verify` | `paypal-verify` | |
| 826 | 调 `verifyCheckoutIsFree(link, fetchResult.pk)` | `paypal-verify` | |
| 827–831 | `!v.ok` → emitStatus `verify_error/done`（reason=`Stripe init: ${v.reason}`, paymentLink 写入）→ `summary.verifyError++` → `continue` | `paypal-verify` | verify_error 在 REUSE_STATUSES 中，下次可复用链接 |
| 833–838 | `v.ok` 但 `!v.is_free`（`amount_due > 0`）→ emitStatus `no_promo/done`（reason=`amount_due=${v.amount_due} ${v.currency}`, paymentLink 写入）→ `summary.noPromo++` → `continue` | `paypal-verify` | |
| 839 | `v.ok && v.is_free` → log coupons 列表，进入 Phase 3 | `paypal-verify` | |
| **paypal-pay: Phase 3 支付** | | | |
| 847–848 | `findFreePort()` 避免与现有 Chrome（9222）碰撞；生成 `tempDir` | `paypal-pay` | |
| 851 | emitStatus `running/payment` | `paypal-pay` | |
| 853–855 | `launchChrome(port, tempDir, {})` + `waitForCDP(port)` 连 CDP；存 `this._chromeProc`, `this._browser`, `this._tempDir` 供 stop() 清理 | `paypal-pay` | v2.42 起不显式传 proxyServer，读 HTTPS_PROXY env |
| 862 | `page.goto(link, {waitUntil:'domcontentloaded', timeout:30000}).catch(()=>{})` — 异常吞掉（后续 pageUrl 检查处理） | `paypal-pay` | |
| **paypal-pay: chrome-error retry-once** | | | |
| 868–881 | pageUrl 以 `chrome-error://` 或 `about:blank` 开头 → `recordBadAttempt(badNode,'main','payment_unreachable')` → `rotate()` → 第 2 次 goto；第 2 次仍 chrome-error → `recordBadAttempt` → 抛 `Error('Payment page unreachable after node rotation')` | `paypal-pay` | |
| 884–886 | 重试后真实页面打开 → **G3** `recordGoodAttempt(newNode,'main')` | `paypal-pay` | |
| 888–891 | 一次到位（非 chrome-error）→ **G3** `recordGoodAttempt(currentNode,'main')` | `paypal-pay` | |
| 903–904 | 每账号重读 `config.json`（freshCfg），取 `freshCfg.phoneSlots?.[0]` 或 `{phone, smsApiUrl}` 作为支付 SMS 配置 | `paypal-pay` | v2.43.3：运行时改 config 不用重启 batch |
| 905 | 调 `autoPayment(page, {phone, smsApiUrl, email}, {signal: abortController.signal})` | `paypal-pay` | |
| 907–911 | `autoPayment` 抛 `e.code==='NOT_FREE_TRIAL'` → `paymentResult={success:false, notFreeTrial:true, reason:e.message}`（不走卡填充） | `paypal-pay` | |
| 913–915 | 其他异常 → log，`paymentResult` 保持 `{success:false}` 默认值 | `paypal-pay` | |
| **paypal-pay: 支付结果分流** | | | |
| 917–927 | `paymentResult.success=true` → `statusDB.clearPaymentLink` + `clearAccessToken`；若 `enableOAuth` → `_finalizePkce`；否则 → `saveCPAAuthFile` + emitStatus `plus_no_rt/done` → `summary.success++` | `paypal-pay` / `paypal-pkce` | |
| 928–931 | `paymentResult.status==='aborted'` → emitStatus `aborted/payment`（reason='Stopped by user'）→ `summary.aborted = (summary.aborted\|0) + 1` | `paypal-pay` | `aborted` 计数器懒初始化，summary 初始化时无此字段 |
| 932–934 | `paymentResult.notFreeTrial=true` → emitStatus `no_link/done`（reason=paymentResult.reason）→ `summary.noLink++` | `paypal-pay` | 链接非免费试用页，视同无有效链接 |
| 935–939 | `paymentResult.status` 存在（非 success/aborted/notFreeTrial）→ emitStatus `{paymentResult.status}/payment`（passthrough status）→ `summary.error++` | `paypal-pay` | autoPayment 可能返回自定义 status（如 `paypal_captcha`） |
| 940–944 | `paymentResult` 无 status 字段（兜底 else）→ emitStatus `error/payment` → `summary.error++` | `paypal-pay` | |
| 946–949 | Phase 3 外层 catch：非 autoPayment 内部异常（如 chrome-error retry 耗尽抛出）→ emitStatus `error/payment` → `summary.error++` | `paypal-pay` | |
| **paypal-pay: finally 清理** | | | |
| 950–960 | finally：`browser.close()` + `killTree(chromeProc.pid)` + `chromeProc.kill()` + `fs.rmSync(tempDir)` + 清空 `this._browser/_chromeProc/_tempDir` | `paypal-pay` | 每账号独立 Chrome 实例，finally 必清 |
| **paypal-pkce: PKCE / add-phone / 写凭证** | | | |
| 461 | `_finalizePkce` 入口：emitStatus `running/pkce` | `paypal-pkce` | |
| 463 | 调 `runProtocolPKCE(account, this)` → Python spawn，timeout=180s | `paypal-pkce` | |
| 465–468 | `pkce.refresh_token` 存在 → `saveCPAAuthFile(email, pkce.access_token\|loginResult.accessToken, {...session, refresh_token, id_token})` → emitStatus `plus/done` | `paypal-pkce` | |
| 469–480 | `pkce.needsPhone=true` → 调 `_finalizePhoneVerify(pkce.session_state\|{}, account)` → 成功（`r.tokens`）→ `saveCPAAuthFile` 用 phone tokens → emitStatus `plus/done` | `paypal-pkce` | |
| 484 | add-phone 失败：`r.phonePoolEmpty=true` → `failStatus='phone_pool_empty'` | `paypal-pkce` | |
| 485 | add-phone 失败：`r.phoneVerifyFail==='pool-disabled'` → `failStatus='plus_no_rt'` | `paypal-pkce` | phonePool 未启用 |
| 486 | add-phone 失败：其他 phoneVerifyFail → `failStatus='phone_verify_fail'` | `paypal-pkce` | |
| 488–489 | add-phone 失败：`saveCPAAuthFile(email, loginResult.accessToken, loginResult.session)` + emitStatus `{failStatus}/done` | `paypal-pkce` | 降级保留无 RT 的 auth |
| 491–494 | `pkce.needsPhone=false` 且无 `refresh_token`（`pkce.error` 或其他）→ `saveCPAAuthFile` + emitStatus `plus_no_rt/done` | `paypal-pkce` | |
| 496–499 | `runProtocolPKCE` 抛异常 → log + `saveCPAAuthFile` + emitStatus `plus_no_rt/done` | `paypal-pkce` | PKCE 失败不阻断账号标记为 plus_no_rt |
| **paypal-pkce: add-phone 子流程 `_finalizePhoneVerify`** | | | |
| 361–363 | `cfg.phonePool.enabled=false`（或配置读取失败）→ 返回 `{phoneVerifyFail:'pool-disabled'}` | `paypal-pkce` | |
| 366–369 | 代理状态读取：若 `proxyMgr.getState().enabled`，`proxyUrl='http://127.0.0.1:7890'`，否则 `null` | `paypal-pkce` | |
| 371–374 | 取 `provider = cfg.phonePool.provider \|\| 'local'`；`MAX_ATTEMPTS=3`；`triedPhones=[]` 防重号 | `paypal-pkce` | |
| 376–457 | **add-phone 最多 3 次 attempt 循环** | `paypal-pkce` | |
| 377 | 调 `_acquirePhoneForProtocol(provider, cfg, email, proxyUrl, triedPhones, attempt-1)` | `paypal-pkce` | |
| 379–381 | 取号失败（phone 为空）→ 若 `lastReason` 非空返 `{phoneVerifyFail:lastReason}`，否则返 `{phonePoolEmpty:true}` | `paypal-pkce` | 区分"从未成功取号"与"取号后全部被拒" |
| 384 | 取号成功后立即 `save()` 落盘（v2.39.4 hotfix 等价） | `paypal-pkce` | |
| 387 | 调 `runProtocolPhoneVerify(sessionState, phone, smsConfig, proxyUrl, this, cfg)` → Python spawn，timeout=180s | `paypal-pkce` | |
| 389–391 | `result.status==='ok'` → 返 `{tokens:result.tokens}` | `paypal-pkce` | 成功出口 |
| 393–398 | `result.status==='phone-rejected'` → `releaseFn()` + `save()` + `lastReason='phone-rejected-by-openai'` → `continue` | `paypal-pkce` | |
| 400–432 | `result.status` 在 `['rate-limited','fraud-blocked','voip-blocked']` → 按 provider 做 reject 处理（见下表）→ `lastReason=result.status` → `continue` | `paypal-pkce` | v2.44.1/v2.45.0/v2.50.0 |
| 406–411 | **local provider**: `phonePool.markPhoneSaturated(db, phone, max)` + `save()` | `paypal-pkce` | 持久黑名单 |
| 412–419 | **smscloud provider** (`meta.provider==='smscloud'`): `smscloudPool.markRejected(db, orderNo)` + `deferredCancel.enqueue(...)` + `save()` | `paypal-pkce` | binding 记录保留，deferred cancel 入队 |
| 420–426 | **oapi provider** (`meta.provider==='oapi'`): `oapiPool.markRejected(db, cdk)` + `save()`（oapi 无 cancel API） | `paypal-pkce` | v2.50.0 |
| 427–430 | **其他 provider**（zhusms 等）: `releaseFn()` + `save()` | `paypal-pkce` | |
| 434–441 | `result.status==='sms-timeout'` → `releaseFn()` + `save()` + `lastReason='sms-timeout'` → `continue`（换号重试） | `paypal-pkce` | v2.49 |
| 443–449 | `result.status` 在 `['validate-error','submit-error']` → `releaseFn()` + `save()` → 不 retry，返 `{phoneVerifyFail:result.status}` | `paypal-pkce` | spawn 失败/号根本未被 OpenAI 用到 |
| 451–453 | `result.status==='post-validate-error'`（或未匹配的其他值）→ binding 保留（不调 releaseFn）→ 返 `{phoneVerifyFail:'post-validate-error'}` | `paypal-pkce` | OpenAI 已接受号+验证码但后续步骤失败 |
| 456 | 3 次 attempt 全部走 continue（`phone-rejected`/`rate-limited`/`fraud-blocked`/`voip-blocked`/`sms-timeout`）→ 返 `{phoneVerifyFail:lastReason \|\| 'all-phones-rejected'}` | `paypal-pkce` | |
| **`_acquirePhoneForProtocol` 各 provider 分支** | | | |
| 195–226 | **zhusms**: 取 `z.cardKey`，无则返 `{}`；调 `zhusmsProvider.takeOrder(...)` → order 为空返 `{}`；调 `ensureSession` 获 cookie（异常忽略）；返 `{phone, smsConfig:{provider:'zhusms',...}, releaseFn:cancelOrder}` | `paypal-pkce` | |
| 222–225 | zhusms `takeOrder` 异常 → log + 返 `{}` | `paypal-pkce` | |
| 227–300 | **smscloud**: 校验 `apiKey/serviceCode/countryCode`，不完整返 `{}`；v2.47 支持 `countryCode` 为 number[]，按 `attemptIdx % codes.length` 循环选 country；内层最多 3 次 acquire 循环（`MAX_ACQUIRE_TRIES=3`）：复用号时调 `resend`，resend 失败则 `markRejected`+`releaseBinding` 后重 acquire；acquire 耗尽返 `{}`；成功返 `{phone, smsConfig, releaseFn:releaseBinding, meta:{provider,orderNo,...}}` | `paypal-pkce` | v2.45.1 resend 失败处理 |
| 256–271 | smscloud 内层 resend 失败 → `smscloudPool.markRejected(db, orderNo)` + `smscloudPool.releaseBinding(db, orderNo, email, phone)` + `save()` + `acq=null` + 继续内层循环 | `paypal-pkce` | |
| 272–275 | smscloud 内层 acquire 3 次全耗尽（acq 仍为 null）→ log + 返 `{}` | `paypal-pkce` | |
| 302–343 | **oapi**: 校验 `apiKey`，无则返 `{}`；调 `oapiPool.acquireCdk(db, email, max, baseUrl, takeOrderFn)`；acquire 失败时调 `oapiPool.diagnose(db)` log 原因 + 返 `{}`；成功返 `{phone, smsConfig:{provider:'oapi',...}, releaseFn:releaseBinding, meta:{provider,cdk,baseUrl}}` | `paypal-pkce` | v2.54 diagnose |
| 345–353 | **local**: `phonePool.acquirePhone(db, email, max, excludePhones)`；失败返 `{}`；成功返 `{phone, smsConfig:{provider:'local',url}, releaseFn:releaseBinding}` | `paypal-pkce` | |
| **Python subprocess 行为** | | | |
| 30–42 | `runProtocolRegister` passkey retry wrapper：最多 2 次 spawn（attempt 0 + 1）；`result.status==='passkey_retry'` 且 attempt=0 → 等 2s → 第 2 次；第 2 次仍 passkey_retry → 抛 `Error('enroll-passkey retry exhausted')` | `login` | v2.51 |
| 48–49 | `_runProtocolRegisterOnce`：Python 120s timeout → `py.kill()` + `reject(Error('Python timeout (120s)'))` | `login` | |
| 67–73 | Python 输出解析：`status='success'` → resolve；`status='deactivated'` → resolve（engine 分流）；`status='tls_failure'` → resolve（engine 重试）；`status='passkey_retry'` → resolve（外层 retry）；其他 → reject with `result.error` | `login` | |
| 73 | Python stdout 非 JSON → `reject(Error(stderr.slice(-200) \|\| 'Python exit N'))` | `login` | |
| 85 | `runProtocolPKCE`：Python 180s timeout → `py.kill()` + `reject(Error('PKCE Python timeout (180s)'))` | `paypal-pkce` | |
| 103–106 | `runProtocolPKCE` 输出：`status='success'` → resolve；其他 → reject with `result.error` | `paypal-pkce` | |
| 119–122 | `runProtocolPhoneVerify`：180s timeout → `py.kill('SIGKILL')` + resolve `{status:'submit-error', detail:'timeout 180s'}` | `paypal-pkce` | resolve 而非 reject，不中断 add-phone 循环 |
| 143–147 | phone verify stdout 非 JSON → resolve `{status:'submit-error', detail:stderr.slice(-800)}` | `paypal-pkce` | |
| 149–154 | phone verify `py.on('error')` spawn 失败 → resolve `{status:'submit-error', detail:'spawn failed: ...'}` | `paypal-pkce` | |
| **emitStatus 基础设施** | | | |
| 178–183 | 每次 emitStatus 注入代理上下文（`proxyNode`, `exitIp`），若 proxyMgr 获取失败则忽略（try/catch） | `engine-shell` | |
| 184 | emit `'account-status'` 事件 | `engine-shell` | Socket.IO 接收转发前端 |
| 185–189 | `statusDB.set(data.email, data)`（merge-aware），失败仅 log | `engine-shell` | |

---

## 全量 emitStatus 调用位置速查

| 行号 | status | phase | 触发上下文 |
|---|---|---|---|
| 461 | `running` | `pkce` | `_finalizePkce` 入口 |
| 468 | `plus` | `done` | PKCE 有 refresh_token |
| 480 | `plus` | `done` | add-phone 成功 |
| 489 | `{failStatus}` | `done` | add-phone 失败（phone_pool_empty/plus_no_rt/phone_verify_fail） |
| 494 | `plus_no_rt` | `done` | PKCE 无 refresh_token（pkce.error 等） |
| 499 | `plus_no_rt` | `done` | PKCE 抛异常兜底 |
| 640 | `running` | `cached-login` | JWT 缓存命中 |
| 660 | `running` | `protocol-login` | Phase 1 正常入口 |
| 682 | `error` | `protocol-login` | TLS 两次失败 |
| 693 | `deactivated` | `done` | Python 返 deactivated |
| 704 | `error` | `protocol-login` | login 抛异常 |
| 737 | `plus_no_rt` | `done` | 已 Plus + enableOAuth=false |
| 745 | `running` | `discord`/`checkout` | Phase 2 入口 |
| 787 | `no_jp_proxy` | `done` | JP channel 不可用 |
| 791 | `no_link` | `done` | link 为空 |
| 802 | `error` | `discord`/`checkout` | 链接获取最终失败 |
| 824 | `running` | `verify` | Phase 2.5 入口 |
| 829 | `verify_error` | `done` | Stripe verify 失败 |
| 835 | `no_promo` | `done` | 非 $0（amount_due>0） |
| 851 | `running` | `payment` | Phase 3 入口 |
| 925 | `plus_no_rt` | `done` | 支付成功 + enableOAuth=false |
| 930 | `aborted` | `payment` | 用户中止 |
| 933 | `no_link` | `done` | NOT_FREE_TRIAL 异常 |
| 938 | `{paymentResult.status}` | `payment` | autoPayment 返自定义 status |
| 943 | `error` | `payment` | paymentResult 无 status |
| 948 | `error` | `payment` | Phase 3 catch 兜底 |

共 **26 处** `emitStatus(` 调用（含定义处 line 175，共 27 次词法出现；定义体本身不计入业务调用）。

---

## SUSPECT_DEAD

以下分支值得人工复核，不代表确认为死代码：

1. **`line 804`：`linkFetchOk=true` 在 catch 分支赋值但后续无读取使用**  
   `linkFetchOk` 在 catch 分支赋值为 `true`（line 804），但后续逻辑仅用 `!link` 做 gate（line 809），`linkFetchOk` 变量实际上从未被后续分支读取用于决策（`usedCachedLink` 赋值后也未被真正消费为 continue/break 的条件）。建议复核是否有逻辑遗漏。

2. **`line 803`：link-fetch catch 分支的 `summary.error++` 后立刻 `break`，但 `link` 仍为 undefined/null**  
   此时 `!link` 为真，line 809 的 `continue` 会跳过 Phase 2.5 和 Phase 3，账号被正确跳过。逻辑上无死区，但代码读起来像双重保护，可复核是否有意为之。

3. **`runProtocolPKCE` 内 Python 返回非 `success` 状态（如 `deactivated`/`tls_failure`/`passkey_retry`）时直接 `reject`（line 103–105）**  
   `_finalizePkce` 外层 catch 会接住并 emit `plus_no_rt`，行为合理。但 PKCE 阶段的 `deactivated` / `tls_failure` 未单独处理，复核是否应该和 Phase 1 同级处理。

4. **`summary.aborted` 懒初始化（line 931）**：`summary` 初始化时（line 581）无 `aborted` 字段；`aborted` 计数仅在 `paymentResult.status==='aborted'` 时才出现。`emit('complete', {summary})` 会带出 `aborted` 字段（若发生过）或不带此字段（若未发生过）。消费方（前端/Results 视图）若依赖此字段存在可能崩溃，建议迁移时统一初始化。

---

## 覆盖自检

- **分支行总数**：主表 **68 行**（不含速查表 26 行）
- **`emitStatus(` 调用位置**：词法搜索共找到 **27 处**（含第 175 行定义体），扣除定义体后为 **26 处**业务调用；速查表已覆盖全部 26 处，主表内亦已标注每处的触发条件。
- **`summary.` 增量点**：`summary.error`（11处）、`summary.success`（2处）、`summary.noLink`（2处）、`summary.noJpProxy`（1处）、`summary.noPromo`（1处）、`summary.verifyError`（1处）、`summary.aborted`（1处，懒初始化）；全部在主表中有对应行。
- 覆盖了所有 `statusDB.set / clearPaymentLink / clearAccessToken / resetRunning / get` 调用。
- 覆盖了所有 `recordGoodAttempt` / `recordBadAttempt` / `isProxyNetError` 调用（共 8 处）。
- 覆盖了所有 4 个 provider（zhusms / smscloud / oapi / local）的完整取号逻辑。
- 覆盖了所有 8 种 phone verify 结果状态的分流处理（ok / phone-rejected / rate-limited / fraud-blocked / voip-blocked / sms-timeout / validate-error / submit-error / post-validate-error — 实际 9 种，其中 rate-limited/fraud-blocked/voip-blocked 合并一条但按 provider 各有子分支）。
