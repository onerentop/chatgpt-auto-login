# v2.34.0 Execute 分组锁定 + 视图切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute.vue 分组视图加 sticky grouping（startExec 快照 `_groupStatus = _status`，分组按 `_groupStatus` 走，row 不跨组）+ 视图切换开关（分组 / 平铺 二选一）。

**Architecture:** `groupAccountsByStatus` 改读 `_groupStatus || _status`（向后兼容）。Execute.vue startExec 加快照循环；toolbar 加 `el-switch`；模板 v-if/v-else 切分组 collapse / 平铺单 AccountTableRows。

**Tech Stack:** Vue 3 + Element Plus + node:test。

**Spec:** `docs/superpowers/specs/2026-05-25-execute-sticky-grouping-and-view-toggle-design.md`

---

## File Structure

| 文件 | 改动 |
|---|---|
| `web/src/status.js` | `groupAccountsByStatus` 读 `_groupStatus \|\| _status \|\| 'idle'` |
| `__tests__/status-groups.test.js` | +2 测试（G11 _groupStatus 优先 / G12 falsy fallback） |
| `web/src/views/Execute.vue` | startExec 加快照、引入 GROUP_ORDER 与 groupingEnabled ref、flatSortedRows computed、toolbar el-switch、模板 v-if/v-else |
| `docs/CHANGELOG.md` | v2.34.0 节 |

依赖：Task 1（status.js 兼容修改 + 测试）→ Task 2（Execute.vue 整合 + 模板）→ Task 3（CHANGELOG）。Task 1/2 严格顺序——Task 2 依赖 Task 1 的新分组行为。

---

## Task 1: status.js — groupAccountsByStatus 优先读 `_groupStatus`

**Files:**
- Modify: `web/src/status.js` (line ~140 `groupAccountsByStatus` 函数体内)
- Modify: `__tests__/status-groups.test.js` (append 2 测试)

### Step 1: 写失败测试 — append to `__tests__/status-groups.test.js`

打开 `__tests__/status-groups.test.js`. 在文件末尾追加：

```js
test('G11 v2.34.0 _groupStatus 优先于 _status 分组', () => {
  const rows = [
    { email: 'a', _status: 'plus', _groupStatus: 'idle' },
    { email: 'b', _status: 'running', _groupStatus: 'idle' },
    { email: 'c', _status: 'error' },  // 无 _groupStatus → 走 _status
  ]
  const groups = groupAccountsByStatus(rows)
  const idleGroup = groups.find(g => g.status === 'idle')
  const errorGroup = groups.find(g => g.status === 'error')
  assert.ok(idleGroup, 'idle 组存在')
  assert.strictEqual(idleGroup.rows.length, 2, 'a + b 锁在 idle 组')
  assert.deepStrictEqual(idleGroup.rows.map(r => r.email), ['a', 'b'])
  assert.ok(errorGroup, 'error 组存在')
  assert.strictEqual(errorGroup.rows.length, 1)
  assert.strictEqual(errorGroup.rows[0].email, 'c')
  // plus 组不应存在（a 锁定到 idle，没有真正的 plus row）
  assert.ok(!groups.find(g => g.status === 'plus'), 'plus 组应为空被隐藏')
})

test('G12 v2.34.0 _groupStatus 为空串/null 时退回 _status', () => {
  const rows = [
    { email: 'a', _status: 'plus', _groupStatus: '' },
    { email: 'b', _status: 'error', _groupStatus: null },
    { email: 'c', _status: 'idle', _groupStatus: undefined },
  ]
  const groups = groupAccountsByStatus(rows)
  // 空/null/undefined 走 || fallback → 用 _status
  assert.ok(groups.find(g => g.status === 'plus'), 'a 落到 plus 组')
  assert.ok(groups.find(g => g.status === 'error'), 'b 落到 error 组')
  assert.ok(groups.find(g => g.status === 'idle'), 'c 落到 idle 组')
})
```

### Step 2: 跑测试验证 FAIL

```
node --test __tests__/status-groups.test.js
```

Expected: 既有 10 测试 pass + G11/G12 FAIL（G11 因为当前 `groupAccountsByStatus` 只读 `_status` —— a 会落到 plus 组、b 会落到 running 组、idleGroup 应只有 1 个 row 而不是 2 个 → 断言失败；G12 应该意外通过，但保险起见 expect FAIL until 改完）。

