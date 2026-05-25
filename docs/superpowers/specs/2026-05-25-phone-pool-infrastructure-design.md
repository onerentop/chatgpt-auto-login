# v2.37.0 — 手机号号池基础设施设计（Phase 1/2）

## 1. 背景

OAuth PKCE 流程在某些账户上会被 ChatGPT 要求绑定手机号（`protocol_register.py:273` 检测到 `add_phone` 页 → 返回 `needsPhone: true`，**当前实际行为是流水线卡死**，没有自动填手机号 / 接码 / 验证逻辑）。

用户希望：
- 维护一个手机号池：每条 = `phone | sms_api_url`（如 `+14642840651|http://a.62-us.com/api/get_sms?key=...`）
- 池里每个号配置最大绑定账户数（如 5），用满即不再可用
- 池有 UI 增删查 + 导入导出
- 账户与号的绑定**首次使用建立**、**永久绑定**（即便账户后续被删，号的 `bindings_used` 计数不回退）

**Phase 1（本 spec）只交付号池基础设施**——DB 表 + 后端服务 + 前端页面 + acquire/SMS API。PKCE 流程**暂不消费号池**（仍然在 needsPhone 处卡死）。这样运维可以先填池、试导入导出、配置最大绑定数，待 Phase 2 wiring PKCE 后立即可用。

Phase 2（独立 spec，本次不写）：协议模式 + 浏览器模式两套 PKCE 手机号验证流程实现，调用 Phase 1 的 `acquirePhone()` API + 复用 SMS 轮询 helper。

## 2. 目标（Phase 1）

- DB：`phone_pool` + `phone_bindings` 两张新表，with sql.js 迁移
- 后端：`server/phone-pool.js` service（list / import / export / delete / acquirePhone / fetchSmsCode helper）
- 路由：`server/routes/phone-pool.js`（4 个 endpoints）
- 配置：`config.json` 加 `phonePool` 块（默认 `enabled: false`）
- 前端：`web/src/views/PhonePool.vue` 新页面，sidebar nav 加「号池」
- 测试：`server/__tests__/phone-pool.test.js` +6
- **不动 PKCE 流程**（Phase 2 范围）
- **不动 PayPal SMS 路径**（config.phone / phoneSlots 与号池正交）

## 3. 方案

### 3.1 DB schema（`server/db.js`）

新增两张表。沿用既有 PRAGMA-gated migration 模式：

```js
// In ensureSchema() 内部
db.run(`
  CREATE TABLE IF NOT EXISTS phone_pool (
    phone TEXT PRIMARY KEY,
    sms_api_url TEXT NOT NULL,
    bindings_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.run(`
  CREATE TABLE IF NOT EXISTS phone_bindings (
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    bound_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (phone, email),
    FOREIGN KEY (phone) REFERENCES phone_pool(phone) ON DELETE CASCADE
  );
`);
```

注意：sql.js 不强制 FK，但写上明确语义。删除 phone 时 `phone_bindings` 由手动 delete cascade（service 层操作）。

### 3.2 Config schema（`config.example.json` + Config UI）

新增 `phonePool` 字段：

```json
{
  "phonePool": {
    "enabled": false,
    "maxBindingsPerPhone": 5,
    "smsPollIntervalMs": 3000,
    "smsMaxAttempts": 30
  }
}
```

- `enabled`: 全局开关。false 时即便 pool 有号也不分配（Phase 2 PKCE 集成时检查这个）
- `maxBindingsPerPhone`: 每号最大绑定数
- `smsPollIntervalMs` / `smsMaxAttempts`: 跟现有 PayPal SMS 路径默认值一致（3s × 30 = 90s）

`web/src/views/Config.vue` 加 4 个 input（en switch + 3 个 number），保存到 config.json。

### 3.3 后端服务 `server/phone-pool.js`

纯函数 + 注入 db (sql.js Database 实例)。模式跟 `server/proxy/` 类似。

```js
// 列表 with 绑定 emails（用于 UI 展示）
function listPhones(db) {
  // SELECT phone, sms_api_url, bindings_used, created_at FROM phone_pool ORDER BY created_at DESC
  // 每行附加 boundEmails: SELECT email FROM phone_bindings WHERE phone = ?
}

// 批量导入：parse `phone|url\n...`，去重（重复 phone 跳过），返回 { added, skipped }
function importPhones(db, text) {
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean)
  let added = 0, skipped = 0
  for (const line of lines) {
    const [phone, url] = line.split('|').map(s => s.trim())
    if (!phone || !url) { skipped++; continue }
    if (!/^\+\d{10,15}$/.test(phone)) { skipped++; continue }  // E.164 sanity
    try {
      db.run('INSERT INTO phone_pool (phone, sms_api_url) VALUES (?, ?)', [phone, url])
      added++
    } catch (e) {
      // UNIQUE 冲突 → 跳过
      skipped++
    }
  }
  return { added, skipped }
}

