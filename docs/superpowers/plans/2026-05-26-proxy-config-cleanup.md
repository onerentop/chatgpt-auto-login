# 代理配置清理 + 黑名单 UI 升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v2.42.0 后清理 `config.proxy.rotationStrategy` / `activeHealthCheck` 等已被 urltest 接管的废弃字段；Config 页代理 tab 删过时 UI；黑名单 tab 升级（reason / 解禁时间 / 批量 unban）。

**Architecture:** 后端先（server/proxy state 删 3 字段 + GET /blacklist 升级 + POST /clear-blacklist 新增），前端跟（Config.vue 代理 tab 简化 + 黑名单 tab 升级），最后测试 + 发布。

**Tech Stack:** Node `proxyDB.listBanned()` / `proxyMgr.unbanNode()` / Express router / Vue 3 Composition + Element Plus。

参考 spec：`docs/superpowers/specs/2026-05-26-proxy-config-cleanup-design.md`

---

## File Structure

**修改：**

- `server/proxy/index.js` — 删 _state.rotationStrategy / activeHealthCheck 等字段
- `server/routes/proxy.js` — GET /blacklist 升级返回结构 + POST /clear-blacklist 新增
- `web/src/views/Config.vue` — 代理 tab 简化 + 黑名单 tab 升级
- `web/src/composables/useConfirmDanger.js` — FAIL_THRESHOLD 引用清理（如有）
- `server/proxy/__tests__/*.test.js` — test mock 删除废字段
- `docs/CHANGELOG.md` — v2.42.1 章节

**不动：**

- `config.example.json`（早已不含废字段）
- v2.30 旧 status 字段（向后兼容）
- bad-node API / urltest / proxyDB schema
- Dashboard ProxyPanel

---

## Task 1: 后端清理 + API 升级

**Files:**
- Modify: `server/proxy/index.js`
- Modify: `server/routes/proxy.js`

- [ ] **Step 1: 删 server/proxy/index.js 废字段**

Read `server/proxy/index.js` 找到所有 `rotationStrategy` / `rotationIndex` / `rotationKeyword` / `activeHealthCheck` 出现的地方。删除：

- `_state.rotationStrategy` / `_state.jp.rotationStrategy` 字段初始化（约 line 60, 81）
- `_state.rotationIndex` 字段
- 读取 cfg.proxy.rotationStrategy / activeHealthCheck 的 if 块
- `getState()` 返回值里的 `rotationStrategy` / `rotationIndex` / `rotationKeyword` / `jp.rotationStrategy` 字段（约 line 179, 197）

保留：`whitelist` / `whitelistMisses` / `subscriptionUrl` 等字段 — 跟 rotation 无关。

- [ ] **Step 2: server/routes/proxy.js GET /blacklist 升级**

Read `server/routes/proxy.js` 找现有 GET /blacklist。改为：

