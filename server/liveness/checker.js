// server/liveness/checker.js
// Probes a ChatGPT access_token against /backend-api/accounts/check
// through the main proxy and decides alive_status.

const DEFAULT_PROXY = 'http://127.0.0.1:7890';
const CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
const FETCH_TIMEOUT_MS = 10_000;

// Node 22's built-in fetch (undici) uses a global dispatcher that ignores
// HTTP_PROXY env vars. To actually route through the main :7890 proxy we have
// to construct a request manually with HttpsProxyAgent — same pattern used in
// server/discord-gateway.js (with the same UND_ERR_INVALID_ARG comment).
function _requestViaProxy(url, { method, headers, signal, proxyUrl }) {
  const https = require('https');
  const { URL } = require('url');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const u = new URL(url);
  const agent = new HttpsProxyAgent(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method, agent,
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
      res.on('error', reject);
    });
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    req.on('error', reject);
    req.end();
  });
}

function decodeJwtExp(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return Number(payload.exp) || 0;
  } catch { return 0; }
}

function mapPlanType(planType) {
  if (planType === 'plus') return { alive_status: 'plus', alive_reason: 'check ok' };
  if (planType === 'free') return { alive_status: 'canceled', alive_reason: 'no plus' };
  return { alive_status: 'canceled', alive_reason: `plan: ${planType}` };
}

function extractPlanType(json) {
  const a = json?.accounts?.default || json?.account_plan || json || {};
  return (
    a?.plan_type ||
    a?.entitlement?.subscription_plan ||
    a?.entitlement?.plan?.name ||
    a?.subscription_plan ||
    'unknown'
  );
}

async function probe(accessToken, opts = {}) {
  const { signal, fetchImpl, proxyUrl = DEFAULT_PROXY } = opts;

  const exp = decodeJwtExp(accessToken);
  if (exp && exp * 1000 < Date.now()) {
    return { alive_status: 'token_expired', alive_reason: 'jwt expired' };
  }

  // Production path goes through HttpsProxyAgent to the main :7890 proxy
  // (account was registered through that IP — direct fetch from a CN IP gets
  // a Cloudflare 403). Tests inject fetchImpl to skip the proxy.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('check timeout')), FETCH_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });

  let res;
  try {
    if (fetchImpl) {
      res = await fetchImpl(CHECK_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Mozilla/5.0' },
        signal: ctl.signal,
      });
    } else {
      res = await _requestViaProxy(CHECK_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Mozilla/5.0' },
        signal: ctl.signal,
        proxyUrl,
      });
    }
  } catch (e) {
    clearTimeout(timer);
    const code = e?.cause?.code || e?.code || '';
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || /reset|refused/i.test(String(e.message))) {
      return { alive_status: 'proxy_error', alive_reason: `proxy ${code || 'reset'}` };
    }
    if (e?.name === 'AbortError') {
      return { alive_status: 'network_error', alive_reason: 'check timeout' };
    }
    return { alive_status: 'network_error', alive_reason: `check err: ${String(e.message || e).slice(0, 40)}` };
  }
  clearTimeout(timer);

  if (res.status === 401) return { alive_status: 'token_expired', alive_reason: 'check 401' };
  if (res.status === 403) return { alive_status: 'login_fail', alive_reason: 'check 403 forbidden' };
  if (res.status === 429) return { alive_status: 'network_error', alive_reason: 'check 429' };
  if (res.status >= 500) return { alive_status: 'network_error', alive_reason: `check ${res.status}` };
  if (!res.ok) return { alive_status: 'network_error', alive_reason: `check ${res.status}` };

  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!body) return { alive_status: 'network_error', alive_reason: 'check schema mismatch' };

  const planType = extractPlanType(body);
  return mapPlanType(planType);
}

module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType };
