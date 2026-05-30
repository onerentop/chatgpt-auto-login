# 配置页：印尼通道独立 tab —— 设计文档

- 日期：2026-05-31
- 状态：设计待审
- 关联：`web/src/views/Config.vue`（配置设置页）

## 1. 背景与问题

配置设置页的「JP 通道」tab（`web/src/views/Config.vue`，`name="jp"`）当前用一条 `el-divider` 把两个**机制完全不同**的代理通道塞在同一个 tab 里：

- **JP 通道**（`config.proxy.jpCheckout`）：sing-box 的第二出口（`:7891`），从**订阅节点池**按白名单/关键字挑日本住宅节点，供 OpenAI checkout API 使用。是双通道代理（7890 主 + 7891 JP）的一部分。
- **印尼通道（GoPay）**（`config.proxy.idGopay`）：一个 **IPRoyal HTTP 代理模板**（`country-id` session、`{sid}` 随机轮转 IP），**不走 sing-box、不来自订阅池**，是 GoPay 注册印尼号专用的住宅代理 URL。

两者并排在「JP 通道」tab 里造成概念混淆。本设计把印尼通道拆成独立 tab。

## 2. 目标

- 把印尼通道（GoPay 代理）从「JP 通道」tab 移出，放进一个独立的「印尼通道」tab。
- 「JP 通道」tab 只保留 JP 通道相关配置。
- 行为/保存/后端逻辑零改动 —— 纯 UI 重组。

## 3. 非目标（YAGNI）

- 不搬动「号池」tab 里的 GoPay PIN / 短信 provider（`form.gopayPin` / `form.gopaySmsProvider`）—— 保持本次聚焦，未来可另议是否整合 GoPay 配置。
- 不改 `config.json` 结构（`proxy.jpCheckout` 与 `proxy.idGopay` 本就是分开字段）。
- 不改任何后端读取逻辑。
- 不改 form 字段名、保存/加载逻辑。

## 4. 现状（`web/src/views/Config.vue`，`name="jp"` tab，约行 369–410）

```
JP 通道 tab：
  启用 JP 通道       form.proxyJpEnabled
  JP 节点关键字      form.proxyJpKeyword
  JP 节点白名单      form.proxyJpWhitelist
  （仪表盘提示）
  ── el-divider「印尼通道（GoPay）」 ──     ← 行 401
  启用印尼通道       form.proxyIdGopayEnabled   ← 行 402–404
  代理模板          form.proxyIdGopayTemplate  ← 行 405–408（v-if 印尼启用时显示）
```

## 5. 设计（方案 A：独立「印尼通道」tab）

**改动范围：仅 `web/src/views/Config.vue` 的 template。**

### 5.1 从 JP tab 移除印尼通道部分
删除 JP tab（`name="jp"`）内的行 401–408：
- `<el-divider content-position="left">印尼通道（GoPay）</el-divider>`
- 「启用印尼通道」`el-form-item`（`form.proxyIdGopayEnabled`）
- 「代理模板」`el-form-item`（`form.proxyIdGopayTemplate`，`v-if="form.proxyIdGopayEnabled"`）

移除后 JP tab 只剩：启用 JP 通道 / JP 节点关键字 / JP 节点白名单 / 仪表盘提示。

### 5.2 新增独立「印尼通道」tab
在 JP tab（`</el-tab-pane>` 行 410）之后、「节点黑名单」tab（`name="blacklist"`）之前，新增：

```vue
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
```

字段 `form.proxyIdGopayEnabled` / `form.proxyIdGopayTemplate` 与原来完全一致，仅在 template 中换了位置。

### 5.3 tab 顺序
支付 / 号池 / 执行 / Discord / OAuth-CPA / 代理 / JP 通道 / **印尼通道** / 节点黑名单。

## 6. 不变量

- `form` 的 `proxyIdGopayEnabled` / `proxyIdGopayTemplate` 绑定不变 → 保存仍写 `config.proxy.idGopay.{enabled,proxyTemplate}`，加载仍回填同字段。无需改 `setup()` 的 form 初始化、`save()`、`load()`。
- `config.proxy.jpCheckout`（JP）后端读取（`server/proxy/index.js` `pickJpNodes`、`server/index.js` 自动启动判断）不变。
- `config.proxy.idGopay` 后端读取（`server/proxy/index.js:285-286` GoPay 代理模板）不变。

## 7. 验证

- `cd web && npm run build` 编译零报错。
- 手动：配置页「印尼通道」tab 显示 启用开关 + 代理模板；「JP 通道」tab 不再包含印尼通道；切换开关 + 保存 + 刷新后印尼通道配置正确持久化（`config.proxy.idGopay`）。

## 8. 决策记录

| 决策 | 选择 |
|---|---|
| 印尼通道放哪 | 独立「印尼通道」tab（用户选定，最小改动、各归各位） |
| 是否搬 GoPay PIN/provider | 不搬（YAGNI，保持聚焦） |
| 是否改 config/后端 | 不改（字段本就分开） |