### Step 3: 实现 — 改 `groupAccountsByStatus`

打开 `web/src/status.js`. 找到 `groupAccountsByStatus` 函数（约 line 138-164）。当前 line 142:

```js
  for (const row of rows) {
    const s = row._status || 'idle'
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s).push(row)
  }
```

替换为：

```js
  for (const row of rows) {
    // v2.34.0: 分组优先看 _groupStatus（执行时快照，sticky grouping）；
    // 未设回退 _status。Execute.vue 调 startExec 时给 batch rows 设
    // _groupStatus = _status，之后 socket 更新只动 _status（驱动行
    // 颜色），row 不跨组。Accounts.vue 没 _groupStatus 概念，自动
    // fallback 到 _status 行为不变。
    const s = row._groupStatus || row._status || 'idle'
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s).push(row)
  }
```

同时更新该函数 JSDoc 注释（line 134-137 区域）：

```js
/**
 * 按状态分桶 + 按 GROUP_ORDER 排序 + 隐藏空组
 * @param {Array} rows — 账户行（优先读 _groupStatus，未设回退 _status，缺失视为 'idle'）
 * @returns {Array<{ status, label, type, rows, count }>}
 */
```

### Step 4: 跑测试验证 PASS

```
node --test __tests__/status-groups.test.js
```

Expected: 全 12 测试 pass。

如果 G11 `idleGroup.rows.length === 2` 失败：检查 `||` 运算符行为 —— `'idle' || 'plus'` 应返回 `'idle'`（truthy 短路）。

### Step 5: 全套件回归

```
npm test
```

Expected: 既有 baseline + 2 新增全过（"fail 0"）。

### Step 6: Commit

```bash
git add web/src/status.js __tests__/status-groups.test.js
git commit -m "$(cat <<'EOF'
feat(status): groupAccountsByStatus 优先读 _groupStatus (v2.34.0)

为 Execute.vue 即将引入的 sticky grouping 做准备：分组函数读
`_groupStatus || _status || 'idle'`。未设 _groupStatus 的 row（含
Accounts.vue 的全部 row 和 Execute.vue 刷新后的 row）行为完全不变
—— 向后兼容。

新增 2 单测：
- G11 _groupStatus 优先于 _status 分组（plus row 锁到 idle 组）
- G12 _groupStatus 空串/null/undefined 时退回 _status
EOF
)"
```

---

## Task 2: Execute.vue — startExec 快照 + 视图切换

**Files:**
- Modify: `web/src/views/Execute.vue` (toolbar / script setup / template)

### Step 1: 在 startExec 内加快照循环

打开 `web/src/views/Execute.vue`. 找到 `startExec` 函数（约 line 324-339）。当前：

```js
async function startExec(emails) {
  try {
    // Snapshot current filtered list → freeze view until user changes a filter
    lockedEmails.value = new Set(filteredRows.value.map(r => r.email))
    socketState.logs.splice(0)
    socketState.accountStatuses = {}
    // Preset selected accounts to 'running'/'queued' for immediate visual feedback.
    // Engine will overwrite with real status as each one progresses.
    for (const a of accounts.value) {
      if (!emails || emails.includes(a.email)) { a._status = 'running'; a._phase = 'queued' }
    }
    await api.post('/execute', { emails: emails || undefined })
    running.value = true
    ElMessage.success('执行已启动')
  } catch (e) { ElMessage.error(e.response?.data?.error || '启动失败') }
}
```

**在 `lockedEmails.value = new Set(...)` 之后、`socketState.logs.splice(0)` 之前**插入 sticky snapshot（**必须在 `_status = 'running'` 预设之前**，否则快照会捕获 'running' 而不是真实旧状态）：

```js
    lockedEmails.value = new Set(filteredRows.value.map(r => r.email))

    // v2.34.0: sticky grouping —— 快照当前真实 _status 到 _groupStatus，
    // 之后 socket 更新只动 _status（驱动行颜色），row 不跨组。
    // 必须在下面的 _status = 'running' 预设之前，否则快照会捕获 'running'
    // 而不是真实旧状态。每次 startExec 都覆盖快照（"第二次执行"基于
    // "第二次开始时"的真实状态）。
    for (const row of filteredRows.value) {
      row._groupStatus = row._status
    }

    socketState.logs.splice(0)
    socketState.accountStatuses = {}
```

其它代码不动。

