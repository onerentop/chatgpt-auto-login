# 账户状态体系重构实施计划

> 创建日期: 2026-05-21
> 状态: 待实施

## 1. 背景与动机

当前账户状态体系存在以下问题：

1. **状态冗余** — `needs_phone` 和 `oauth_failed` 生成一样的 JSON（都没有 refresh_token），分两个状态没有实际意义
2. **行为不一致** — `already_plus` 在协议模式直接调用 `saveAuthFiles`，在浏览器模式根据 `enableCPA` 走不同路径（CPA OAuth 或 PKCE）
3. **僵尸状态** — `pending` 只是中间态从未作为最终状态写入，`failed` 从未被引擎设置（引擎只用 `error`）
4. **Auth 文件生成不一致** — `saveAuthFiles`（protocol-engine.js）生成 CPA + Sub2API 两个文件但 refresh_token 为空字符串，`saveCPAAuthFile`（utils.js）也生成两种格式但来自 session 的 refresh_token，两个函数并存造成混淆

## 2. 目标状态体系

| 状态值 | 标签 | 颜色 | 触发条件 | 生成 JSON |
|--------|------|------|----------|-----------|
| `success` | Plus成功 | success (绿) | enableOAuth ON: 支付/已Plus + PKCE 成功 (有 RT); OFF: 支付/已Plus 成功 | 有 (含 RT) |
| `plus_no_rt` | Plus(无RT) | warning (橙) | enableOAuth ON 但 PKCE 失败或需手机验证 | 有 (无 RT) |
| `no_link` | 无链接 | warning (橙) | Discord 没返回支付链接 | 无 |
| `error` | 错误 | danger (红) | 登录/支付/其他失败 | 无 |
| `idle` | 空闲 | info (灰) | 未执行 | - |
| `running` | 运行中 | primary (蓝) | 执行中 | - |

**删除的状态：**

- `already_plus` → 合并进 `success` / `plus_no_rt`（根据是否有 RT 决定）
- `needs_phone` → 合并进 `plus_no_rt`
- `oauth_failed` → 合并进 `plus_no_rt`
- `pending` → 删除（仅中间态，不应作为最终状态）
- `failed` → 用 `error` 替代（引擎从未设置过 `failed`）

**Auth 文件统一：** 两个引擎都统一使用 `utils.js` 的 `saveCPAAuthFile`，删除 `protocol-engine.js` 中的 `saveAuthFiles` 函数。

## 3. 实施任务清单

---

### 任务 1: 删除 protocol-engine.js 中的 saveAuthFiles 函数

**文件:** `protocol-engine.js`

**改动 A — 删除 saveAuthFiles 函数定义 (line 161-233)**

删除以下代码块：

```javascript
// ========== Auth JSON generation (CPA + sub2api, no refresh_token) ==========
function parseJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  } catch { return {}; }
}

function saveAuthFiles(email, accessToken, session) {
  // ... 整个函数体 (line 168-233)
}
```

这两个函数（`parseJwtPayload` 和 `saveAuthFiles`）都不再需要，因为 `saveCPAAuthFile` 已经从 `utils.js` 导入，且已包含 JWT 解析和双格式文件生成。

**改动 B — already_plus 分支改为走统一逻辑 (line 358-365)**

当前代码：
```javascript
if (isPlusOrAbove) {
  console.log(`[${progress}] Already Plus, generating auth files...`);
  saveAuthFiles(account.email, result.accessToken, result.session);
  this.emitStatus({ email: account.email, status: 'already_plus', phase: 'done', progress });
  summary.alreadyPlus++;
  continue;
}
```

改为：
```javascript
if (isPlusOrAbove) {
  console.log(`[${progress}] Already Plus`);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  if (cfg.enableOAuth) {
    // 已是 Plus，也需走 PKCE 获取 RT
    console.log(`[${progress}] Running PKCE for already-Plus account...`);
    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });

    // 需要一个 Chrome 实例来跑 PKCE
    const port = 9222 + i;
    const tempDir = path.join(os.tmpdir(), `proto-pkce-${Date.now()}-${i}`);
    let chromeProc = null, browser = null;
    try {
      chromeProc = launchChrome(port, tempDir);
      browser = await waitForCDP(port);
      const pkceTokens = await fetchTokensViaPKCE(browser, account, result.lastOtp).catch((e) => {
        console.log(`[${progress}] PKCE failed: ${e.message?.slice(0, 60)}`);
        return null;
      });
      if (pkceTokens?.needsPhone) {
        console.log(`[${progress}] PKCE requires phone verification`);
        saveCPAAuthFile(account.email, result.accessToken, result.session);
        this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      } else if (pkceTokens) {
        console.log(`[${progress}] PKCE success, saving with refresh_token`);
        saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
        this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
      } else {
        console.log(`[${progress}] PKCE failed, saving without refresh_token`);
        saveCPAAuthFile(account.email, result.accessToken, result.session);
        this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      }
    } finally {
      if (browser) try { await browser.close(); } catch {}
      if (chromeProc) try { chromeProc.kill(); } catch {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  } else {
    // enableOAuth OFF，直接 success
    saveCPAAuthFile(account.email, result.accessToken, result.session);
    this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
  }
  summary.success++;
  continue;
}
```

