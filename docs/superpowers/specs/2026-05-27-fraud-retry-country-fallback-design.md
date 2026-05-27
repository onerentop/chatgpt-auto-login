# smscloud fraud-blocked retry 跨 country fallback 设计

> 日期：2026-05-27
> 作用域：v2.45.1 fraud-blocked / rate-limited / voip-blocked retry 逻辑增强 —— 按 countryCode 列表轮换取号，避免号段相似性触发 OpenAI fraud_guard 全 3 attempts 失败

## 1. 背景

v2.45.1 把 fraud-blocked / rate-limited / voip-blocked 三状态归到"换号 retry"，但 retry 仍调相同 `smscloud.takeOrder(serviceCode, countryCode)` —— countryCode 单值导致 retry 拿到同 country 同号段的号。

线上日志（2026-05-27 08:29）：

```
attempt 1: +601164325497 (Malaysia)
attempt 2: +601164313038 (Malaysia)
attempt 3: +601164287604 (Malaysia)
```

3 个号前缀均 `+60116` —— smscloud 平台对单 country 分号集中。OpenAI fraud_guard "We've detected suspicious behavior from phone numbers similar to yours" 命中**号段相似性**，3 attempts 全 fraud-blocked，账号最终 `phone_verify_fail`。

修复方向：让用户配 `countryCode` 列表，每次 retry attempt 用 list 下一项跨 country 取号。

## 2. 决定

- **D1**：`phonePool.smscloud.countryCode` 字段接受 `number | number[]`。number 等价 [number]，向后兼容现有 config。
- **D2**：retry 切换策略统一 —— attempt N (1-indexed) 取 `list[(N-1) % list.length]`，不区分 fail status。最大化简化代码 + 行为可预测。
- **D3**：cache 复用号需要"按 country 过滤" —— `smscloud_phone_cache` schema 加 `country_code INTEGER` 列（ALTER 兜底）+ `acquirePhone` 接 `preferredCountryCode` 参数 SQL filter。
- **D4**：Config 页 country select 改 `multiple` —— v-model 直接是 number[]。旧值（number）在 onMounted 读 config 时归一为 [number]。
- **D5**：不动 zhusms / local provider（zhusms 没 country 维度，local 不取号）。
- **D6**：不引入 serviceCode 列表（fraud 主要按号段，不按 service）。
- **D7**：不主动调 inventory 自动选最优 country（用户按价格 list 排序）。

## 3. 改动范围

### 3.1 `server/db.js` schema 加 country_code 列

`smscloud_phone_cache` CREATE TABLE 加列：

```sql
CREATE TABLE IF NOT EXISTS smscloud_phone_cache (
  order_no       TEXT PRIMARY KEY,
  phone          TEXT NOT NULL,
  api_key        TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  taken_at_ms    INTEGER NOT NULL,
  bindings_used  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  country_code   INTEGER  -- v2.47: nullable 兼容 v2.45.0 老行
);
```

ALTER 兜底（仿 db.js:106-123 payment_link 模式），加在现有 PRAGMA table_info(account_status) 之后：

```js
const smscloudCachCols = db.exec("PRAGMA table_info(smscloud_phone_cache)");
const smscloudCacheColsSet = new Set(smscloudCachCols[0]?.values.map(row => row[1]) || []);
if (!smscloudCacheColsSet.has('country_code')) {
  db.run("ALTER TABLE smscloud_phone_cache ADD COLUMN country_code INTEGER");
}
```

### 3.2 `server/smscloud-pool.js` `acquirePhone` 加 preferredCountryCode

签名扩为：

```js
function acquirePhone(db, email, maxBindingsPerPhone, expiryMs, excludePhones, takeOrderFn, preferredCountryCode = null) {
  ...
}
```

cache 查询 SQL 加 country filter（preferredCountryCode 非 null 时）：

