# Execute.vue 选中操作迁移到 ContextActionBar 设计

> **状态**：设计完成，等待审查 → 转 writing-plans。
> **版本目标**：v2.41.1
> **关联前置**：v2.35 ContextActionBar 组件、Accounts.vue 已应用模式

---

## 1. 目标 / 背景

`web/src/views/Accounts.vue` v2.35 起用 `web/src/components/ui/ContextActionBar.vue` 实现"选中 > 0 时底部悬浮操作 bar"模式 — 顶部工具栏只放全局操作，与选中相关的批量操作走 ContextActionBar。

`web/src/views/Execute.vue` 顶部工具栏目前混着全局操作和选中相关操作（"执行选中 (N)" / "下载选中 (N)" / "取消选中"），样式与 Accounts 不一致。本次迁移使两个视图体验统一。

---

## 2. 当前状态对照

**Execute.vue:14-52 顶部工具栏 row 1**（8 项）：

| 按钮 | 选中相关? | 处理方案 |
|---|---|---|
| 执行选中 (N) | ✅ | **移到 ContextActionBar** |
| 执行全部 | ❌ | 顶部保留 |
| 重试失败 (N) | ❌（基于 status filter） | 顶部保留 |
| 停止 | ❌ | 顶部保留 |
| 下载选中 (N) CPA/Sub2API dropdown | ✅ | **移到 ContextActionBar** |
| 下载全部 (ZIP) CPA/Sub2API dropdown | ❌ | 顶部保留 |
| 取消选中 | ✅ | **删除**（ContextActionBar 内置 clear 按钮代替） |
| 分组/平铺 el-switch | ❌ | 顶部保留 |

---

## 3. 改动后布局

**顶部工具栏 row 1**（5 项 + 一个 switch）：

```
[执行全部] [重试失败 (N)] [停止] | [下载全部 (ZIP) ▼] | [分组/平铺]
```

**ContextActionBar（选中 > 0 时滑入 fixed bottom 中央）**：

```
[N 个账号] | [执行选中] [下载选中 ▼ CPA/Sub2API] | [取消选中 (内置 clear)]
```

ContextActionBar 内置 `@clear` 是 element 末尾的 `取消选中` el-button-text，emit `clear` → 调 `clearAllSelection()`。

---

## 4. 实现细节

### 4.1 `web/src/views/Execute.vue` 改动

**`<template>` 部分**：

1. 顶部工具栏 row 1 **删除** 3 个 element：
   - `<el-button>执行选中 (N)</el-button>` (line 16-18)
   - `<el-dropdown split-button>下载选中</el-dropdown>` (line 25-33)
   - `<el-button>取消选中</el-button>` (line 43)
   - 也删除前后多余的 `<el-divider direction="vertical" />` (line 24 之类)

2. SectionCard 之外、`<el-collapse>` / 平铺 table 之外，加 `<ContextActionBar>`（建议放在整个 `<div class="ex-page">` 末尾、`</template>` 之前，与 Accounts.vue:85 同位置）：

```vue
<ContextActionBar :count="selectedEmails.length" label="个账号" @clear="clearAllSelection">
  <el-button type="success" :disabled="running" @click="execSelected">
    执行选中
  </el-button>
  <el-dropdown @command="downloadSelectedAs" split-button size="default">
    下载选中
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="cpa">CPA 格式</el-dropdown-item>
        <el-dropdown-item command="sub2api">Sub2API 格式</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</ContextActionBar>
```

注意 button 文案去掉 `(N)` 计数 — 计数在 ContextActionBar 左侧 `[N 个账号]` 已显示，避免重复。

**`<script setup>` 部分**：

3. 加 import：
   ```js
   import ContextActionBar from '../components/ui/ContextActionBar.vue'
   ```
   插在既有 `import { getSelectionSet, clearSelection } from '../selection'` (line 126) 附近。

### 4.2 不动的

- script setup 函数体不变（`execSelected` / `downloadSelectedAs` / `clearAllSelection` 都不动）
- row 2 筛选区不动
- AccountTableRows 组件不动
- 分组 / 平铺切换 + el-collapse 逻辑不动
- `selectedEmails` / `globalSelectedSet` / `failedEmails` 计算属性不动
- `server/routes/results.js` 后端 endpoints 不动

---

## 5. 测试

**手动验证清单**：

1. **空选中** — ContextActionBar 不显示，顶部工具栏 5 项操作可见
2. **选 1 个** — ContextActionBar 滑入（fixed bottom 中央），显示"1 个账号 | 执行选中 | 下载选中 ▼ | 取消选中"
3. **选 N 个** — 数字更新为 N
4. **执行选中** — pipeline 启动，与原"执行选中 (N)"按钮行为一致
5. **下载选中 (CPA)** — POST `/api/results/download-selected {format:'cpa'}` 拿 ZIP
6. **下载选中 (Sub2API)** — POST `/api/results/download-selected {format:'sub2api'}` 拿 ZIP
7. **取消选中** — ContextActionBar 内置 clear 按钮触发，selection 清空，bar 滑出
8. **running 时执行选中** — 按钮 disabled（与"执行全部"一致）
9. **顶部工具栏** — 执行全部 / 重试失败 / 停止 / 下载全部 / 分组开关 5 项行为不变
10. **窗口 resize / 滚动** — ContextActionBar `position:fixed` 仍居中底部，不被表格遮挡

**自动化测试**：纯 UI 改动，npm test 不覆盖前端组件（项目无 Vue 测试套件）。218 既有 Node 测试 baseline 保持。

---

## 6. 不变式

- ContextActionBar 组件本体（`web/src/components/ui/ContextActionBar.vue`）零改动
- Accounts.vue 行为零改动
- `selectedEmails` / `globalSelectedSet` 选中状态机制不变
- 后端 API 零改动
- `/api/results/*` 全部 endpoints 留用

---

## 7. 不在范围

- 不调整 Accounts.vue 的 ContextActionBar 用法
- 不重构 selection store (`web/src/selection.js`)
- 不动后端
- 不改"重试失败 (N)"按钮（保留顶部，按钮基于 `failedEmails` filter，不属选中语义）
- 不动 row 2 筛选区
- 不调整 ContextActionBar 视觉样式

---

## 8. 文件清单

| 文件 | 操作 |
|---|---|
| `web/src/views/Execute.vue` | 修改：template + script import |
| `web/src/components/ui/ContextActionBar.vue` | 不动（复用） |
| `web/dist/*` | rebuild（`npm run build` in `web/`） |
| `docs/CHANGELOG.md` | 加 v2.41.1 entry |