**改动 C — 支付成功后 PKCE 分支 (line 431-458)**

当前代码：
```javascript
if (paymentResult.success) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  if (cfg.enableOAuth) {
    // ...
    if (pkceTokens?.needsPhone) {
      saveAuthFiles(account.email, result.accessToken, result.session);         // ← saveAuthFiles
      this.emitStatus({ ..., status: 'needs_phone', ... });                     // ← needs_phone
    } else if (pkceTokens) {
      saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
      this.emitStatus({ ..., status: 'success', ... });
    } else {
      saveAuthFiles(account.email, result.accessToken, result.session);         // ← saveAuthFiles
      this.emitStatus({ ..., status: 'oauth_failed', ... });                    // ← oauth_failed
    }
  } else {
    saveAuthFiles(account.email, result.accessToken, result.session);           // ← saveAuthFiles
    this.emitStatus({ ..., status: 'success', ... });
  }
}
```

改为：
```javascript
if (paymentResult.success) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
  if (cfg.enableOAuth) {
    console.log(`[${progress}] Running PKCE OAuth...`);
    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
    const pkceTokens = await fetchTokensViaPKCE(browser, account, result.lastOtp).catch((e) => {
      console.log(`[${progress}] PKCE failed: ${e.message?.slice(0, 60)}`);
      return null;
    });
    if (pkceTokens?.needsPhone) {
      console.log(`[${progress}] PKCE requires phone verification`);
      saveCPAAuthFile(account.email, result.accessToken, result.session);
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      summary.success++;
    } else if (pkceTokens) {
      console.log(`[${progress}] PKCE success, saving with refresh_token`);
      saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
      this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
      summary.success++;
    } else {
      console.log(`[${progress}] PKCE failed, saving without refresh_token`);
      saveCPAAuthFile(account.email, result.accessToken, result.session);
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
      summary.success++;
    }
  } else {
    saveCPAAuthFile(account.email, result.accessToken, result.session);
    this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
    summary.success++;
  }
}
```

**改动 D — summary 对象 (line 327)**

当前：
```javascript
const summary = { total: accounts.length, success: 0, alreadyPlus: 0, noLink: 0, error: 0 };
```

改为：
```javascript
const summary = { total: accounts.length, success: 0, noLink: 0, error: 0 };
```

删除 `alreadyPlus` 计数，已合并 Plus 账号不再单独计数。

---

### 任务 2: server/engine.js — 状态和 auth 文件统一

**文件:** `server/engine.js`

**改动 A — already_plus 分支 (line 489-521)**

当前代码中 `isPlusOrAbove` 为 true 时：
- 如果 `enableCPA !== false`，走 CPA OAuth 注册
- 否则走 PKCE，最终状态仍为 `already_plus` 或 `needs_phone`

改为与协议模式一致的逻辑：

```javascript
if (isPlusOrAbove) {
  console.log(`${p} Already Plus!`);
  finalResult = { email: account.email, status: 'success', paymentLink: '', reason: '' };

  currentPhase = 'cpa';
  if (PAY_CONFIG.enableCPA !== false) {
    console.log(`${p} Phase 4: CPA OAuth...`);
    this.emitStatus({ email: account.email, status: 'running', phase: 'cpa', progress });
    try {
      const cpaOk = await registerToCPA(browser, account.email, account);
      if (cpaOk) console.log(`${p} CPA OAuth done.`);
      else console.log(`${p} CPA OAuth may have issues, check manually.`);
    } catch (e) {
      console.log(`${p} CPA error: ${e.message}`);
    }
  } else {
    console.log(`${p} CPA OAuth skipped. Running PKCE to get full tokens...`);
    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
    const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => {
      console.log(`  [PKCE] Failed: ${e.message}`);
      return null;
    });
    if (pkceTokens?.needsPhone) {
      console.log(`${p} PKCE requires phone verification, saving with session token only`);
      saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
      finalResult.status = 'plus_no_rt';
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
    } else if (pkceTokens) {
      saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
      finalResult.status = 'success';
      this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
    } else {
      console.log(`${p} PKCE failed, saving with session token only`);
      saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
      finalResult.status = 'plus_no_rt';
      this.emitStatus({ email: account.email, status: 'plus_no_rt', phase: 'done', progress });
    }
  }
}
```

