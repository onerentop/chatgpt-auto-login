# v2.32.0 测活终态同步到 status 字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 测活 dispatchOne 终态后按 5 项映射表把 alive_status 同步覆盖到 `status` 字段（含 plus_no_rt 不降级例外），让 Execute.vue 看到最新真相。

**Architecture:** runner.js `dispatchOne` 末尾在 `clipReason` 之后、`setAlive` 之前调 `statusDB.set` + `io.emit('account-status', ...)`，复用 v2.32 之前所有现有基础设施。前端 `web/src/status.js` 加 3 个 status 码（canceled / token_expired / login_fail），3 个 Vue 视图各 +3 `<el-option>`。

**Tech Stack:** Node + sql.js、Socket.IO、Vue 3 + Element Plus、node:test。

**Spec:** `docs/superpowers/specs/2026-05-25-liveness-status-sync-design.md`

---

## File Structure

| 文件 | 角色 | 状态 |
|---|---|---|
| `server/liveness/runner.js` | dispatchOne 末尾 status 同步块 | 修改 |
| `server/liveness/__tests__/runner.test.js` | +4 单测 | 修改 |
| `web/src/status.js` | TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3 | 修改 |
| `web/src/views/Execute.vue` | status 筛选下拉 +3 option | 修改 |
| `web/src/views/Accounts.vue` | status 筛选下拉 +3 option | 修改 |
| `web/src/views/Results.vue` | status 筛选下拉 +3 option | 修改 |
| `docs/CHANGELOG.md` | v2.32.0 节 | 修改 |

依赖：Task 1（后端 + 测试）→ Task 2（前端 status.js + 3 个 Vue）→ Task 3（CHANGELOG）。Task 1 / Task 2 互相独立可并行，但顺序执行更安全。

---

## Task 1: Backend — runner.js status 同步 + 4 单测

**Files:**
- Modify: `server/liveness/runner.js:204-205` (在 clipReason 后、setAlive 前插入)
- Modify: `server/liveness/__tests__/runner.test.js` (mkEnv 添加 statusDB.set spy；末尾 +4 测试)

### Step 1: 扩展 mkEnv 让 tests 可注入 statusDB.set / get spy

打开 `server/liveness/__tests__/runner.test.js`. 找到 `function mkEnv` 体（line 6-29）。当前 statusDB 只有 setAlive + clearAlive。替换为：

找到：

```js
  const statusDB = {
    setAlive: (email, data) => dbCalls.push({ email, ...data }),
    clearAlive: () => {},
  };
```

替换为：

```js
  const statusDB = {
    setAlive: (email, data) => dbCalls.push({ kind: 'setAlive', email, ...data }),
    set: opts.statusSetSpy || ((email, data) => dbCalls.push({ kind: 'set', email, ...data })),
    get: opts.statusGetSpy || ((email) => null),
    clearAlive: () => {},
  };
```

**注意**：现有测试断言用了 `env.dbCalls.some(c => c.email === ... && c.alive_status === 'plus')` —— 旧 setAlive 调用没有 `kind` 字段，现在加上 `kind: 'setAlive'` 后旧断言仍然过（`c.alive_status` 字段仍在）。检查 line 37、line 81、line 116、line 145、line 192、line 222 等既有断言是否兼容：都只读 `email` / `alive_status`，不读 `kind`，所以兼容。

如果某个既有测试因为 setAlive 的 dbCall shape 变化导致挂掉，再来微调。

### Step 2: 写 4 个新失败测试

在 `runner.test.js` 末尾追加：