### Step 2: 引入 GROUP_ORDER + groupingEnabled ref + flatSortedRows computed

找到 line 97 既有 import：

```js
import { statusType, statusLabel, PLUS_STATUSES, ERROR_STATUSES, DEFAULT_EXPANDED_STATUSES, groupAccountsByStatus, isFailedToRetry, EXECUTE_STATUS_FILTER_OPTIONS } from '../status'
```

替换为（加 `GROUP_ORDER`）：

```js
import { statusType, statusLabel, PLUS_STATUSES, ERROR_STATUSES, DEFAULT_EXPANDED_STATUSES, groupAccountsByStatus, isFailedToRetry, EXECUTE_STATUS_FILTER_OPTIONS, GROUP_ORDER } from '../status'
```

找到 line 104 `const expandedKeys = ref([...DEFAULT_EXPANDED_STATUSES])`。**在它之后**插入：

```js
// v2.34.0: 分组视图开关，默认 true（沿用分组语义）
const groupingEnabled = ref(true)
```

找到 line 169 `const visibleGroups = computed(() => groupAccountsByStatus(filteredRows.value))`。**在它之后**插入：

```js
// v2.34.0: 平铺视图的排序计算 —— 按 GROUP_ORDER 业务优先序，
// 同 status 内保持稳定排序（filteredRows 的插入顺序）
const flatSortedRows = computed(() => {
  const orderIndex = new Map(GROUP_ORDER.map((s, i) => [s, i]))
  return [...filteredRows.value].sort((a, b) => {
    const ia = orderIndex.has(a._status) ? orderIndex.get(a._status) : 999
    const ib = orderIndex.has(b._status) ? orderIndex.get(b._status) : 999
    return ia - ib
  })
})
```

### Step 3: toolbar 加 el-switch

打开 template 区域。找到 line 28-29（既有 download / 取消选中按钮区域结尾）：

```vue
        <el-button :disabled="selectedEmails.length === 0" style="margin-left:8px" @click="clearAllSelection">取消选中</el-button>
        <el-divider direction="vertical" />
```

替换为（在「取消选中」之后、`<el-divider>` 之前插入 el-switch）：

```vue
        <el-button :disabled="selectedEmails.length === 0" style="margin-left:8px" @click="clearAllSelection">取消选中</el-button>
        <el-divider direction="vertical" />
        <el-switch
          v-model="groupingEnabled"
          active-text="分组"
          inactive-text="平铺"
          inline-prompt
          style="margin-left:4px"
        />
        <el-divider direction="vertical" />
```

注意：原本 line 29 后已有 `<el-divider direction="vertical" />` —— 把 switch 插在两个 divider 之间。如果担心 divider 数量乱，改用「保留一个 divider」: 把 switch 替代某个 divider 的对应位置。**实现时择保证 toolbar 不臃肿的版本**。

### Step 4: 模板切分组 / 平铺

找到 line 62-88（既有 `<el-collapse>` ... `</el-collapse>`）。当前：

```vue
    <!-- Status-grouped tables with expandable logs -->
    <el-collapse v-model="expandedKeys" style="margin-top:8px">
      <el-collapse-item
        v-for="g in visibleGroups"
        :key="g.status"
        :name="g.status"
      >
        <template #title>
          <div style="display:flex;align-items:center;gap:8px;padding:0 8px">
            <el-tag :type="statusType(g.status)" size="small">{{ statusLabel(g.status) }}</el-tag>
            <span style="color:#909399;font-size:13px">共 {{ g.count }} 个</span>
          </div>
        </template>
        <AccountTableRows
          :ref="el => { if (el) groupRefs[g.status] = el }"
          :rows="g.rows"
          :running="running"
          :global-selected-set="globalSelectedSet"
          :get-history-logs="getHistoryLogs"
          :get-realtime-logs="getRealtimeLogs"
          @group-selection-change="onGroupSelectionChange(g.status, $event)"
          @expand-change="onExpand"
          @row-action="onRowAction"
          @auth-download="onAuthDownload"
          @row-click="onRowClick"
        />
      </el-collapse-item>
    </el-collapse>
```

替换为（v-if/v-else 切两个视图）：