**改动 B — pending 中间状态 (line 547)**

当前：
```javascript
finalResult = { email: account.email, status: 'pending', paymentLink: discord.link, reason: '' };
```

改为：
```javascript
finalResult = { email: account.email, status: 'running', paymentLink: discord.link, reason: '' };
```

`pending` 不再使用，中间态统一为 `running`。

**改动 C — 支付成功后 PKCE 分支 (line 585-601)**

当前：
```javascript
if (pkceTokens?.needsPhone) {
  // ...
  finalResult.status = 'needs_phone';
} else if (pkceTokens) {
  // ...
} else {
  // ...
  finalResult.status = 'oauth_failed';
}
```

改为：
```javascript
if (pkceTokens?.needsPhone) {
  console.log(`${p} PKCE requires phone verification`);
  saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
  finalResult.status = 'plus_no_rt';
} else if (pkceTokens) {
  console.log(`${p} PKCE success, saving with refresh_token`);
  saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
  // finalResult.status 保持 'success' (line 569 已设置)
} else {
  console.log(`${p} PKCE failed, saving without refresh_token`);
  saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
  finalResult.status = 'plus_no_rt';
}
```

**改动 D — summary 统计 (line 664-670)**

当前：
```javascript
const summary = {
  total: allResults.length,
  success: allResults.filter((r) => r.status === 'success').length,
  alreadyPlus: allResults.filter((r) => r.status === 'already_plus').length,
  noLink: allResults.filter((r) => r.status === 'no_link').length,
  error: allResults.filter((r) => r.status === 'error').length,
};
```

改为：
```javascript
const summary = {
  total: allResults.length,
  success: allResults.filter((r) => r.status === 'success' || r.status === 'plus_no_rt').length,
  noLink: allResults.filter((r) => r.status === 'no_link').length,
  error: allResults.filter((r) => r.status === 'error').length,
};
```

**改动 E — summary 日志输出 (line 673)**

当前：
```javascript
console.log(`  Success: ${summary.success}  |  Already Plus: ${summary.alreadyPlus}  |  No Link: ${summary.noLink}  |  Error: ${summary.error}`);
```

改为：
```javascript
console.log(`  Success: ${summary.success}  |  No Link: ${summary.noLink}  |  Error: ${summary.error}`);
```

**改动 F — complete 事件 JSDoc (line 10)**

当前：
```javascript
 *   'complete'       → { summary: { total, success, alreadyPlus, noLink, error } }
```

改为：
```javascript
 *   'complete'       → { summary: { total, success, noLink, error } }
```

---

### 任务 3: 前端 — Execute.vue 状态映射更新

**文件:** `web/src/views/Execute.vue`

**改动 A — statusType 函数 (line 232)**

当前：
```javascript
function statusType(s) {
  return { idle: 'info', running: 'warning', success: 'success', failed: 'danger', already_plus: 'success', no_link: 'warning', error: 'danger', pending: '', needs_phone: 'warning', oauth_failed: '' }[s] || 'info'
}
```

改为：
```javascript
function statusType(s) {
  return { idle: 'info', running: '', success: 'success', plus_no_rt: 'warning', no_link: 'warning', error: 'danger' }[s] || 'info'
}
```

说明：
- 删除 `failed`、`already_plus`、`pending`、`needs_phone`、`oauth_failed`
- 新增 `plus_no_rt: 'warning'`
- `running` 从 `'warning'` 改为 `''`（对应 Element Plus 的蓝色/默认色）

**改动 B — statusLabel 函数 (line 236)**

当前：
```javascript
function statusLabel(s) {
  return { idle: '空闲', running: '运行中', success: 'Plus成功', failed: '失败', already_plus: '已是Plus', no_link: '无链接', error: '错误', pending: '待确认', needs_phone: 'Plus需验证', oauth_failed: 'Plus(无RT)' }[s] || s || '空闲'
}
```

