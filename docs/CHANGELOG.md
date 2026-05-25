# Changelog

## v2.29.0 — 2026-05-25

### Liveness Protocol-Mode lightLogin（v2.26 Phase B 收尾）

关闭 v2.26 Phase B 待办：协议模式下，无 `cpa-auth/codex-{email}.json`
缓存的账号测活时 `!tok` 触发 `lightLogin` → 当时抛 stub →
runner 标 `alive_status='login_fail', reason='liveness not yet
supported in protocol mode'`，看起来像账号死了实际是机制缺失。

**核心改动：**

- **`chatgpt_register/liveness_login.py`** —— 新建协议模式纯登录脚本
  （~290 行）：username → password → OTP → session 7 步走 curl_cffi +
  sentinel，与 `protocol_register.py` 解耦但共享底层。
- **`chatgpt_register/otp.py`** —— 从 `protocol_register.py` 抽出
  `fetch_imap_otp` / `get_imap_baseline`（函数体逐字复制，加 `log=`
  callback 解耦）+ 新增 `gen_totp(secret)`（pyotp lazy import）。
- **`server/liveness/light-login.js`** —— `protocolMode=true` 分支
  spawn `chatgpt_register/liveness_login.py`，120s timeout + abortSignal
  双兜底；spawn ENOENT 仍 reject `LivenessLoginNotImplementedError`
  保留 runner.js:99 兜底兼容。stderr 摘要过 `redact()` 防止 proxy URL
  含凭证泄露到 alive_reason。
- **`server/liveness/runner.js`** —— 1 行改动：`lightLogin(...)` 调用
  加 `proxyUrl: getProxyMgr()?.getProxyUrl()`，让子进程走代理。
- **错误契约**：Python `reason` 字符串包含 runner.js:99-117 的 9 类
  keyword 之一（bad password / outlook oauth missing / otp timeout /
  captcha / proxy reset / no session / unexpected / ...）；runner 错误
  映射零改动。

**对外契约不变**：`lightLogin(account, opts)` 返回 shape
`{accessToken, accountId, expiresAtIso}` 双模式一致；`LivenessLoginNotImplementedError`
类保留为 spawn 失败兜底。

**单测**：`tests/test_liveness_login.py` 新建 3 Y unittest（Y1 no
password / Y2 bad password / Y3 happy path 三字段）+
`server/liveness/__tests__/light-login.test.js` 新增 5 P 单测（P1-P5
Node 端 spawn 胶水），并保留原 v2.26 的 8 个浏览器路径测试。共新增 8 用例。

**新依赖**：`pyotp`（仅 Gmail 协议模式 liveness 需要；Outlook 不影响）。
CLAUDE.md / start.bat 已更新说明，缺失时 start.bat WARN 不阻塞。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-protocol-lightlogin-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-protocol-lightlogin.md`。

## v2.35.0 — 2026-05-25

### 任务流驱动的前端重设计 — Command Palette / Pipeline HUD / 工作台

v2.34 完成了 design token + 包壳；v2.35 按"运营每天做什么"重新组
织前端，加入键盘党生产力工具。spec 见
`docs/superpowers/specs/2026-05-25-v2.35-task-flow-redesign-design.md`。

**B1 现代视觉系统升级（新增 `web/src/styles/v235-polish.css`，叠加
在 v2.34 tokens 之上不改原文件）：**

- 主色 `#5b67f0` indigo 替换 Element Plus 默认 `#409eff`；9 step
  lightness scale 自动让所有 el-* 组件 rebrand。
- 多层柔和阴影（Linear / Vercel 风格）：每档 1px hairline 内描边 +
  两层 diffused shadow。圆角 sm/md/lg 6/10/14。
- 按钮 hover 微 0.5px 上升；focus-visible 全局描边；滚动条变细；
  ElMessage 圆角 + 玻璃感 backdrop-filter。
- 全局动效曲线 cubic-bezier(0.4,0,0.2,1)；`.app-fade-in` opt-in 动画。

**B2 Dashboard 改工作台 hub：**

- 4 hero metric 卡：账号总数 / 今日激活 / 待重试 / 运行中。每张
  含 icon（着色 badge） + 数值 + 副标 delta；可点击跳带筛选的对应
  视图；键盘可达。
- 快捷操作（6 张任务卡）：导入 / 跑一批 / 重试失败 / 测活 / 下载
  凭证 / 调代理。按当前状态自动 disable；点击直接跳带 `?action=
  import/add` 的对应视图。
- 系统健康 6 行：引擎 / 主代理 / JP 通道 / WebSocket / 运行时长 /
  版本。10s 轮询 `/api/health`，颜色 dot 绿 / 灰 / 红。
- 近期执行 SectionCard + "查看全部 →" 跳 Results。

**B3 Command Palette（Ctrl/Cmd+K）：**

- 新增 `web/src/stores/commands.js` 反应式 commands registry +
  `web/src/components/ui/CommandPalette.vue`（Teleport modal）。
- 全局键盘监听 Ctrl/Cmd+K 打开 palette；输入即模糊匹配；分组显示
  （导航 / 账号 / 执行 / 代理 / 配置 / 主题）；↑↓ 选 / ↵ 执行 /
  Esc 关闭。
- AppLayout 注册 11 条核心命令（5 导航 + 主题切换 + 通知 + 账号
  导入/添加/导出 + 下载凭证 ZIP）；视图未来可 registerCommand 扩展。
- 顶栏左上加 `[⌘K / Ctrl K]` 命令按钮（mac/non-mac 自动适配）。

**B4 Pipeline HUD（v2.29 FX-4 deferred 项落地）：**

- 新增 `web/src/stores/pipelineStore.js`：running / total / done /
  currentEmail / currentPhase / recentDurations (last 5)。
- 新增 `web/src/components/ui/PipelineHUD.vue`：v-if 全局可见进度
  带；spinner + X/Y + 当前邮箱 + phase + 渐变进度条 + 已用 + ETA
  + 查看 / 停止。1s tick 刷新；slide-down 入场。
- socket.js 在 `account-status` 事件转发 `recordAccountStatus`；
  `execution-complete` 调 `endPipeline`。
- Execute.vue startExec 成功后调 `beginPipeline(total)`。
- ETA = 最近 5 个账号平均耗时 × 剩余数；< 2 样本时显示 "—"。
- 运营在 Config / Accounts 等页也能看到流水线进度。

**B5 Accounts toolbar 收纳 + ContextActionBar：**

- Toolbar Row 1：搜索 + 状态多选 + "更多筛选 ▾" popover（折叠
  Plan / Auth / 活性 / 仅看未测试 / 7 天未测 / 重置）。popover
  按钮含 brand 圆点 badge 显示已激活高级筛选数。
- Toolbar Row 2：测活全局控制（与选中无关）+ 下载全部 ZIP。
- 新增 `web/src/components/ui/ContextActionBar.vue`：底部居中
  sticky pill 操作栏；slide-up + fade 入场；选中数 > 0 时显示
  导出 / 下载 / 测活 / 删除 / 取消按钮，选中 = 0 时彻底不渲染。
- Accounts.vue onMounted 解析 `?action=import` / `?action=add`
  自动打开对应弹窗（来自 Dashboard 任务卡 / Command Palette）；
  解析后 router.replace 清掉 query。

**B6 EmptyState 升级：**

- 64×64 圆形 icon wrap（surface-2 背景 + hairline border + sh-1
  阴影），title 升 xl 加重，hint 加宽行距；整体加 app-fade-in
  入场动画。

**工程：**

- 182/182 测试全绿（前端无新测试基础设施；后端零改动）。
- 6 个 batch 共 6 commits；每 batch 验证 npm run build 成功。
- 新增依赖：0。新增 npm 包：0。
- 不动文件：`web/src/styles/tokens.css`（v2.34 原状）/ 4 个 composable /
  status.js / selection.js / socket 协议 / 后端任何代码。
- 保留所有 v2.29~v2.34 已有不变式：dirty 守卫、URL 筛选、行运行时
  高亮、通知中心、batch-delete、Execute 分组锁定、列锁定 +
  reserve-selection 等。

## v2.34.0 — 2026-05-25

### Execute 分组锁定 + 视图切换

两个独立但相关的 UX 改进：

**Part A — Sticky grouping**