```js
test('runner: alive=plus 同步 status=plus (v2.32.0)', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sp@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'idle' }),
  });
  const runner = createRunner(env);
  runner.start(['sp@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'sp@x.com');
  assert.ok(c, 'statusDB.set was called');
  assert.strictEqual(c.status, 'plus');
  assert.strictEqual(c.phase, '');
  assert.strictEqual(c.progress, 0);
});

test('runner: alive=deactivated 覆盖 status (无论原值)', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sd@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'deactivated', alive_reason: 'account_deactivated' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'plus' }),  // 原本是 plus
  });
  const runner = createRunner(env);
  runner.start(['sd@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'sd@x.com');
  assert.ok(c, 'statusDB.set was called');
  assert.strictEqual(c.status, 'deactivated');
});

test('runner: alive=network_error 不同步 status', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'sn@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'network_error', alive_reason: 'check 503' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'idle' }),
  });
  const runner = createRunner(env);
  runner.start(['sn@x.com']);
  // 3 retry × 即时 probe + 2 × 2s delay ≈ 5.5s
  await new Promise(r => setTimeout(r, 5500));
  const c = setCalls.find(x => x.email === 'sn@x.com');
  assert.strictEqual(c, undefined, 'statusDB.set must NOT be called for network_error');
});

test('runner: alive=plus 不降级 plus_no_rt', async () => {
  const setCalls = [];
  const env = mkEnv({
    accounts: [{ email: 'snr@x.com', password: 'p', client_id: 'c', refresh_token: 'r' }],
    checker: {
      probe: async () => ({ alive_status: 'plus', alive_reason: 'check ok' }),
      verifyDeactivated: async () => ({ status: 'error', reason: 'na' }),
    },
    codexFile: { read: async () => ({ access_token: 'tok' }), write: async () => {} },
    statusSetSpy: (email, data) => setCalls.push({ email, ...data }),
    statusGetSpy: () => ({ status: 'plus_no_rt' }),  // 已经是更精细的 plus_no_rt
  });
  const runner = createRunner(env);
  runner.start(['snr@x.com']);
  await new Promise(r => setTimeout(r, 1500));
  const c = setCalls.find(x => x.email === 'snr@x.com');
  assert.strictEqual(c, undefined, 'plus 不该降级覆盖 plus_no_rt');
});
```

### Step 3: 跑测试验证 FAIL

```
node --test server/liveness/__tests__/runner.test.js
```

Expected: 4 个新测试 FAIL（statusDB.set 没被调用 / undefined）。

### Step 4: 实现 runner.js 同步块

打开 `server/liveness/runner.js`. 找到 line 204-205：

```js
    result.alive_reason = clipReason(result.alive_reason);
    statusDB.setAlive(email, result);
```

在 **line 204 之后、line 205 之前**插入同步块（注意：clipReason 已经把 alive_reason 截断到合理长度，新代码读取已截断的值传给 set）：

```js
    result.alive_reason = clipReason(result.alive_reason);

    // v2.32.0: 把 alive 终态同步到 status 字段（Execute.vue 可见）。
    // 测活是 ground truth —— 用户跑测活就是想刷新视图，按映射表无条件
    // 覆盖 status；唯一例外：alive=plus 且 status=plus_no_rt 时保留
    // plus_no_rt（plus_no_rt 含"Plus 但没拿到 refresh_token"语义，alive=plus
    // 验证不到 RT 状态，不该降级覆盖）。
    try {
      const aliveToStatus = {
        plus: 'plus',
        deactivated: 'deactivated',
        canceled: 'canceled',
        token_expired: 'token_expired',
        login_fail: 'login_fail',
      };
      const mapped = aliveToStatus[result.alive_status];
      if (mapped) {
        const persisted = statusDB.get(email);
        const skipDowngrade = (mapped === 'plus' && persisted?.status === 'plus_no_rt');
        if (!skipDowngrade) {
          statusDB.set(email, {
            status: mapped,
            phase: '',
            progress: 0,
            reason: result.alive_reason || '',
          });
          io.emit('account-status', {
            email,
            status: mapped,
            phase: '',
            progress: 0,
            reason: result.alive_reason || '',
          });
        }
      }
    } catch {}

    statusDB.setAlive(email, result);
```

### Step 5: Syntax check

```
node --check server/liveness/runner.js
```

Expected: no output.

### Step 6: 跑 liveness 测试验证 PASS

```
node --test server/liveness/__tests__/runner.test.js
```

Expected: 全过（既有 16 + 新 4 = 20）。

如果"alive=plus 同步"测试 `c === undefined`：检查 aliveToStatus 字典 + 是否传入 statusGetSpy 正确返回 `{status:'idle'}`。

如果"network_error 不同步"测试 `setCalls.length > 0`：检查 mapped 在 network_error 时是否 undefined（不应进 if）。

如果"plus_no_rt 不降级"测试 `c !== undefined`：检查 `skipDowngrade` 逻辑（`mapped === 'plus' && persisted?.status === 'plus_no_rt'`）。

### Step 7: 全项目回归

