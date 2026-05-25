# v2.33.0 账号行运行时整行高亮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute.vue 子组件和 Accounts.vue 在执行/测活时给整行换浅色底色（按 status 映射到 success/warning/danger/info），running 强制 warning，idle 保持默认；Accounts.vue 同时补 `account-status` socket 订阅。

**Architecture:** 在 `web/src/status.js` 加 `rowClassFor(status)` 工具函数（统一 idle 不上色 + running 例外）。两个表格组件加 `:row-class-name="rowClass"` + 4 个 CSS 类。Accounts.vue 加 `watch(socketState.accountStatuses)` 接通实时流。

**Tech Stack:** Vue 3 `<el-table>` row-class-name、`statusType` 既有色系映射、socketState.accountStatuses 既有数据流、node:test dynamic import。

**Spec:** `docs/superpowers/specs/2026-05-25-row-highlight-during-execution-design.md`

---

## File Structure

| 文件 | 改动 |
|---|---|
| `web/src/status.js` | +`rowClassFor(status)` 工具函数 |
| `__tests__/status-row-class.test.js` | 新建，8 单测 |
| `web/src/components/AccountTableRows.vue` | el-table +`:row-class-name`、import rowClassFor、行内 rowClass 函数、style scoped CSS |
| `web/src/views/Accounts.vue` | watch accountStatuses 新增、el-table +`:row-class-name`、import rowClassFor、行内 rowClass 函数、style scoped CSS |
| `docs/CHANGELOG.md` | v2.33.0 节 |

依赖：Task 1（工具函数 + 测试）→ Task 2（Execute 子组件）→ Task 3（Accounts.vue 含 socket + UI）→ Task 4（CHANGELOG）。Task 2 + Task 3 都依赖 Task 1 的 `rowClassFor`，但彼此独立。

---

## Task 1: status.js — 新增 rowClassFor + 8 单测

**Files:**
- Modify: `web/src/status.js` (insert after `statusLabel`，约 line 45)
- Create: `__tests__/status-row-class.test.js`

### Step 1: 写失败测试

新建 `__tests__/status-row-class.test.js`：

```js
const test = require('node:test')
const assert = require('node:assert')

let rowClassFor

test.before(async () => {
  const mod = await import('../web/src/status.js')
  rowClassFor = mod.rowClassFor
})

test('rowClassFor: idle 不高亮', () => {
  assert.strictEqual(rowClassFor('idle'), '')
  assert.strictEqual(rowClassFor(''), '')
  assert.strictEqual(rowClassFor(null), '')
  assert.strictEqual(rowClassFor(undefined), '')
})

test('rowClassFor: running 强制 warning（即便 TYPE_MAP=空字符串）', () => {
  assert.strictEqual(rowClassFor('running'), 'row-status-warning')
})

test('rowClassFor: success 状态（plus）', () => {
  assert.strictEqual(rowClassFor('plus'), 'row-status-success')
})

test('rowClassFor: danger 状态（error / deactivated / login_fail）', () => {
  assert.strictEqual(rowClassFor('error'), 'row-status-danger')
  assert.strictEqual(rowClassFor('deactivated'), 'row-status-danger')
  assert.strictEqual(rowClassFor('login_fail'), 'row-status-danger')
})

test('rowClassFor: warning 状态（plus_no_rt / no_link / token_expired）', () => {
  assert.strictEqual(rowClassFor('plus_no_rt'), 'row-status-warning')
  assert.strictEqual(rowClassFor('no_link'), 'row-status-warning')
  assert.strictEqual(rowClassFor('token_expired'), 'row-status-warning')
})

test('rowClassFor: info 状态（no_promo / aborted）', () => {
  assert.strictEqual(rowClassFor('no_promo'), 'row-status-info')
  assert.strictEqual(rowClassFor('aborted'), 'row-status-info')
})

test('rowClassFor: 未知状态 fallback info', () => {
  assert.strictEqual(rowClassFor('made_up_status'), 'row-status-info')
})

test('rowClassFor: 大小写不敏感', () => {
  assert.strictEqual(rowClassFor('PLUS'), 'row-status-success')
  assert.strictEqual(rowClassFor('Running'), 'row-status-warning')
})
```

### Step 2: 跑测试验证 FAIL

```
node --test __tests__/status-row-class.test.js
```

Expected: 全部 8 测试 FAIL — `rowClassFor is not a function`（导入到 undefined）。

### Step 3: 实现 rowClassFor in `web/src/status.js`

打开 `web/src/status.js`. 找到 `statusLabel` 函数（约 line 43-45）：

```js
export function statusLabel(s) {
  return LABEL_MAP[s] || s || '空闲'
}
```

在 `statusLabel` 之后、`export const PLUS_STATUSES` 之前（约 line 46 处）插入：

