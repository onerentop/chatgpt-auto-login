# v2.33.0 — 账号行运行时整行高亮设计

## 1. 背景

Execute.vue 和 Accounts.vue 都展示账户列表，但运行流水线（执行 / 测活）期间用户难以一眼看出每个账户的当前状态：

- **Execute.vue**：已实时收 `account-status` socket 更新 `row._status` / `row._phase`，但 row 本身不变色 —— 只有「状态」列的 el-tag 颜色变化（小图标，不显眼）
- **Accounts.vue**：完全**不订阅** `account-status` socket —— 哪怕 Execute 在跑，Accounts 页的 status 列也是静态（只在 `load()` 时拉一次）

用户希望两页都在运行时让整行换底色，扫一眼识别进度。

## 2. 目标

- 两页 `<el-table>` 加 row-class-name，按 `_status` 映射到 4 个 Element Plus 类型色（success/warning/danger/info），row 整行换浅色背景
- Accounts.vue 补上 `account-status` socket 订阅，让 Execute 在跑时 Accounts 也实时反映 row 状态变化
- idle 状态保持默认（不上色），避免视觉噪声
- 沿用 statusType()，不引入新色系；唯一例外：`running` 在 TYPE_MAP 里是 `''`（回退 info），我们要把它特殊处理为 warning，让"运行中"明显可见

## 3. 方案

### 3.1 新增工具函数 `web/src/status.js:rowClassFor`

```js
// v2.33.0: 给 <el-table> :row-class-name 用。
// 返回 'row-status-{type}' 或 '' (idle 时不高亮)。
// 大部分 status 直接复用 statusType()；唯一例外是 running ——
// TYPE_MAP['running'] 是 ''，statusType 会回退 'info' 渲染浅灰，
// 但运行中需要明显的"在跑"信号，所以特殊处理成 warning（浅黄）。
export function rowClassFor(status) {
  const st = (status || '').toLowerCase()
  if (!st || st === 'idle') return ''
  if (st === 'running') return 'row-status-warning'
  const type = statusType(st) || 'info'
  return `row-status-${type}`
}
```

放在 `statusLabel()` 之后、`PLUS_STATUSES` 常量之前。

### 3.2 CSS 4 个类（写到 Accounts.vue 和 AccountTableRows.vue 的 `<style scoped>` 末尾）

```css
:deep(.row-status-success td) { background-color: #f0f9eb !important; }
:deep(.row-status-warning td) { background-color: #fdf6ec !important; }
:deep(.row-status-danger  td) { background-color: #fef0f0 !important; }
:deep(.row-status-info    td) { background-color: #f4f4f5 !important; }
```

- `:deep()` 穿透 Vue scoped style，让选择器命中 el-table 内部生成的 td
- `!important` 覆盖 el-table 自身的 zebra 条纹 / hover 默认色
- hover 时 el-table 的默认 `#f5f7fa` 仍生效，作为更深一层焦点提示

### 3.3 Execute.vue / AccountTableRows.vue 接线

`AccountTableRows.vue` 的 `<el-table>`：

```vue
<el-table :data="rows" :row-class-name="rowClass" ...>
```

`<script setup>` 加：

```js
import { rowClassFor } from '../status'

function rowClass({ row }) {
  return rowClassFor(row._status)
}
```

Execute.vue 已经实时更新 `row._status`（watch socketState.accountStatuses → 写 row._status），所以本节零改动 Execute.vue —— 全部在子组件 AccountTableRows.vue 完成。

### 3.4 Accounts.vue 接线 — 补 socket 订阅 + row-class-name

**新增 socket 订阅**：

```js
import { socketState } from '../socket'  // 应已 import

watch(() => socketState.accountStatuses, (statuses) => {
  for (const email in statuses) {
    const row = accounts.value.find(a => a.email === email)
    if (row) {
      row._status = statuses[email].status || row._status
      row._phase = statuses[email].phase || row._phase || ''
    }
  }
}, { deep: true })
```

放在既有 `watch(() => socketState.aliveStatuses, ...)` 之后。`row._phase` 不参与背景色，但顺手存一份方便将来扩展。

