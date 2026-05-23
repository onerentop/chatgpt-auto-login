# 协议模式支付：页面就绪检测设计

**日期：** 2026-05-23
**范围：** `protocol-engine.js` → `payment.js` 浏览器自动化阶段（OpenAI/Stripe + PayPal + SMS 对话框）
**目标：** 在网络慢、React 还没渲染完成时，避免自动填表/点击操作过早执行导致卡住或报错

---

## 1. 背景

协议模式（`protocol-engine.js`）在拿到 checkout 链接后，启动 Chrome + Playwright 调用 `payment.js::autoPayment(page, ...)` 完成支付。当前所有 handler（OpenAI/Stripe、PayPal Login、PayPal Checkout、SMS Dialog）使用**固定 `randomDelay(2000, 3000)` + 固定 timeout 的 `isVisible`** 作为等待手段。

**已观察到的问题：**
- 慢网络下 React 还没 commit 就开始扫描 DOM → `$0 trial` 误判
- PayPal accordion 点击后 form 未真正可交互前就开始填，silent fail
- `selectOption` 在 options 还没加载完时执行子串匹配，命中错值（如上次 `Kansas → Arkansas`）
- 切换国家后 `randomDelay(1500, 2500)` 固定窗口，不够时 schema 还在重画就开始填

---

## 2. 决策（已与用户确认）

| 决策点 | 选项 |
|---|---|
| 就绪标准 | **复合：DOM 稳定 + 关键元素就绪**（不用 networkidle，因 Stripe/PayPal 持续 polling） |
| 逐页超时 | **60s** |
| 超时后行为 | **沿用现有路径继续填**（日志记录，不中断流程） |
| 反检测 `randomDelay` | **保留**，就绪检测加在前 |

---

## 3. 架构

新增模块 `payment-readiness.js`，与 `payment.js` 同目录：

```
payment.js
  └─ autoPayment(page, ...)
       ├─ handleOpenAIPage(page)
       │    ├─ await waitForPageReady(page, PROFILES.openai)              ← 新增（入口）
       │    ├─ ... 点击 PayPal accordion ...
       │    └─ await waitForPageReady(page, PROFILES.paypalAccordionExpanded)  ← 新增（accordion 展开后）
       ├─ handlePayPalLogin(page)
       │    └─ await waitForPageReady(page, PROFILES.paypalLogin)
       ├─ handlePayPalCheckout(page)
       │    ├─ await waitForPageReady(page, PROFILES.paypalCheckout)      ← 新增（入口）
       │    ├─ ... 切换国家到 US ...
       │    └─ await waitForPageReady(page, PROFILES.paypalCheckoutAfterCountry)  ← 新增（国家切换后）
       └─ handleSmsVerification(page)
            └─ await waitForPageReady(page, PROFILES.smsDialog)
```

共 **6 个调用点**：openai 入口、accordion 展开、paypalLogin 入口、paypalCheckout 入口、afterCountry、smsDialog。

`protocol-engine.js:375` 的 `page.goto(link, { waitUntil: 'domcontentloaded' })` 不变 —— `waitForPageReady` 在 handler 入口兜住后续就绪判定。

---

## 4. `waitForPageReady` API

### 签名
```js
async function waitForPageReady(page, profile, opts = {}) → { ready, waitedMs, missing }
```

### 参数
- `page` — Playwright Page
- `profile` — readiness profile 对象（见第 5 节）
- `opts.totalTimeoutMs` — 总超时，默认 60000

### Profile 字段默认值
- `stableWindowMs` — 必填（每个 profile 显式声明）
- `elementTimeoutMs` — 可选，缺省 **5000**（PROFILES 里未指定的项走默认）
- `opts.log` — 日志函数，默认 noop

### 返回
- `ready: boolean` — 是否就绪
- `waitedMs: number` — 实际等待毫秒数
- `missing: string[]` — 未就绪关键元素的名称列表

### 行为流程
1. 计算 `deadline = Date.now() + totalTimeoutMs`
2. **并发**启动两组等待：
   - **DOM 稳定**：在浏览器内注入 `MutationObserver`，连续 `stableWindowMs` 无 mutation 即返回 ok
   - **关键元素**：`Promise.all` 等 `profile.requiredElements` 全部满足
3. 两者都成功 → `ready: true`，否则 `ready: false`（含部分成功的情况）
4. **不抛错**，由 handler 决定是日志+继续还是抛错

