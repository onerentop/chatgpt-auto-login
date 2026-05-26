# 代理配置清理 + 黑名单 UI 升级设计

**状态**：草案，待 review
**日期**：2026-05-26
**触发**：v2.42.0 完成 sing-box urltest 改造后，`config.proxy.rotationStrategy` / `activeHealthCheck` / `jpCheckout.rotationStrategy` 3 个字段已经被 urltest 接管不再读取；Config.vue 黑名单 tab 说明文"连续 N 次自动加入"也已过时（v2.42 改为业务上报临时 ban）。

**目标**：

1. 删除 v2.42 后**已废弃**的 config 字段 + UI（用户不再看到"死选项"）
2. 黑名单 tab UI **升级**：说明文 + 加 reason / 解禁时间列 + 清空改批量 unban
3. Config 页代理状态显示部分**整体删除**（重复 Dashboard ProxyPanel）

**非目标**：不动 `proxy.localPort` / `proxy.jpPort` UI 暴露（YAGNI，用户手改 config.json 即可）；不动 v2.30 旧 status 字段（向后兼容）；不动 bad-node API / urltest 等 v2.42 新机制。

## 1. 删除清单（v2.42 后废弃）

### 1.1 config schema 删除

| 字段 | 为什么删 |
|------|--------|
| `proxy.rotationStrategy` | urltest 内部 latency-based 自动选最优，"sequential"/"random" 无意义 |
| `proxy.jpCheckout.rotationStrategy` | 同上 |
| `proxy.activeHealthCheck` | urltest 内置 probe（interval=3m），server 自实现 30s probe 已删 |

`config.example.json` 已经不含这些字段（之前从未列出），确认 OK 即可。

### 1.2 server/proxy/index.js 代码删除（~30 行）

- 删 `_state.rotationStrategy` / `_state.jp.rotationStrategy` 字段
- 删 `_state.rotationIndex` / `_state.rotationKeyword`
- 删读 `cfg.proxy.rotationStrategy` / `cfg.proxy.jpCheckout.rotationStrategy` / `cfg.proxy.activeHealthCheck` 的 if 块
- `getState()` 返回值删 `rotationStrategy` / `rotationIndex` / `rotationKeyword` 字段（**注意**：Config.vue 不再读它们，但保留 v2.30 其他状态字段 `currentNode` / `exitIp` / `whitelist` 等仍向后兼容）

### 1.3 Config.vue 代理 tab UI 删除（~80 行）

**删**：

- `proxyRotationStrategy` 表单字段 + `<el-radio-group>` 单选 UI（line ~151-155）
- 整个 "代理状态" 显示块 `<el-form-item label="代理状态" v-if="proxyStatus">` 含 currentNode / exitIp / whitelistMisses 显示（line ~161-176）
- 整个 "JP 通道状态" 显示块 `<el-form-item v-if="proxyStatus?.jp">`（line ~208-224）
- `proxyStatus` ref + `loadProxyStatus()` 函数（line ~322 + ~580+）
- `onMounted` 里 `loadProxyStatus()` 调用 + 周期 setInterval（如果有）

**加**：

```vue
<div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0">
  代理实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
</div>
```

**保留**：

- 启用代理 switch / 订阅 URL / 节点白名单多选 / 地区过滤 / JP 通道全部配置项
- 应用 / 停止代理按钮
- `whitelistMisses` 警告作为"配置错误"提示保留（**但要从 form-validation 拿，不依赖 proxyStatus**）—— 实际上 whitelist 校验当前依赖 proxyStatus，移到 refreshProxy 完成后的 response 显示，本 task 简化：完全删 whitelistMisses 显示，等用户报告再补

## 2. 黑名单 tab UI 升级（~30 行修改）

`Config.vue` `<el-tab-pane label="节点黑名单" name="blacklist">`（line 231-300）：

### 2.1 说明文改写

