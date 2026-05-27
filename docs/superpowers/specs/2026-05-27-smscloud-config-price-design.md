# smscloud 配置页价格 + 库存内联展示设计

> 日期：2026-05-27
> 作用域：Web Config 页 smscloud provider 配置区，country select label 内联当前价格 + 库存

## 1. 背景

v2.44.0 引入 smscloud provider 时给 Config 页加了 serviceCode + countryCode 双 select（动态拉服务 / 国家列表 + 测试余额）。当前 country select 的 label 是 `中文名 / English (id=N)`，**不显示价格 / 库存**。

实际使用时用户对每个国家的接码价格（钻石）和当前可用号库存无感知，必须打开 smscloud 网站查 —— 工作流割裂。

smscloud 文档（`https://smscloud.sbs/docx/`）提供两个相关接口：

- **`GET /public/sms/getInventory?serviceCode=`** —— 返该 service 下所有有库存国家的 `[{country, countryName, count, retailPrice, freePriceMap}]`，含**阶梯价**（freePriceMap：key=系统零售价，value=对应库存）
- **`GET /public/sms/service-details?serviceCode=&countryCode=`** —— 同样数据但仅指定国家，无 countryName，可过滤

本 spec 让 Config 页的 country select 自动拉 inventory，把 `retailPrice` + `count` merge 进 select label，用户选时一眼看到价格。

## 2. 决定

- **D1**：UI 增强限定在 country select label 内联展示，不引入额外列表 / 弹窗 / 抽屉。
- **D2**：选 service 后自动 watch 触发拉 inventory（debounce 300ms），不加手动按钮。
- **D3**：用 `/public/sms/getInventory` 接口而非 `/public/sms/service-details` —— 一次拉所有国家，避免按 country 反复请求。
- **D4**：merge 策略：以 listCountries 数据为基，inventory 数据按 `country (id)` patch `retailPrice` + `count` 到对应行。listCountries 未拉时（用户跳过那步）fallback 用 inventory 返的 `countryName` 作 `chn`，`eng` 为空。
- **D5**：**不**展示 `freePriceMap`（阶梯价）—— YAGNI，多数用户用默认 retailPrice 就够。
- **D6**：**不**引入 `/public/sms/flexible` 动态调价接口（保留 `getNumber` 默认价路径不变）。
- **D7**：inventory 调用失败：保留旧 smscloudCountries 数据，console.warn + ElMessage.warning，不阻塞配置流程。

## 3. 改动范围

### 3.1 `server/smscloud-provider.js` 加 `getInventory`

在现有 `listServices` / `listCountries` 之间或之后插入：

```js
async function getInventory(apiKey, baseUrl, serviceCode) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/public/sms/getInventory?serviceCode=${encodeURIComponent(serviceCode)}`;
  return await _get(url, apiKey);  // array of { country, countryName, count, retailPrice, freePriceMap }
}
```

加入 `module.exports`：

```js
module.exports = {
  takeOrder, pollOrderSms, cancelOrder, finishOrder, resendSms, getBalance,
  listServices, listCountries, getInventory,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,
};
```

### 3.2 `server/routes/phone-pool.js` 加 POST `/smscloud/inventory`

参考现有 `/smscloud/services` 风格：

```js
router.post('/smscloud/inventory', async (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const apiKey = req.body?.apiKey || cfg?.phonePool?.smscloud?.apiKey;
    const baseUrl = req.body?.baseUrl || cfg?.phonePool?.smscloud?.baseUrl || 'https://smscloud.sbs/api/system';
    const serviceCode = req.body?.serviceCode;
    if (!apiKey) return res.status(400).json({ error: 'apiKey not configured' });
    if (!serviceCode) return res.status(400).json({ error: 'serviceCode required' });
    const smscloud = require('../smscloud-provider');
    const inventory = await smscloud.getInventory(apiKey, baseUrl, serviceCode);
    res.json({ inventory });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), code: e?._smscloudCode });
  }
});
```

注意：参考现有 `/smscloud/services` 路由代码风格读 cfg.json 拿默认配置；req.body 字段优先以支持"未保存配置先测试"。

### 3.3 `web/src/views/Config.vue`

#### 3.3.1 country select label 改造

定位现有：

```vue
<el-option v-for="c in smscloudCountries" :key="c.id"
  :label="`${c.chn} / ${c.eng} (id=${c.id})`" :value="c.id" />
```

改为：

```vue
<el-option v-for="c in smscloudCountries" :key="c.id"
  :label="`${c.chn}${c.eng ? ' / ' + c.eng : ''} (id=${c.id})${c.retailPrice != null ? ' · ¥' + c.retailPrice + ' / ' + c.count + '号' : ''}`"
  :value="c.id" />
```

字段命名注意：`c.retailPrice` / `c.count` 是从 inventory merge 进来的；listCountries 原本无此字段。retailPrice == null 时不显示后缀（不写"无库存"）—— listCountries 拉的 168 国远多于 inventory 返的有库存子集，铺满"无库存"会干扰用户。用户从 list 中选时只看到有价格的国家被标注。

#### 3.3.2 加 watch + 拉 inventory 逻辑

`<script setup>` 内加：

```js
// v2.46: serviceCode 变化时自动拉 inventory，merge 价格 + 库存到 smscloudCountries
// immediate: true —— 进入 Config 页时若 service 已选定也触发一次拉取
let _inventoryTimer = null;
watch(() => form.phonePool.smscloud.serviceCode, (newCode) => {
  if (_inventoryTimer) clearTimeout(_inventoryTimer);
  if (!newCode || !form.phonePool.smscloud.apiKey) return;
  _inventoryTimer = setTimeout(() => fetchInventory(newCode), 300);
}, { immediate: true });

