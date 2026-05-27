# smscloud 配置页价格 + 库存内联展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Config 页 smscloud country select 选择 service 后自动拉 `/getInventory` 接口，把当前价格 + 库存内联进 select label。

**Architecture:** `smscloud-provider.js` 加 `getInventory(apiKey, baseUrl, serviceCode)` 调 `/public/sms/getInventory`。`phone-pool.js` routes 加 POST `/smscloud/inventory` 透传调用。`Config.vue` 加 `watch(form.phonePool.smscloud.serviceCode, ..., { immediate: true })` 触发 `fetchInventory` 拉数据并 merge 进 `smscloudCountries`，country select label 模板内联 `¥${retailPrice} / ${count}号`。

**Tech Stack:** Node.js (CommonJS) + Vue 3 Composition + Element Plus。无新依赖。

**Spec:** `docs/superpowers/specs/2026-05-27-smscloud-config-price-design.md`

---

## File Structure

- **Modify:** `server/smscloud-provider.js` —— 加 `getInventory` + 导出
- **Modify:** `server/__tests__/smscloud-provider.test.js` —— 追加 2 测
- **Modify:** `server/routes/phone-pool.js` —— 加 POST `/smscloud/inventory` route
- **Modify:** `web/src/views/Config.vue` —— country select label 改造 + watch + fetchInventory
- **Modify:** `docs/CHANGELOG.md` —— v2.46.0 节

---

## Task 1: smscloud-provider 加 getInventory（TDD）

**Files:**
- Modify: `server/smscloud-provider.js`
- Modify: `server/__tests__/smscloud-provider.test.js`（追加）

依赖：无。

- [ ] **Step 1: 追加 2 失败测试**

在 `server/__tests__/smscloud-provider.test.js` 末尾追加：

```js
test('getInventory: 返 array', async () => {
  const restore = mockFetch(async (url) => {
    assert.ok(url.includes('/public/sms/getInventory?serviceCode=tg'));
    return { ok: true, json: async () => ({ code: 0, data: [
      { country: 187, countryName: '美国', count: 365, retailPrice: 0.56, freePriceMap: '{}' },
      { country: 44, countryName: '英国', count: 25, retailPrice: 3.2, freePriceMap: '{}' },
    ] }) };
  });
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    const inv = await smscloud.getInventory('key', null, 'tg');
    assert.strictEqual(inv.length, 2);
    assert.strictEqual(inv[0].country, 187);
    assert.strictEqual(inv[0].retailPrice, 0.56);
  } finally { restore(); }
});

test('getInventory: serviceCode 不存在抛错', async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ code: 1, message: 'service not found' }),
  }));
  try {
    delete require.cache[require.resolve('../smscloud-provider')];
    const smscloud = require('../smscloud-provider');
    await assert.rejects(
      smscloud.getInventory('key', null, 'unknown'),
      (e) => e.message.includes('service not found')
    );
  } finally { restore(); }
});
```

- [ ] **Step 2: 跑测试确认旧用例 pass + 新 2 fail**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 旧 11 用例（v2.44.0 ~ v2.45.1）全 pass；新 2 fail (smscloud.getInventory is not a function)

- [ ] **Step 3: 实现 getInventory**

打开 `server/smscloud-provider.js`，在 `listCountries` 函数（约 line 82-84）**之后**插入：

```js
async function getInventory(apiKey, baseUrl, serviceCode) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/public/sms/getInventory?serviceCode=${encodeURIComponent(serviceCode)}`;
  return await _get(url, apiKey);
}
```

更新 `module.exports`（约 line 86-89）加入 `getInventory`：

```js
module.exports = {
  takeOrder, pollOrderSms, cancelOrder, finishOrder, resendSms, getBalance,
  listServices, listCountries, getInventory,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,
};
```

- [ ] **Step 4: 跑测试全 pass**

Run: `node --test server/__tests__/smscloud-provider.test.js`
Expected: 13/13 pass（11 旧 + 2 新）

- [ ] **Step 5: 提交**

```bash
git add server/smscloud-provider.js server/__tests__/smscloud-provider.test.js
git commit -m "feat(smscloud): 加 getInventory 接口供 Config 页拉价格库存"
```

---

## Task 2: 后端 route + 前端 UI（前后端配对一个 commit）

**Files:**
- Modify: `server/routes/phone-pool.js`
- Modify: `web/src/views/Config.vue`

依赖：Task 1 完成。

- [ ] **Step 1: 加 POST `/smscloud/inventory` route**

打开 `server/routes/phone-pool.js`，在 `/smscloud/countries` route 之后（约 line 118 之后、`module.exports = router` 之前）插入：

```js
router.post('/smscloud/inventory', async (req, res) => {
  try {
    const cfg = req.body?.config || JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    const serviceCode = req.body?.serviceCode;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });
    if (!serviceCode) return res.status(400).json({ error: 'serviceCode required' });
    const smscloud = require('../smscloud-provider');
    const inventory = await smscloud.getInventory(apiKey, baseUrl, serviceCode);
    res.json({ inventory });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});