### MutationObserver 注入策略
- 用 `page.evaluate` 内联注入（不用 exposeFunction，避免多 frame 副作用）
- 监听 `document.body`，配置 `{ childList: true, subtree: true, attributes: true, characterData: true }`
- 每次 mutation 重置一个 `stableWindowMs` 的 timer，timer 触发即 resolve
- 兜底：observer 最多挂 60s 强制 disconnect
- 不监听 iframe（跨域 + 关心的元素都在主 document）

### Element check 类型
```js
{ name, kind: 'visible'|'attached'|'select'|'selectAny'|'text'|'visibleAny'|'js', ... }
```
- `visible`：`locator.waitFor({ state: 'visible' })` + `isEnabled()`
- `attached`：`locator.waitFor({ state: 'attached' })`（不要求可见，比如 submit 按钮可能在表单填完前 disabled）
- `select`：visible + `page.evaluate(() => el.options.length > 1)` —— 防止在 options 还没加载时选错值
- `selectAny`：多 selector 任一满足 select 条件
- `text`：`page.locator('text=...').waitFor({ state: 'visible' })`，支持 `anyOf` 数组
- `visibleAny`：多 selector 任一可见
- `js`：自定义 `page.evaluate(check)` 返回布尔

---

## 5. PROFILES（5 个）

### 5.1 `PROFILES.openai` — OpenAI/Stripe 支付页
URL：`pay.openai.com/c/pay/*` 或 `checkout.stripe.com/*`

```js
{
  name: 'openai-stripe',
  stableWindowMs: 800,
  requiredElements: [
    { name: 'priceRendered', kind: 'js',
      check: () => /\$\s*[0-9]/.test(document.body.innerText || '') },
    { name: 'paymentAccordion', kind: 'visible',
      selector: '[data-testid="paypal-accordion-item-button"], [data-testid="card-accordion-item-button"], #payment-method-accordion-item-title-paypal' },
    { name: 'submitBtn', kind: 'attached',
      selector: 'button[data-testid="hosted-payment-submit-button"], button[data-testid="submit-button"]' },
  ],
}
```

**替换：** `handleOpenAIPage` 头部的 `randomDelay(1500, 2500)` 删除（被 readiness 覆盖）；后续 `randomDelay` 保留作反检测节奏。

### 5.2 `PROFILES.paypalAccordionExpanded` — 点 PayPal 后等账单地址表单展开

```js
{
  name: 'paypal-accordion-expanded',
  stableWindowMs: 500,
  elementTimeoutMs: 10000,
  requiredElements: [
    { name: 'addressLine1', kind: 'visible',
      selector: '#billingAddressLine1, input[name*="addressLine1"]' },
    { name: 'stateSelect', kind: 'select',
      selector: '#billingAdministrativeArea' },
    { name: 'termsCheckbox', kind: 'attached',
      selector: '#termsOfServiceConsentCheckbox, input[type="checkbox"]' },
  ],
}
```

**替换：** `payment.js:237-249` 当前的 10 轮 1s 间隔循环等 `#billingAddressLine1`。新逻辑还会确保 `#billingAdministrativeArea` 的 options 加载完毕，避免子串匹配 bug 在 options 不完整时被触发。

### 5.3 `PROFILES.paypalLogin` — PayPal 登录页
URL：`paypal.com/pay`

```js
{
  name: 'paypal-login',
  stableWindowMs: 800,
  requiredElements: [
    { name: 'emailInput', kind: 'visible', selector: '#email' },
    { name: 'submitBtn', kind: 'attached',
      selector: 'button[data-testid="submit-button"], button[type="submit"]' },
  ],
}
```

**替换：** `handlePayPalLogin` 头部的 `randomDelay(2000, 3000)`。

### 5.4 `PROFILES.paypalCheckout` — PayPal checkout 页
URL：`paypal.com/checkoutweb` 或 `paypal.com/signup`

```js
{
  name: 'paypal-checkout',
  stableWindowMs: 1000,
  elementTimeoutMs: 8000,
  requiredElements: [
    { name: 'countrySelect', kind: 'selectAny',
      selectors: ['#country', '#countryCode', 'select[name="country"]', 'select[name="countryCode"]', 'select[id*="ountry"]'] },
    { name: 'emailInput',  kind: 'visible', selector: '#email' },
    { name: 'cardNumber',  kind: 'visible', selector: '#cardNumber' },
    { name: 'firstName',   kind: 'visible', selector: '#firstName' },
  ],
}
```

