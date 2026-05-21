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

module.exports = {
  healthCheck,
  _deps: deps,
  __internal: { parseProxy, readCfg, getApiBase },
};