```

风格与 `/smscloud/services` / `/smscloud/countries` 一致。

- [ ] **Step 2: 改 Config.vue country select label**

定位 country select option（约 line 79-80）：

```vue
<el-option v-for="c in smscloudCountries" :key="c.id" :label="`${c.chn} / ${c.eng} (id=${c.id})`" :value="c.id" />
```

改为：

```vue
<el-option v-for="c in smscloudCountries" :key="c.id" :label="`${c.chn}${c.eng ? ' / ' + c.eng : ''} (id=${c.id})${c.retailPrice != null ? ' · ¥' + c.retailPrice + ' / ' + c.count + '号' : ''}`" :value="c.id" />
```

注意：spec §3.3.1 给的 label 模板包含"· 无库存"分支，但实施时 simplify 成"价格存在才显示，否则不带后缀"—— 因为 listCountries 拉了 168 国但 inventory 只返有库存的子集，"无库存"会铺满 list 反而干扰。改为：有价格才显示，无价格则保持原 label 不变（用户从原列表中找）。

- [ ] **Step 3: Config.vue 加 fetchInventory 函数 + watch**

定位 `fetchSmscloudCountries` 函数（约 line 690-700 区域，触发"拉国家"按钮调）末尾或 `fetchSmscloudBalance`（约 line 708-720）旁边，在其后插入：

```js
// v2.46.0: serviceCode 变化时自动拉 inventory，merge 价格 + 库存到 smscloudCountries
async function fetchInventory(serviceCode) {
  try {
    const { data } = await api.post('/phone-pool/smscloud/inventory', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
      serviceCode,
    });
    const inv = data.inventory || [];
    const byId = new Map(inv.map(i => [i.country, i]));
    const existingIds = new Set(smscloudCountries.value.map(c => c.id));
    const merged = smscloudCountries.value.map(row => {
      const m = byId.get(row.id);
      return m ? { ...row, retailPrice: m.retailPrice, count: m.count }
               : { ...row, retailPrice: null, count: null };
    });
    for (const i of inv) {
      if (!existingIds.has(i.country)) {
        merged.push({ id: i.country, chn: i.countryName, eng: '', phoneCode: '', retailPrice: i.retailPrice, count: i.count });
      }
    }
    smscloudCountries.value = merged;
    ElMessage.success(`已加载 ${inv.length} 个有库存国家的价格`);
  } catch (e) {
    console.warn('[smscloud inventory] fetch failed:', e);
    ElMessage.warning('价格拉取失败：' + (e?.response?.data?.error || e.message));
  }
}

let _inventoryTimer = null;
watch(() => form.phonePool.smscloud.serviceCode, (newCode) => {
  if (_inventoryTimer) clearTimeout(_inventoryTimer);
  if (!newCode || !form.phonePool.smscloud.apiKey) return;
  _inventoryTimer = setTimeout(() => fetchInventory(newCode), 300);
}, { immediate: true });
```

`watch` 已在 line 308 `import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue'`，无需新加 import。

- [ ] **Step 4: 跑 npm test 无回归**

Run: `npm test`
Expected: 全套 pass

- [ ] **Step 5: 烟测前端**

```bash
cd web && npm run build
```

Expected: build 成功，无 TypeScript / Vue compile 错误（项目无 TS，但 Vite 会报 vue template 错）。

build 完后用户可以重启 server + 浏览器打开 Config 页验证 —— 但本 task 不强制实施 implementer 跑 server，build pass 即可。

- [ ] **Step 6: 提交**