v2.27 引入分组面板后，运行时 row 跨组跳跃（idle → running → 终态
plus / error）让用户跟丢 —— 刚看的一行跑着跑着就跳到别的组里去了。

修复：`Execute.vue:startExec` 时给 `filteredRows` 设
`_groupStatus = _status` 快照。`groupAccountsByStatus` 改读
`_groupStatus || _status || 'idle'`。socket 更新只动 `_status`
（驱动 v2.33 的行颜色），但 row 留在原组。

- **解锁时机：仅页面刷新**（`loadResults()` 重建 `accounts.value` 时新
  row 没 `_groupStatus` → 回到真实分组）。不主动清。
- **二次执行覆盖快照**：第二次 startExec 重新设 `_groupStatus = _status`
  —— 第二次开始时的真实状态。
- **行颜色不锁**：v2.33 `rowClassFor(row._status)` 仍读真实 `_status`，
  row 颜色随真实状态实时变 —— 用户既看到"还在跑/已成功"也保留视觉位置。

**Part B — 视图切换：分组 / 平铺**

toolbar 加 `<el-switch v-model="groupingEnabled">`（默认开 = 分组）。

- **分组（默认）**：既有 `<el-collapse>` + groups + AccountTableRows
- **平铺**：单 `<AccountTableRows :rows="flatSortedRows">`，按 GROUP_ORDER
  业务优先序排（Plus 在上、运行中、错误、已删除... 依次），同 status
  内稳定插入序

选择跨视图保持一致（复用既有 globalSelectedSet）。`onGroupSelectionChange`
平铺分支用 clearSelection + 重建确保选择 Set 与 UI 同步。

**测试**：`__tests__/status-groups.test.js` +2（_groupStatus 优先于
_status / falsy fallback）。`groupAccountsByStatus` 改动**向后兼容**
—— Accounts.vue 不受影响（其 row 没 `_groupStatus` 概念）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-sticky-grouping-and-view-toggle-design.md`
+ `docs/superpowers/plans/2026-05-25-execute-sticky-grouping-and-view-toggle.md`。

## v2.33.1 — 2026-05-25

### Hotfix: running 专属高亮色，不再与 warning 撞色

v2.33.0 把 `running` 映射到 warning（浅黄）—— 但 warning 还包括
plus_no_rt / token_expired / no_link / canceled / no_jp_proxy /
paypal_captcha 等多个终态。结果一个 token_expired 账户（浅黄）
点执行后变 running（也浅黄），**row 颜色没变化看不出"在跑"**。

**修复**：

- `rowClassFor('running')` 改返回 `'row-status-running'` 专属 class
  （不复用 `row-status-warning`）
- 两个 Vue 文件加 CSS `.row-status-running` —— 浅蓝 `#ecf5ff`
  背景 + 左边 4px Element Plus 主色 `#409eff` border，让"正在跑"
  视觉强突出，与所有终态色（红/黄/绿/灰）都不同
- 8 单测里 `running` 断言改成 `row-status-running`

## v2.33.0 — 2026-05-25

### 账号行运行时整行高亮

Execute 流水线运行时，账户列表的每一行整行换浅色底色，扫一眼就
能识别每个账号当前状态。Accounts.vue 顺带补上之前漏的
`account-status` socket 订阅 —— Execute 在跑时 Accounts 页也实时
反映 status / phase 变化。

**颜色映射（基于 `statusType()`）**

| 类型 | 包含 status | row 背景色 |
|---|---|---|
| `success` | plus | `#f0f9eb` 浅绿 |
| `warning` | running（特殊）/ plus_no_rt / no_link / no_jp_proxy / token_expired / canceled / paypal_captcha | `#fdf6ec` 浅黄 |
| `danger` | error / deactivated / verify_error / login_fail | `#fef0f0` 浅红 |
| `info` | no_promo / aborted | `#f4f4f5` 浅灰 |
| —（idle / 空） | — | 默认背景（不上色） |

**实现要点**

- 新增 `web/src/status.js:rowClassFor(status)` 工具函数，沿用
  `statusType()` 单一来源；唯一例外：`running` 在 TYPE_MAP 是 `''`
  → 回退 info（浅灰）会让"运行中"不醒目，所以强制返回 warning
- `AccountTableRows.vue`（Execute 子组件）和 `Accounts.vue` 的
  `<el-table>` 都加 `:row-class-name="rowClass"`，CSS 4 个类
  使用 `:deep()` + `!important` 覆盖 el-table 默认 zebra
- Accounts.vue 新增 `watch(socketState.accountStatuses, ...)`
  接通实时数据流（Execute.vue 已有，零改动）
- 后端零改动；Dashboard.vue / Results.vue YAGNI 不动

**测试**：182 tests pass — `__tests__/status-row-class.test.js` +8（idle / running 例外 / 4 个 type / 未知 fallback / 大小写）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-row-highlight-during-execution-design.md`
+ `docs/superpowers/plans/2026-05-25-row-highlight-during-execution.md`。

## v2.30.0 — 2026-05-25

### v2.29 deferred 项二轮收敛 — 8 项一次性 ship

接 v2.29 同日发布。仍不动登录/支付/JSON 主管道。spec 见
`docs/superpowers/specs/2026-05-25-v2.30-deferred-followups-design.md`。

**后端（4 项）：**

- **HX-9 SIGINT / SIGTERM 优雅退出**：`server/index.js` 注册信号
  → 调 `logsDB.flush()` 强制 save → `await save.flush()` 等队尾
  原子落盘 → `process.exit(0)`。5s 硬 deadline 防磁盘 wedge 时
  挂死。之前 Ctrl+C 时 logsDB 内未达 10 行阈值的 0-9 条日志直接
  消失。
- **HX-13 Windows tree-kill**：新增 `server/process-utils.js`
  `killTree(pid)`：Windows 走 `taskkill /T /F` 杀整棵进程树；
  POSIX 走 `process.kill(-pid)` 进程组 + 单 PID 双保险。引擎
  `stop()` 改 `killTree(chromeProc.pid) + chromeProc.kill()` /
  `killTree(pyProc.pid) + py.kill()` 双保险。之前 `py.kill()`
  只 SIGTERM 顶层 python.exe，curl_cffi 内部 C 子线程不接受
  信号 → Windows 留僵尸进程；Chrome 同理 renderer / GPU 孙进
  程残留。
- **HX-16 `/api/health` endpoint**：新增 `server/routes/health.js`
  返回 `{ ok, db, proxy: {…字段白名单子集}, engine, uptimeSec,
  version }`。200 / 503 区分 DB ok 与否。同时新增
  `server/engine-singleton.js` 把 `let engine` 从 routes/execute.js
  提升到模块级，避免 cyclic require。
- **PX-7 主动健康检查**：新增 `clashApi.testNodeDelay()` 调用
  Clash `/proxies/{name}/delay` 一次性 HTTPS GET，不动 active
  selector。新增 `server/proxy/health-probe.js#probeAllNodes()`
  并发 4 跑 delay test 写入 `_state.probeResults` Map。`refresh()`
  末尾 fire-and-forget 触发；`config.proxy.activeHealthCheck =
  false` 可关。`rotate / rotateJp` 内先看是否有 alive 节点，有
  则跳过 dead-by-probe；全 dead 时回退原逻辑避免死锁。
  好处：之前首批 3 个账号必失才能识别死节点 + TTL 30min 到期
  又浪费 3 个；现在 refresh 后秒级标 dead，rotate 自动跳过。

**前端（4 项）：**

- **FX-15 Accounts 主表瘦身**：移除 TOTP / Client ID / Refresh
  Token 三列。新增"凭证"列：3 个圆点（绿=有 灰=空）+ "查"按钮
  触发 el-popover 展示完整 3 字段 + 各自复制按钮。主表瘦身约
  350px，1366px 屏幕不再溢出。
- **FX-17 Dark mode**：引入 `element-plus/theme-chalk/dark/css-
  vars.css`。`useDarkMode` composable 写 `html.dark` 类 +
  localStorage；OS 偏好兜底（用户未显式选过时跟随 prefers-color-
  scheme）。AppLayout logo 区加月亮 / 太阳切换按钮。
  `.main` 背景改 `var(--el-bg-color-page, …)` 跟随主题。