// 导出：与导入相同格式（`phone|url\n`）
function exportPhones(db) {
  // SELECT phone, sms_api_url FROM phone_pool ORDER BY created_at ASC
  // return lines.join('\n')
}

// 删除：cascade bindings
function deletePhone(db, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ?', [phone])
  db.run('DELETE FROM phone_pool WHERE phone = ?', [phone])
}

// acquirePhone(email)：原子操作
// 1. 选第一个 bindings_used < max 且 (phone, email) 不在 phone_bindings 的 phone
// 2. 插入 binding；自增 bindings_used
// 3. 返回 { phone, smsApiUrl } or null
function acquirePhone(db, email, maxBindingsPerPhone) {
  // SELECT phone, sms_api_url FROM phone_pool
  //   WHERE bindings_used < ?
  //     AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
  //   ORDER BY bindings_used ASC, created_at ASC
  //   LIMIT 1
  // 找到 → INSERT INTO phone_bindings + UPDATE phone_pool SET bindings_used = bindings_used + 1
  // 没找到 → return null
}
```

**`acquirePhone()` 并发安全**：sql.js 是内存 DB 单线程操作，没有真正的并发，但同步操作序列化保证原子性。

**`fetchSmsCode(smsApiUrl, signal)` 短信轮询 helper**：

```js
async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      const resp = await fetch(smsApiUrl, { signal })
      const text = await resp.text()
      const m = text.match(/\b(\d{6})\b/)
      if (m) return m[1]
    } catch {}
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error('sms-poll-timeout')
}
```

逻辑跟 `payment.js:handleSmsVerification`（line 563-610）的 SMS 轮询一致，但提取成独立 helper。**本次只导出 fetchSmsCode，不动 payment.js** —— Phase 2 重构 payment.js 也用这个 helper（避免现在动 PayPal 链路风险）。

### 3.4 API 路由 `server/routes/phone-pool.js`

```js
const router = require('express').Router()
const phonePool = require('../phone-pool')
const db = require('../db')
const { readCfg } = require('../config-store')

router.get('/', (req, res) => {
  res.json(phonePool.listPhones(db.get()))
})

router.post('/import', (req, res) => {
  const text = String(req.body?.text || '')
  if (!text) return res.status(400).json({ error: 'text required' })
  const result = phonePool.importPhones(db.get(), text)
  db.save()
  res.json({ ok: true, ...result })
})

