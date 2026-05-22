# Changelog

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