- **FX-13 通知中心**：新增 `web/src/notifications.js` 反应式
  store（items 最近 100 + unread）。`web/src/api.js` axios
  interceptor 自动捕获 5xx + 网络错误 → pushNotification
  （4xx 留给业务代码自决，避免吃掉 409 pipeline-busy 这类正常
  拒绝）。AppLayout 顶栏铃铛 + 未读 badge；点开弹 el-drawer
  历史，tag 染色 + 标题 + 正文 + 时间。
- **FX-5 batch-delete**：新增 `accountsDB.bulkDelete(emails)` +
  `POST /api/accounts/batch-delete`。前端 `delSelected` 改单次
  POST，按钮 loading + "删除中…"。之前 N 次串行 DELETE 在
  N=200 时卡 30s 无进度反馈。

**工程：**

- 6 个新测试文件、174 个 case 全绿（v2.29 158 + v2.30 16 新）。
- `server/__tests__/process-utils.test.js`：killTree 输入安全 /
  不存在 PID 静默 / 真子进程实际终止。
- `server/__tests__/health-endpoint.test.js`：200 + 字段不含
  subscriptionUrl/token/password。
- `server/proxy/__tests__/health-probe.test.js`：alive/dead 标
  记 / rotate 跳 dead / 全 dead 回退 / shouldSkip 跳过 manual /
  getState 形状。
- `server/__tests__/accounts-batch-delete.test.js`：成功 / 部分
  notFound / 边界输入。

**仍留下次的**：PX-4 sing-box stop-after-start-success、PX-8
Clash secret + 端口自动、FX-4 Pipeline HUD、HX-10 LogCapture
重写、HX-11 zod schema、HX-19 GitHub Actions CI、`ProxyManager`
类化、`better-sqlite3` 迁移。

## v2.29.0 — 2026-05-25

### 代理 / 前端 UX / 横切硬化 — 4 路审计后 20 项一次性 ship

不动登录/支付/JSON 凭证主管道。spec 见
`docs/superpowers/specs/2026-05-25-v2.29-proxy-ux-and-hardening-design.md`。

**横切硬化（6 项）：**

- **HX-1a/1b DB 原子写 + save 串行化**：`server/db.js#save()` 改成
  `tmp + rename` 原子落盘，断电不会再留半截 `data.db`；并发 set()
  通过 `_saveQueue.then(...)` 串行化，避免快照互相覆盖。新增
  `save.flush()` 供测试 / 优雅退出 await。
- **HX-6 config.json 原子写**：`server/routes/config.js#writeConfig`
  同样改 `tmp + renameSync`。
- **HX-7 默认绑 127.0.0.1**：`server.listen(PORT, HOST, …)`，
  `HOST` 默认 loopback；远程访问需显式 `set HOST=0.0.0.0`，
  启动时显眼警告 dashboard 无认证。CORS allow-list 同步加入
  `http://${HOST}:3000`。
- **HX-3 engine.stop() async**：浏览器 / 协议两套引擎 stop() 改
  async，按 browser.close() → chromeProc.kill() → tempDir rm
  顺序 await，避免 fire-and-forget 让新一轮 engine 撞旧资源。
  /execute 路由构造新 engine 前显式 `await engine.stop()` 兜底
  清掉 LogCapture monkey-patch + tempdir。
- **HX-2 LogCapture 兜底脱敏**：`server/logger.js` 新增
  `redact()`，过滤 JWT 三段 / `access_token=…` / `refresh_token=…`
  / `id_token=…` URL 参数 / `Bearer <token>` / "OTP|code|verification
  code|sms code" 紧邻数字。覆盖 server.log + Socket.IO 推送两路。
  start() idempotent，二次调用不嵌套 wrapper（避免多次切引擎让
  console.log 被层层包装）。

**代理（4 项）：**

- **PX-1 `getState()` 字段白名单**：不再 `{ ..._state }` spread，
  去掉 `subscriptionUrl`（含 token）和 `outbounds`（含 vmess UUID
  / ss 密码）；新增 `hasSubscription: bool` + `subscriptionHost:
  string|null` 让前端仍能展示"已配置 + 主机名"。
- **PX-2 rotate 串行化**：模块级 `_rotateLock` + `withRotateLock`
  helper，`rotate / rotateJp / switchTo` 以及 refresh 末尾的
  selector 同步都过同一把锁，防止 `recordBadAttempt` 的 fire-
  and-forget rotate 与显式 await rotate 竞态 `_state.currentNode`
  + Clash API PUT /proxies。
- **PX-3 refresh 后同步 selector**：sing-box config 写
  `default = filtered[0]`，但 `_state.currentNode = filtered[
  rotationIndex]` 在 `rotationIndex != 0` 时不一致。`refresh()`
  末尾主动调 `clashApi.switchSelector(SELECTOR_TAG, currentNode)`
  对齐，避免下一次 `recordBadAttempt` 冤枉错节点。
- **PX-5 黑名单 auto/manual 分两步清**：`rotate()` 兜底"全部 bad
  → clear"分支先只清 `source === 'auto'`，保留运维 manual 拉黑；
  清完依然无可用节点才退化为全清，防止死锁。

**前端 UX（10 项）：**

- **FX-1 Dashboard / Results 用 statusLabel**：状态 tag 从原始
  code (`verify_error`) 改 `statusLabel`（"Stripe验证失败"）。
- **FX-2 侧栏菜单顺序 + Results 入口**：仪表盘 / 账号管理 / 执行
  控制 / 执行结果 / 配置设置。之前 Results 是孤儿路由，必须改
  URL 才能进。
- **FX-3 WebSocket 断线横幅**：AppLayout 主区顶部 sticky 警告
  + 手动重连按钮，比 Execute 顶部的小 tag 显眼。
- **FX-6 Config dirty form 守卫**：watch form 计 isDirty；
  `onBeforeRouteLeave` + `beforeunload` 双重保护未保存改动。
- **FX-7 键盘快捷键基础三键**：`useHotkeys` composable 全局注册
  `/` 聚焦搜索（焦点在 INPUT 时不抢）+ `Ctrl+Enter` 触发
  `[data-hotkey="submit"]`。Esc 仍由 Element Plus 弹窗承担。
- **FX-8 Accounts 6 个筛选写 URL**：`useUrlSyncedFilters`
  composable 让 search / status / plan / auth / alive / stale
  双向同步到 `route.query`，刷新 / 复制粘 URL 都保持筛选。
- **FX-9 全 FAILED_TO_RETRY 行内重试**：`AccountTableRows.vue`
  重试按钮显示条件从 `error || idle` 扩到 `isFailedToRetry()`
  全部 9 个终态，不再必须勾选→顶部"重试失败"。
- **FX-11 删除选中 confirmDanger**：从 popconfirm（一键，误点率
  高）改 `confirmDanger`，N > 5 时要求输入数字 N 才确认，防止
  误点批量删除。
- **FX-12 Results 状态下拉用单一来源**：v-for
  `EXECUTE_STATUS_FILTER_OPTIONS`（status.js），不再硬编码 12 项。
- **FX-14 Config 黑名单 polling visibility 暂停**：tab 隐藏停
  setInterval；可见时重启并触发一次 loadBlacklist。

**工程：**

- npm scripts `test` / `test:py`：以前要手敲一长串 `node --test`，
  现在 `npm test` 一键跑（158 个 case：143 旧 + 15 新增覆盖
  HX-1/HX-2/PX-1/PX-3/PX-5）。

**未做（留 v3.0 / 下次 spec）：**

PX-4（sing-box stop-after-start-success）、PX-7（主动健康检查）、
PX-8（Clash secret + 端口自动）、FX-4（Execute Pipeline HUD）、
FX-5（后端 batch-delete）、HX-10（LogCapture 重写）、HX-11（zod
schema 校验）、HX-13（Windows tree-kill）、`/healthz` + metrics、
`better-sqlite3` 迁移、ProxyManager 类化。

## v2.28.0 — 2026-05-25

### Ops UX Fixes — 10 个 P1 改进一次性 ship

3 模块审查（执行控制 / 账号管理 / 代理）共发现 32 个改进项，
10 个 P1 打包本版本一次性 ship。覆盖 v2.18-v2.32 快速迭代积攒
的 3 类债：(a) 状态维度扩展未同步到 UI、(b) 后端能力 > 前端
暴露、(c) 危险操作无守卫 + UI 体力活。