```diff
- 共 {{ blacklist.main.length }} 个节点 · 连续 {{ FAIL_THRESHOLD }} 次代理错误自动加入
+ 共 {{ blacklist.main.length }} 个节点 · 业务遇 Cloudflare / rate_limited / connection_reset 等风控自动加入，默认 5 分钟过期
```

JP 同样改。

删除 `FAIL_THRESHOLD` 常量引用（v2.42 后没用了；可在 `web/src/composables/useConfirmDanger.js` 也 grep 看）。

### 2.2 加 reason + 解禁时间列

```vue
<el-table :data="blacklist.main" size="small" empty-text="（无）" max-height="260">
  <el-table-column prop="node" label="节点" min-width="200" />
  <el-table-column prop="reason" label="原因" width="160">
    <template #default="{ row }">
      <el-tag :type="reasonTagType(row.reason)" size="small">{{ reasonLabel(row.reason) }}</el-tag>
    </template>
  </el-table-column>
  <el-table-column label="解禁时间" width="160">
    <template #default="{ row }">
      <span v-if="row.bannedUntil">{{ formatRemaining(row.bannedUntil) }}</span>
      <span v-else class="muted">已过期</span>
    </template>
  </el-table-column>
  <el-table-column label="操作" width="100">
    <template #default="{ row }">
      <el-button size="small" link @click="unbanOne(row.node)">解禁</el-button>
    </template>
  </el-table-column>
</el-table>
```

新增 helper：

```js
function reasonTagType(reason) {
  if (reason === 'cloudflare_403') return 'danger';
  if (reason === 'rate_limited') return 'warning';
  if (reason === 'connection_reset' || reason === 'connection_upload_closed') return 'info';
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
function formatRemaining(isoOrMs) {
  const t = typeof isoOrMs === 'string' ? new Date(isoOrMs).getTime() : isoOrMs;
  const remainSec = Math.max(0, Math.round((t - Date.now()) / 1000));
  if (remainSec < 60) return `${remainSec}s 后`;
  if (remainSec < 3600) return `${Math.round(remainSec / 60)}min 后`;
  return new Date(t).toLocaleTimeString();
}
```

### 2.3 清空按钮改批量 unban

```vue
<el-button size="small" :disabled="!blacklist.main.length" @click="clearChannel('main')">
  清空主代理黑名单
</el-button>
```

`clearChannel(channel)` 函数：

```js
async function clearChannel(channel) {
  const nodes = blacklist.value[channel] || [];
  if (nodes.length === 0) return;
  // 调批量 unban API
  try {
    await api.post('/proxy/clear-blacklist', { channel });
    await loadBlacklist();
    ElMessage.success(`已清空 ${channel === 'main' ? '主代理' : 'JP'} 黑名单（${nodes.length} 个节点）`);
  } catch (err) {
    ElMessage.error(`清空失败: ${err?.response?.data?.error || err.message}`);
  }
}

async function unbanOne(node) {
  try {
    await api.post('/proxy/unban-node', { node });
    await loadBlacklist();
    ElMessage.success(`已解禁 ${node}`);
  } catch (err) {
    ElMessage.error(`解禁失败: ${err.message}`);
  }
}
```

## 3. server/routes/proxy.js 后端改动

### 3.1 `GET /api/proxy/blacklist` 返回结构升级

```jsonc
// 旧（v2.30）
{
  "main": [{ "node": "us-xxx", "addedAt": 1779xxx, "reason": "fail*3" }],
  "jp": [...]
}

// 新（v2.42 cleanup）— 字段升级到 proxy_blacklist 表 schema
{
  "main": [
    {
      "node": "us-vmrack-CN2精品-AI-2g-95.41 ...",
      "reason": "cloudflare_403",
      "bannedUntil": "2026-05-26T15:08:11.572Z",
      "addedAt": 1779800000000  // optional, 兼容
    }
  ],
  "jp": [...]
}
```

后端 query 改为：