```bash
git add server/routes/phone-pool.js web/src/views/Config.vue
git commit -m "feat(config): smscloud country select label 内联价格库存"
```

注意：`web/dist/` 由 `npm run build` 产生但 .gitignore 是否忽略它需要 implementer 用 `git status` 确认。**若 dist 也 staged，则单独 commit dist 或在本 commit 一起带（参考项目历史 dist 处理惯例）**。

---

## Task 3: CHANGELOG v2.46.0 + tag

**Files:**
- Modify: `docs/CHANGELOG.md`

依赖：Task 1 + Task 2 完成。

- [ ] **Step 1: 加 v2.46.0 节**

在 v2.45.1 节上方插入：

```markdown
## v2.46.0 — 2026-05-27 — smscloud Config 页价格 + 库存内联

### 核心改动

- `server/smscloud-provider.js` 加 `getInventory(apiKey, baseUrl, serviceCode)` 对应 smscloud 文档 `/public/sms/getInventory`，返该 service 下所有有库存国家的 `{country, countryName, count, retailPrice, freePriceMap}`。
- `server/routes/phone-pool.js` 加 POST `/smscloud/inventory` 透传调用，body 接 `{apiKey?, baseUrl?, serviceCode}`，apiKey 缺省读 `config.json`。
- `web/src/views/Config.vue` 加 `watch(form.phonePool.smscloud.serviceCode, ..., { immediate: true })` + debounce 300ms 触发 `fetchInventory`，把 inventory 数据 by-id merge 进 `smscloudCountries`。country select 的 option label 增强为 `中文名 / English (id=N) · ¥R / N号`（无价格时保持原 label）。

### UX 提升

- 选定 service 后 country select 直接看到每个国家的当前价格 + 可用号库存，不再需要切到 smscloud 网站查价。
- 切 service 自动重拉，无需手动按钮。
- 价格拉取失败仅 warn 不阻塞配置流程。

### 不在范围

- 不展示阶梯价 `freePriceMap`（YAGNI）。
- 不引入动态调价取号 `/public/sms/flexible`（保留 `/getNumber` 默认价路径）。
- 不动 protocol-engine / smscloud-pool / smscloud-deferred-cancel。

### 测试

- 单测新增 2 个（`getInventory` 成功 + 失败）。后端 route 与前端 Vue 沿用项目无单测惯例。
- `npm test` 339 / 317 pass / 22 skipped / 0 fail。
```

- [ ] **Step 2: 提交 + tag**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: CHANGELOG v2.46.0"
git tag v2.46.0
git tag --list 'v2.4*'
git log --oneline -8
```

不 push。

---

## Self-Review

- **Spec coverage**：
  - spec §3.1 getInventory → Task 1 ✓
  - spec §3.2 route → Task 2 Step 1 ✓
  - spec §3.3.1 label 改造 → Task 2 Step 2（实施 simplify "无库存" 分支为空字符串）✓ —— 这是 plan 微调 spec 的实践决策
  - spec §3.3.2 watch + fetchInventory → Task 2 Step 3 ✓
  - spec §3.4 测试 → Task 1 Step 1 ✓
- **Placeholder scan**：无 TBD / TODO / "fill in" / "similar to" ✓
- **Type consistency**：
  - `getInventory(apiKey, baseUrl, serviceCode)` 签名在 Task 1 实现 / Task 2 route 调用 / 测试 mock 三处一致 ✓
  - inventory 数据字段 `country / countryName / count / retailPrice / freePriceMap` 在 Task 1 测试 / Task 2 fetchInventory merge 逻辑一致 ✓
  - select label 模板与 spec §3.3.1 一致（除"无库存"分支 simplify）✓
- **plan 微调 spec**：Task 2 Step 2 simplify "无库存"分支为空字符串 —— 因 listCountries 拉的国家数远多于 inventory 返的有库存子集，全部显示"无库存"反而干扰用户。在 CHANGELOG 内已写明"无价格时保持原 label"。

---

## Execution Handoff

Plan 落到 `docs/superpowers/plans/2026-05-27-smscloud-config-price.md`。3 个 Task：

1. **Subagent-Driven（推荐）** —— 每 Task 派 implementer + review，本会话内 3 个 Task 串行
2. **Inline Execution** —— 主体 Claude 逐 Task 执行

选哪个？