**Execute 页（5 项）：**

- **#1 `failedEmails` 涵盖所有可重试终态（9 个）**：之前只识别
  `error` 一个，"重试失败"按钮严重失真；改用新 helper
  `isFailedToRetry()` 涵盖 error / no_link / no_promo /
  verify_error / paypal_captcha / login_fail / token_expired /
  aborted / no_jp_proxy 共 9 个未拿到 Plus 但非死号的终态。
- **#2 statusFilter 下拉动态生成**：从硬编码 11 项 → v-for
  `EXECUTE_STATUS_FILTER_OPTIONS`（status.js LABEL_MAP 全集除
  checking / canceled），下拉自动与状态体系同步。
- **#3 子表加 `原因` 列 + expand-row 顶部 banner**：reason 上列
  高频可见；代理节点 + 出口 IP + updatedAt 放 banner 低频查阅。
  后端 account_status 加 proxy_node / exit_ip 两列 + engine
  emitStatus 时从 proxyMgr 注入。
- **#4 toolbar 显示 engine mode badge**：协议模式 / 浏览器模式 +
  link: API / Discord，从 /config/raw 读 protocolMode 和
  paymentLinkSource。
- **#5 5s polling /execute/status 兜底 Stop 按钮**：socket 仍是
  fast path，polling 仅作为冗余；visibilitychange 暂停节省请求。
  断 socket 后仍可成功 Stop 引擎。

**Accounts 页（3 项）：**

- **#6 toolbar 拆 4 行**：16+ 控件由单行挤拥改成 by 职责分组
  （数据管理 / 筛选 / 测活 / 下载）；aliveFilter 从下载按钮右
  边移回筛选行；statusFilter 改用 EXECUTE_STATUS_FILTER_OPTIONS。
- **#7 TOTP / Refresh Token / Client ID 列加 tooltip + 复制**：
  el-tooltip 显示完整值；DocumentCopy icon 调 navigator.clipboard
  复制并 ElMessage 反馈。
- **#8 测活全部加 ElMessageBox 二次确认**：显示账户数量警告，避
  免误点对几千账户的库一键发起测活打爆 API/proxy。

**Config 页（2 项）：**

- **#9 整页用 7 个 el-tabs 重构**：支付 / 执行 / Discord / OAuth /
  代理 / JP / 节点黑名单。原 482 行平铺由 tab 切换替代滚动查找；
  保存按钮仍是全局一个（所有 tab 字段同时保存）。
- **#10 停止代理加 ElMessageBox 二次确认**：警告将断开当前所有
  execute / liveness 流水线的网络。

**后端配套：**

- `account_status` 表加 `proxy_node` / `exit_ip` 两列；CREATE
  TABLE 块同步 + 老库 PRAGMA-gated ALTER 防御性迁移（幂等不抛错）。
- `statusDB.set` 沿用既有 'in incoming' 显式判断 merge-aware
  pattern（与 paymentLink / accessToken 同），中间态 emitStatus
  不会清空已写入的代理上下文；`statusDB.setAlive` 也同步保留
  proxy_node / exit_ip 防 INSERT OR REPLACE 清空。
- `server/engine.js` + `protocol-engine.js` emitStatus 时从
  `proxyMgr.getState()` 读 currentNode + exitIp 注入 data。
- `/api/results` 透传 proxyNode / exitIp camelCase 字段。

**单测**：6 个新增 — `db-status-proxy-cols.test.js` +6
（M1-M3 sql.js schema 行为 + M4-M6 production code 不变式
回归屏障）+ `status-groups.test.js` 追加 G11/G12 +
`status-filter-options.test.js` 新建 S1。无回归。

**Spec / Plan**：
`docs/superpowers/specs/2026-05-25-v2.28-ops-ux-fixes-design.md` +
`docs/superpowers/plans/2026-05-25-v2.28-ops-ux-fixes.md`。

## v2.32.2 — 2026-05-25

### Hotfix: Execute.vue 计划列推导漏改

v2.32.1 把 3 个新 status 码加进了 `ERROR_STATUSES`，Accounts.vue
的计划列正常显示 free。但 Execute.vue 自己有两处 `_plan` 推导
**没有用 ERROR_STATUSES**，而是硬编码 `['error', 'no_link']`：

- 第 190 行（socket 实时 update）：`if (['error', 'no_link'].includes(data.status)) row._plan = 'free'`
- 第 245 行（load 时 hydrate）：`row._plan = PLUS_STATUSES.includes(st) ? 'plus' : (['error', 'no_link'].includes(st) ? 'free' : '')`

结果 Execute.vue 计划列在 `token_expired` / `canceled` / `login_fail`
/ `deactivated` / `no_promo` 这些 ERROR_STATUSES 状态下都显示 `-`
而非 free。

修复：两处硬编码改为 `ERROR_STATUSES.includes(...)`，并在
import 中加入 `ERROR_STATUSES`。前端 rebuild。

## v2.32.1 — 2026-05-25

### Hotfix: 3 个新 status 码加入 ERROR_STATUSES

v2.32.0 引入的 3 个 status 码 (`canceled` / `token_expired` /
`login_fail`) 当时只加进了 TYPE_MAP / LABEL_MAP / GROUP_ORDER，
**漏加 ERROR_STATUSES**。导致 Accounts.vue:291 的 `_plan` 推导：

```js
PLUS_STATUSES.includes(st) ? 'plus' : (ERROR_STATUSES.includes(st) ? 'free' : '')
```

3 个新 status 既不在 PLUS_STATUSES 也不在 ERROR_STATUSES → `_plan=''`
→ Accounts 页「计划」列显示 `-`（看起来"没数据"）。

修复：`web/src/status.js:ERROR_STATUSES` 追加 3 个值。这 3 个全
归 free（账户层面失败 → Plus 信息已不可信）。前端 rebuild。

## v2.32.0 — 2026-05-25

### 测活终态同步到 status 字段 + 3 个新 status 码

之前 alive_status 和 status 完全解耦：Execute.vue 只看 status，
测活只写 alive_status —— 跑完测活 Execute 页看到的还是上次执行
流水线写的旧值。

**后端 — runner.js dispatchOne 末尾按映射表同步**

| alive_status | → status |
|---|---|
| `plus` | `plus` |
| `deactivated` | `deactivated` |
| `canceled` | `canceled` (新) |
| `token_expired` | `token_expired` (新) |
| `login_fail` | `login_fail` (新) |
| `network_error` / `proxy_error` / `checking` / `unknown` | 不同步 |

例外：`alive=plus` 且 `persisted.status=plus_no_rt` 时保留 plus_no_rt
（plus_no_rt 比 plus 信息更丰富，alive=plus 验证不到 RT 状态，不
降级覆盖）。同步时同时 `io.emit('account-status', ...)` 推送，
Execute.vue 通过既有 socket 路径实时更新 `row._status`。

**前端 — 3 个新 status 码 + 筛选下拉补齐**

- `web/src/status.js`: TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3
- Execute.vue / Accounts.vue / Results.vue 状态筛选下拉 +3 option
  - Results.vue 顺便补 deactivated（之前漏掉）

样式：canceled / token_expired = warning；login_fail = danger。
Labels：已取消 / Token失效 / 登录失败。

