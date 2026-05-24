// server/liveness/checker.js
// Probes a ChatGPT access_token against /backend-api/accounts/check via the
// Python curl_cffi sub-process (chatgpt_register/liveness_probe.py).
//
// Why Python? Cloudflare's TLS fingerprint check blocks Node's https.request
// regardless of proxy. curl_cffi with impersonate='chrome131' is the same
// approach used by stripe_init.py / protocol_register.py / checkout_link.py
// everywhere else in this project.

const { spawn } = require('child_process');
const path = require('path');
let proxyMgr;  // lazy require to avoid cycle at module load
function getProxyUrl() {
  try {
    proxyMgr = proxyMgr || require('../proxy');
    return proxyMgr.getProxyUrl() || '';
  } catch { return ''; }
}

const SCRIPT = path.join(__dirname, '..', '..', 'chatgpt_register', 'liveness_probe.py');
const FETCH_TIMEOUT_MS = 10_000;
const SPAWN_TIMEOUT_MS = 12_000;  // 10s request + 2s startup grace

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

// Translate Python terminal object → alive_status/alive_reason per spec §3.3.
function mapTerminal(parsed) {
  if (parsed.status === 'ok' && parsed.http === 200) {
    return mapPlanType(parsed.plan_type || 'unknown');
  }
  const http = parsed.http;
  const reason = parsed.reason || '';
  if (http === 401) return { alive_status: 'token_expired', alive_reason: 'check 401' };
  if (http === 403 && /cloudflare/i.test(reason)) {
    return { alive_status: 'proxy_error', alive_reason: 'cloudflare blocked' };
  }
  if (http === 403) return { alive_status: 'login_fail', alive_reason: 'check 403 forbidden' };
  if (http === 429) return { alive_status: 'network_error', alive_reason: 'check 429' };
  if (http >= 500) return { alive_status: 'network_error', alive_reason: `check ${http}` };
  if (http === 0 && /exception/i.test(reason)) {
    return { alive_status: 'network_error', alive_reason: reason.slice(0, 60) };
  }
  return { alive_status: 'network_error', alive_reason: reason.slice(0, 60) || `check ${http}` };
}

async function probe(accessToken, opts = {}) {
  const { signal, spawnImpl, proxyUrl } = opts;

  // Local JWT exp check — short-circuit expired tokens (no Python spawn).
  const exp = decodeJwtExp(accessToken);
  if (exp && exp * 1000 < Date.now()) {
    return { alive_status: 'token_expired', alive_reason: 'jwt expired' };
  }

  const doSpawn = spawnImpl || ((cmd, args, options) => spawn(cmd, args, options));
  const effectiveProxy = (proxyUrl !== undefined) ? proxyUrl : getProxyUrl();

  return new Promise((resolve) => {
    let settled = false;
    let stdoutLast = '';
    let stderrBuf = '';
    const py = doSpawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { py.kill(); } catch {}
      resolve({ alive_status: 'network_error', alive_reason: 'probe timeout' });
    }, SPAWN_TIMEOUT_MS);

    if (signal) signal.addEventListener('abort', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { py.kill(); } catch {}
      resolve({ alive_status: 'network_error', alive_reason: 'aborted' });
    }, { once: true });

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdoutLast = line;
        } catch {
          stdoutLast = line;
        }
      }
    });
    py.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    py.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ alive_status: 'network_error', alive_reason: `spawn error: ${(e.code || e.message || '').toString().slice(0, 40)}` });
    });

    py.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdoutLast); }
      catch {
        resolve({ alive_status: 'network_error', alive_reason: `probe unparsable: ${stderrBuf.slice(-60).trim()}` });
        return;
      }
      resolve(mapTerminal(parsed));
    });

    const stdinPayload = JSON.stringify({
      access_token: accessToken,
      proxy_url: effectiveProxy || null,
      // No `impersonate` field: lets the Python script rotate through its
      // _CHROME pool on Cloudflare-403 retry. chrome131 (the previous hard-
      // coded default) is currently 100% blocked; chrome146 / chrome142 /
      // chrome136 work — same multi-impersonate behavior as checkout_link.py.
      timeout_ms: FETCH_TIMEOUT_MS,
    });
    try { py.stdin.write(stdinPayload); py.stdin.end(); } catch {}
  });
}

module.exports = { probe, decodeJwtExp, mapPlanType, extractPlanType, mapTerminal };
