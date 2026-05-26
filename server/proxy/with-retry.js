// server/proxy/with-retry.js
// 业务可选 helper：自动检测 Cloudflare / 429 / ECONNRESET → 上报 bad-node + retry 1 次。
// 走全局 fetch (undici dispatcher 已 setGlobalDispatcher)。
//
// 用法：
//   const { fetchWithRetry } = require('./proxy/with-retry');
//   const r = await fetchWithRetry(url, opts, { channel: 'main', maxRetries: 1 });

async function fetchWithRetry(url, opts = {}, { channel = 'main', maxRetries = 1 } = {}) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 403) {
        const text = await r.clone().text();
        if (/cloudflare|just a moment|challenge-platform|cf-mitigated/i.test(text)) {
          reportBadNode('cloudflare_403', channel);
          throw new Error('proxy_blocked: cloudflare');
        }
      }
      if (r.status === 429) {
        reportBadNode('rate_limited', channel);
        throw new Error('proxy_blocked: rate_limited');
      }
      return r;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/ECONNRESET|connection.*closed|socket hang up|timeout/i.test(msg)) {
        if (i === maxRetries) {
          reportBadNode('connection_reset', channel);
          throw e;
        }
        await new Promise(r => setTimeout(r, 500));  // 等 urltest 切节点
        continue;
      }
      throw e;
    }
  }
}

function reportBadNode(reason, channel = 'main') {
  // fire-and-forget；走 NO_PROXY 直连本机不走 sing-box
  fetch('http://127.0.0.1:3000/api/proxy/bad-node', {
    method: 'POST',
    body: JSON.stringify({ reason, channel }),
    headers: { 'Content-Type': 'application/json' },
  }).catch(() => {});
}

module.exports = { fetchWithRetry, reportBadNode };