**测试**：188 tests pass — runner +4（plus 同步 / deactivated 覆盖 /
network_error 不同步 / plus 不降级 plus_no_rt）on v2.31.1 baseline 184.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-status-sync-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-status-sync.md`。

## v2.27.0 — 2026-05-25

### Execute Page Status-Grouped Account List

Execute 页账户列表由单表平铺改为按 `_status` 分组成 `el-collapse` 折叠面板。默认展开 Plus(有RT) + Plus(无RT) 两组，其余折叠 —— 运维一眼能看到"成功资产"，错误账号按需展开排查。

**核心改动：**

- **`groupAccountsByStatus` 纯函数** 加到 `web/src/status.js`：按 `_status` 分桶 + 按固定业务序 `GROUP_ORDER`（12 个状态）排序 + 隐藏空组。`DEFAULT_EXPANDED_STATUSES = ['plus', 'plus_no_rt']` 同 status.js 导出。
- **`AccountTableRows.vue` 子组件**：从 Execute.vue 抽出 el-table 列定义 + 展开日志行模板（~142 行）。Props 含 `rows / running / globalSelectedSet / getHistoryLogs / getRealtimeLogs`。Emits `group-selection-change / expand-change / row-action / auth-download / row-click`。Exposes `clearSelection / toggleRowExpansion`。
- **`Execute.vue` 改造**：`<el-collapse v-model="expandedKeys">` v-for `<AccountTableRows>`；selection 由 `selection.js` 全局 Set 跨组聚合；`autoExpand` 跨子组件接线（先 push `'running'` 进 expandedKeys，nextTick 后调对应子组件 `toggleRowExpansion`）。
- **`statusFilter` 与分组协同**：选某状态 → watch only-add 进 expandedKeys → 该组自动展开；空组隐藏后效果等同于"只看那一组"。

**关键不变式**：`selection.js` 仍是单一来源 —— 子组件 `watch(() => props.rows) + { flush: 'post' }` 在 rows 变化（如跨组迁移）时用 `globalSelectedSet` 回填选中标记。替代了原 `restoreSelection()` 函数。

**单测**：`__tests__/status-groups.test.js` +10（G1-G10：空输入 / 业务序 / 空组过滤 / 同状态聚合 / 缺失 _status / 未知状态 fallback / label-type 派生 / DEFAULT_EXPANDED 常量 / 非数组守卫 / 多个未知 status 插入序）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-status-groups-design.md` + `docs/superpowers/plans/2026-05-25-execute-status-groups.md`。

## v2.31.1 — 2026-05-25

### Hotfix: 测活投票粒度细化 + 自动 rotate

v2.31.0 投票"每个账户末尾 1 票"过粗：1 个账户 3 次 net_error 只
贡献 1 个 failCount，需要 3 个账户都净失败才拉黑节点；且
recordBadAttempt 拉黑后 currentNode 不变，后续账户继续踩坑。

**修复 1 — Proxy auto-rotate**

- `server/proxy/index.js:recordBadAttempt` 在 `next >= FAIL_THRESHOLD`
  时 fire-and-forget `Promise.resolve().then(() => rotate())`
  （jp 通道走 `rotateJp`），让 `currentNode` 立即切到非黑名单节点
- 新增 `__setAutoRotateForTest(mainFn, jpFn)` 注入钩子；传 `null` 恢复默认
- 现有 engine.js / chatgpt-checkout.js 调用方零改动也享受自动 rotate

**修复 2 — Liveness 逐 attempt vote**

- `server/liveness/runner.js:dispatchOne` retry loop 每次 net_error attempt
  立即 `recordBadAttempt(currentNode, 'main', 'liveness_net_error_a<N>')`
- 同账户 3 次连环 net_error 即累加到 FAIL_THRESHOLD=3 拉黑当前节点
- `blacklisted=true` 时显式 `await pm.rotate?.()` —— 双保险，确保
  attempt N+1 看到新 currentNode
- v2.31.0 末尾 vote 块从 bad+good 砍剩 good（bad 已搬进 retry loop）

**测试**：184 tests pass — proxy +2（B5 main / B6 jp 通道阈值触发 rotate）
+ runner +1 替换（3 次 bad call 替原 1 次）+ runner +1 新增
（mid-retry rotate 顺序断言）on v2.31.0 baseline 181.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-blacklist-vote-granularity-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-blacklist-vote-granularity.md`。

## v2.31.0 — 2026-05-24

### Liveness Proxy Blacklist Integration + Accounts Page Download UI

**Part A — 测活集成 proxy 黑名单**

- `server/liveness/runner.js` 在 `dispatchOne` 末尾终态投票：
  - `alive_status ∈ {network_error, proxy_error}` → `proxyMgr.recordBadAttempt(currentNode, 'main', 'liveness_<status>')`
  - `alive_status ∈ {plus, canceled, token_expired, login_fail, deactivated}` → `proxyMgr.recordGoodAttempt(currentNode, 'main')`
- 依赖 v2.30 的 3-attempt retry —— 走到终态的 network_error 是节点持续不通、不是偶发抖动
- `createRunner` 接受可选 `proxyMgr` 注入用于测试 mock；production 走 lazy require
- proxy 未启用时跳过投票（gate `getState().enabled`）
- reason 字符串 `liveness_<status>` 与流水线的 `login_net_error` / `payment_unreachable` 区分，便于排查黑名单来源

**Part B — Accounts 页下载 UI**

- toolbar 在"测活全部"右侧加两个 dropdown：
  - **下载选中 (N)** — POST `/api/results/download-selected` 流式 ZIP
  - **下载全部 (ZIP)** — GET `/api/results/download-all`
  - 每个 dropdown 含 `CPA 格式` / `Sub2API 格式` 命令
- 操作列宽 140 → 240，编辑/删除前加 **CPA** / **Sub** 文字按钮，`_hasAuth=false` 时 disabled
- 三个 helper 函数 (`downloadAuth` / `downloadAllAs` / `downloadSelectedAs`) 跟 Execute.vue 套路一致
- 后端 endpoint 全沿用 v2.29.1 / 早期既有，零后端改动

**测试**：171 tests pass — runner +3 测试（network_error vote bad / plus vote good / proxy disabled skip）on 168 baseline.

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-blacklist-and-accounts-download-design.md` + `docs/superpowers/plans/2026-05-24-liveness-blacklist-and-accounts-download.md`。

## v2.30.0 — 2026-05-24

### Liveness Log Partition + network_error Auto-Retry

**Part A — UI 日志面板拆分**

- 单一 `<el-collapse>` 拆成两个：
  - **旧日志** (默认折叠) — 来自 DB 的最近 200 条历史，跨页面刷新保留
  - **实时日志** (默认展开) — 本次会话 socket 推送的 500 条，自动滚动到底部
- `socketState.logs` 每条 entry 加 `isHistorical: boolean` 字段。`loadLivenessLogs` (onMounted) 设 true；`pushLivenessLog` (socket realtime) 默认 false。
- `watch(newLogs.length)` + `nextTick` + `scrollTop = scrollHeight` 实现自动滚动。无手动滚动暂停检测——KISS。

**Part B — network_error 自动重试**

- `runner.dispatchOne` 重构：抽 `dispatchOnceInner(email, account, onLog, signal)` 单次尝试，外层 3-attempt 循环每次间隔 2s。
- 重试触发：`alive_status === 'network_error'`（含 HTTP 429/5xx / probe timeout / curl exception / spawn ENOENT / stdout 不可解析 / unexpected）。
- 重试进度通过 `onLog('warning', ...)` 流到 UI 面板和 DB（`network_error: ... — retrying 1/3 in 2s`）。
- `abortableSleep` 让 `await sleep()` 在 `abortCtrl.signal` abort 时立刻 resolve，"停止测活" 秒级响应。
- Worst case 耗时：3 × 12s probe + 2 × 2s delay = **~40s/账号**（仅 network_error 触发；正常 plus 单次 1-3s 不受影响）。

**测试**：168 tests pass — runner +3 (3-attempt 重试 / 1-attempt 重试成功 / plus 不重试) on 165 baseline。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-log-partition-and-retry-design.md` + `docs/superpowers/plans/2026-05-24-liveness-log-partition-and-retry.md`。

## v2.29.0 — 2026-05-24

### Liveness Deactivated Detection + Search UX Overhaul

**Part A — deactivated 检测**

- **Case 1 修复**：`mapPlanType('deactivated')` 直接返 `alive_status='deactivated', reason='account_deactivated'`。v2.28 hotfix `3b64727` 已经让 Python 端在 HTTP 200 + `is_deactivated=true` 时报 `plan_type='deactivated'`，但 Node 端 mapPlanType 误归 `canceled` —— 本次打通。
- **Case 2 新增**：新建 `chatgpt_register/deactivated_check.py`，跑 `protocol_register.py` 的 Step 0-2（homepage / signin / authorize），扫描响应体里的 `account_deactivated` / `account_disabled` 标记。无 OTP，5-10s/账号。`server/liveness/checker.js` 新 `verifyDeactivated` 包装 spawn；`runner.dispatchOne` 在 probe 返 `token_expired` 后调它。
- **实时日志**：v2.26 spec §6.2 定义了 `liveness-log` 事件名但 runner 当时没真发。本次正式实现：runner 注入 `onLog(level, message)` 闭包 → `io.emit('liveness-log', {email, level, message})` → 前端 `socket.on('liveness-log')` → `pushLivenessLog`。`pushLivenessLog` 加 `source:'liveness'` 字段，`Accounts.vue` 的 `livenessLogs` computed 改用该字段过滤（不再靠 message 前缀字符串）。

**Part B — Accounts 页搜索 UX**

- 状态、活性筛选改 `<el-select multiple collapse-tags>`，可同时选多项；filter 用 `Array.includes(a._status)`。
- 搜索框 placeholder 改 `搜索 (邮箱/RT/Client ID/TOTP/密码)`，匹配五个字段的 haystack join。
- toolbar 新增 3 个按钮：
  - `仅看未测试` 一键设 `aliveFilter=['unknown']`
  - `7天未测` 切换 `staleOnly`，按 `alive_checked_at` 时间过滤
  - `重置筛选` 一键清 6 个 filter 维度（含 staleOnly），任意 filter 激活时才可用

**测试**：159 tests pass —— 16 checker（+2 deactivated 映射）+ 6 verify-deactivated（新）+ 10 runner（+2 verifyDeactivated 集成）+ 既有 125 unchanged。Python `deactivated_check.py` 沿用 stripe_init.py 模式不写单测，集成 smoke 验证。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-deactivated-detection-and-search-ux-design.md` + `docs/superpowers/plans/2026-05-24-deactivated-detection-and-search-ux.md`。

## v2.28.0 — 2026-05-24

### Liveness Probe Cloudflare Bypass + 日志面板

v2.26 测活在 2026-05-24 实测中发现 **100% 失败**：Node `globalThis.fetch` 调 `/accounts/check` 被 Cloudflare 的 TLS 指纹检测一律拦截返 403，即便走 :7890 主代理也无法绕过（验证 commit `7b65000` 的 `HttpsProxyAgent + https.request` 路径仍中招）。同时用户反馈"测活看不到日志"。

**核心改动：**

- **Python curl_cffi probe**：新建 `chatgpt_register/liveness_probe.py`，套路对照 `stripe_init.py` / `protocol_register.py` / `checkout_link.py`，spawn 出来用 `impersonate='chrome131'` 模拟真实浏览器 TLS 指纹过 Cloudflare。
- **`server/liveness/checker.js` 重构**：删 v2.26 的 `globalThis.fetch` 和 `7b65000` 的 `_requestViaProxy`；改 `spawn('py', ['-3', 'liveness_probe.py'])`，套路对照 `server/stripe-verify.js`。`decodeJwtExp` / `mapPlanType` / `extractPlanType` 保留导出。
- **Cloudflare 403 区分账号 403**：Python 端扫返回体里的 `__cf_chl` / `cf-mitigated` / `Cloudflare` 标记。Cloudflare → `alive_status='proxy_error'`（网络层、提示切节点）；账号 → `alive_status='login_fail'`（账号问题）。
- **测试改造**：11 → 14 测试。5 个纯 helper unit 保留；9 个 probe 测试从 `fetchImpl` 注入改成 `spawnImpl` 注入（fakeChild EventEmitter）；新增包括 spawn ENOENT、stdout unparsable、cloudflare-vs-account 403 discriminator。
- **Accounts 页底部折叠日志面板**：表格下方加 `<el-collapse>`，订阅 `socketState.logs` 过滤 `[liveness]` 前缀。测活启动时自动展开、结束后保留展开供回看。`socket.js` 3 个 liveness handler 各加一条 push（liveness-progress 不打日志避免 flood）。

**预期效果：** 测活通过率从 0% 回到 ~100%（JWT 未过期 + 账号是 Plus 的真实账号），用户能实时看到逐账号 `[liveness] checking → plus: check ok` 日志流。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-liveness-python-probe-design.md` + `docs/superpowers/plans/2026-05-24-liveness-python-probe.md`。

**测试**：149 个测试通过。

## v2.27.0 — 2026-05-24

### Skip Phase 1 on Access-Token Cache Hit

Building on v2.25's payment-link cache (Phase 2 + 2.5 skip), this release also persists the protocol-login `accessToken + session JSON` to `account_status`. On retry of a failed account, if the JWT exp is still in the future (with 60s buffer), `result` is reconstituted from the DB and the entire Phase 1 login is skipped — saving the 30-60s OTP+auth0 round-trip on top of v2.25's 8-25s savings.

**核心改动：**

- **DB schema**：`account_status` 加 3 列 `last_access_token / last_session_json / last_access_token_at`，PRAGMA-gated ALTER 防御性迁移存量库。
- **statusDB.set 扩展 merge**：camelCase 入参 `accessToken / sessionJson`；未传时保留 DB 现值（同 v2.25 paymentLink 套路）；新 helper `clearAccessToken` 用于支付成功后清除。
- **双引擎同步**：`protocol-engine.js` 和 `server/engine.js` 都在 `dispatchOne` 入口加 cached-login 分支，紧跟 v2.26.1 引入的 `prevPersisted` snapshot。
- **JWT exp 校验**：复用 v2.26 `server/liveness/checker.js` 导出的 `decodeJwtExp` 工具——单一来源、不重复实现。
- **失败兜底**：cached token 还有效但 OpenAI 已 revoke（改密等）→ Phase 3 page.goto(link) 仍 OK（link 自带 stripe session）；Phase 5 PKCE 重登失败 → plus_no_rt 兜底，下次测活会标 token_expired。

**预期收益：** cache + token 都命中的重试场景，账号耗时从 68-145s 缩到 30-60s（节省 **40-90s/账号**）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-skip-login-on-cache-hit-design.md` + `docs/superpowers/plans/2026-05-24-skip-login-on-cache-hit.md`。

**测试**：`__tests__/db-access-token.test.js` 5 个新单元 + 集成 smoke。146 测试通过。

## v2.26.0 — 2026-05-24

### Account Liveness Check (Phase A — Browser Mode)

Accounts 页加 "测活选中 / 测活全部" 顶部按钮，对账号批量调 `/backend-api/accounts/check` 判 Plus 订阅是否还在 + access_token 是否还能用。本地 JWT 过期或返 401 时自动密码 + OTP 重登拿 `/api/auth/session` 的 access_token、手工拼装 `cpa-auth/codex-{email}.json`，**不走** PKCE。

**核心改动：**

- **DB schema**：`account_status` 加 3 列 `alive_status / alive_checked_at / alive_reason`，PRAGMA-gated ALTER 防御性迁移存量库。新 `statusDB.setAlive` / `clearAlive` 与 `statusDB.set` 同样的 merge-aware 不变式 — 测活写入绝不污染 `status` / `payment_link*` 列。
- **独立模块** `server/liveness/`：4 个核心模块（`checker.js` / `light-login.js` / `codex-file.js` / `runner.js`）+ `server/routes/liveness.js`。runner 3 并发 + 1s 节流，跟 `PipelineEngine` / `ProtocolEngine` 完全解耦、与主流水线可并行。
- **Lazy hybrid 流程**：先用现存 access_token 调 `/backend-api/accounts/check`；2xx 直接判 plan_type；返 401 或本地 JWT 过期才走 `lightLogin` 重登拿新 token、覆写 codex-{email}.json、再调 check。
- **8 种 alive_status**：`plus / canceled / login_fail / token_expired / proxy_error / network_error / unknown / checking`，与执行流水线 status 完全独立的维度。
- **UI**：Accounts.vue 顶部 toolbar + 活性 / 上次测活 列 + 活性筛选下拉。Socket.IO 三事件 `liveness-status / liveness-progress / liveness-complete` 通过 `socketState` 推送，watch 桥接到每行 `_aliveStatus / _aliveReason / _aliveCheckedAt`。
- **不动 sub2api**：与 `utils.saveCPAAuthFile` 不同，`server/liveness/codex-file.js` **只** 写 `cpa-auth/codex-{email}.json`，sub2api 文件由 sub2api 服务自己处理。grep 验证：`server/liveness/*.js` 源码零提及 sub2api。

**端到端验证：**

