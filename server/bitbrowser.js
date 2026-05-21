// BitBrowser local API client.
// API docs: https://doc2.bitbrowser.cn/jiekou.html

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

module.exports = {
  __internal: { parseProxy },
};