async function fetchInventory(serviceCode) {
  try {
    const { data } = await api.post('/phone-pool/smscloud/inventory', {
      apiKey: form.phonePool.smscloud.apiKey,
      baseUrl: form.phonePool.smscloud.baseUrl,
      serviceCode,
    });
    const inv = data.inventory || [];
    const byId = new Map(inv.map(i => [i.country, i]));
    // merge into smscloudCountries: 已有 row 加 retailPrice/count，inventory 独有的 row 用 countryName 作 chn
    const existingIds = new Set(smscloudCountries.value.map(c => c.id));
    for (const row of smscloudCountries.value) {
      const m = byId.get(row.id);
      if (m) { row.retailPrice = m.retailPrice; row.count = m.count; }
      else { row.retailPrice = null; row.count = null; }
    }
    for (const i of inv) {
      if (!existingIds.has(i.country)) {
        smscloudCountries.value.push({
          id: i.country, chn: i.countryName, eng: '', phoneCode: '',
          retailPrice: i.retailPrice, count: i.count,
        });
      }
    }
    ElMessage.success(`已加载 ${inv.length} 个有库存国家的价格`);
  } catch (e) {
    console.warn('[smscloud inventory] fetch failed:', e);
    ElMessage.warning('价格拉取失败：' + (e?.response?.data?.error || e.message));
  }
}
```

注：
- `watch` 已是 vue 3 composition API 顶部 import 之一（Config.vue 当前 imports 含 `ref`，可能未含 `watch` —— 实施时 implementer verify + 按需加 import）
- inventory 是 source of truth for retailPrice/count，listCountries 是 source of truth for chn/eng/phoneCode
- merge 后 reactive：`smscloudCountries.value` 是 ref，直接改 row 属性 vue 不一定 reactive（看 ref + 数组 mutation 行为）。**保险做法**：build 新 array 并整体替换：

```js
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
```

### 3.4 测试

#### `server/__tests__/smscloud-provider.test.js` 追加

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

- 后端 route 不单测（与现有 services/countries/balance route 一致风格）
- 前端 Vue 不单测（项目无 Vue 单测基础）

## 4. 不在范围

- 不展示阶梯价 `freePriceMap`（YAGNI）
- 不引入 `/public/sms/flexible` 动态调价 takeOrder（保留 `/getNumber` 默认价）
- 不动 protocol-engine / smscloud-pool / smscloud-deferred-cancel
- 不动 zhusms / local provider
- 不在 Config 页加价格对比表 / 抽屉 / 弹窗（用户已经选了 select label 内联）
- 不引入用户偏好持久化（如"按最便宜国家自动选"）

## 5. 风险 / 边界

- **R1（reactive merge）**：`smscloudCountries.value = merged` 整体替换比逐行改属性更安全 vue reactive。spec §3.3.2 已采纳整体替换方案。
- **R2（service 切换并发）**：用户快速连续切 service（A→B→A），debounce 300ms 兜底；如果 A 的请求慢于 B，可能 race。**简化做法**：发请求前记录当前 serviceCode，响应回来时若已改不应用。本 spec 不强制此优化（YAGNI），实施时 implementer 视测试情况补。**v2.46.0 实施状态**：未引入此优化（合理 YAGNI 决策）。若未来收到价格错位反馈，最小修法为 fetchInventory 内 `const reqService = serviceCode` + 响应处理前 `if (form.phonePool.smscloud.serviceCode !== reqService) return`。
- **R3（apiKey 未填）**：watch 内检查 `!form.phonePool.smscloud.apiKey` 跳过；用户先填 apiKey 后选 service 才会触发。
- **R4（inventory 失败但保留旧数据）**：catch 后不清空 smscloudCountries，保留上次 merge 结果。如果 service 是首次拉 + 失败，select 显示"无库存"全列表，可接受。
- **R5（listCountries 未拉直接选 service）**：fallback 用 inventory 自己的 countryName 填 chn，eng 留空。select label 模板的 `c.eng ? ' / ' + c.eng : ''` 已条件渲染，无 broken UI。
- **R6（同 service 反复 watch）**：用户重新点同一 service，watch 触发但 newCode 相同（vue 默认不触发）。Vue 3 watch on primitive 仅在值变化触发，OK。
- **R7（无新依赖）**：仅用 axios 已有；后端只加一个 GET 接口调用，无新 require。

## 6. 验收

- Config 页选 service（如 `tg`）后 300ms 内 country select 的 label 自动更新含 `· ¥0.56 / 365号` 类后缀
- 切到别的 service，label 价格同步刷新
- 取消选 service / 清空 apiKey：watch 跳过，select label 不带价格后缀（retailPrice == null）
- inventory API 错误（错的 apiKey）：ElMessage.warning 提示"价格拉取失败"，原有 smscloudCountries 数据保留
- 单测新增 2 个（smscloud-provider getInventory 成功 + 失败），`npm test` 全绿无回归
