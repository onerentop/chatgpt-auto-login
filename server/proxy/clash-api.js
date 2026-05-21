// Thin Clash API client (sing-box exposes same interface)
const http = require('http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9090;

function request(method, path, body, secret) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: DEFAULT_HOST, port: DEFAULT_PORT, path, method, headers, timeout: 8000 },
      (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
          } else reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 100)}`));
        });
      });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Clash API timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function getProxies(secret) {
  return (await request('GET', '/proxies', null, secret)).proxies || {};
}

async function getSelector(name, secret) {
  return (await request('GET', `/proxies/${encodeURIComponent(name)}`, null, secret));
}

async function switchSelector(selectorName, nodeName, secret) {
  return request('PUT', `/proxies/${encodeURIComponent(selectorName)}`, { name: nodeName }, secret);
}

async function getCurrentSelected(selectorName, secret) {
  const sel = await getSelector(selectorName, secret);
  return sel.now || '';
}

module.exports = { getProxies, getSelector, switchSelector, getCurrentSelected, request };