router.get('/export', (req, res) => {
  const text = phonePool.exportPhones(db.get())
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="phone-pool-${Date.now()}.txt"`)
  res.send(text)
})

router.delete('/:phone', (req, res) => {
  const phone = req.params.phone
  phonePool.deletePhone(db.get(), phone)
  db.save()
  res.json({ ok: true })
})
```

挂到 `server/index.js`：`app.use('/api/phone-pool', require('./routes/phone-pool'))`.

### 3.5 前端页面 `web/src/views/PhonePool.vue`

布局沿用 v2.34 design tokens（PageHeader + SectionCard）：

- **PageHeader**：标题「号池」+ 副标题 显示「共 X 个号 / 已用 Y 个绑定」
- **toolbar (SectionCard top)**：
  - 「批量导入」按钮 → 打开 `<el-dialog>` 含 textarea + 提示「格式：每行 `phone|url`」+ 确定按钮
  - 「导出」按钮 → window.open `/api/phone-pool/export`
  - 「号池配置」链接 → 跳 Config.vue（max bindings 等设在那里）
- **表格**（SectionCard body）：
  - 列：phone / SMS URL（短显 tooltip 看全文）/ 已用 (bindings_used / maxBindings) / 创建时间 / 操作（删除）
  - 行点击展开 → 显示 boundEmails 列表
- **路由**：`web/src/router.js` 加 `{ path: '/phone-pool', name: 'PhonePool', component: () => import('../views/PhonePool.vue') }`
- **侧栏导航**：`web/src/components/AppLayout.vue` 加 el-menu-item「号池」

**示例视图**：
```
┌─ 号池 ──────────────────────────────────────┐
│ 共 12 个号 / 已用 28 个绑定                 │
├──────────────────────────────────────────────┤
│ [批量导入] [导出] [配置]                     │
│ ┌──────────────┬─────────┬──────┬───────────┐│
│ │ phone        │ url     │ 已用 │ 操作      ││
│ ├──────────────┼─────────┼──────┼───────────┤│
│ │ +1464284...  │ a.62... │ 2/5  │ 删除      ││
│ │ +1500123...  │ b.cd... │ 5/5  │ 删除      ││
│ └──────────────┴─────────┴──────┴───────────┘│
└──────────────────────────────────────────────┘
```

### 3.6 边界与不变式

- **§3.6.1 phone 唯一**：PRIMARY KEY，导入重复跳过（不覆盖 URL）
- **§3.6.2 bindings_used 单调递增**：account 删除不释放（per user 明确）。如果用户要"重置"，只能删掉该 phone 重导入
- **§3.6.3 acquirePhone 排序**：优先 `bindings_used ASC`（轮转使用 phone，避免某个号一直被打），同 used 时按 `created_at ASC`（FIFO）
- **§3.6.4 不允许重复绑定**：同一 phone 不会绑同 email 两次（acquirePhone WHERE 子句已排除）。SQL UNIQUE 约束兜底
- **§3.6.5 删除 phone**：直接 cascade 删除 bindings（不影响 bindings_used —— 那是历史水位）
- **§3.6.6 Phase 1 不消费号池**：PKCE 仍卡死。Phase 2 才接通
- **§3.6.7 PayPal 不动**：config.phone / phoneSlots 仍归 PayPal。互不影响
- **§3.6.8 enabled=false 时**：UI 仍可管理号池；Phase 2 PKCE 会检查 enabled 决定是否消费
- **§3.6.9 phone 格式校验**：E.164 (`+[10-15 digits]`)；不符合的导入行 skipped 计数
- **§3.6.10 SMS URL 校验**：仅检查非空（http(s) 形式不强制——支持假 URL 用于测试）
- **§3.6.11 sensitive masking**：route GET / list 不 mask URL（号池页面专用，本地无认证设计跟 config.phone 一致）

### 3.7 测试

`server/__tests__/phone-pool.test.js`（新建）：

1. **P1 importPhones 基本**：parse 3 条合法行 → added=3 / skipped=0
2. **P2 importPhones 跳过非法**：含空行 / 无 `|` / 非 E.164 / 重复 → skipped 计数正确
3. **P3 listPhones 含 boundEmails**：先 import 1 个 + 手动 insert 2 个 binding → list 该 phone.boundEmails.length === 2
4. **P4 acquirePhone 满绑定跳过**：phone A bindings_used=5 (max=5), phone B bindings_used=0 → acquire 返回 B
5. **P5 acquirePhone 同 email 不重绑**：先 acquire('foo@x') 拿 phone A → 再 acquire('foo@x') → 返回 B（如果 B 可用）或 null
6. **P6 deletePhone cascade**：phone A 有 2 bindings → delete A → bindings 表里没 A 行；bindings_used 不影响其它 phone

每个测试用 sql.js in-memory DB fresh setup。

### 3.8 文件清单（Phase 1）

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/db.js` | 加 2 张表的 CREATE | 修改 |
| `server/phone-pool.js` | 新建 service (~150 LOC) | 新建 |
| `server/__tests__/phone-pool.test.js` | +6 单测 | 新建 |
| `server/routes/phone-pool.js` | 4 个 endpoints | 新建 |
| `server/index.js` | 挂路由 `app.use('/api/phone-pool', ...)` | 修改 (1 行) |
| `config.example.json` | +`phonePool` 块（默认 disabled） | 修改 |
| `web/src/views/PhonePool.vue` | 新建（PageHeader + 表格 + import dialog） | 新建 |
| `web/src/router.js` | +1 route | 修改 |
| `web/src/components/AppLayout.vue` | +1 nav 项「号池」 | 修改 |
| `web/src/views/Config.vue` | +4 input for phonePool 配置 | 修改 |
| `docs/CHANGELOG.md` | v2.37.0 节 | 修改 |

PKCE 引擎 / Python 协议代码 / payment.js / engine.js / protocol-engine.js **零改动**。

## 4. YAGNI / 不做的（Phase 1）

- 不动 PKCE 实现（Phase 2 范围）
- 不动 PayPal SMS 路径
- 不重构 payment.js 用 fetchSmsCode helper（Phase 2 一起）
- 不为 phone 加 enable/disable 开关（删除即可）
- 不支持 phone 编辑（只能删后重导）
- 不持久化 bindings_used 历史水位（计数器就够）
- 不支持 phone 转移（手动 delete + re-import）
- 不为 sms_api_url 做 health probe（消费时撞错就撞错）

## 5. Phase 2 预览（不在本 spec 范围）

Phase 2 spec（独立写）会做：
- `chatgpt_register/protocol_register.py` 扩展：detect needsPhone → emit `{requestPhone:true}` → Python 读 stdin `{phoneAnswer}` → POST OpenAI `add_phone` + verify endpoint
- `protocol-engine.js`：处理 `requestPhone` → 调 `phonePool.acquirePhone(email)` → 启动 fetchSmsCode polling → stdin 回 phone + 之后 stdin 回 sms code
- `server/engine.js` + Playwright：浏览器模式 add_phone 页 自动填表 + 接码
- `payment.js` 拆出 SMS poll helper 用 phone-pool.js 的 fetchSmsCode（DRY）
- 新 status 码 `phone_pool_empty`（号池耗尽时）
- 集成测试：手动 smoke 协议 + 浏览器

预计 Phase 2 = 5-6 个文件，500-700 LOC，1-2 个工作单元。

## 6. 版本

v2.37.0 — minor over v2.36.x（并行 session 的前端重设计已落地）。Phase 2 = v2.37.1 / v2.38.0 后续决定。

避开 v2.35.x / v2.36.x（已被并行 session 占用为 frontend redesign + GitHub style）。