```js
const countryClause = preferredCountryCode != null ? 'AND (country_code = ? OR country_code IS NULL)' : '';
const r = db.exec(`
  SELECT order_no, phone, api_key, base_url, taken_at_ms, bindings_used, country_code
  FROM smscloud_phone_cache
  WHERE status = 'active'
    AND taken_at_ms + ? > ?
    AND bindings_used < ?
    AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
    ${countryClause}
    ${exclusionClause}
  ORDER BY bindings_used ASC, taken_at_ms ASC
  LIMIT 1
`, [expiryMs, now, maxBindingsPerPhone, email, ...(preferredCountryCode != null ? [preferredCountryCode] : []), ...excludePhones]);
```

`country_code IS NULL` 兼容 v2.45.0 旧 row。

INSERT 新 entry 时存 `country_code`，需要 takeOrderFn 返值含 `countryCode` 字段：

```js
return Promise.resolve(takeOrderFn()).then(({ orderNo, phone, apiKey, baseUrl, countryCode }) => {
  const taken_at_ms = Date.now();
  db.run(
    `INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status, country_code)
     VALUES (?, ?, ?, ?, ?, 1, 'active', ?)`,
    [orderNo, phone, apiKey, baseUrl, taken_at_ms, countryCode ?? null]
  );
  ...
});
```

返值字段不变（保持现有 acq 形态），不需要返 country_code。

### 3.3 `protocol-engine.js` `_acquirePhoneForProtocol`

签名扩 `attemptIdx`：

```js
async _acquirePhoneForProtocol(provider, cfg, email, proxyUrl, excludePhones = [], attemptIdx = 0)
```

smscloud branch 内：

```js
const s = cfg.phonePool.smscloud || {};
const codes = Array.isArray(s.countryCode) ? s.countryCode : (s.countryCode != null ? [s.countryCode] : []);
if (!s.apiKey || !s.serviceCode || codes.length === 0) {
  console.log(`[protocol] smscloud config incomplete (apiKey/serviceCode/countryCode 任一为空)`);
  return {};
}
const countryCode = codes[attemptIdx % codes.length];
console.log(`[protocol] smscloud attempt ${attemptIdx + 1} country=${countryCode} (list=[${codes.join(',')}])`);
const baseUrl = s.baseUrl || 'https://smscloud.sbs/api/system';
const takeOrderFn = async () => {
  const order = await smscloud.takeOrder(s.apiKey, baseUrl, s.serviceCode, countryCode);
  if (!order || !order.phone) throw new Error('takeOrder empty');
  return { orderNo: order.order_no, phone: order.phone, apiKey: s.apiKey, baseUrl, countryCode };
};
const acq = await smscloudPool.acquirePhone(getRawDb(), email, max, EXPIRY_MS, excludePhones, takeOrderFn, countryCode);
...
```

注意：现有内层 `MAX_ACQUIRE_TRIES = 3` 循环（v2.45.1 resend 失败兜底）保留不变，countryCode 在循环外固定（同 attempt 用同 country 取号 + resend）。

### 3.4 `protocol-engine.js` `_finalizePhoneVerify` 调 acquire 时传 attempt - 1

`for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)` 内：

```js
const acq = await this._acquirePhoneForProtocol(provider, cfg, account.email, proxyUrl, triedPhones, attempt - 1);
```

`local` / `zhusms` 路径 attemptIdx 参数被忽略（不用），向后兼容。

### 3.5 `web/src/views/Config.vue` country select 改 multi-select

```vue
<el-select v-model="form.phonePool.smscloud.countryCode"
  placeholder="选 1+ 国家（按顺序作为 retry fallback）"
  filterable multiple clearable
  style="width: 360px">
  <el-option v-for="c in smscloudCountries" :key="c.id" :label="..." :value="c.id" />
</el-select>
```

v-model 现在是 number[]。

旧值归一在 onMounted 读 config 后：

```js
// v2.47: 旧 number 归一为 [number] 兼容 multi-select
if (form.phonePool.smscloud.countryCode != null && !Array.isArray(form.phonePool.smscloud.countryCode)) {
  form.phonePool.smscloud.countryCode = [form.phonePool.smscloud.countryCode];
}
```

