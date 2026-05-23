# 协议模式注册：SOCKS5 代理 + HTTP/1.1 兜底 + sing-box 升级

**日期：** 2026-05-23
**范围：** `protocol_register.py` 关键 POST + `server/proxy/singbox.js` 版本
**目标：** 修复"内置代理走 HTTP CONNECT 时 `/api/accounts/create_account` 返回 400 invalid_request，TUN 模式正常"

---

## 1. 背景与问题

协议模式（curl_cffi 走 sing-box mixed inbound HTTP CONNECT，端口 7890）注册账号时，`POST /api/accounts/create_account` 偶发返回：
```
400 {"error": {"message": "Sorry, we cannot create your account with the given information.", "type": "invalid_request"}}
```

但**同一个用户在用第三方代理软件开 TUN 模式时一切正常**（同一套节点订阅）。

### 根因分析

通过对照 sing-box issue [#3945](https://github.com/SagerNet/sing-box/issues/3945)、curl_cffi 社区讨论、本项目 `protocol_register.py:549-557` 的旧注释（"unstable proxy paths break HTTP/2 framing mid-handshake"）综合判断：

curl_cffi 默认走 HTTP/2，请求经 sing-box mixed inbound 的 HTTP CONNECT 隧道时，HTTP/2 帧的分片/SETTINGS 时序与 OpenAI server-side 期望不完全匹配。Server 解析时拿到不完整或时序错乱的请求 body，sentinel-token / risk-control 校验失败 → 返回 generic 400 `invalid_request`。

TUN 模式下 sing-box 在 L3 透明转发，不动 HTTP 帧，所以没有这个问题。

代码已经在 `Step 0 Homepage` 的 retry 路径里埋伏了 HTTP/1.1 fallback，但**关键 POST（`create_account` / `authorize/continue` / `email-otp/validate`）没有同样的 fallback**，一次 HTTP/2 失败就直接抛 400 出来。

---

## 2. 决策（已与用户确认）

| 决策点 | 选择 |
|---|---|
| 修复策略 | **A + B + C 三合一**：应用层 HTTP/1.1 兜底 + 代理协议改 SOCKS5 + sing-box 升级 |
| 实施顺序 | 分两个 Phase：先 A+B（应用层），再 C（sing-box 升级） |
| SOCKS5 变体 | `socks5h://`（DNS 由代理解析，对齐 TUN 模式行为） |
| HTTP/1.1 fallback 触发条件 | (1) HTTP/2 抛 TLS-level 异常 (2) HTTP/2 返回 400 且响应含 `invalid_r` 字符串 |
| Fallback 重试次数 | 一次（够覆盖瞬时帧失败，不至于放大失败请求量） |
| sing-box 目标版本 | **1.13.12**（最新稳定版，发布于 2026-05-15） |
| sing-box 回滚 | 改回 `'1.10.7'` + 删 `bin/sing-box.exe` + 重启 |

---

## 3. 架构

3 个独立改动层，互不依赖：

| 层 | 改动 | 文件 | Phase |
|---|---|---|---|
| **B — 代理协议** | `proxy_url` 从 `http://` 改写成 `socks5h://`。sing-box mixed inbound 同端口同时支持 HTTP CONNECT 与 SOCKS5（peek 第一字节判定） | `protocol_register.py` | 1 |
| **A — HTTP/1.1 兜底** | 新建 helper `_post_with_h1_fallback`，3 处关键 POST 替换为它 | `protocol_register.py` | 1 |
| **C — sing-box 升级** | `SINGBOX_VERSION = '1.10.7'` → `'1.13.12'` | `server/proxy/singbox.js` | 2 |

任何一层单独应用都能减少 400 出现概率，三层叠加最稳。

---

## 4. Phase 1 — 应用层修复（A + B）

### 4.1 B — SOCKS5 代理转换

**位置：** `protocol_register.py:559`（紧接 `proxy_url = input_data.get("proxy", "")` 之后）

**当前：**
```python
proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
```

**改后：**
```python
# Convert http://... → socks5h://... since sing-box's mixed inbound serves both
# HTTP CONNECT and SOCKS5 on the same port. SOCKS5 has less framing overhead
# than HTTP CONNECT and avoids HTTP/2-over-CONNECT-tunnel issues observed with
# sing-box mixed inbound (ref: SagerNet/sing-box#3945). 'socks5h' offloads DNS
# to the proxy, matching TUN-mode behavior.
if proxy_url and proxy_url.startswith('http://'):
    proxy_url = 'socks5h://' + proxy_url[len('http://'):]
proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
```

**为什么 `socks5h` 而不是 `socks5`：**
- `socks5` — client 端 DNS 解析，发 IP 给代理
- `socks5h` — hostname 发给代理，由代理解析 DNS

我们要的是与 TUN 模式同样的"DNS 也走出口节点"行为，所以用 `socks5h`。否则会出现 IP（节点出口）与 DNS（ISP）不一致的反 bot 信号。

**风险：** 极低。`proxy_url` 来源仅有 `server/proxy/index.js::getProxyUrl()`（我们自家 sing-box），固定支持 SOCKS5，不需要 fallback 到 HTTP CONNECT。

### 4.2 A — HTTP/1.1 兜底 helper

**位置：** `protocol_register.py`，紧跟 `_RetrySession` 类定义之后（约 line 580 附近，新增）

```python
def _post_with_h1_fallback(session, url, *, json=None, headers=None, timeout=30):
    """POST that retries once with HTTP/1.1 on transient HTTP/2 errors or 400
    risk-control responses. Returns the final Response.

    Triggers HTTP/1.1 retry on:
      (1) HTTP/2 raises a TLS/curl exception
      (2) HTTP/2 returns 400 with 'invalid_r' in body (sentinel-token / frame
          corruption marker observed with sing-box mixed inbound)

    No retry happens on success or other non-400 status.
    """
    try:
        r = session.post(url, json=json, headers=headers, timeout=timeout)
    except Exception as e:
        if HTTP11 is not None:
            _log(f"POST {url.rsplit('/', 1)[-1]} HTTP/2 raise: {str(e)[:60]} — retry HTTP/1.1")
            return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)
        raise

    if r.status_code == 400 and 'invalid_r' in (r.text or '') and HTTP11 is not None:
        _log(f"POST {url.rsplit('/', 1)[-1]} got 400 invalid_r on HTTP/2 — retry HTTP/1.1")
        return session.post(url, json=json, headers=headers, timeout=timeout, http_version=HTTP11)

    return r
```

**关键设计点：**

- **`'invalid_r'` 匹配** —— `invalid_request` 是 OpenAI 当前的 error.type 字符串。用前缀 `invalid_r` 匹配更宽松，也覆盖 `invalid_request_error` / `invalid_response` 变体，避免 OpenAI 改字符串时漏匹配
- **`HTTP11 is None` 时直接抛错** —— 老版 curl_cffi（<0.5.9）没 `CurlHttpVersion.V1_1`，没法 fallback。维持原 fail-fast 行为
- **不重试多次** —— HTTP/1.1 是最后一次尝试，再失败就让上层（engine 的 account-retry）处理
- **不修改请求 body / headers** —— 同样的 payload 重试，只换 transport 层

### 4.3 三个接入点

| Endpoint | 当前 line | 改动 |
|---|---|---|
| `POST /api/accounts/create_account` | `protocol_register.py:829-830` | `session.post(...)` → `_post_with_h1_fallback(session, ...)` |
| `POST /api/accounts/authorize/continue` (v2 流邮件提交) | `protocol_register.py:693-697` | 同上 |
| `POST /api/accounts/email-otp/validate` | `protocol_register.py:758-763` | 同上 |

**不接入的端点：**

- `POST /api/accounts/user/register` —— 失败模式不同（401/409 而非 400 invalid_r），加 fallback 反而误判
- `POST /api/accounts/email-otp/send` —— 同上
- `POST /api/auth/signin/openai` —— 不在 auth.openai.com 域，行为模式不同
- PKCE 流（line 259, 335）的 `authorize/continue` —— 旧版兼容路径，保持原状

### 4.4 单元测试

**新建 `tests/test_protocol_register_h1_fallback.py`：**

```python
import unittest
from unittest.mock import MagicMock
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Stub curl_cffi before importing protocol_register so HTTP11 sentinel is set
import types
fake_curl_cffi = types.ModuleType('curl_cffi')
fake_curl_cffi.CurlHttpVersion = types.SimpleNamespace(V1_1='HTTP11_SENTINEL')
sys.modules.setdefault('curl_cffi', fake_curl_cffi)

from protocol_register import _post_with_h1_fallback

class H1FallbackTest(unittest.TestCase):
    def test_h2_success_no_retry(self):
        resp = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a':1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)
        # No http_version kwarg on the single call → HTTP/2 path
        call_kwargs = session.post.call_args.kwargs
        self.assertNotIn('http_version', call_kwargs)

    def test_h2_400_invalid_r_retries_h1(self):
        resp_h2 = MagicMock(status_code=400, text='{"error":{"type":"invalid_request"}}')
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [resp_h2, resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a':1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        # Second call must use HTTP/1.1
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), 'HTTP11_SENTINEL')

    def test_h2_raises_retries_h1(self):
        resp_h1 = MagicMock(status_code=200, text='{"ok":true}')
        session = MagicMock()
        session.post.side_effect = [Exception('curl: TLS error'), resp_h1]
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a':1})
        self.assertEqual(out, resp_h1)
        self.assertEqual(session.post.call_count, 2)
        self.assertEqual(session.post.call_args_list[1].kwargs.get('http_version'), 'HTTP11_SENTINEL')

    def test_h2_400_other_error_no_retry(self):
        # 400 but body doesn't match 'invalid_r' → no retry, return as-is
        resp = MagicMock(status_code=400, text='{"error":{"type":"too_many_requests"}}')
        session = MagicMock()
        session.post.return_value = resp
        out = _post_with_h1_fallback(session, 'https://x/y', json={'a':1})
        self.assertEqual(out, resp)
        self.assertEqual(session.post.call_count, 1)

if __name__ == '__main__':
    unittest.main()
```

跑：`py -3 -m unittest tests.test_protocol_register_h1_fallback -v`，预期 4/4 pass。

---

## 5. Phase 2 — sing-box 升级（C）

### 5.1 改动

**`server/proxy/singbox.js:13`：**
```js
const SINGBOX_VERSION = '1.10.7';
```
改为：
```js
const SINGBOX_VERSION = '1.13.12';
```

### 5.2 升级机制

`server/proxy/singbox.js::ensureBinary()` 已实现自动下载：若 `bin/sing-box.exe` 不存在则从 GitHub releases 拉取。所以升级流程：

1. 改 `SINGBOX_VERSION`
2. 删 `bin/sing-box.exe`
3. 重启 server → 自动下载 1.13.12
4. 观察启动日志，确认 sing-box 顺利启动 + 节点握手成功

### 5.3 配置兼容性

我们用到的 sing-box 字段在 1.13 全部稳定：
- `mixed` inbound、`selector` outbound、`shadowsocks`/`vless`/`vmess`/`trojan` outbound、`experimental.clash_api`
- 旧式 `sniff: true`：1.13 仍兼容（输出 deprecation warning），不影响运行
- VLESS-Reality 配置字段：与 1.10 schema 一致

**理论上 0 配置改动**，但 VLESS-Reality 握手实测前不能 100% 保证。

### 5.4 回滚

如果新版导致节点握手失败或其他回归：
```js
const SINGBOX_VERSION = '1.10.7';  // 改回
```
+ 删 `bin/sing-box.exe` + 重启。

回滚时间 < 1 分钟。

---

## 6. 错误处理

- **`_post_with_h1_fallback` 永不静默吞错** —— 第二次失败仍抛出/返回错误响应，由调用方继续按原逻辑处理
- **日志可观测** —— 每次触发 fallback 都打一行 `POST <endpoint> ... — retry HTTP/1.1` 便于事后统计触发频率
- **SOCKS5 切换失败兜底** —— 不实现（`proxy_url` 来源固定可信，不会出现 SOCKS5 不支持的代理）

---

## 7. 测试

| 改动 | 测试方式 |
|---|---|
| A 单元测试 | `unittest` mock-based，4 个 case 覆盖 success / 400-retry / exception-retry / 400-non-invalid_r-no-retry |
| B SOCKS5 | 不写单元测试。改完跑 dry-run，看 sing-box 日志确认 SOCKS5 inbound 连接 |
| C sing-box 升级 | 不写单元测试。启动 log 确认 1.13.12 启动 + 节点握手 + dry-run 完整流程 |

---

## 8. 改动文件清单

| 文件 | 改动 | Phase |
|---|---|---|
| `protocol_register.py` | (B) `proxy_url` 转 socks5h；(A) `_post_with_h1_fallback` helper；3 处 POST 调用替换 | 1 |
| `tests/test_protocol_register_h1_fallback.py` | **新建** —— mock-based 单元测试 | 1 |
| `server/proxy/singbox.js` | (C) `SINGBOX_VERSION = '1.13.12'` | 2 |

---

## 9. 完成判据

**Phase 1（A + B）：**
- ✅ 4 个 Python 单元测试 pass
- ✅ Server 重启后 sing-box 日志无异常
- ✅ Dry-run 一个账号注册成功，`create_account` 不再返回 400 invalid_r
- ✅ 若触发 fallback，日志出现 `POST create_account ... — retry HTTP/1.1`

**Phase 2（C）：**
- ✅ Server 启动日志显示 `sing-box-1.13.12` 下载完成 + 启动
- ✅ 节点握手成功（`main=:7890(N) jp=:7891(M)`）
- ✅ Dry-run 完整流程通过

---

## 10. 非目标

- **不接入第三方 SOCKS5 代理软件** —— `proxy_url` 仍来自我们自家 sing-box
- **不重写订阅解析** —— 1.13 schema 兼容 1.10 输出，subscription.js 不动
- **不改 PKCE 旧流的 authorize/continue 调用** —— 失败模式不同
- **不改协议模式以外的浏览器自动化** —— `payment.js` 走的是浏览器，不经过 curl_cffi，无此问题