- **141 个 tests passing**（既有 96 + 6 payment-link + 5 db-alive + 11 checker + 7 codex-file + 9 light-login + 8 runner + 5 routes-liveness = 141；超 spec §9.1 写的 35 因 mapPlanType / sanitize / protocolMode 等子单元拆开单测）。
- **关键不变式 verified**：`server/liveness/codex-file.js` 源码 0 处 `sub2api` write；db `setAlive` 不污染 `status` / `payment_link*` 通过 db-alive.test.js 第 3 例锁。
- **Spec / Plan**：`docs/superpowers/specs/2026-05-24-account-liveness-check-design.md` + `docs/superpowers/plans/2026-05-24-account-liveness-check.md`。

**Phase B 待办：**

协议模式 light-login（`config.protocolMode=true` 时的密码+OTP 重登）—— 现在协议模式只能 check 未过期 token，需重登的账号标 `alive_status='login_fail', reason='liveness not yet supported in protocol mode'`。后续单独立 spec 处理 `chatgpt_register/liveness_login.py` 实现。

## v2.21.0 — 2026-05-24

### Main Proxy Node Whitelist

主代理通道之前只有 `regionFilter` 关键字筛选（默认 `'US'`，走大型正则）。用户想精确指定几个节点只能祈祷它们 tag 共享同一关键字。复刻 JP-Checkout 通道（v2.18.1）的成熟白名单模式，主通道获得对称能力。

**核心改动：**

- **新字段** `cfg.proxy.whitelist: string[]` —— 精确 tag 列表。
- **新决策函数** `pickMainNodes(all, mainCfg)` —— 与 `pickJpNodes` 同构：whitelist 非空时精确匹配（`filterByWhitelist`），空时回退 `regionFilter` 关键字（`filterByRegion`），**双空** 时（regionFilter 为空字符串/未设）返回全部节点。
- **`refresh()` 集成** —— 主通道筛选块改用 `pickMainNodes`，按 `usedWhitelist` 分流日志格式；全不命中订阅时 throw 不静默退化（与 JP 同）。
- **`regionFilter` 默认 `'US'` 仅当字段缺失**：显式空字符串现在被识别为"不过滤"，统一规则用 `??` 替原 `||`。
- **`GET /api/proxy/nodes` 加 `usTags`** —— UI 主白名单下拉据此高亮匹配 regionFilter 的节点。
- **Config.vue 节点白名单分节** —— `el-select multiple filterable` + US 节点绿色加粗 + 'US' 标签；区域过滤输入框在白名单非空时灰显 + "已被白名单覆盖" 提示；代理状态卡加 whitelist 计数 + misses 黄色行。

**对外契约扩展（无破坏）**：`getState()` 返回多两个字段 `whitelist` / `whitelistMisses`（与 `_state.jp.whitelist` 同语义）。Config.vue 是唯一消费者，新增渲染逻辑兼容旧响应（undefined 时不渲染）。

**单测**：`server/proxy/__tests__/index.test.js` +7（W1-W7：5 个仿 pickJpNodes 同号 + W6 双空边界 + W7 字段缺失边界）。proxy 套件总 46→53 用例，无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-main-proxy-whitelist-design.md` + `docs/superpowers/plans/2026-05-24-main-proxy-whitelist.md`。

## v2.20.0 — 2026-05-24

### Proxy Blacklist Threshold + Rotation Cursor Persistence

之前的代理黑名单是"一次失败立即拉黑 30 min"，对网络偶发抖动过于敏感；运维也没有 UI 入口移除误拉黑的节点；`refresh()` 每次都把 `rotationIndex` 重置为 0，导致顺序轮换模式下头部节点反复使用、尾部节点长期闲置。

**核心改动：**

- **连续 3 次失败计数**（中间任一次成功立刻清零）：新函数 `recordBadAttempt(tag, channel, reason)` / `recordGoodAttempt(tag, channel)`，旧 `markBad` / `markJpBad` 保留作 alias 向后兼容。
- **黑名单跨重启持久化**：新表 `proxy_blacklist (tag, channel, expires_at, reason, source)`，新模块 `server/proxy/blacklist.js` 封装 CRUD；首次 `refresh()` 时 hydrate 回内存 Map；TTL 30 min 行为保持。计数器仍在内存。
- **`refresh()` 不重置游标**：仅在节点列表变短时取模到合法范围，`currentNode` 跟随 `rotationIndex` 而非固定 `filtered[0]`。
- **4 个新 REST endpoint**：`GET /api/proxy/blacklist` / `POST /add` / `POST /remove` / `POST /clear`。
- **Config.vue 节点黑名单分节**：主代理 + JP 各一个 `el-table`（节点 / 剩余 TTL / 来源 / 原因 / 移除按钮 + 清空），10s 轮询。
- **触发点扩充**：除现有 3 个点（TLS / payment unreachable / JP checkout 空 link）外，新增 Stripe verify timeout / 协议模式网络类 catch / 浏览器模式 login 网络类 reason 三个。`isProxyNetError` 共享网络错误关键字识别。

**对外契约变化**：`getState().badNodes` 从 `{tag: expiryMs}` 升级为 `{tag: {expiresAt, reason, source}}`。Config.vue 不再读这个字段（专门走 `/api/proxy/blacklist`），无回归。

**单测**：`server/proxy/__tests__/index.test.js` +12（U1-U10 + 2 个 review 修复用例）、`rotation.test.js` 新建 +5 (R1-R5)、`blacklist.test.js` 新建 +6 (B1-B4 + 边界)、`server/__tests__/proxy-route-blacklist.test.js` 新建 +4。共新增 27 用例，60+ 总测试无回归。

**Spec / Plan**：`docs/superpowers/specs/2026-05-24-proxy-blacklist-and-rotation-cursor-design.md` + `docs/superpowers/plans/2026-05-24-proxy-blacklist-and-rotation-cursor.md`。

## v2.19.1 — 2026-05-23

### payment.js rolled back to v2.14.0 baseline

实测验证 v2.19 Phase 2.5 链路全程正常（osxti6295 端到端 `redirect_status=succeeded`），但 v2.14 之后的 6 个 payment.js perf/fix 累积导致 PayPal checkout 12 字段在当前 PayPal DOM 下全部 MISSED。先回退 payment.js 到 v2.14.0 最后已知能用的状态，未来如需重新引入这些 perf，按 commit 单独 cherry-pick + 充分验证。

回退的提交：
- `def0d11` fix(payment): restore 'unable to add this card' regex
- `5e28006` perf(payment): race post-submit outcome
- `f695f84` perf(payment): waitForURL replaces polling loops
- `e9e03e0` perf(payment): replace randomDelays with selector waits
- `ef4d1a9` perf(payment): parallelize PayPal field fills（提前已 revert 为 29f97aa）
- `4201276` perf(payment): cache fetchAddress

端到端实测（v2.19 + v2.14 payment.js）：

- ✅ `gexi4056685` → status=`no_promo`（Phase 2.5 拦截 \$20，不浪费 payment.js）
- ✅ `osxti6295` → status=`plus_no_rt`（全流程通过：\$0 → 12 字段 Filled → SMS 307251 → `redirect_status=succeeded`）
- ⚠ `hprfvxml12008` → status=`error`/PayPal `genericError`（PayPal 服务端在 SMS 提交后拒；非代码问题，单账号风控）

## v2.19.0 — 2026-05-23

### Reliable JP-First Checkout

实测推翻了 v2.18.2 阶段的"节点 IP 无关"误判（当时独立测试脚本里 proxyMgr 未初始化导致请求走直连，掩盖了 JP IP 的关键作用）。强制 JP 节点后实测，hprfvxml12008 / ovjvant465198 / osxti6295 等账号能稳定拿到 $0；同时确认 bot 的 Eligibility Check 真实有效——gexi4056685 / qnke4812473 等被 bot 标"无资格"的账号即使强制 JP 仍只拿 $20。

**核心改动**：

- **强制 JP**：`server/chatgpt-checkout.js` 移除 `jpUrl || mainUrl` 静默回退。JP 节点池不可用时立即 resolve `{noJpProxy:true}`，不启动 Python 子进程。
- **Stripe init 验证**：新增 `server/stripe-verify.js` + `stripe_init.py`，从 cs_live URL 提取 cs_id，经 main proxy (7890 US) 调 Stripe `/v1/payment_pages/{cs}/init`，解析 `invoice.amount_due` 判断是否真 $0。
- **Phase 2.5 分支**：`server/engine.js` 在 Phase 2 (checkout) 与 Phase 3 (payment.js) 之间插入验证阶段，按结果分流 3 个新状态。
- **`pk` 字段链路**：`checkout_link.py` 把 OpenAI 响应里的 `publishable_key` 作为 `pk` 输出；`fetchCheckoutLink` 在 result shape 中携带 `pk`；engine.js 将 `discord.pk` 传给 `verifyCheckoutIsFree(link, pk)`。Discord linkSource 路径 (`paymentLinkSource: 'discord'`) 跳过 Phase 2.5 验证（信任 bot 的资格判定）。
- **spawn error handling**：`chatgpt-checkout.js` 和 `stripe-verify.js` 都加了 `py.on('error', ...)` 处理 Python 二进制缺失/权限拒绝等本地故障，避免挂到 timeout。

**新增 status 状态**：

| status | 触发 | 文案 | 可重试 |
|---|---|---|---|
| `no_jp_proxy` | JP 节点池不可用 | JP 节点不可用 | ✅ JP 恢复后 |
| `no_promo` | invoice.amount_due > 0 | 无 0 元资格 | ❌ 账号资格问题 |
| `verify_error` | Stripe init 调用失败 | Stripe 验证失败 | ✅ Stripe 恢复后 |

**单测**：`server/__tests__/stripe-verify.test.js` (9 cases) + `server/__tests__/chatgpt-checkout.test.js` (2 cases) 覆盖 pure helpers 与早返回；既有 proxy 测试 (20 cases) 无回归。

**Web Dashboard**：`web/src/status.js` 加 3 个 type/label 映射；`web/src/views/Dashboard.vue` 加 3 个 KPI 卡片；`web/src/views/Accounts.vue` / `Execute.vue` / `Results.vue` 的状态筛选下拉各加 3 个 option。

**对照 v2.18**：
- v2.18.0: JP-KDDI 双入口
- v2.18.1: jpCheckout 白名单
- v2.18.2: `country=US, currency=USD` 1 行改动（解锁 PayPal + USD 计价）
- **v2.19.0**: fail-fast 与 $0 验证（本次）

**E2E 验证清单**（待运维实际跑，非合并阻塞）：
- [ ] hprfvxml12008 → 应当 status=plus（Phase 2.5 ✓ 通过，Phase 3 完整跑通）
- [ ] gexi4056685 → 应当 status=no_promo（Phase 2.5 拦截 $20 link）
- [ ] 临时 disable jpCheckout → 应当 status=no_jp_proxy（不启动 Python）

## v2.18.1 — 2026-05-23

### Added
- `config.proxy.jpCheckout.whitelist: string[]` —— 精确指定 JP-Checkout 通道使用的节点 tag 数组。非空时优先，空时回退到 v2.18.0 的 `keyword` 过滤行为（向后兼容）。
- `GET /api/proxy/nodes` —— 返回订阅当前全部节点 tag + KDDI 子集，供 UI 下拉选项使用。
- `server/proxy/subscription.js` 新增 `filterByWhitelist(outbounds, whitelist)` —— 用 Set 精确匹配 tag，自动去重 + 剔除非字符串项。
- `server/proxy/index.js` 新增 `pickJpNodes(all, jpCfg)` —— 纯函数承载“whitelist > keyword”决策；导出供单测使用。
- `_state.jp.whitelist` / `_state.jp.whitelistMisses` —— 跟踪用户配置的白名单与订阅中缺失的 tag。
- `_state.allTags` —— refresh 时缓存全部节点 tag，供 `/nodes` 接口快速返回。
- `Config.vue` 加 `JP 节点白名单` 下拉多选 (el-select multiple filterable)：含全部节点 + 搜索框，KDDI 节点绿色加粗高亮 + 右侧 “KDDI” 标签。
- `Config.vue` 状态卡新增 `whitelistMisses` 黄色提示行（白名单中订阅缺失的 tag）。

### Changed
- `refresh()` 改用 `pickJpNodes()` 做节点选择决策，原 `filterByJpKddi` 直接调用降为 `pickJpNodes` 内部回退分支。
- `Config.vue` `JP 节点关键字` 输入框在白名单非空时自动灰显 + 提示 “已被白名单覆盖”。

### Robustness
- 白名单含订阅没有的 tag → 静默跳过，`whitelistMisses` 记录，UI 黄色提示。
- 白名单**全部**不命中 → `jp.enabled=false`，`lastError` 含未匹配的 tag 列表（**不**静默回退到 keyword，避免反直觉行为）。
- 白名单非数组（字符串误填）→ `pickJpNodes` 类型守卫，视为空 → fallback keyword 分支。

### Tests
- 单元测试 20/20 通过：
  - `filterByJpKddi` × 5 (v2.18.0)
  - `filterByWhitelist` × 6 (新增)
  - `buildSingboxConfig` × 4 (v2.18.0)
  - `pickJpNodes` × 5 (新增)
- 集成验证后端 T8-T11 全过（白名单生效、部分命中、全不命中、清空回退）。
- `/api/proxy/nodes` 返回 147 节点、2 个 KDDI tags 验证通过。

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-jp-checkout-whitelist-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-jp-checkout-whitelist.md`