```js
router.get('/blacklist', (req, res) => {
  try {
    const { proxyDB } = require('../db');
    const proxyMgr = require('../proxy');
    const rows = proxyDB.listBanned();  // [[node, reason, banned_until], ...]
    const jpState = proxyMgr.getState().jp || {};
    const jpNodes = jpState.nodes || jpState.whitelist || [];
    const jpNodeSet = new Set(jpNodes.map(n => typeof n === 'string' ? n : (n.tag || n.name || '')));
    const main = [], jp = [];
    for (const r of rows) {
      // proxyDB.listBanned 返回 sql.js 数组格式 [[node, reason, banned_until], ...]
      const [node, reason, bannedUntilMs] = Array.isArray(r) ? r : [r.node, r.reason, r.banned_until];
      const entry = {
        node,
        reason: reason || 'custom',
        bannedUntil: bannedUntilMs ? new Date(Number(bannedUntilMs)).toISOString() : null,
        addedAt: bannedUntilMs ? Number(bannedUntilMs) - 5 * 60_000 : null,  // 兼容旧 schema 用解禁前 5min 作 addedAt
      };
      if (jpNodeSet.has(node)) jp.push(entry);
      else main.push(entry);
    }
    res.json({ main, jp });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

**注意**：proxyDB.listBanned 返回结构看 v2.42 Task 9 实现（可能是 array of arrays `[[node, reason, banned_until]]` 因为 sql.js `db.exec` 返回 `[{values}]`）。代码用 `Array.isArray(r)` 判断兼容两种形式。

- [ ] **Step 3: POST /clear-blacklist 新增**

```js
router.post('/clear-blacklist', async (req, res) => {
  const { channel } = req.body || {};
  if (!['main', 'jp'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be main or jp' });
  }
  try {
    const { proxyDB } = require('../db');
    const proxyMgr = require('../proxy');
    const rows = proxyDB.listBanned();
    const jpState = proxyMgr.getState().jp || {};
    const jpNodes = jpState.nodes || jpState.whitelist || [];
    const jpNodeSet = new Set(jpNodes.map(n => typeof n === 'string' ? n : (n.tag || n.name || '')));
    const targets = rows
      .map(r => Array.isArray(r) ? r[0] : r.node)
      .filter(node => channel === 'jp' ? jpNodeSet.has(node) : !jpNodeSet.has(node));
    for (const node of targets) {
      try { proxyDB.unbanNode(node); } catch {}
      try { await proxyMgr.unbanNode(node); } catch {}
    }
    res.json({ ok: true, cleared: targets.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

- [ ] **Step 4: 跑 npm test 不 regress**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
npm test
```

Expected: 302 pass。如果 test mock 里有 `rotationStrategy` / `activeHealthCheck` 字段，更新 mock（一般在 `server/proxy/__tests__/rotation.test.js` / `health-probe.test.js`）。

- [ ] **Step 5: 实测 API**

```bash
# server 应该跑 v2.42.0 (b1abftpy2)
# 模拟 ban 一个节点
curl -s -X POST http://127.0.0.1:3000/api/proxy/bad-node -H "Content-Type: application/json" -d '{"reason":"cloudflare_403","channel":"main","durationMinutes":2}'

# 拉新 schema
curl -s http://127.0.0.1:3000/api/proxy/blacklist | python -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d,indent=2,ensure_ascii=False))"
```

Expected: `main` 数组里至少 1 项，含 `node` / `reason` / `bannedUntil` 字段。

```bash
# 批量清空
curl -s -X POST http://127.0.0.1:3000/api/proxy/clear-blacklist -H "Content-Type: application/json" -d '{"channel":"main"}'
# Expected: {"ok":true,"cleared":N}
```

- [ ] **Step 6: Commit**

```bash
git add server/proxy/index.js server/routes/proxy.js
git commit -m "refactor(proxy): 删 rotationStrategy/activeHealthCheck + GET /blacklist 升级 + POST /clear-blacklist (Task 1)

server/proxy/index.js 删:
- _state.rotationStrategy / _state.jp.rotationStrategy
- _state.rotationIndex / _state.rotationKeyword
- 读 cfg.proxy.rotationStrategy / activeHealthCheck 的 if 块
- getState() 返回的 rotationStrategy/rotationIndex/rotationKeyword 字段

server/routes/proxy.js:
- GET /blacklist 升级返回 {node, reason, bannedUntil, addedAt} schema (superset 向后兼容)
- POST /clear-blacklist 新增 (按 channel 批量 unban)

实测 bad-node ban → GET /blacklist 显示新字段 → clear-blacklist cleared OK。"
```

---

## Task 2: Config.vue 代理 tab 简化

**Files:**
- Modify: `web/src/views/Config.vue`（代理 tab 部分）

- [ ] **Step 1: 删 rotationStrategy 表单字段 + radio UI**

Read `web/src/views/Config.vue`，找到 `<el-radio-group v-model="form.proxyRotationStrategy">`（约 line 151）那个 form-item 整块删。

JS 端 `form` 对象删 `proxyRotationStrategy: 'sequential'`（约 line 356）。`save()` / `loadConfig()` 里读写它的代码也删。

- [ ] **Step 2: 删整个"代理状态"显示块**

`<el-form-item label="代理状态" v-if="proxyStatus">`（约 line 161-176）整块删。

`<el-form-item v-if="proxyStatus?.jp">` "JP 通道状态"块（约 line 208-224）整块删。

- [ ] **Step 3: 删 proxyStatus ref + loadProxyStatus 函数**

JS 端找：

```js
const proxyStatus = ref(null)
```

删除。

`loadProxyStatus()` 函数（应该在某处定义）整块删。`onMounted` 里调 `loadProxyStatus()` 的行删；`setInterval(loadProxyStatus, ...)` 周期定时器删；`onUnmounted` 里清 timer 的逻辑删。

- [ ] **Step 4: 加引导链接**

在代理 tab 顶部（启用代理 switch 上面）或者底部（应用/停止按钮下面）加：

```vue
<div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0">
  代理实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
</div>
```

- [ ] **Step 5: build web 验证**

```bash
cd web && npm run build && cd ..
```

Expected: build 成功，无 Vue compile error。

如果有 unused-import warning（删 ref 后），按 lint 提示清理。

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Config.vue web/dist
git commit -m "feat(web): Config 代理 tab 简化 (Task 2)

删除:
- proxyRotationStrategy radio UI + form 字段 (v2.42 urltest 自动选)
- 代理状态 / JP 通道状态 显示块 (重复 Dashboard ProxyPanel)
- proxyStatus ref + loadProxyStatus 函数 + onMounted/onUnmounted 周期

新增:
- 引导链接\"代理实时状态请到仪表盘查看\"

代理 tab 现在仅含:
- 启用代理 switch / 订阅 URL / 节点白名单 / 地区过滤
- JP 通道 enabled/keyword/whitelist
- 应用 / 停止代理 按钮"
```

---

## Task 3: Config.vue 黑名单 tab 升级

**Files:**
- Modify: `web/src/views/Config.vue`（黑名单 tab 部分）
- Modify: `web/src/composables/useConfirmDanger.js`（如有 FAIL_THRESHOLD 引用）

- [ ] **Step 1: 改说明文**

找到 `<el-tab-pane label="节点黑名单" name="blacklist">`（约 line 231）。改说明文：

```diff
- 共 {{ blacklist.main.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
+ 共 {{ blacklist.main.length }} 个节点 · 业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期
```

JP 同样改。

删 `FAIL_THRESHOLD` 引用（如果是常量 import）。

- [ ] **Step 2: 加 reason 列 + 解禁时间列 + 单个解禁按钮**

改 table 结构（main + jp 两个 table）：

```vue
<el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
  <el-table-column prop="node" label="节点" min-width="200" show-overflow-tooltip />
  <el-table-column prop="reason" label="原因" width="160">
    <template #default="{ row }">
      <el-tag :type="reasonTagType(row.reason)" size="small">{{ reasonLabel(row.reason) }}</el-tag>
    </template>
  </el-table-column>
  <el-table-column label="解禁时间" width="120">
    <template #default="{ row }">
      <span v-if="row.bannedUntil">{{ formatRemaining(row.bannedUntil) }}</span>
      <span v-else class="muted">已过期</span>
    </template>
  </el-table-column>
  <el-table-column label="操作" width="80">
    <template #default="{ row }">
      <el-button size="small" link type="primary" @click="unbanOne(row.node)">解禁</el-button>
    </template>
  </el-table-column>
</el-table>
```

JS 端加 helpers：

```js
function reasonTagType(reason) {
  if (reason === 'cloudflare_403') return 'danger';
  if (reason === 'rate_limited') return 'warning';
  if (reason === 'captcha') return 'danger';
  return 'info';
}
function reasonLabel(reason) {
  const map = {
    'cloudflare_403': 'Cloudflare 风控',
    'rate_limited': '速率限制',
    'connection_reset': '连接重置',
    'connection_upload_closed': '连接关闭',
    'openai_403': 'OpenAI 403',
    'captcha': '验证码',
    'custom': '手动',
  };
  return map[reason] || reason;
}
function formatRemaining(iso) {
  const t = new Date(iso).getTime();
  const remainSec = Math.max(0, Math.round((t - Date.now()) / 1000));
  if (remainSec < 60) return `${remainSec}s 后`;
  if (remainSec < 3600) return `${Math.round(remainSec / 60)}min 后`;
  return new Date(t).toLocaleTimeString();
}

async function unbanOne(node) {
  try {
    await api.post('/proxy/unban-node', { node });
    await loadBlacklist();
    ElMessage?.success(`已解禁 ${node.slice(0, 40)}...`);
  } catch (err) {
    ElMessage?.error(`解禁失败: ${err?.response?.data?.error || err.message}`);
  }
}
```

- [ ] **Step 3: 清空按钮改批量 unban**

找 `clearChannel(channel)` 函数（既有），改实现：

```js
async function clearChannel(channel) {
  const nodes = blacklist.value[channel] || [];
  if (nodes.length === 0) return;
  // 用户确认
  try {
    await ElMessageBox.confirm(
      `确定清空 ${channel === 'main' ? '主代理' : 'JP'} 黑名单 ${nodes.length} 个节点？`,
      '批量解禁', { type: 'warning' }
    );
  } catch { return; }  // 取消
  try {
    const { data } = await api.post('/proxy/clear-blacklist', { channel });
    await loadBlacklist();
    ElMessage?.success(`已清空 ${data.cleared} 个节点`);
  } catch (err) {
    ElMessage?.error(`清空失败: ${err?.response?.data?.error || err.message}`);
  }
}
```

- [ ] **Step 4: loadBlacklist normalize 处理 superset schema**

找现有 `loadBlacklist()` + `normalizeBlacklist()`（约 line 593）。如果 normalize 把字段拍平到 `[{node, addedAt}]`，要保留新增的 reason / bannedUntil 字段：

```js
function normalizeBlacklist(data) {
  return {
    main: (data?.main || []).map(item => ({
      node: item.node || item,
      reason: item.reason || 'custom',
      bannedUntil: item.bannedUntil || null,
      addedAt: item.addedAt || null,
    })),
    jp: (data?.jp || []).map(item => ({
      node: item.node || item,
      reason: item.reason || 'custom',
      bannedUntil: item.bannedUntil || null,
      addedAt: item.addedAt || null,
    })),
  };
}
```

- [ ] **Step 5: build web + 实测**

```bash
cd web && npm run build && cd ..
```

实测：

```bash
# ban 一个节点
curl -s -X POST http://127.0.0.1:3000/api/proxy/bad-node -H "Content-Type: application/json" -d '{"reason":"cloudflare_403","channel":"main","durationMinutes":3}'

# 浏览器打开 http://localhost:3000，进入配置 → 节点黑名单 tab
# 期望：看到 1 条 banned 节点 + reason 列显示 "Cloudflare 风控" 红色 tag + 解禁时间 "Xmin 后"
# 点单个"解禁" → 该节点从 list 消失
# 再 ban 一个 → 点"清空主代理黑名单" → 确认对话框 → cleared
```

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Config.vue web/src/composables/useConfirmDanger.js web/dist
git commit -m "feat(web): Config 黑名单 tab 升级 reason / 解禁时间 / 批量 unban (Task 3)

UI 改动:
- 说明文改写为'业务遇 Cloudflare/rate_limited/connection_reset 等风控自动加入，5 分钟过期'
- 加 reason 列 (cloudflare_403/rate_limited/captcha 等 → 中文 tag)
- 加 解禁时间 列 (倒计时显示)
- 加 单个'解禁'按钮 (调 POST /proxy/unban-node)
- '清空' 按钮改批量 unban (调 POST /proxy/clear-blacklist) + 确认对话框

normalizeBlacklist 保留 reason / bannedUntil superset 字段。
删 FAIL_THRESHOLD 引用 (v2.42 后不再使用)。"
```

---

## Task 4: CHANGELOG + merge + tag v2.42.1

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: 写 CHANGELOG v2.42.1**

prepend：

```markdown
## v2.42.1 — 2026-05-26

### 代理配置清理 + 黑名单 UI 升级

v2.42.0 sing-box urltest 改造后，部分 config 字段已废弃但仍存在；Config 黑名单 tab 说明文 / 字段也过时。本版本 housekeeping。

**删除 (v2.42 后已废弃)**：
- `config.proxy.rotationStrategy` / `proxy.jpCheckout.rotationStrategy` — urltest 内部自动 latency-based 选最优
- `config.proxy.activeHealthCheck` — urltest 内置 probe (interval 3m)
- `_state.rotationStrategy` / `rotationIndex` / `rotationKeyword` 等 state 字段
- Config 代理 tab：rotationStrategy radio UI + "代理状态" / "JP 通道状态" 显示块（转 Dashboard ProxyPanel）

**新增 / 升级**：
- `GET /api/proxy/blacklist` 返回结构 superset：含 `reason` + `bannedUntil` 字段（向后兼容旧字段）
- `POST /api/proxy/clear-blacklist` 新增 — 按 channel 批量 unban
- Config 黑名单 tab：
  - 加 **reason 列** (Cloudflare 风控 / 速率限制 / 连接重置 等中文 tag)
  - 加 **解禁时间列** (倒计时 "Xmin 后")
  - 加 **单个解禁按钮** (`POST /proxy/unban-node`)
  - **清空按钮改批量 unban** (`POST /proxy/clear-blacklist`) + 确认对话框
  - 说明文改写："业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期"
- Config 代理 tab 加引导链接 → Dashboard ProxyPanel 看实时状态

**向后兼容**：
- 老 `config.json` 含废字段 → server 启动忽略不报错
- v2.30 旧 `currentNode` / `nodeTags` / `exitIp` 等 status 字段保留（其他模块可能用）

**改动量**：净减 ~48 行（删 90 行 + 加 42 行）。

详见 `docs/superpowers/specs/2026-05-26-proxy-config-cleanup-design.md`。
```

- [ ] **Step 2: Commit CHANGELOG**

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.42.1 代理配置清理 + 黑名单 UI 升级"
```

- [ ] **Step 3: Merge + tag + push**

```bash
git checkout master && git merge --ff-only dev
git tag -a v2.42.1 -m "v2.42.1 — 代理配置清理 + 黑名单 UI 升级

v2.42.0 urltest 改造后 housekeeping：
- 删 config.proxy.rotationStrategy / activeHealthCheck 等 3 废字段
- Config 代理 tab 简化 (转 Dashboard ProxyPanel)
- 黑名单 tab 升级 (reason / 解禁时间 / 批量 unban)
- 后端 GET /blacklist superset + POST /clear-blacklist
- 净减 ~48 行"

git push origin master
git push origin v2.42.1
git checkout dev
```

- [ ] **Step 4: 重启 server 验证**

```bash
# Windows kill old server PID
# powershell -c "Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.Id)\").CommandLine -like '*server/index.js*' } | Stop-Process -Force"
# 启 v2.42.1
node server/index.js
```

实测：
- 浏览器打开 http://127.0.0.1:3000 → 配置 → 代理 tab：无 rotation radio + 无 status block
- 配置 → 节点黑名单 tab：列含 reason / 解禁时间
- 模拟 ban → 看到新字段 → 单个解禁 + 批量清空 work

---

## Self-Review

**Spec 覆盖**：

| Spec 章节 | Plan 任务 |
|----------|----------|
| §1.1 config schema 删 3 字段 | Task 1 step 1（间接：删读取代码后字段自动 ignored） |
| §1.2 server/proxy/index.js 删 ~30 行 | Task 1 step 1 |
| §1.3 Config.vue 代理 tab 删 ~80 行 | Task 2 |
| §2 黑名单 tab 升级 | Task 3 |
| §3.1 GET /blacklist 升级 | Task 1 step 2 |
| §3.2 POST /clear-blacklist | Task 1 step 3 |
| §4 测试 + 风险 | Task 1/2/3 step 末尾 + Task 4 |

**Placeholder 扫描**：无 TBD / TODO。每 task 含完整代码 + 命令。

**命名一致性**：`reasonTagType` / `reasonLabel` / `formatRemaining` / `unbanOne` / `clearChannel` 跨 Task 3 step 2/3 一致。`proxyDB.listBanned` / `proxyDB.unbanNode` / `proxyMgr.unbanNode` 跨 Task 1 step 2/3 一致。

---

## Execution Handoff

Plan 完成。3 个核心 task + 发布 task：

1. **Subagent-Driven (推荐)** — Task 1 后端 / Task 2 前端代理 tab / Task 3 黑名单 tab 各派 1 个 implementer fresh context。Task 4 发布 controller 自己跑（push 要授权）。
2. **Inline Execution** — 顺序跑 4 task。