**替换：** `handlePayPalCheckout` 头部的 `randomDelay(2000, 3000)` + 第一段的 country `waitForFunction` 8s 探测（becomes 冗余）。

### 5.5 `PROFILES.paypalCheckoutAfterCountry` — 切完国家后等表单 schema 重渲染

```js
{
  name: 'paypal-checkout-after-country',
  stableWindowMs: 1500,
  elementTimeoutMs: 8000,
  requiredElements: [
    { name: 'billingLine1', kind: 'visible', selector: '#billingLine1' },
    { name: 'billingState', kind: 'select',  selector: '#billingState' },
    { name: 'billingZip',   kind: 'visible', selector: '#billingPostalCode' },
  ],
}
```

**替换：** `payment.js:429` 当前 `await randomDelay(1500, 2500)`（"give dependent fields a beat to repaint"）。

### 5.6 `PROFILES.smsDialog` — SMS 验证对话框

```js
{
  name: 'sms-dialog',
  stableWindowMs: 500,
  elementTimeoutMs: 8000,
  requiredElements: [
    { name: 'codeDialog', kind: 'text',
      anyOf: ['Enter your code', '输入验证码', '输入你的验证码'] },
    { name: 'codeInput', kind: 'visibleAny',
      selectors: ['input[autocomplete="one-time-code"]', 'input[type="tel"]', 'input[type="number"]'] },
  ],
}
```

**替换：** `payment.js:522-527` 当前的 `text=Enter your code` 8s 探测。

---

## 6. 错误处理

1. **`waitForPageReady` 永不 throw** —— 永远返回 `{ ready, waitedMs, missing }`
2. **handler 调用方只记日志、不分支** ——
   ```js
   const r = await waitForPageReady(page, PROFILES.openai, { log: console.log });
   if (!r.ready) {
     console.log(`    [Pay] 警告：${r.missing.join(',')} 60s 未就绪，仍尝试继续`);
   }
   // 原有 randomDelay/fill/click 逻辑保留
   ```
3. **观测性** —— 每次调用打一行日志：ready 时 `waited=XXms`，超时记 missing 列表，便于事后定位哪页最容易超时
4. **业务逻辑异常照常 throw** —— `NOT_FREE_TRIAL` 等仍由 `waitForPageReady` 之后的扫描代码触发（行为不变）

---

## 7. 测试

新增 `payment-readiness.test.js`，**不依赖真实浏览器**：

1. **`waitForPageReady` 纯逻辑单元测试**（mock page 对象）：
   - 全就绪 → `ready: true`
   - DOM 永远不稳定 + 元素就绪 → 超时，`ready: false`，`missing: []`
   - 部分元素超时 → `ready: false`，`missing` 含名称
   - elementTimeoutMs 并发不超过 deadline
2. **PROFILES schema 校验** —— 所有 profile 含 `name`、`requiredElements`、`stableWindowMs`
3. **fake timers** —— 用 `node:test` 的 mock timers，避免真等 60s
4. **不做端到端** —— Stripe/PayPal 端到端会被风控且非确定性，由生产 dry-run 验证

---

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `payment-readiness.js` | **新建** — 导出 `waitForPageReady` + `PROFILES` |
| `payment-readiness.test.js` | **新建** — 单元测试 |
| `payment.js` | 6 处 handler 入口/状态切换点插入 `await waitForPageReady` 调用；删除被覆盖的 `randomDelay`（具体见 §5 每个 profile 的"替换"小节）；保留 fill/click 之间的反检测随机间隔 |
| `protocol-engine.js` | 不动 |
| `config.json` / UI | 不动 |

---

## 9. 非目标 / 不做

- **不做 networkidle 等待** —— 已确认对 Stripe/PayPal 不适用
- **不抽 readiness manager 配置文件层** —— 过度工程
- **不改 protocol_register.py** —— HTTP 层无浏览器
- **不改 server/engine.js 非协议模式** —— 用户明确说"先改协议模式"，后续可推广
- **不端到端 mock Stripe/PayPal** —— 维护成本高，由 dry-run 覆盖

---

## 10. 后续可推广

本次方案落地后，可以以零成本扩展到：
- `server/engine.js` 浏览器自动化模式（同样调用 `payment.js`，profiles 复用）
- 其他需要等 React 就绪的 Playwright 流程（登录页、CPA 页等）

profile 是数据，新加场景只需要追加一个 profile 条目，不改 `waitForPageReady` 实现。