watch fetchInventory 触发条件不变（serviceCode 变化时拉），inventory 数据 merge 仍按所有 country 全拉（不按 form.countryCode 列表过滤）—— 这样 multi-select 显示所有有库存国家便于用户挑。

`config.example.json` 同步把 smscloud.countryCode 改成 `[187]`（数组示例）。

### 3.6 测试

#### `server/__tests__/smscloud-pool.test.js` 加 2 测

```js
test('S10 acquirePhone: preferredCountryCode 过滤 → 仅命中匹配 country 的 entry', async () => {
  const db = freshDb();  // freshDb 内 schema 也要加 country_code 列
  insertEntry(db, { orderNo: 'A', phone: '+1A', taken_at_ms: Date.now(), country_code: 7 });
  insertEntry(db, { orderNo: 'B', phone: '+1B', taken_at_ms: Date.now() - 1000, country_code: 187 });
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'NEW', phone: '+1NEW', apiKey: 'k', baseUrl: 'b', countryCode: 187 }; };
  const r = await pool.acquirePhone(db, 'x@y', 3, EXPIRY_MS, [], takeOrderFn, 187);
  assert.strictEqual(called, 0, 'cache hit on B');
  assert.strictEqual(r.phone, '+1B');
});

test('S11 acquirePhone: preferredCountryCode 无匹配 → 调 takeOrderFn 新取号', async () => {
  const db = freshDb();
  insertEntry(db, { orderNo: 'C', phone: '+1C', taken_at_ms: Date.now(), country_code: 7 });
  let called = 0;
  const takeOrderFn = async () => { called++; return { orderNo: 'D', phone: '+1D', apiKey: 'k', baseUrl: 'b', countryCode: 44 }; };
  const r = await pool.acquirePhone(db, 'y@z', 3, EXPIRY_MS, [], takeOrderFn, 44);
  assert.strictEqual(called, 1);
  assert.strictEqual(r.phone, '+1D');
  // 验证 country_code 落库
  const row = db.exec("SELECT country_code FROM smscloud_phone_cache WHERE order_no='D'");
  assert.strictEqual(row[0].values[0][0], 44);
});
```

`freshDb()` 同步加 `country_code INTEGER` 列；`insertEntry(db, { ..., country_code })` 支持新参数。

#### `__tests__/protocol-engine-smscloud-cache.test.js` 改造 + 新 SC5

SC1（两账号复用）—— 加 `countryCode: 187` 在 mock takeOrder 返值（合 smscloud-pool 新签名要求）。其他不变。

SC3/SC4 同样补 countryCode 字段。

新 SC5 测多 attempt 跨 country：

```js
test('SC5 attempt 1/2/3 跨 countryCode list 切换', async () => {
  setupCfg();  // 改 setupCfg 把 countryCode 设为 [7, 187, 44]
  try {
    const { engine, rawDb, protoMod } = await freshEngine();
    delete require.cache[require.resolve('../server/smscloud-provider')];
    const smscloud = require('../server/smscloud-provider');
    const origTake = smscloud.takeOrder, origResend = smscloud.resendSms;
    const takeCountries = [];
    smscloud.takeOrder = async (apiKey, baseUrl, serviceCode, countryCode) => {
      takeCountries.push(countryCode);
      return { order_no: 'OO' + takeCountries.length, phone: '+1' + countryCode + 'XX', raw: {} };
    };
    smscloud.resendSms = async () => {};

    const orig = protoMod.__runProtocolPhoneVerify;
    let i = 0;
    protoMod.__setRunProtocolPhoneVerify(async () => {
      i++;
      if (i < 3) return { status: 'fraud-blocked', detail: 'fraud_guard' };
      return { status: 'ok', tokens: { access_token: 'tok' } };
    });
    try {
      const r = await engine._finalizePhoneVerify({}, { email: 'sc5@x.com' });
      assert.ok(r.tokens, 'attempt 3 success');
      assert.deepStrictEqual(takeCountries, [7, 187, 44], 'attempt 跨 country fallback');
      try { await require('../server/db').save?.flush?.(); } catch {}
    } finally {
      smscloud.takeOrder = origTake;
      smscloud.resendSms = origResend;
      protoMod.__setRunProtocolPhoneVerify(orig);
    }
  } finally { restoreCfg(); }
});
```