```
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: **188** total（184 baseline after v2.31.1 + 4 new）。

如果其它既有测试因为 mkEnv 改变 dbCall shape 而挂：回到 Step 1 检查既有断言中是否依赖 `c.kind === undefined`（不应有）。

### Step 8: Commit

```bash
git add server/liveness/runner.js server/liveness/__tests__/runner.test.js
git commit -m "$(cat <<'EOF'
feat(liveness): 测活终态按映射同步到 status 字段

测活当前只写 alive_status —— Execute.vue 完全只看 status 字段，
跑完测活那边的状态还是上次执行流水线写的旧值。

dispatchOne 末尾在 clipReason 之后、setAlive 之前按映射表调
statusDB.set + io.emit('account-status'):
  plus           → status='plus'
  deactivated    → status='deactivated'
  canceled       → status='canceled' (新值)
  token_expired  → status='token_expired' (新值)
  login_fail     → status='login_fail' (新值)
  network_error / proxy_error / checking / unknown → 不同步

例外：alive=plus 且 persisted.status=plus_no_rt 时保留 plus_no_rt
（plus_no_rt 比 plus 信息更丰富，测活验证不到 RT 状态，不降级）。

新增 4 单测 (plus 同步 / deactivated 覆盖 / network_error 不同步 /
plus 不降级 plus_no_rt)。mkEnv 扩展支持 statusSetSpy + statusGetSpy
注入。
EOF
)"
```

---

## Task 2: Frontend — status.js + 3 个 Vue 文件状态码 +3

**Files:**
- Modify: `web/src/status.js` (TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3)
- Modify: `web/src/views/Execute.vue:39-49` (status 筛选 +3 option)
- Modify: `web/src/views/Accounts.vue:14-24` (status 筛选 +3 option)
- Modify: `web/src/views/Results.vue:13-20` (status 筛选 +3 option)

### Step 1: `web/src/status.js` TYPE_MAP / LABEL_MAP +3

打开 `web/src/status.js`. 找到 TYPE_MAP（line 3-16）。在 `verify_error: 'danger',` 之后、`paypal_captcha:` 之前插入：

```js
  canceled: 'warning',
  token_expired: 'warning',
  login_fail: 'danger',
```

最终 TYPE_MAP 长这样（参考）：

```js
const TYPE_MAP = {
  idle: 'info',
  running: '',
  plus: 'success',
  plus_no_rt: 'warning',
  no_link: 'warning',
  error: 'danger',
  deactivated: 'danger',
  no_jp_proxy: 'warning',
  no_promo: 'info',
  verify_error: 'danger',
  canceled: 'warning',
  token_expired: 'warning',
  login_fail: 'danger',
  paypal_captcha: 'warning',
  aborted: 'info',
}
```

找到 LABEL_MAP（line 18-31）。在 `verify_error: 'Stripe验证失败',` 之后、`paypal_captcha:` 之前插入：

```js
  canceled: '已取消',
  token_expired: 'Token失效',
  login_fail: '登录失败',
```

### Step 2: `web/src/status.js` GROUP_ORDER +3

找到 GROUP_ORDER（line 91-104）。在 `'deactivated',` 之后、`'no_link',` 之前插入：

```js
  'canceled',       // 已取消（测活同步）
  'token_expired',  // Token失效（测活同步）
  'login_fail',     // 登录失败（测活同步）
```

最终 GROUP_ORDER 顺序（参考）：

```js
export const GROUP_ORDER = [
  'plus',
  'plus_no_rt',
  'running',
  'error',
  'deactivated',
  'canceled',
  'token_expired',
  'login_fail',
  'no_link',
  'no_promo',
  'verify_error',
  'no_jp_proxy',
  'paypal_captcha',
  'aborted',
  'idle',
]
```

### Step 3: `web/src/views/Execute.vue` 状态筛选 +3 option

打开 `web/src/views/Execute.vue`. 找到 line 39-49 的 11 个 el-option。在 `<el-option label="Stripe验证失败" value="verify_error" />` (line 49) **之后**、`</el-select>` (line 50) **之前**插入：

```vue
          <el-option label="已取消" value="canceled" />
          <el-option label="Token失效" value="token_expired" />
          <el-option label="登录失败" value="login_fail" />