```vue
    <!-- v2.34.0: 视图切换 —— 分组 collapse 面板 / 平铺单 table -->
    <el-collapse v-if="groupingEnabled" v-model="expandedKeys" style="margin-top:8px">
      <el-collapse-item
        v-for="g in visibleGroups"
        :key="g.status"
        :name="g.status"
      >
        <template #title>
          <div style="display:flex;align-items:center;gap:8px;padding:0 8px">
            <el-tag :type="statusType(g.status)" size="small">{{ statusLabel(g.status) }}</el-tag>
            <span style="color:#909399;font-size:13px">共 {{ g.count }} 个</span>
          </div>
        </template>
        <AccountTableRows
          :ref="el => { if (el) groupRefs[g.status] = el }"
          :rows="g.rows"
          :running="running"
          :global-selected-set="globalSelectedSet"
          :get-history-logs="getHistoryLogs"
          :get-realtime-logs="getRealtimeLogs"
          @group-selection-change="onGroupSelectionChange(g.status, $event)"
          @expand-change="onExpand"
          @row-action="onRowAction"
          @auth-download="onAuthDownload"
          @row-click="onRowClick"
        />
      </el-collapse-item>
    </el-collapse>

    <!-- v2.34.0: 平铺视图 —— 单 AccountTableRows 渲染全部 filteredRows（按 GROUP_ORDER 排序） -->
    <AccountTableRows
      v-else
      :rows="flatSortedRows"
      :running="running"
      :global-selected-set="globalSelectedSet"
      :get-history-logs="getHistoryLogs"
      :get-realtime-logs="getRealtimeLogs"
      @group-selection-change="onGroupSelectionChange('__flat__', $event)"
      @expand-change="onExpand"
      @row-action="onRowAction"
      @auth-download="onAuthDownload"
      @row-click="onRowClick"
      style="margin-top:8px"
    />
```

**注意**：`@group-selection-change="onGroupSelectionChange('__flat__', $event)"` —— 复用既有 handler，传一个占位 status `'__flat__'`。既有 onGroupSelectionChange 内部应是基于 `globalSelectedSet` 的 add/delete 逻辑（不依赖 status 参数做组级 dedupe）。**实施时打开 onGroupSelectionChange 确认是否仍能正确工作**。如果它依赖 status 做组内 reservation 处理，可能需要小调整 —— 见 Step 5 验证。

### Step 5: 验证 onGroupSelectionChange 在 flat 视图下行为

读 Execute.vue 中 `onGroupSelectionChange` 函数体。如果它内部用 status 参数做组级 dedupe（例如清除该组以外的选中），传 `'__flat__'` 时可能误清空 —— 需要 short-circuit：

```js
function onGroupSelectionChange(status, rows) {
  if (status === '__flat__') {
    // 平铺视图：直接覆盖全局选中 = rows
    clearSelection('execute')
    for (const r of rows) globalSelectedSet.add(r.email)
    return
  }
  // 既有分组逻辑
  ...
}
```

**实施时打开函数判断 —— 如果函数已是"接收当前组选中行集合 → 合并到 globalSelectedSet"语义，不需要 short-circuit 也能正常工作。否则按上面补 `'__flat__'` 分支。**

### Step 6: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`. 常见错误：
- `GROUP_ORDER is not exported` → status.js 检查（应已 export）
- `flatSortedRows is not defined` → Step 2 computed 没落到 `<script setup>` 顶级
- `groupingEnabled is not defined` → Step 2 ref 没落
- el-switch 渲染异常 → 检查 Element Plus 版本（项目已用 el-switch，应正常）

### Step 7: 服务端测试回归

```
cd .. ; npm test
```

Expected: 既有套件（含 Task 1 新增 G11/G12）全过 "fail 0"。

### Step 8: Commit

```bash
git add web/src/views/Execute.vue
git commit -m "$(cat <<'EOF'
feat(execute): sticky grouping 快照 + 分组/平铺视图切换 (v2.34.0)

两项 UX 改进：

1) Sticky grouping：startExec 时给 filteredRows 设 _groupStatus =
   _status 快照。后续 socket 更新只动 _status（驱动行颜色 v2.33），
   row 不跨组。仅刷新页面清快照（loadResults 重建 accounts.value
   时新 row 自动无 _groupStatus）。

2) 视图切换：toolbar 加 el-switch（分组/平铺）；
   - 分组：既有 <el-collapse> + AccountTableRows 子组件
   - 平铺：单 AccountTableRows 渲染 flatSortedRows（按 GROUP_ORDER
     业务优先序 + 同 status 内稳定插入序）

复用既有 globalSelectedSet 跨视图选择保持一致。onGroupSelectionChange
平铺视图传 '__flat__' 占位 status。
EOF
)"
```