改为：
```javascript
function statusLabel(s) {
  return { idle: '空闲', running: '运行中', success: 'Plus成功', plus_no_rt: 'Plus(无RT)', no_link: '无链接', error: '错误' }[s] || s || '空闲'
}
```

**改动 C — _hasAuth 判断 (line 179)**

当前：
```javascript
if (['success', 'already_plus', 'needs_phone', 'oauth_failed', 'pending'].includes(data.status)) { row._hasAuth = true; row._plan = 'plus'; }
```

改为：
```javascript
if (['success', 'plus_no_rt'].includes(data.status)) { row._hasAuth = true; row._plan = 'plus'; }
```

**改动 D — _plan 判断 (line 211)**

当前：
```javascript
row._plan = ['success', 'already_plus', 'needs_phone', 'oauth_failed', 'pending'].includes(st) ? 'plus' : (['error', 'failed', 'no_link'].includes(st) ? 'free' : '')
```

改为：
```javascript
row._plan = ['success', 'plus_no_rt'].includes(st) ? 'plus' : (['error', 'no_link'].includes(st) ? 'free' : '')
```

**改动 E — 重试按钮条件 (line 88)**

当前：
```javascript
v-if="row._status === 'failed' || row._status === 'error' || row._status === 'idle'"
```

改为：
```javascript
v-if="row._status === 'error' || row._status === 'idle'"
```

**改动 F — 重试按钮文本 (line 92)**

当前：
```javascript
>{{ (row._status === 'failed' || row._status === 'error') ? '重试' : '执行' }}</el-button>
```

改为：
```javascript
>{{ row._status === 'error' ? '重试' : '执行' }}</el-button>
```

**改动 G — failedEmails 计算属性 (line 139)**

当前：
```javascript
const failedEmails = computed(() => accounts.value.filter(a => a._status === 'failed' || a._status === 'error').map(a => a.email))
```

改为：
```javascript
const failedEmails = computed(() => accounts.value.filter(a => a._status === 'error').map(a => a.email))
```

---

### 任务 4: 前端 — Accounts.vue 状态映射更新

**文件:** `web/src/views/Accounts.vue`

**改动 A — plan 判断 (line 115)**

当前：
```javascript
const plan = ['success', 'already_plus', 'needs_phone', 'oauth_failed', 'pending'].includes(st) ? 'plus' : (['error', 'failed', 'no_link'].includes(st) ? 'free' : '')
```

改为：
```javascript
const plan = ['success', 'plus_no_rt'].includes(st) ? 'plus' : (['error', 'no_link'].includes(st) ? 'free' : '')
```

---

### 任务 5: 前端 — Dashboard.vue 状态映射更新

**文件:** `web/src/views/Dashboard.vue`

**改动 A — statusType 函数 (line 60-68)**

当前：
```javascript
function statusType(s) {
  if (!s) return 'info'
  const sl = s.toLowerCase()
  if (sl === 'success' || sl === 'already_plus') return 'success'
  if (sl === 'error' || sl === 'failed') return 'danger'
  if (sl === 'no_link') return 'warning'
  if (sl === 'running') return ''
  return 'info'
}
```

改为：
```javascript
function statusType(s) {
  if (!s) return 'info'
  const sl = s.toLowerCase()
  if (sl === 'success') return 'success'
  if (sl === 'plus_no_rt') return 'warning'
  if (sl === 'error') return 'danger'
  if (sl === 'no_link') return 'warning'
  if (sl === 'running') return ''
  return 'info'
}
```

**改动 B — stats.plus 统计 (line 80)**

当前：
```javascript
stats.plus = statuses.filter(r => ['success', 'already_plus'].includes((r.status || '').toLowerCase())).length
```

改为：
```javascript
stats.plus = statuses.filter(r => ['success', 'plus_no_rt'].includes((r.status || '').toLowerCase())).length
```

**改动 C — stats.success 统计 (line 81)**

当前：
```javascript
stats.success = statuses.filter(r => ['success', 'already_plus'].includes((r.status || '').toLowerCase())).length
```

改为：
```javascript
stats.success = statuses.filter(r => ['success', 'plus_no_rt'].includes((r.status || '').toLowerCase())).length
```

**改动 D — stats.error 统计 (line 82)**

当前：
```javascript
stats.error = statuses.filter(r => ['error', 'failed'].includes((r.status || '').toLowerCase())).length
```

改为：
```javascript
stats.error = statuses.filter(r => r.status === 'error').length
```

---

### 任务 6: 前端 — Results.vue 状态映射更新

**文件:** `web/src/views/Results.vue`

**改动 A — statusType 函数 (line 72-79)**

当前：
```javascript
function statusType(status) {
  const map = {
    success: 'success',
    error: 'danger',
    pending: 'info',
    running: 'warning',
  }
  return map[status] || 'info'
}
```

改为：
```javascript
function statusType(status) {
  const map = {
    success: 'success',
    plus_no_rt: 'warning',
    error: 'danger',
    no_link: 'warning',
    running: '',
    idle: 'info',
  }
  return map[status] || 'info'
}
```

**改动 B — 筛选选项 (line 11-16)**

当前只有 success / error / pending 三个筛选项：
```html
<el-option label="成功" value="success" />
<el-option label="失败" value="error" />
<el-option label="待处理" value="pending" />
```

改为：
```html
<el-option label="Plus成功" value="success" />
<el-option label="Plus(无RT)" value="plus_no_rt" />
<el-option label="无链接" value="no_link" />
<el-option label="错误" value="error" />
```

---

### 任务 7: index.js (CLI 版本) — 状态常量更新

**文件:** `index.js`

**改动 A — ALREADY_PLUS 状态 (line 218)**

当前：
```javascript
finalResult = { email: account.email, status: 'ALREADY_PLUS', paymentLink: '', reason: '' };
```

改为：
```javascript
finalResult = { email: account.email, status: 'success', paymentLink: '', reason: '' };
```

> 注意：`index.js` 是独立的 CLI 入口，与 Web 仪表盘的引擎并行。如果此文件已不再积极维护，可在改动时加注释标注。该文件后续的 PKCE 分支（如果有）也应改为使用 `plus_no_rt` 而非 `needs_phone` / `oauth_failed`。

---

## 4. 实施顺序

建议按以下顺序实施，确保每一步都可独立验证：

```
阶段 1 — 后端引擎（无破坏性）
  [1] protocol-engine.js: 删除 saveAuthFiles，改用 saveCPAAuthFile
  [2] protocol-engine.js: 状态值替换 (already_plus → success/plus_no_rt, needs_phone → plus_no_rt, oauth_failed → plus_no_rt)
  [3] server/engine.js: 状态值替换 (同上 + pending → running)
  [4] server/engine.js: summary 统计更新
  [5] index.js: ALREADY_PLUS → success

阶段 2 — 前端适配
  [6] Execute.vue: statusType + statusLabel + _hasAuth + _plan + 重试按钮
  [7] Accounts.vue: plan 判断
  [8] Dashboard.vue: statusType + stats
  [9] Results.vue: statusType + 筛选选项
```

## 5. 数据迁移

现有 `data.db` 中的 `account_status` 表可能包含旧状态值。需要在部署后运行一次 SQL 更新：

```sql
UPDATE account_status SET status = 'plus_no_rt' WHERE status IN ('needs_phone', 'oauth_failed');
UPDATE account_status SET status = 'success' WHERE status = 'already_plus';
UPDATE account_status SET status = 'error' WHERE status = 'failed';
DELETE FROM account_status WHERE status = 'pending';
```

这可以作为一次性的手动操作，或者在 `server/db.js` 的 `initDB()` 中添加迁移逻辑。

## 6. 风险与注意事项

1. **protocol-engine.js already_plus 分支需要新开 Chrome 实例** — 原来 already_plus 直接 continue 不需要 Chrome，改为走 PKCE 后需要启动 Chrome 实例。如果性能是问题，可以考虑在 enableOAuth OFF 时直接跳过（已在计划中处理）。

2. **saveAuthFiles 和 saveCPAAuthFile 的差异** — `saveAuthFiles` 的 refresh_token / id_token 都硬编码为空字符串，而 `saveCPAAuthFile` 从 session 对象中提取。统一使用 `saveCPAAuthFile` 后，在没有 PKCE 结果时传入的 session 对象也不会有 RT，所以行为等价。

3. **前端缓存** — 用户浏览器可能缓存旧的 Vue 组件。发布时确保前端重新构建，或者使用版本化的资源路径。

4. **向下兼容** — results.js 的 API 返回 `hasAuthFile` 是通过文件系统检查的 (line 25)，不依赖状态值，所以状态改名不影响 auth 文件的下载功能。