```

### Step 4: `web/src/views/Accounts.vue` 状态筛选 +3 option

打开 `web/src/views/Accounts.vue`. 找到 line 14-24 的 11 个 el-option。在 `<el-option label="Stripe验证失败" value="verify_error" />` (line 24) **之后**、`</el-select>` (line 25) **之前**插入：

```vue
          <el-option label="已取消" value="canceled" />
          <el-option label="Token失效" value="token_expired" />
          <el-option label="登录失败" value="login_fail" />
```

### Step 5: `web/src/views/Results.vue` 状态筛选 +3 option

打开 `web/src/views/Results.vue`. 找到 line 13-20 的 9 个 el-option（注意 Results.vue 的列表是 8 个无 `idle`/`running`/`deactivated`）。在 `<el-option label="Stripe验证失败" value="verify_error" />` (line 20) **之后**、`</el-select>` 之前插入：

```vue
          <el-option label="已删除" value="deactivated" />
          <el-option label="已取消" value="canceled" />
          <el-option label="Token失效" value="token_expired" />
          <el-option label="登录失败" value="login_fail" />
```

**注意**：Results.vue 之前没 `deactivated` option，但 deactivated 是 v2.32 之前就已存在的合法 status，且测活同步还可能产生。为完整性补上。如果不想加，省略第一行（`已删除`）；后 3 行必加（v2.32 引入的新值）。

### Step 6: 构建前端

```
cd web ; npm run build
```

Expected: `✓ built`. 如果 Vue 编译错误：

- 引用未导入的常量 → status.js 改动里没引入新 import，应不会有这种问题
- `</el-select>` 标签不闭合 → 检查 4 个 Vue 文件的 option 插入位置

### Step 7: 后端回归 sanity

```
cd .. ; node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 188 仍过（前端改动不影响后端测试）。

### Step 8: Commit

```bash
git add web/src/status.js web/src/views/Execute.vue web/src/views/Accounts.vue web/src/views/Results.vue
git commit -m "$(cat <<'EOF'
feat(ui): 新增 canceled/token_expired/login_fail 三个 status 码

测活终态同步到 status 字段后（见上一个 commit），三个新值需要
显示支持：

- web/src/status.js: TYPE_MAP / LABEL_MAP 各 +3；GROUP_ORDER 把这
  三个排在 deactivated 之后、no_link 之前（账户层面失败的分组）
- Execute.vue / Accounts.vue / Results.vue: status 筛选下拉硬编码
  列表各 +3 option。Results.vue 顺便补 deactivated（之前漏掉）

样式 type：
- canceled / token_expired → warning（黄）
- login_fail → danger（红）

Label：已取消 / Token失效 / 登录失败。
EOF
)"
```

---

## Task 3: CHANGELOG v2.32.0

**Files:**
- Modify: `docs/CHANGELOG.md`

### Step 1: Prepend v2.32.0 section

打开 `docs/CHANGELOG.md`. 在 `# Changelog` 行之后、`## v2.31.1` 之前插入：

```markdown
## v2.32.0 — 2026-05-25

### 测活终态同步到 status 字段 + 3 个新 status 码

之前 alive_status 和 status 完全解耦：Execute.vue 只看 status，
测活只写 alive_status —— 跑完测活 Execute 页看到的还是上次执行
流水线写的旧值。

**后端 — runner.js dispatchOne 末尾按映射表同步**

| alive_status | → status |
|---|---|
| `plus` | `plus` |
| `deactivated` | `deactivated` |
| `canceled` | `canceled` (新) |
| `token_expired` | `token_expired` (新) |
| `login_fail` | `login_fail` (新) |
| `network_error` / `proxy_error` / `checking` / `unknown` | 不同步 |

例外：`alive=plus` 且 `persisted.status=plus_no_rt` 时保留 plus_no_rt
（plus_no_rt 比 plus 信息更丰富，alive=plus 验证不到 RT 状态，不
降级覆盖）。同步时同时 `io.emit('account-status', ...)` 推送，
Execute.vue 通过既有 socket 路径实时更新 `row._status`。

**前端 — 3 个新 status 码 + 筛选下拉补齐**

- `web/src/status.js`: TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3
- Execute.vue / Accounts.vue / Results.vue 状态筛选下拉 +3 option
  - Results.vue 顺便补 deactivated（之前漏掉）

样式：canceled / token_expired = warning；login_fail = danger。
Labels：已取消 / Token失效 / 登录失败。

**测试**：188 tests pass — runner +4（plus 同步 / deactivated 覆盖 /
network_error 不同步 / plus 不降级 plus_no_rt）on v2.31.1 baseline 184.

**Spec / Plan**：`docs/superpowers/specs/2026-05-25-liveness-status-sync-design.md`
+ `docs/superpowers/plans/2026-05-25-liveness-status-sync.md`。

```

