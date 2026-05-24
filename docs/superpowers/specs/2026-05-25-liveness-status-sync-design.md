# v2.32.0 — 测活终态同步到 status 字段设计

## 1. 背景

v2.26+ 加了测活功能，结果写入 `alive_status` 字段（`server/db.js:statusDB.setAlive`）。但 `alive_status` 是和 `status` 完全解耦的两个字段：

- `status` 是执行流水线（engine.js / protocol-engine.js）维护的状态，Execute.vue **只显示这个字段**（绑定 `row._status`、用 `groupAccountsByStatus` 分组）。
- `alive_status` 仅在 Accounts.vue 的"活性"列显示，Execute.vue 看不到。

用户跑完测活后，Execute.vue 看到的状态还是上次执行流水线写的旧值，没法快速看出账户当前到底活不活。

## 2. 目标

测活的终态结果按以下映射**同步覆盖到 `status` 字段**，让 Execute.vue 反映最新真相：

| alive_status | → status | 含义 |
|---|---|---|
| `plus` | `plus` | 账户活着 + Plus |
| `deactivated` | `deactivated` | 账户被封 |
| `canceled` | `canceled` | Plus 已取消（新增 status 码） |
| `token_expired` | `token_expired` | Token 失效（新增 status 码） |
| `login_fail` | `login_fail` | 登录失败 / 凭证不对（新增 status 码） |
| `network_error` | (不覆盖) | 探针网络问题 |
| `proxy_error` | (不覆盖) | 代理问题 |
| `checking` / `unknown` | (不覆盖) | 非终态 |

例外：`alive=plus` 且 `status=plus_no_rt` 时**保留 `plus_no_rt`**（plus_no_rt 比 plus 信息更丰富，含"Plus 但没拿到 refresh_token"，测活验证不到 RT 状态，不该降级）。

## 3. 方案

### 3.1 后端 `server/liveness/runner.js`

在 `dispatchOne` 末尾（v2.31.1 vote 块 / good vote 之后、`statusDB.setAlive(email, result)` **之前**）插入 status 同步块：

```js
// v2.32.0: 把 alive 终态同步到 status 字段（Execute.vue 可见）。
// 测活是 ground truth —— 用户跑测活就是想刷新视图，按下表无条件覆盖
// status 字段；唯一例外：alive=plus 且 status 已是 plus_no_rt 时保留
// plus_no_rt（plus_no_rt 含"Plus 但没拿到 refresh_token"，alive=plus
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
```

放置顺序明确：vote block (v2.31.1) → **status sync (本节)** → `setAlive(email, result)` (既有)。这样 setAlive 写入 alive_* 字段时不会因为 set 调用而干扰（setAlive 内部 preserve status，所以即便先 setAlive 再 set，行为一致；但本节 set 在 setAlive 之前更符合数据流"先决定状态再持久化"的语义）。

### 3.2 前端 `web/src/status.js` 新增 3 个 status 码

`TYPE_MAP` 追加 3 行（紧跟 `verify_error: 'danger',` 之后或合适位置）：

```js
canceled: 'warning',
token_expired: 'warning',
login_fail: 'danger',
```

`LABEL_MAP` 追加 3 行：

```js
canceled: '已取消',
token_expired: 'Token失效',
login_fail: '登录失败',
```

`GROUP_ORDER` 追加 3 个值（建议位置：`deactivated` 之后、`no_link` 之前，因为这 3 个都属于"账户层面"的失败）：

```js
'canceled',
'token_expired',
'login_fail',
```

`ERROR_STATUSES` **不动**（这 3 个都不是流水线 error，是测活同步过来的；纳入 ERROR_STATUSES 会污染 KPI 统计）。

### 3.3 前端筛选下拉

`web/src/views/Execute.vue` 和 `web/src/views/Accounts.vue` 的 status 筛选下拉如果是基于 `LABEL_MAP` 循环生成（或某个 export 列表），自动 pick up 新 3 项；如果是硬编码 `<el-option>` 列表，需要补 3 行。**实现时打开两个文件确认**。

### 3.4 Dashboard