```js

// v2.33.0: 给 <el-table> :row-class-name 用。
// 返回 'row-status-{type}' 或 '' (idle/empty 时不高亮)。
// 大部分 status 直接复用 statusType()；唯一例外是 running ——
// TYPE_MAP['running'] 是 ''（statusType 回退 'info' 渲染浅灰），
// 但运行中需要明显的"在跑"信号，所以特殊处理为 warning（浅黄）。
export function rowClassFor(status) {
  const st = (status || '').toLowerCase()
  if (!st || st === 'idle') return ''
  if (st === 'running') return 'row-status-warning'
  const type = statusType(st) || 'info'
  return `row-status-${type}`
}
```

### Step 4: 跑测试验证 PASS

```
node --test __tests__/status-row-class.test.js
```

Expected: 8 pass.

如果"未知状态 fallback info"失败：检查 statusType 行为 — 它对未知 key 返回 'info'，所以 `row-status-info` 是预期。

### Step 5: 全 JS 测试套件回归

```
npm test
```

Expected: 既有套件总数 + 8 新测试全过。基线见 master 当前 `git log --oneline -1` 加上 v2.30+ 套件改动后的数字。

### Step 6: Commit

```bash
git add web/src/status.js __tests__/status-row-class.test.js
git commit -m "$(cat <<'EOF'
feat(status): rowClassFor — el-table 行级状态色类工具 (v2.33.0)

新增 rowClassFor(status) 把 status 映射为 'row-status-{success|warning|
danger|info}' CSS 类名供 <el-table> :row-class-name 用。沿用
statusType() 色系；idle / 空字符串不返回类（保持默认背景）；
running 在 TYPE_MAP 是 ''（默认回退 info → 浅灰），这里特殊处理为
warning 让"运行中"视觉醒目。

8 单测覆盖：idle / running / success / danger / warning / info /
未知 fallback / 大小写不敏感。
EOF
)"
```

---

## Task 2: AccountTableRows.vue — el-table 上色

**Files:**
- Modify: `web/src/components/AccountTableRows.vue` (el-table 标签 + import + 函数 + style scoped CSS)

### Step 1: 加 `:row-class-name` 到 `<el-table>`

打开 `web/src/components/AccountTableRows.vue`. 找到 line 2-10 的 el-table 开标签：

```vue
  <el-table
    ref="tableRef"
    :data="rows"
    row-key="email"
    stripe border size="small"
    @selection-change="onSelectionChange"
    @expand-change="onExpandChange"
    @row-click="onRowClick"
  >
```

替换为（追加 `:row-class-name="rowClass"`）：

```vue
  <el-table
    ref="tableRef"
    :data="rows"
    row-key="email"
    stripe border size="small"
    :row-class-name="rowClass"
    @selection-change="onSelectionChange"
    @expand-change="onExpandChange"
    @row-click="onRowClick"
  >
```

### Step 2: 加 import + rowClass 函数

找到 line 98：

```js
import { statusType, statusLabel, isFailedToRetry } from '../status'
```

替换为（加 `rowClassFor`）：

```js
import { statusType, statusLabel, isFailedToRetry, rowClassFor } from '../status'
```

在 `defineEmits(...)` 之后（约 line 107 之后）、其它函数定义之前的位置追加：

```js

// v2.33.0: el-table :row-class-name 钩子，按 row._status 上色
function rowClass({ row }) {
  return rowClassFor(row._status)
}
```

### Step 3: 加 style scoped CSS

找到 `<style scoped>` 块（line 162 开始）。在该块**末尾**（紧贴 `</style>` 之前）追加：

```css

/* v2.33.0: 运行时整行高亮，对应 rowClassFor 返回 */
:deep(.row-status-success td) { background-color: #f0f9eb !important; }
:deep(.row-status-warning td) { background-color: #fdf6ec !important; }
:deep(.row-status-danger  td) { background-color: #fef0f0 !important; }
:deep(.row-status-info    td) { background-color: #f4f4f5 !important; }
```

### Step 4: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`，无 Vue 编译错误。常见错误：
- `rowClassFor is not exported` → 检查 Task 1 Step 3 是否已写入
- `rowClass is not defined in template` → 检查 Step 2 函数是否落到 `<script setup>` 顶级作用域

### Step 5: 服务端测试回归

```
cd .. ; npm test
```

Expected: 同 Task 1 Step 5 数字（前端改动不影响后端测试）。

### Step 6: Commit

```bash
git add web/src/components/AccountTableRows.vue
git commit -m "$(cat <<'EOF'
feat(ui): Execute 子组件 row 整行按 status 上色 (v2.33.0)

AccountTableRows.vue 的 <el-table> 加 :row-class-name="rowClass"，
按 row._status 调 rowClassFor()。4 个 CSS 类绑定 4 个 Element Plus
色系的浅色背景：success=#f0f9eb / warning=#fdf6ec /
danger=#fef0f0 / info=#f4f4f5。

Execute.vue 已通过 socketState.accountStatuses watch 实时更新
row._status，所以本提交零改动 Execute.vue —— 整个变化只在子组件
完成。idle 不上色保持默认背景。
EOF
)"
```