**`<el-table>` 加 row-class-name**：

```vue
<el-table :data="filteredAccounts" :row-class-name="rowClass" ...>
```

`<script setup>` 加 `rowClass` 函数（同 3.3）。

### 3.5 边界 / 不变式

- **§3.5.1 idle 不高亮**：`rowClassFor('idle') === ''` → row 用默认背景（与 zebra 条纹兼容）。
- **§3.5.2 running 特殊处理**：running 是 TYPE_MAP 里唯一 type=`''` 的状态，强制映射到 warning（浅黄），让"运行中"视觉醒目。
- **§3.5.3 statusType 单一来源**：除了 running 例外，所有其它状态颜色严格来自 `statusType()`。新增 status 码自动 pickup（plus_no_rt → warning → 浅黄、token_expired → warning → 浅黄、等）。
- **§3.5.4 hover 仍可识别行焦点**：el-table 自身 hover 用 `#f5f7fa`（浅灰），跟我们的浅色 row 背景重叠时仍能看出 "鼠标当前指向这一行"。
- **§3.5.5 zebra 不再可见**：el-table 默认 zebra 用奇偶行不同灰度；上色后 zebra 被 `!important` 覆盖，但 idle 行仍可见 zebra。
- **§3.5.6 不改 statusType / LABEL_MAP / TYPE_MAP**：避免影响 el-tag 渲染（状态列的 tag 颜色不动 — 跟 v2.32.x 保持一致）。
- **§3.5.7 phase 不参与颜色**：YAGNI。phase 只存在 row._phase 字段供未来用，不映射到颜色。
- **§3.5.8 Accounts.vue socket 订阅幂等**：watch deep + 找到 email 才更新 —— 加载顺序（先 load() 后 socket）和反过来都不会丢更新。

## 4. 测试

新增 `__tests__/status-row-class.test.js`：

```js
const test = require('node:test')
const assert = require('node:assert')
const { rowClassFor } = require('../web/src/status.js')

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

test('rowClassFor: info 状态（no_promo / aborted / canceled）', () => {
  assert.strictEqual(rowClassFor('no_promo'), 'row-status-info')
  assert.strictEqual(rowClassFor('aborted'), 'row-status-info')
})

test('rowClassFor: 未知状态 fallback info', () => {
  assert.strictEqual(rowClassFor('made_up'), 'row-status-info')
})

test('rowClassFor: 大小写不敏感', () => {
  assert.strictEqual(rowClassFor('PLUS'), 'row-status-success')
  assert.strictEqual(rowClassFor('Running'), 'row-status-warning')
})
```

注意：status.js 是 ESM 但项目使用 require(...) 在 node:test 里能读，因为 status.js 没有顶部 `export default` 也无副作用 import；如果 require 不可行，改用动态 `await import()` 或加一行 CommonJS 兼容包装。**实施时如果 require 报错，把测试改成 dynamic import**。

## 5. 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/status.js` | +`rowClassFor(status)` 工具函数 |
| `__tests__/status-row-class.test.js` | +8 单测 |
| `web/src/components/AccountTableRows.vue` | el-table +`:row-class-name`、import + 函数、style scoped CSS |
| `web/src/views/Accounts.vue` | watch accountStatuses 新增、el-table +`:row-class-name`、import + 函数、style scoped CSS |
| `docs/CHANGELOG.md` | v2.33.0 节 |

后端零改动。Execute.vue 也零改动（实时数据流已有，只动子组件）。

## 6. YAGNI / 不做的

- 不引入 phase 维度颜色 / 动画 / 进度条
- 不改 statusType / TYPE_MAP / LABEL_MAP
- 不为 Accounts.vue / Execute.vue 加新 status 码
- 不动 Dashboard.vue（统计页不需要 row 高亮）
- 不做 Results.vue（结果页是历史快照，进度 / 运行态语义不适用）

## 7. 版本

v2.33.0 — minor over v2.32.2（前端 UX 增强 + 1 个新工具函数）。
