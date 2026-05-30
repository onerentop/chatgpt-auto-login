# 配置页：印尼通道独立 tab 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把印尼通道（GoPay 代理）从「JP 通道」tab 移出，放进一个独立的「印尼通道」tab。

**Architecture:** 纯 UI 重组——只改 `web/src/views/Config.vue` 的 template，把 JP tab 里用 `el-divider` 分隔的印尼通道部分搬到一个新 `el-tab-pane`。form 字段名、保存/加载逻辑、`config.json` 结构、后端读取全部不变。

**Tech Stack:** Vue 3 + Element Plus（`el-tabs`/`el-tab-pane`/`el-form`），Vite 构建。前端无单测惯例——验证靠 `npm run build` 编译通过 + 人工冒烟。

参考 spec：`docs/superpowers/specs/2026-05-31-config-indonesia-channel-tab-design.md`

---

## 文件结构

| 文件 | 改动 | 职责 |
|---|---|---|
| `web/src/views/Config.vue` | Modify（仅 template，约行 397–411） | 从 JP tab 移除印尼通道部分 + 新增独立「印尼通道」tab |

无新建文件，无后端/逻辑改动。

---

## Task 1: 把印尼通道搬到独立 tab

**Files:**
- Modify: `web/src/views/Config.vue`（JP tab 末尾，约行 397–411）

- [ ] **Step 1: 确认当前内容**

打开 `web/src/views/Config.vue`，定位「JP 通道」tab（`<el-tab-pane label="JP 通道" name="jp">`）末尾。当前结构（约行 397–411）应为：

```vue
          <div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0 0 160px">
            JP 通道实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
          </div>

          <el-divider content-position="left">印尼通道（GoPay）</el-divider>
          <el-form-item label="启用印尼通道">
            <el-switch v-model="form.proxyIdGopayEnabled" />
          </el-form-item>
          <el-form-item label="代理模板" v-if="form.proxyIdGopayEnabled">
            <el-input v-model="form.proxyIdGopayTemplate" placeholder="http://user:pass_country-id_session-{sid}@host:port" style="width: 480px" />
            <div style="color:#909399;font-size:12px;margin-top:4px">{sid} 自动替换为随机 session ID（IP 轮转）</div>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="节点黑名单" name="blacklist">
```

如果实际行号有偏移（前面有人改过），以这段文本内容为准定位，不要硬套行号。

- [ ] **Step 2: 用一次 Edit 完成搬移**

把上面那段（从 `<div ...>JP 通道实时状态...` 到 `<el-tab-pane label="节点黑名单" name="blacklist">`）整体替换为下面这段——即：JP tab 在仪表盘提示后直接收尾（删掉 divider + 印尼两项），并在 JP tab 之后插入独立的「印尼通道」tab：

```vue
          <div style="color: var(--el-text-color-secondary); font-size: 12px; padding: 8px 0 0 160px">
            JP 通道实时状态请到 <router-link to="/">仪表盘</router-link> 查看。
          </div>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="印尼通道" name="indonesia">
        <el-form :model="form" label-width="160px" style="max-width: 600px">
          <el-form-item label="启用印尼通道">
            <el-switch v-model="form.proxyIdGopayEnabled" />
            <span style="color:#909399;margin-left:8px;font-size:12px">GoPay 注册印尼号专用住宅代理（IPRoyal），独立于 JP sing-box 通道</span>
          </el-form-item>
          <el-form-item label="代理模板" v-if="form.proxyIdGopayEnabled">
            <el-input v-model="form.proxyIdGopayTemplate" placeholder="http://user:pass_country-id_session-{sid}@host:port" style="width: 480px" />
            <div style="color:#909399;font-size:12px;margin-top:4px">{sid} 自动替换为随机 session ID（IP 轮转）</div>
          </el-form-item>
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="节点黑名单" name="blacklist">
```

要点：
- `form.proxyIdGopayEnabled` / `form.proxyIdGopayTemplate` 绑定**原样不变**（只是换了位置）——所以 `setup()` 的 form 初始化、`save()`、`load()` 都不用动。
- 新 tab `name="indonesia"`（与现有 `payment/phone-pool/execute/discord/oauth/proxy/jp/blacklist` 不重名）。
- 给「启用印尼通道」加了一句说明 `span`，区分它与 JP sing-box 通道。
- JP tab 现在只剩：启用 JP 通道 / JP 节点关键字 / JP 节点白名单 / 仪表盘提示。

- [ ] **Step 3: 编译验证**

Run:
```bash
cd web && npm run build
```
Expected: 编译成功（`✓ built in N.Ns`），无报错。仅有既存的 chunk 体积告警（`index.js 1148kB`）属正常，不是新问题。

- [ ] **Step 4: 静态自查（无单测，靠 grep 确认）**

Run（从 repo 根）:
```bash
grep -n "name=\"indonesia\"\|印尼通道\|proxyIdGopay\|el-divider content-position=\"left\">印尼" web/src/views/Config.vue
```
Expected:
- 有一行 `<el-tab-pane label="印尼通道" name="indonesia">`
- `proxyIdGopayEnabled` / `proxyIdGopayTemplate` 各出现在新 tab 内（不在 `name="jp"` tab 内）
- **不再有** `<el-divider content-position="left">印尼通道（GoPay）</el-divider>`（JP tab 里的那条 divider 已删）

- [ ] **Step 5: 提交**

```bash
git add web/src/views/Config.vue
git commit -m "feat(config): 印尼通道拆为独立 tab（从 JP 通道 tab 移出, 纯 UI 重组）"
```

- [ ] **Step 6: 人工冒烟（可选，需重启服务）**

如果服务在跑，前端是静态托管 `web/dist`，Step 3 的 `npm run build` 已更新 dist，刷新页面即可。打开「配置设置 → 印尼通道」tab，确认：
- 「印尼通道」tab 显示 启用开关 + （开启后）代理模板输入框
- 「JP 通道」tab 不再包含印尼通道
- 切换开关 + 保存配置 + 刷新页面后，印尼通道设置正确持久化（写入 `config.json` 的 `proxy.idGopay`）

---

## 自查（Self-Review）

- **Spec 覆盖**：spec §5.1（从 JP tab 移除印尼部分）→ Task 1 Step 2 的删除；§5.2（新增独立 tab）→ Step 2 的插入；§5.3（tab 顺序 印尼在 JP 后、黑名单前）→ Step 2 的插入位置；§6 不变量（form/save/后端不动）→ Step 2 要点 + 未触碰其它文件；§7 验证 → Step 3/4/6。全覆盖。
- **占位符**：无 TBD/TODO；Step 2 给出完整可粘贴的 template 代码。
- **一致性**：`form.proxyIdGopayEnabled` / `form.proxyIdGopayTemplate` / `name="indonesia"` 全文一致，与 spec 一致。