---

## Task 3: Accounts.vue — 补 socket 订阅 + el-table 上色

**Files:**
- Modify: `web/src/views/Accounts.vue` (新增 watch socket + el-table +`:row-class-name` + import + 函数 + style scoped CSS)

### Step 1: import rowClassFor

打开 `web/src/views/Accounts.vue`. 找到 status 的 import 行（grep 'from .../status'）。当前长这样（具体内容已被并行 session 改过，但 import 一定在 `<script setup>` 头部）：

读出当前 import：

```
grep -n "from '../status'" web/src/views/Accounts.vue
```

定位后修改：把 import 列表里加入 `rowClassFor`。例如如果当前是：

```js
import { PLUS_STATUSES, ERROR_STATUSES, aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS } from '../status'
```

改为：

```js
import { PLUS_STATUSES, ERROR_STATUSES, aliveStatusType, aliveStatusLabel, ALIVE_FILTER_OPTIONS, rowClassFor } from '../status'
```

（保持原有所有 import，仅追加 `rowClassFor`）

### Step 2: 加 rowClass 函数 + watch socketState.accountStatuses

找到既有 `watch(() => socketState.aliveStatuses, ...)`（约 line 377）：

```js
watch(() => socketState.aliveStatuses, (val) => {
  for (const row of accounts.value) {
    const s = val[row.email]
    if (s) {
      row._aliveStatus = s.alive_status
      row._aliveReason = s.alive_reason
      if (s.alive_checked_at) row._aliveCheckedAt = s.alive_checked_at
    }
  }
}, { deep: true })
```

**在它之后**（紧贴下一行）追加 watch accountStatuses + rowClass 函数：

```js

// v2.33.0: Execute 流水线运行时，账号管理也实时反馈 row 状态变化
watch(() => socketState.accountStatuses, (statuses) => {
  for (const email in statuses) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = statuses[email].status || row._status
      row._phase = statuses[email].phase || row._phase || ''
    }
  }
}, { deep: true })

// v2.33.0: el-table :row-class-name 钩子，按 row._status 上色
function rowClass({ row }) {
  return rowClassFor(row._status)
}
```

注意：Accounts.vue 的 row 在 `load()` 里通过 `accounts.value = acctRes.data.map(a => ({ ...a, _status: ..., _plan: ... }))` 构造（约 line 290+）。所以 row 已有 `_status` 字段；socket watch 仅在 row 已存在时更新。**如果 socket 在 load() 完成之前到达**，accounts.value 是空数组，find 返回 undefined → 跳过 — 等下次 load 后通过同一 watch 再追上（statuses 是 reactive object，deep watch 会在后续 row 添加时不触发；这是边界情况，加载顺序一般是 load 先于第一次 account-status，安全）。

### Step 3: 加 `:row-class-name` 到 `<el-table>`

找到 line 103（`<el-table ref="tableRef" :data="filteredAccounts" ...>`）：

```vue
    <el-table ref="tableRef" :data="filteredAccounts" stripe border size="small" row-key="email" @selection-change="onSelectionChange" @row-click="onRowClick">
```

替换为（追加 `:row-class-name="rowClass"`）：

```vue
    <el-table ref="tableRef" :data="filteredAccounts" stripe border size="small" row-key="email" :row-class-name="rowClass" @selection-change="onSelectionChange" @row-click="onRowClick">
```

### Step 4: 加 style scoped CSS

找到 `<style scoped>` 块（line 601 开始）。在该块**末尾**（紧贴 `</style>` 之前）追加同样的 4 行 CSS：

```css

/* v2.33.0: 运行时整行高亮，对应 rowClassFor 返回 */
:deep(.row-status-success td) { background-color: #f0f9eb !important; }
:deep(.row-status-warning td) { background-color: #fdf6ec !important; }
:deep(.row-status-danger  td) { background-color: #fef0f0 !important; }
:deep(.row-status-info    td) { background-color: #f4f4f5 !important; }
```

### Step 5: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`. 常见错误同 Task 2 Step 4。

### Step 6: 服务端测试回归

```
cd .. ; npm test
```

Expected: 同 Task 1 Step 5 数字。

### Step 7: Commit

