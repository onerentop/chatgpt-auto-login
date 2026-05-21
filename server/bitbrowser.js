// BitBrowser local API client.
// API docs: https://doc2.bitbrowser.cn/jiekou.html

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
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).bitbrowser || {}; }
  catch { return {}; }
}

function getApiBase(override) {
  const raw = override || readCfg().apiUrl || 'http://127.0.0.1:54345';
  return raw.trim().replace(/\/+$/, '');
}

class BitBrowserError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

async function request(pathname, body, timeoutMs = 5000) {
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
      throw new BitBrowserError('BitBrowserUnavailable', `BitBrowser unavailable: ${getApiBase()}`);
    }
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser request error: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser HTTP ${res.status} on ${pathname}`);
  }
  const json = await res.json().catch(() => ({}));
  if (json && json.success === false) {
    throw new BitBrowserError('BitBrowserApiError', `BitBrowser API: ${String(json.msg || 'unknown').slice(0, 80)}`);
  }
  return json.data || {};
}

function parseProxy(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('BitBrowser: proxyServer is required (got empty/undefined)');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error(`BitBrowser: malformed proxyServer "${url}"`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'socks5'].includes(scheme)) {
    throw new Error(`BitBrowser: unsupported proxy scheme "${scheme}"`);
  }
  if (!u.hostname || !u.port) {
    throw new Error(`BitBrowser: proxyServer "${url}" missing host or port`);
  }
  return { proxyType: scheme, host: u.hostname, port: u.port };
}

async function healthCheck() {
  // /browser/list is a primary documented endpoint; any HTTP response (not ECONNREFUSED)
  // means the daemon is alive. We don't care about pagination success, only reachability.
  // 3s timeout prevents a hung daemon from blocking batch start for ~21s (OS TCP timeout).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await deps.fetch(`${getApiBase()}/browser/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 0, pageSize: 1 }),
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
  const proxy = parseProxy(proxyServer); // throws on empty/malformed
  const cfg = readCfg();
  const openTimeoutMs = Number(cfg.openTimeoutMs) || 30000;

  let id = null;
  let windowOpen = false;
  let browser = null;

  const close = async () => {
    if (browser)    { try { await browser.close(); } catch {} browser = null; }
    if (windowOpen) { try { await request('/browser/close', { id }); } catch {} windowOpen = false; }
    if (id) {
      try { await request('/browser/delete', { id }); }
      catch (e) { console.log(`[BitBrowser] delete failed: ${e.message?.slice(0, 80)}`); }
      id = null;
    }
  };

  try {
    // 1. Create a one-shot profile
    const updateBody = {
      name: `pay-${Date.now()}`,
      remark: 'auto-pay',
      proxyMethod: 2,
      proxyType: proxy.proxyType,
      host: proxy.host,
      port: proxy.port,
      browserFingerPrint: { ostype: 'PC', version: '136' },
    };
    const updateData = await request('/browser/update', updateBody);
    id = updateData.id;
    if (!id) throw new BitBrowserError('BitBrowserApiError', '/browser/update did not return data.id');

    // 2. Launch and obtain CDP endpoint.
    // /browser/open is the slow step — BitBrowser cold-starts a Chrome subprocess
    // here, which can take 10-15s on first launch. Pass openTimeoutMs (default 30s)
    // so we don't trip the request() default of 5s and misclassify a slow launch as
    // BitBrowserUnavailable. Also mark windowOpen=true BEFORE awaiting: if the request
    // succeeds but later the launcher is mid-flight when we error out, close() needs
    // to call /browser/close to terminate the partially-launched window.
    windowOpen = true;
    const openData = await request('/browser/open', { id }, openTimeoutMs);
    const http = openData.http;
    if (!http) throw new BitBrowserError('BitBrowserApiError', '/browser/open did not return data.http');
    const cdpUrl = http.startsWith('http') ? http : `http://${http}`;

    // 3. Connect Playwright with a hard timeout budget.
    // Capture the timer so we can clear it if connectOverCDP wins the race —
    // otherwise the setTimeout keeps the event loop alive for openTimeoutMs and
    // its rejection becomes a deferred rejection on a Promise nobody is listening to.
    let cdpTimer;
    browser = await Promise.race([
      deps.connectOverCDP(cdpUrl),
      new Promise((_, rej) => {
        cdpTimer = setTimeout(
          () => rej(new BitBrowserError('CDPConnectFailed', `connectOverCDP timeout after ${openTimeoutMs}ms`)),
          openTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(cdpTimer))
      .catch((e) => {
        if (e instanceof BitBrowserError) throw e;
        throw new BitBrowserError('CDPConnectFailed', `connectOverCDP failed: ${e.message?.slice(0, 80)}`);
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
  BitBrowserError,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase, request },
};
