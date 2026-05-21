// ixbrowser local API client.
// Reference: E:\workspace\projects\ixbrowser-local-api-python (official Python SDK).
// Endpoints used:
//   POST /api/v2/profile-create
//   POST /api/v2/profile-open
//   POST /api/v2/profile-close
//   POST /api/v2/profile-delete
//   POST /api/v2/profile-list  (healthCheck only)

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const deps = {
  fetch: (...args) => globalThis.fetch(...args),
  connectOverCDP: async (url) => {
    const { chromium } = require('playwright');
    return chromium.connectOverCDP(url);
  },
};

// Read fresh on every call: the UI writes config.json at runtime, and a new
// value must take effect without a server restart. Do not cache.
function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).ixbrowser || {}; }
  catch { return {}; }
}

function getApiBase(override) {
  const raw = override || readCfg().apiUrl || 'http://127.0.0.1:53200';
  return raw.trim().replace(/\/+$/, '');
}

function parseProxy(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('ixbrowser: proxyServer is required (got empty/undefined)');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`ixbrowser: malformed proxyServer "${url}"`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`ixbrowser: unsupported proxy scheme "${scheme}"`);
  }
  if (!u.hostname || !u.port) {
    throw new Error(`ixbrowser: proxyServer "${url}" missing host or port`);
  }
  return { proxy_type: scheme, proxy_ip: u.hostname, proxy_port: u.port };
}

class IxBrowserError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

async function request(pathname, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await deps.fetch(`${getApiBase()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    const code = e.code || e.cause?.code || '';
    if (code === 'ECONNREFUSED' || e.name === 'AbortError' || /fetch failed/i.test(e.message)) {
      throw new IxBrowserError('IxBrowserUnavailable', `ixbrowser unavailable: ${getApiBase()}`);
    }
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser request error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser HTTP ${res.status} on ${pathname}`);
  }
  const json = await res.json().catch(() => null);
  if (json === null) {
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser ${pathname}: response not JSON`);
  }
  if (!json.error || json.error.code !== 0) {
    const msg = json.error?.message || `error.code=${json.error?.code}`;
    throw new IxBrowserError('IxBrowserApiError', `ixbrowser API: ${String(msg).slice(0, 80)}`);
  }
  // Return data as-is. Empirically ixbrowser returns scalars (e.g. /profile-create
  // returns data: 373 — the new profile_id as a bare integer), arrays (/profile-delete
  // returns data: []), and objects (/profile-open returns data: {debugging_address,...}).
  // Callers must handle the per-endpoint shape.
  return json.data;
}

async function healthCheck() {
  // /api/v2/profile-list is a primary documented endpoint; any HTTP response
  // (including error.code !== 0) means the daemon is alive. Only network-level
  // failure flips false. 3s timeout prevents a hung daemon blocking batch start
  // for ~21s (OS TCP timeout).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await deps.fetch(`${getApiBase()}/api/v2/profile-list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, limit: 1 }),
      signal: ctrl.signal,
    });
    return !!res;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function open({ proxyServer } = {}) {
  const proxy = parseProxy(proxyServer); // throws on empty/malformed before any HTTP
  const cfg = readCfg();
  const openTimeoutMs = Number(cfg.openTimeoutMs) || 30000;

  let profile_id = null;
  let opened = false;
  let browser = null;

  const close = async () => {
    if (browser)    { try { await browser.close(); } catch {} browser = null; }
    if (opened)     { try { await request('/api/v2/profile-close', { profile_id }); } catch {} opened = false; }
    if (profile_id) {
      try { await request('/api/v2/profile-delete', { profile_id }); }
      catch (e) { console.log(`[ixbrowser] delete failed: ${e.message?.slice(0, 80)}`); }
      profile_id = null;
    }
  };

  try {
    // 1. Create a one-shot profile.
    const createBody = {
      name: `pay-${Date.now()}`,
      note: 'auto-pay',
      site_id: 22,   // 22 = blank page (Consts.DEFAULT_SITE_ID_BLANK_PAGE in the Python SDK)
      color: '#1E90FF',
      proxy_config: {
        proxy_mode: 2,   // 2 = custom (Consts.PROXY_MODE_CUSTOM)
        ...proxy,        // { proxy_type, proxy_ip, proxy_port }
      },
    };
    const createData = await request('/api/v2/profile-create', createBody);
    // Empirically, ixbrowser's /profile-create returns the new id as a bare integer
    // in the `data` field (i.e. data: 373, NOT data: {profile_id: 373}). The Python SDK
    // documentation suggested an object shape; live testing on 2026-05-21 with daemon
    // confirmed the scalar form. Tolerate the object form too as a forward-compat fallback.
    profile_id = (typeof createData === 'number')
      ? createData
      : (createData?.profile_id || createData?.id);
    if (!profile_id) throw new IxBrowserError('IxBrowserApiError', `/profile-create did not return a profile_id (got ${JSON.stringify(createData)?.slice(0, 80)})`);

    // 2. Launch and obtain CDP endpoint.
    // /profile-open cold-starts a Chrome subprocess on the ixbrowser side, which
    // can take 10-15s on first launch. Pass openTimeoutMs (default 30s) so we
    // don't trip the request() 15s default and misclassify a slow launch as
    // IxBrowserUnavailable. Mark opened=true BEFORE awaiting: if the request
    // succeeds but we error out mid-launch, close() needs to call /profile-close
    // to terminate the partially-launched window.
    opened = true;
    const openData = await request('/api/v2/profile-open', {
      profile_id,
      load_extensions: true,
      load_profile_info_page: false,
      cookies_backup: false,
      args: ['--disable-extension-welcome-page'],
    }, openTimeoutMs);
    const debugging_address = openData.debugging_address;
    if (!debugging_address) throw new IxBrowserError('IxBrowserApiError', '/profile-open did not return debugging_address');
    const cdpUrl = debugging_address.startsWith('http') ? debugging_address : `http://${debugging_address}`;

    // 3. Connect Playwright with a hard timeout budget.
    // Capture the timer so we can clear it if connectOverCDP wins the race —
    // otherwise the setTimeout keeps the event loop alive for openTimeoutMs and
    // its rejection becomes a deferred rejection on a Promise nobody is listening to.
    let cdpTimer;
    browser = await Promise.race([
      deps.connectOverCDP(cdpUrl),
      new Promise((_, rej) => {
        cdpTimer = setTimeout(
          () => rej(new IxBrowserError('CDPConnectFailed', `connectOverCDP timeout after ${openTimeoutMs}ms`)),
          openTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(cdpTimer))
      .catch((e) => {
        if (e instanceof IxBrowserError) throw e;
        throw new IxBrowserError('CDPConnectFailed', `connectOverCDP failed: ${e.message?.slice(0, 80)}`);
      });

    return { browser, close };
  } catch (e) {
    await close();
    throw e;
  }
}

module.exports = {
  open,
  healthCheck,
  IxBrowserError,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase, request },
};