## v2.18.0 — 2026-05-23

### Added
- 新增 `JP-Checkout` 通道：sing-box 增加第二个 mixed inbound (`:7891`)，专用 `jp-checkout` selector 仅选 KDDI 节点。
- `server/proxy/subscription.js` 新增 `filterByJpKddi(outbounds, keyword='KDDI')`，按 tag 关键字（不区分大小写正则）过滤。
- `server/proxy/index.js` 扩展 `_state.jp` 子结构与 `getJpProxyUrl / getJpState / rotateJp / detectJpExit / markJpBad`。
- `/api/proxy/jp/{rotate,detect-exit,mark-bad}` 三个新端点。
- `Config.vue` 加 `JP-Checkout 通道` 分区：启用开关、关键字输入、只读状态卡片（节点数、当前节点、出口 IP、错误）+ 检测/切换按钮。
- 配置 schema 新增 `proxy.jpCheckout: { enabled, keyword, rotationStrategy }`（缺省值 `{ true, 'KDDI', 'sequential' }`，向后兼容）。

### Changed
- `server/chatgpt-checkout.js` 把 proxy 优先级改为 `getJpProxyUrl() || getProxyUrl()`；JP 通道未启用时 raw 字段附 `WARN: jp_channel_disabled`。
- `buildSingboxConfig(us, jp)` 改为接收双池参数；`jp` 为空数组/null 时 `route.rules` 退回单入口形态。

### Fixed
- `server/proxy/singbox.js` 的 `start()` 现在在 spawn 后**主动探测每个 mixed inbound 端口**是否真的 LISTENING；进程死亡或端口未绑定时立即 throw（含 `address already in use` 关键字）。修复 v2.17.0 起就存在的"sing-box 实际已死但 server 仍报 enabled=true"问题。

### Robustness
- 订阅中无 KDDI 节点时**软失败**：主代理正常启动，`jp.enabled=false`，UI 显示提示。
- 7891 端口被占时**降级**：catch sing-box 启动错误后用无 jp 配置重启 sing-box；主代理不受影响。

### Tests
- 单元测试 9/9 通过：
  - `filterByJpKddi` × 5 cases（含正则元字符、空输入、自定义关键字）
  - `buildSingboxConfig` × 4 cases（单/双入口、route.rules 形态、direct/block 兜底）
- 集成验证 T1+T2+T5+T6 全过（双端口 listen、JP 出口 IP 为 KDDI 住宅段、软失败、端口冲突降级）

### Spec & Plan
- Spec: `docs/superpowers/specs/2026-05-23-checkout-via-jp-kddi-design.md`
- Plan: `docs/superpowers/plans/2026-05-23-checkout-via-jp-kddi.md`

### 关键验收待项
- **T3 ¥0 试用链接验证**：需要一个全新、未用过试用的 OpenAI 账号通过 checkout 拿链接，Chrome+CDP 渲染验证显示 `Free trial / ¥0 / Total due today: ¥0`。这是 v2.17.0 从未验证到的核心目标。