```js
// server/routes/proxy.js
router.get('/blacklist', (req, res) => {
  try {
    const { proxyDB } = require('../db');
    const rows = proxyDB.listBanned();  // 返回 [ {node, reason, banned_until} ]
    const proxyMgr = require('../proxy');
    const jpNodeSet = new Set((proxyMgr.getState().jp?.nodes || []).map(n => n.tag || n));
    const main = [], jp = [];
    for (const r of rows) {
      const entry = { node: r.node, reason: r.reason, bannedUntil: new Date(r.banned_until).toISOString() };
      if (jpNodeSet.has(r.node)) jp.push(entry);
      else main.push(entry);
    }
    res.json({ main, jp });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

### 3.2 `POST /api/proxy/clear-blacklist` 新增

```js
router.post('/clear-blacklist', async (req, res) => {
  const { channel } = req.body || {};
  if (!['main', 'jp'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be main or jp' });
  }
  try {
    const { proxyDB } = require('../db');
    const proxyMgr = require('../proxy');
    const all = proxyDB.listBanned();
    const jpNodeSet = new Set((proxyMgr.getState().jp?.nodes || []).map(n => n.tag || n));
    const toClear = all.filter(r => {
      const isJp = jpNodeSet.has(r.node);
      return channel === 'jp' ? isJp : !isJp;
    });
    for (const r of toClear) {
      proxyDB.unbanNode(r.node);
      await proxyMgr.unbanNode(r.node).catch(() => {});  // sing-box regenerate
    }
    res.json({ ok: true, cleared: toClear.length });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
```

### 3.3 `POST /api/proxy/unban-node` 已存在（v2.42 Task 9）

不变。

## 4. 测试 + 风险

### 4.1 测试

- npm test 302 不该 regress；test mock 里如有 `rotationStrategy` 字段 → 删
- web build 通过
- 单测 server/proxy/__tests__/blacklist.test.js（既有）若依赖 `markBad` 自动累积 → 更新 mock 或确认已 skip
- 集成测：浏览器打开 Config 黑名单 tab → 看到 reason / 解禁时间列 → 清空按钮调批量 unban 成功

### 4.2 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| 老 config.json 含 `rotationStrategy: "random"` | 高 | server 启动时忽略（不报错），向后兼容 |
| GET /blacklist 旧 schema 客户端（v2.30 前端 cache）报错 | 低 | 返回结构 SUPERSET（保留 node + addedAt 兼容） |
| `proxyDB.listBanned()` 返回 banned_until 早已过期但未清理 | 中 | listBanned 查询已 filter `> Date.now()`，前端不会显示过期项 |
| Config 页 onMounted setInterval 还在跑 loadProxyStatus | 低 | 显式 onUnmounted 清 timer + 删 ref |

## 5. 验收标准

1. `config.json` 删 3 字段后 server 启动正常（向后兼容老配置忽略额外字段）
2. Config 页代理 tab：无 rotationStrategy radio + 无"代理状态/JP 通道状态"显示块 + 有"请到 Dashboard 查看"引导
3. Config 页黑名单 tab：显示 reason / 解禁时间列；清空批量 unban 成功
4. Dashboard ProxyPanel 仍工作（不受本 task 影响）
5. npm test 302+ pass，web build 通过
6. 实测：bad-node API ban 节点 → Config 黑名单 tab 显示 + 解禁时间倒计时 + 清空 unban

## 6. 改动量

| 项目 | 改动 |
|------|------|
| `server/proxy/index.js` rotationStrategy/activeHealthCheck 删除 | -30 行 |
| `server/routes/proxy.js` GET /blacklist 升级 + POST /clear-blacklist | +35 行 |
| `web/src/views/Config.vue` 代理 tab 简化 | -80 行 |
| `web/src/views/Config.vue` 黑名单 tab 升级 | +40 行 |
| `web/src/composables/useConfirmDanger.js` FAIL_THRESHOLD 引用（如有） | -3 行 |
| 测试 mock 清理 | -10 行 |
| **净 -48 行** |
