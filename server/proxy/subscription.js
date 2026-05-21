// Parse airport subscription URL → sing-box outbound list
const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'v2rayN/6.42' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve, reject);
        return;
      }
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Timeout')));
  });
}

function tryBase64Decode(str) {
  try {
    const decoded = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    if (decoded.includes('://') || decoded.includes('\n')) return decoded;
  } catch {}
  return str;
}

// ───── URI parsers ─────────────────────────────────────────

function parseVmess(uri) {
  try {
    const b64 = uri.slice(8);
    const data = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    const o = {
      type: 'vmess',
      tag: data.ps || `vmess-${data.add}`,
      server: data.add,
      server_port: Number(data.port),
      uuid: data.id,
      security: data.scy || 'auto',
      alter_id: Number(data.aid || 0),
    };
    if (data.tls === 'tls') o.tls = { enabled: true, server_name: data.sni || data.host || data.add, insecure: false };
    if (data.net === 'ws') o.transport = { type: 'ws', path: data.path || '/', headers: data.host ? { Host: data.host } : undefined };
    if (data.net === 'grpc') o.transport = { type: 'grpc', service_name: data.path || '' };
    return o;
  } catch { return null; }
}

function parseVless(uri) {
  try {
    const u = new URL(uri);
    const params = u.searchParams;
    const o = {
      type: 'vless',
      tag: decodeURIComponent(u.hash.slice(1)) || `vless-${u.hostname}`,
      server: u.hostname,
      server_port: Number(u.port),
      uuid: u.username,
      flow: params.get('flow') || '',
    };
    const security = params.get('security');
    if (security === 'tls' || security === 'reality') {
      o.tls = { enabled: true, server_name: params.get('sni') || u.hostname, insecure: false };
      if (params.get('fp')) o.tls.utls = { enabled: true, fingerprint: params.get('fp') };
      if (security === 'reality') {
        o.tls.reality = { enabled: true, public_key: params.get('pbk'), short_id: params.get('sid') || '' };
      }
    }
    const type = params.get('type');
    if (type === 'ws') o.transport = { type: 'ws', path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
    if (type === 'grpc') o.transport = { type: 'grpc', service_name: params.get('serviceName') || '' };
    return o;
  } catch { return null; }
}

function parseTrojan(uri) {
  try {
    const u = new URL(uri);
    const params = u.searchParams;
    const o = {
      type: 'trojan',
      tag: decodeURIComponent(u.hash.slice(1)) || `trojan-${u.hostname}`,
      server: u.hostname,
      server_port: Number(u.port),
      password: decodeURIComponent(u.username),
      tls: { enabled: true, server_name: params.get('sni') || u.hostname, insecure: params.get('allowInsecure') === '1' },
    };
    const type = params.get('type');
    if (type === 'ws') o.transport = { type: 'ws', path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
    return o;
  } catch { return null; }
}

function parseSS(uri) {
  try {
    // ss://base64(method:password)@host:port#name  or  ss://base64(method:password@host:port)#name
    const hashIdx = uri.indexOf('#');
    const name = hashIdx > -1 ? decodeURIComponent(uri.slice(hashIdx + 1)) : '';
    const main = hashIdx > -1 ? uri.slice(5, hashIdx) : uri.slice(5);
    let method, password, host, port;
    if (main.includes('@')) {
      const [userInfo, hostPort] = main.split('@');
      const decoded = Buffer.from(userInfo.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
      [method, password] = decoded.split(':');
      const [h, p] = hostPort.split(':');
      host = h;
      port = Number(p);
    } else {
      const decoded = Buffer.from(main.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
      const m = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
      if (!m) return null;
      [, method, password, host, port] = m;
      port = Number(port);
    }
    return { type: 'shadowsocks', tag: name || `ss-${host}`, server: host, server_port: port, method, password };
  } catch { return null; }
}

function parseHysteria2(uri) {
  try {
    const u = new URL(uri);
    const params = u.searchParams;
    return {
      type: 'hysteria2',
      tag: decodeURIComponent(u.hash.slice(1)) || `hy2-${u.hostname}`,
      server: u.hostname,
      server_port: Number(u.port),
      password: u.username,
      tls: { enabled: true, server_name: params.get('sni') || u.hostname, insecure: params.get('insecure') === '1' },
    };
  } catch { return null; }
}

function parseUri(uri) {
  if (uri.startsWith('vmess://'))     return parseVmess(uri);
  if (uri.startsWith('vless://'))     return parseVless(uri);
  if (uri.startsWith('trojan://'))    return parseTrojan(uri);
  if (uri.startsWith('ss://'))        return parseSS(uri);
  if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return parseHysteria2(uri);
  return null;
}

// ───── Public API ──────────────────────────────────────────

async function fetchAndParse(subscriptionUrl) {
  const raw = await fetchUrl(subscriptionUrl);
  const text = tryBase64Decode(raw.trim());
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes('://'));
  const outbounds = [];
  const seen = new Set();
  for (const line of lines) {
    const ob = parseUri(line);
    if (!ob || !ob.server) continue;
    // Dedupe by tag
    let tag = ob.tag;
    let n = 1;
    while (seen.has(tag)) { tag = `${ob.tag}-${++n}`; }
    ob.tag = tag;
    seen.add(tag);
    outbounds.push(ob);
  }
  return outbounds;
}

const US_PATTERNS = /\bUS\b|🇺🇸|美国|美區|美区|USA|United States|United_States|Los Angeles|San Jose|New York|Seattle|加州|洛杉矶|纽约|西雅图|圣何塞/i;

function filterByRegion(outbounds, region = 'US') {
  if (!region || region === 'all') return outbounds;
  if (region === 'US') return outbounds.filter(o => US_PATTERNS.test(o.tag));
  // Custom: comma-separated keywords
  const keywords = region.split(/[,，;\s]+/).filter(Boolean);
  const re = new RegExp(keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  return outbounds.filter(o => re.test(o.tag));
}

module.exports = { fetchAndParse, filterByRegion, US_PATTERNS };