setupCfg 改 countryCode 默认 [7, 187, 44]（如果旧测试用 single 7，归一逻辑保证兼容）。

## 4. 不在范围

- 不动 `protocol_phone_verify.py`
- 不动 zhusms / local provider
- 不引入 serviceCode 列表
- 不主动 inventory-driven country 选择
- 不引入 country 价格 + 库存 weight 自动决策
- 不动 deferred-cancel / smscloud-deferred-cancel
- 不动 PipelineEngine

## 5. 风险 / 边界

- **R1（schema migration）**：ALTER TABLE 兜底必须在 initDB CREATE TABLE 之后执行，与 v2.25 payment_link 模式对齐。新数据库直接 CREATE 含 country_code，旧数据库 ALTER。country_code IS NULL 的旧行 acquire 时被 `(country_code = ? OR country_code IS NULL)` 命中 —— 但 v2.45.1 旧行已"无品牌"，会被用户用于任何 country attempt，可能引入老号 race。考虑过滤掉 NULL 行更严格，但 v2.45.0/v2.45.1 已上线，强行排除旧行可能丢用户既有 cache。**采用宽松匹配（包括 NULL）**，后续清理由 expireOldEntries 18min 自然完成。
- **R2（takeOrderFn 返值兼容性）**：v2.45.0 唯一 caller 是 protocol-engine smscloud branch（本 spec §3.3 同步加 countryCode 字段），无外部 caller。但**测试 mock 的 takeOrderFn 可能漏写 countryCode** —— `country_code ?? null` fallback 让 INSERT NULL，acquire 宽松匹配仍能命中。本 spec §3.6 测试 mock 显式写 countryCode 字段，但旧测试改造时 fallback 兜底防止漏改。
- **R3（list 全空 / 缺字段）**：codes.length === 0 时 acquire return {}，上层 fail-fast 走 phonePoolEmpty 路径。config UI 强制至少选 1 个 country。
- **R4（attempt 用尽 list 循环）**：MAX_ATTEMPTS=3 + list.length<3 时 `% length` 循环回 list[0]，但 excludePhones（v2.45.1 内已含 triedPhones.push）会让 acquire 取 list[0] 的下一号 —— 行为退化但合理。
- **R5（multi-select v-model 顺序）**：Element Plus el-select multiple 模式默认按选择顺序排（选 7 → 选 187 → 选 44 → v-model = [7, 187, 44]）。删除某项后顺序保留剩余项。无需额外排序 UI。
- **R6（v2.46.0 inventory merge）**：fetchInventory 仍按 form.serviceCode 拉所有 country 的价格，不被 countryCode list 过滤 —— select 显示**所有有库存国家**便于用户挑选。
- **R7（zhusms / local attemptIdx 忽略）**：`_acquirePhoneForProtocol` 新参数 attemptIdx 在 zhusms / local branch 不使用，向后兼容无影响。
- **R8（v2.45.1 内层 MAX_ACQUIRE_TRIES=3 不冲突）**：内层循环处理同 country 的 resend 失败 → 内层用同 countryCode，外层 attempt 切换 country。两层语义正交。

## 6. 验收

- config.json `smscloud.countryCode` 改 `[7, 187, 44]` → Execute 一个 fraud-blocked 触发账号 → 日志：
  - `[protocol] smscloud attempt 1 country=7 (list=[7,187,44])` + 取号 +60116xxx → fraud-blocked
  - `[protocol] smscloud attempt 2 country=187 (list=[7,187,44])` + 取号 +1xxx (美国号) → success / fail
  - 不再 3 次全马来西亚 fraud-blocked
- 旧 `countryCode: 7` (number 单值) config 仍正常运行 —— 归一为 [7]，行为同 v2.45.1
- Config 页 country select 显示 multi-select，可选 1+ 国家拖出顺序
- 单测新增 3 个（smscloud-pool S10/S11 + protocol-engine SC5），`npm test` 全绿无回归