`web/src/views/Dashboard.vue` 的 KPI 卡：3 个新值是"测活同步过来的失败状态"，属于"账户出问题"语义。当前 Dashboard 是否有"失败合计"卡？需查看，并按现有归类逻辑加进合适分组（一般 ERROR_STATUSES 用得到，但本设计选择不动 ERROR_STATUSES —— 所以 Dashboard 默认不会把这 3 个统计为 error）。**实现时打开 Dashboard.vue 确认是否需要更新**。

### 3.5 边界 / 不变式

- **§3.5.1 不动 setAlive**：setAlive 仍只写 alive_* 字段。status 同步在 runner.js 显式调 `statusDB.set` 完成。setAlive 保持单一职责。
- **§3.5.2 socket 推送**：`io.emit('account-status', ...)` 让 Execute.vue 实时收到新 status（已有的 socket 路径 `socketState.accountStatuses` 会更新 `row._status`）。
- **§3.5.3 batch 期间**：测活 dispatchOne 串行（concurrency=3 但每个账户独立），每个账户的 status 同步独立完成，互不干扰。
- **§3.5.4 plus_no_rt 保留语义**：仅在 mapped='plus' 且当前 status='plus_no_rt' 时跳过。alive=deactivated/canceled/token_expired/login_fail 时**不**跳过，无论当前 status 是什么。
- **§3.5.5 reason 字段**：设为 `result.alive_reason || ''`。phase 设为 ''（清空），progress 设为 0（清空）。
- **§3.5.6 不 reverse-sync**：执行流水线写 status 时不动 alive_status（保持现有行为）。
- **§3.5.7 非终态**：alive_status='checking' / 'unknown' 不应触发同步（mapping 表里也没这些键，自然不进 if）。

## 4. 测试

### 4.1 新增 runner 测试 `alive plus 同步到 status`

mock `statusDB.set` spy + `statusDB.get` 返回 `{status: 'idle'}`：alive=plus → setAlive 调 spy with `status:'plus'`。

### 4.2 新增 runner 测试 `alive deactivated 同步到 status`

mock get 返回 `{status: 'plus'}`（执行流水线之前判断是 plus）→ alive=deactivated → set 调 spy with `status:'deactivated'`（覆盖 plus）。

### 4.3 新增 runner 测试 `alive network_error 不同步 status`

mock 永远 net_error → setAlive 终态 net_error → `statusDB.set` 不被调用（mapping 表无 network_error）。注意：v2.31.1 retry loop 内 vote 会触发 recordBadAttempt，但本测试用的是 `statusDB.set` spy，不影响。

### 4.4 新增 runner 测试 `alive plus 不降级 plus_no_rt`

mock get 返回 `{status: 'plus_no_rt'}` → alive=plus → set **不被调用**（保留 plus_no_rt）。

### 4.5 新增 status.js 单元测试 / 或验证既有测试不挂

`web/src/status.js` 是纯前端工具，没有现成测试基础设施。**不新增前端测试**（YAGNI，纯映射表改动）。

## 5. 文件清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `server/liveness/runner.js` | dispatchOne 末尾 status 同步块 | 修改 |
| `server/liveness/__tests__/runner.test.js` | +4 新测试 | 修改 |
| `web/src/status.js` | TYPE_MAP / LABEL_MAP / GROUP_ORDER 各 +3 | 修改 |
| `web/src/views/Execute.vue` | 仅在 status 筛选硬编码时需 +3 option | 可能修改 |
| `web/src/views/Accounts.vue` | 仅在 status 筛选硬编码时需 +3 option | 可能修改 |
| `web/src/views/Dashboard.vue` | 仅在有显式状态归类时考虑加入 | 可能修改 |
| `docs/CHANGELOG.md` | v2.32.0 节 | 修改 |

实施时先打开三个 Vue 文件确认筛选下拉来源，再决定是否要改。

## 6. YAGNI / 不做的

- 不改 `statusDB.setAlive` 内部行为
- 不为 network_error / proxy_error 引入新 status 码
- 不增加任何 reverse-sync (status → alive_status)
- 不增加测活完成后弹通知 / toast 等额外 UX

## 7. 版本

v2.32.0 — minor over v2.31.1（新增 status 码 + 跨字段同步）。
