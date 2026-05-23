# Changelog

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