```bash
git add web/src/views/Accounts.vue
git commit -m "$(cat <<'EOF'
feat(ui): Accounts 页 row 整行按 status 上色 + 实时 socket 订阅 (v2.33.0)

Accounts.vue 之前完全不订阅 'account-status' socket —— 哪怕
Execute 在跑，Accounts 页的 status / row 都是 load() 拉的静态值。

新增 watch(socketState.accountStatuses, ...) → 找到 email 对应行
就更新 row._status / row._phase，实现执行期间实时反馈。

<el-table> 加 :row-class-name="rowClass" —— 调 rowClassFor()
按 row._status 返回 'row-status-{type}' 浅色背景。CSS 与
AccountTableRows.vue 一致。idle 行不上色保持默认。
EOF
)"
```

---

## Task 4: CHANGELOG v2.33.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.33.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 行之后、紧贴下一个 `## v2.x.x` 之前插入：

```markdown
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

**测试**：runner-of-record 套件 + 8 新 status-row-class 测试。`__tests__/status-row-class.test.js` 8 单测覆盖 idle / running 例外 / 4 个 type / 未知 fallback / 大小写。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-row-highlight-during-execution-design.md`
+ `docs/superpowers/plans/2026-05-25-row-highlight-during-execution.md`。

```

保持现存版本节完整不动。

### Step 2: Final regression

```
npm test
```

Expected: 同 Task 1 Step 5 数字。

### Step 3: 手动 smoke（用户跑）

1. 重启 server + 硬刷 web。
2. **Execute 页 smoke**：跑一个账号执行 → 该行在「运行中」组下底色应是浅黄（warning）；执行完毕后 row 进入终态 group，底色变成对应色（plus 浅绿 / error 浅红 / 等）。
3. **Accounts 页 smoke**：在 Execute 页跑账号的**同时**，切到 Accounts 页 → 应能看到那个账号的 row 实时变成 warning 黄色；执行完毕变终态色。
4. **idle 不上色**：找一个 status=idle 的账号，row 应保持默认背景（无浅色）。
5. **hover 仍可识别行焦点**：鼠标悬停在已上色的 row 上，应能看到比浅色更深的灰色覆盖（el-table 默认 hover）。

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.33.0 — 账号行运行时整行高亮"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 目标 + 颜色映射表 → Task 1（rowClassFor 实现 + 测试）+ Task 2/3（接线）+ Task 4 CHANGELOG。
- Spec §3.1 rowClassFor 函数 → Task 1 Step 3。
- Spec §3.2 4 个 CSS 类 → Task 2 Step 3 + Task 3 Step 4（两处一致）。
- Spec §3.3 Execute / AccountTableRows 接线 → Task 2 全部 step。
- Spec §3.4 Accounts.vue 接线（socket 订阅 + row-class-name + CSS）→ Task 3 全部 step。
- Spec §3.5 边界 8 条 → 由实现 + 测试覆盖（idle / running 例外 / statusType 单一来源 / hover / zebra / 不改 TYPE_MAP / phase 不参与色 / 加载顺序）。Task 1 测试用例直接验 idle + running + 各色 + 未知 + 大小写；其余通过代码注释表达。
- Spec §4 8 单测 → Task 1 Step 1 全部到位。
- Spec §5 文件清单 → matches Task 1+2+3+4。
- Spec §6 YAGNI → 不引 phase 维度 / 不改 statusType / 不改 Dashboard / 不改 Results / 后端零改动 —— 计划严格遵守。
- Spec §7 v2.33.0 → Task 4 Step 1。

**2. Placeholder scan:** 无 "TBD" / "implement later"。每步含完整代码、确切命令、期望输出。

注意 Task 3 Step 1 提示 "import 列表已被并行 session 改过，先 grep 定位再追加 rowClassFor" —— 不是占位符，是因为 Accounts.vue 的 import 在另一个 session 持续演进，无法把当前确切行内容写死。所以**给出 grep 命令 + 追加规则**已经是确定的"how"。

**3. Type/symbol consistency:**

- `rowClassFor` —— Task 1 Step 3 定义（status.js 导出），Task 1 Step 1 测试调用，Task 2 Step 2 + Task 3 Step 1 import；Task 2 Step 2 + Task 3 Step 2 的 `rowClass` 函数内调用 `rowClassFor(row._status)`。一致。
- `rowClass({ row })` —— Vue `:row-class-name` 钩子签名（el-table 文档定义入参为 `{ row, rowIndex }`），Task 2 Step 1 模板 / Step 2 函数定义 + Task 3 Step 3 模板 / Step 2 函数定义 4 处对齐。
- CSS 类名 `row-status-success` / `row-status-warning` / `row-status-danger` / `row-status-info` —— Task 1 Step 3 `rowClassFor` 返回串、Task 1 Step 1 测试断言、Task 2 Step 3 + Task 3 Step 4 CSS 选择器，6 处一致。
- `socketState.accountStatuses` 字段 shape `{email, phase, progress, status}` —— socket.js 既有，Task 3 Step 2 watch handler 读 `status` / `phase` 与之匹配。

无 issue。Plan ready.