保持 `## v2.31.1` 及以下完整不动。

### Step 2: Final regression

```
node --test __tests__/*.test.js server/__tests__/*.test.js server/proxy/__tests__/*.test.js server/liveness/__tests__/*.test.js
```

Expected: 188 pass.

### Step 3: 手动 smoke（用户跑）

1. 重启 server（kill 现 node + 启新）+ 硬刷 web。
2. 找一个 status 当前是 `idle` 或 `error` 的账户跑测活。
3. 测活完成后看 Execute.vue：该账户 status 应已变成测活的同步值（按映射）。
4. 找一个 status 是 `plus_no_rt` 的账户跑测活，alive=plus → Execute.vue 看到的 status 应**仍为 plus_no_rt**（不降级）。
5. 找一个会触发 network_error 的账户（断网或坏代理）跑测活 → status 应**不变**。

### Step 4: Commit CHANGELOG

```bash
git add docs/CHANGELOG.md
git commit -m "docs(changelog): v2.32.0 — 测活终态同步 status 字段"
```

---

## Self-Review

**1. Spec coverage:**

- Spec §1 背景：informational。
- Spec §2 映射表 + plus_no_rt 例外 → Task 1 Step 4 实现 + Step 2 测试覆盖。
- Spec §3.1 runner.js 同步块 → Task 1 Step 4。
- Spec §3.2 status.js TYPE_MAP/LABEL_MAP/GROUP_ORDER 各 +3 → Task 2 Step 1+2。
- Spec §3.3 Execute/Accounts/Results status 筛选下拉 → Task 2 Step 3+4+5。
- Spec §3.4 Dashboard → spec 写"实施时打开 Dashboard.vue 确认是否需要更新"。Self-review 时复查：Dashboard KPI 当前只过滤具体 status (`plus`/`error`/`no_jp_proxy`/`no_promo`/`verify_error`)，不依赖 LABEL_MAP；3 个新值不属于这些既有分类，**不动 Dashboard 是符合 YAGNI 的**（用户 Dashboard 想看新值时手动到 Execute/Accounts 看）。Plan **不包含 Dashboard 改动**。
- Spec §3.5 边界：runner 用 try/catch、socket emit、不动 setAlive、phase/progress 清空 → Task 1 Step 4 实现兼顾。
- Spec §4 4 个测试 → Task 1 Step 2 全部到位。
- Spec §5 文件清单 → matches Task 1+2+3。
- Spec §6 YAGNI → 不动 setAlive 内部、不引入 network_error/proxy_error 新 status 码、不 reverse-sync、不加 toast → 全部 honored。
- Spec §7 v2.32.0 → Task 3 Step 1。

**2. Placeholder scan:** 无 "TBD" / "implement later"。每步含完整代码、确切命令、期望输出。

**3. Type/symbol consistency:**

- `aliveToStatus` 字典 5 个键（plus/deactivated/canceled/token_expired/login_fail）—— 与 §2 映射表 + Task 1 测试断言（c.status 期望值）一致。
- `mapped` / `persisted` / `skipDowngrade` 局部变量命名 —— 仅 Task 1 Step 4 内使用，不跨任务。
- `canceled` / `token_expired` / `login_fail` 三个新 status 字符串 —— 在 Task 1 Step 4（映射目标）、Task 2 Step 1（TYPE_MAP key）、Step 2（LABEL_MAP key）、Step 2（GROUP_ORDER 元素）、Step 3-5（el-option value）一致；无 typo。
- `statusSetSpy` / `statusGetSpy` mkEnv 注入名 —— Task 1 Step 1 引入、Step 2 测试调用，一致。

**4. CHANGELOG 测试数字校验**：v2.32.0 baseline 是 v2.31.1 完成后的 184 + 4 新测试 = 188，与 Task 1 Step 7 期望、Task 3 Step 2 期望一致。

无 issue。Plan ready.