---

## Task 3: CHANGELOG v2.34.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.34.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 行之后、下一个 `## v2.x.x` 之前插入：

```markdown
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

选择跨视图保持一致（复用既有 globalSelectedSet）。

**测试**：`__tests__/status-groups.test.js` +2（G11 `_groupStatus` 优先于
`_status` / G12 falsy fallback）。`groupAccountsByStatus` 改动**向后
兼容** —— Accounts.vue 不受影响（其 row 没 `_groupStatus` 概念）。

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-execute-sticky-grouping-and-view-toggle-design.md`
+ `docs/superpowers/plans/2026-05-25-execute-sticky-grouping-and-view-toggle.md`。

```

保持其它版本节完整不动。

### Step 2: Final regression

```
npm test
```

Expected: 全套件 "fail 0"。

### Step 3: 手动 smoke（用户跑）

1. 重启 server + 硬刷 web。
2. **分组视图 sticky smoke**：
   - 进 Execute 页 → 找一个 idle 账户在 idle 组 → 点「执行选中」
   - 该 row 应**留在 idle 组**（不跨到 running 组）；同时 row 底色应变浅蓝（v2.33 running 色）+ 左边蓝边
   - 执行完成后，row 仍**停在 idle 组**，但底色变成终态色（plus 浅绿 / error 浅红等）
   - 硬刷页面 → row 跳到真实分组（plus 跳到 plus 组、error 跳到 error 组）
3. **二次执行覆盖**：跑完一次后不刷新，再点「执行选中」该 row → 快照覆盖为终态色对应组（比如 plus 组），新执行时 row 锁定在 plus 组。
4. **平铺视图 smoke**：toggle 「分组」→「平铺」→ 整张表平铺，按 plus → running → error → ... → idle 顺序排
5. **选择跨视图保持**：在分组视图选 2 个账户 → 切到平铺 → 选中状态保持。

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.34.0 — Execute 分组锁定 + 视图切换"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景 + §2 目标：informational + 由 Task 1+2 共同实现。
- Spec §3.1 `groupAccountsByStatus` 改读 `_groupStatus || _status` → Task 1 Step 3。
- Spec §3.2 startExec 快照 → Task 2 Step 1。
- Spec §3.3 视图切换 toggle + flatSortedRows + template 分支 → Task 2 Steps 2/3/4。
- Spec §3.4 仅刷新解锁（loadResults 自然清）→ 由 Task 2 Step 1 行为兜底，CHANGELOG 显式描述。
- Spec §3.5 边界 7 条 → 由 Task 2 实现 + CHANGELOG + 代码注释覆盖。
- Spec §3.6 持久化 = 无 → 不引入 DB 改动（Task 列表无后端 task 证实）。
- Spec §4 测试 G11/G12 → Task 1 Step 1。
- Spec §5 文件清单 → matches Task 1+2+3。
- Spec §6 YAGNI → 计划严格遵守（不持久化 / 不改 Accounts.vue / 不改 row 高亮 / 不加排序）。
- Spec §7 v2.34.0 → Task 3 Step 1。

**2. Placeholder scan:** 无 "TBD" / "implement later"。Task 2 Step 5 提到"实施时判断 onGroupSelectionChange 行为"——是给定 condition 的两种确切处理路径（直接复用 vs 加 short-circuit 分支），不是占位符。

**3. Type/symbol consistency:**

- `_groupStatus` —— Task 1 Step 3 在 status.js 读、Task 1 Step 1 测试用、Task 2 Step 1 startExec 写、CHANGELOG 描述。4 处拼写一致。
- `groupingEnabled` —— Task 2 Step 2 ref 定义、Step 3 el-switch v-model、Step 4 template v-if。3 处一致。
- `flatSortedRows` —— Task 2 Step 2 computed 定义、Step 4 template `:rows="flatSortedRows"`。一致。
- `GROUP_ORDER` —— status.js 已 export（既存）、Task 2 Step 2 import + Step 2 computed 使用。一致。
- `onGroupSelectionChange` —— 既存函数；Task 2 Step 4 template 传 `'__flat__'` 占位；Step 5 给出"若需要"补 short-circuit 的具体代码。函数签名 `(status, rows)` 在两处使用一致。

无 issue。Plan ready.
