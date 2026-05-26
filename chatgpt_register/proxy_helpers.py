# chatgpt_register/proxy_helpers.py
# v2.42 Task 10: Python 业务侧 fire-and-forget bad-node 上报 helper。
# 配合 Node POST /api/proxy/bad-node 双层风控机制。
import os
try:
    from curl_cffi import requests as _r
except ImportError:
    import requests as _r

_SERVER = os.environ.get('LIVENESS_SERVER', 'http://127.0.0.1:3000')


def report_bad_node(reason, channel='main'):
    """Fire-and-forget bad-node 上报。失败静默。

    Args:
      reason: 'cloudflare_403' | 'rate_limited' | 'connection_reset' |
              'openai_403' | 'captcha' | 'custom'
      channel: 'main' | 'jp'
    """
    try:
        _r.post(
            f"{_SERVER}/api/proxy/bad-node",
            json={'reason': reason, 'channel': channel},
            timeout=3,
        )
    except Exception:
        pass  # 静默
