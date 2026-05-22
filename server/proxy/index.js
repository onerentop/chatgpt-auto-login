// Proxy orchestration: subscription → sing-box → Clash API rotation
const fs = require('fs');
const path = require('path');
const singbox = require('./singbox');
const { fetchAndParse, filterByRegion, filterByJpKddi } = require('./subscription');
const clashApi = require('./clash-api');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const SELECTOR_TAG = 'auto-rotate';
const HTTP_PORT = 7890;
const CLASH_API_PORT = 9090;

const JP_HTTP_PORT = 7891;
const JP_SELECTOR_TAG = 'jp-checkout';
const JP_DEFAULT_KEYWORD = 'KDDI';

const BAD_NODE_TTL_MS = 30 * 60 * 1000;  // 30 min — nodes recover eventually

let _state = {
  enabled: false,
  subscriptionUrl: '',
  outbounds: [],         // parsed nodes (filtered by region)
  nodeTags: [],          // names of available nodes
  currentNode: '',
  rotationStrategy: 'sequential',  // sequential | random
  rotationIndex: 0,
  rotationKeyword: 'US', // region filter
  lastError: '',
  exitIp: '',
  badNodes: new Map(),   // tag → expiry timestamp (ms). Nodes that produced repeated TLS/network errors.
  jp: {
    enabled: false,
    keyword: JP_DEFAULT_KEYWORD,
    outbounds: [],
    nodeTags: [],
    currentNode: '',
    rotationStrategy: 'sequential',
    rotationIndex: 0,
    badNodes: new Map(),
    exitIp: '',
    lastError: '',
  },
};

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function isBad(tag) {
  const expiry = _state.badNodes.get(tag);
  if (!expiry) return false;
  if (Date.now() > expiry) { _state.badNodes.delete(tag); return false; }
  return true;
}

function markBad(tag, ttlMs = BAD_NODE_TTL_MS) {
  if (!tag) return;
  _state.badNodes.set(tag, Date.now() + ttlMs);
  console.log(`[Proxy] Marked bad: ${tag} (TTL ${Math.round(ttlMs/60000)}min)`);
}

function getState() {
  const now = Date.now();
  const badNodes = {};
  for (const [tag, expiry] of _state.badNodes.entries()) {
    if (expiry > now) badNodes[tag] = expiry;
    else _state.badNodes.delete(tag);
  }
  const jpBadNodes = {};
  for (const [tag, expiry] of _state.jp.badNodes.entries()) {
    if (expiry > now) jpBadNodes[tag] = expiry;
    else _state.jp.badNodes.delete(tag);
  }
  return {
    ..._state,
    available: _state.nodeTags.length,
    badNodes,
    jp: {
      ..._state.jp,
      available: _state.jp.nodeTags.length,
      badNodes: jpBadNodes,
    },
  };
}

function buildSingboxConfig(us, jp /* nullable */) {
  const inbounds = [
    { type: 'mixed', tag: 'in-mixed', listen: '127.0.0.1', listen_port: HTTP_PORT, sniff: true },
  ];
  const outbounds = [
    { type: 'selector', tag: SELECTOR_TAG, outbounds: us.map(o => o.tag), default: us[0]?.tag },
    ...us,
  ];
  const rules = [];

  if (Array.isArray(jp) && jp.length > 0) {
    inbounds.push({ type: 'mixed', tag: 'in-jp', listen: '127.0.0.1', listen_port: JP_HTTP_PORT, sniff: true });
    outbounds.push({ type: 'selector', tag: JP_SELECTOR_TAG, outbounds: jp.map(o => o.tag), default: jp[0].tag });
    outbounds.push(...jp);
    rules.push({ inbound: 'in-jp', outbound: JP_SELECTOR_TAG });
  }

  outbounds.push({ type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' });

  return {
    log: { level: 'warn' },
    inbounds,
    outbounds,
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${CLASH_API_PORT}`,
        default_mode: 'rule',
      },
    },
    route: {
      final: SELECTOR_TAG,
      rules,
    },
  };
}

/** Refresh subscription and (re)start sing-box. Returns the number of nodes loaded. */
async function refresh() {
  const cfg = readCfg().proxy || {};
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter || 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';

  const jpCfg = cfg.jpCheckout || {};
  const jpEnabledByConfig = jpCfg.enabled !== false;
  _state.jp.keyword = jpCfg.keyword || JP_DEFAULT_KEYWORD;
  _state.jp.rotationStrategy = jpCfg.rotationStrategy || 'sequential';

  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  const filtered = filterByRegion(all, _state.rotationKeyword);
  console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
  if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);

  let jpFiltered = [];
  if (jpEnabledByConfig) {
    jpFiltered = filterByJpKddi(all, _state.jp.keyword);
    console.log(`[Proxy] JP-KDDI filter (keyword=${_state.jp.keyword}): ${jpFiltered.length}`);
  } else {
    console.log(`[Proxy] JP-Checkout channel disabled by config`);
  }

  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  _state.rotationIndex = 0;

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  _state.jp.rotationIndex = 0;
  _state.jp.currentNode = jpFiltered[0]?.tag || '';
  _state.jp.enabled = false;
  _state.jp.lastError = '';
  if (!jpEnabledByConfig) {
    _state.jp.lastError = 'JP 通道已被 config.jpCheckout.enabled=false 禁用';
  } else if (jpFiltered.length === 0) {
    _state.jp.lastError = `订阅中未找到关键字 "${_state.jp.keyword}" 的节点`;
  }

  const useJp = jpEnabledByConfig && jpFiltered.length > 0;
  const sbConfig = buildSingboxConfig(filtered, useJp ? jpFiltered : null);

  try {
    await singbox.start(sbConfig);
    _state.jp.enabled = useJp;
  } catch (err) {
    if (useJp && /7891|address already in use|bind/i.test(err.message || '')) {
      console.log(`[Proxy] 7891 端口被占用或绑定失败，降级关闭 JP 通道: ${err.message}`);
      _state.jp.enabled = false;
      _state.jp.lastError = `端口 7891 被占用，JP 通道已禁用: ${(err.message || '').slice(0, 120)}`;
      const fallbackConfig = buildSingboxConfig(filtered, null);
      await singbox.start(fallbackConfig);
    } else {
      throw err;
    }
  }

  _state.enabled = true;
  _state.currentNode = filtered[0].tag;
  _state.lastError = '';
  console.log(`[Proxy] sing-box running: main=:${HTTP_PORT}(${filtered.length}) jp=${_state.jp.enabled ? `:${JP_HTTP_PORT}(${jpFiltered.length})` : 'disabled'}`);
  return filtered.length;
}

async function stop() {
  await singbox.stop();
  _state.enabled = false;
  _state.exitIp = '';
}

/** Switch to the next node according to rotation strategy, skipping nodes in the
 * bad-node blacklist (with TTL). If every node is currently blacklisted (all bad),
 * clear the blacklist as a fail-safe and pick any node — better to retry a stale
 * "bad" mark than to fail with no candidates.
 */
async function rotate() {
  if (!_state.enabled || _state.nodeTags.length === 0) throw new Error('代理未启用');

  // Try to find a non-bad next node; bounded by nodeTags.length attempts.
  let nextTag = null;
  for (let i = 0; i < _state.nodeTags.length; i++) {
    let candidate;
    if (_state.rotationStrategy === 'random') {
      candidate = _state.nodeTags[Math.floor(Math.random() * _state.nodeTags.length)];
    } else {
      _state.rotationIndex = (_state.rotationIndex + 1) % _state.nodeTags.length;
      candidate = _state.nodeTags[_state.rotationIndex];
    }
    if (!isBad(candidate)) { nextTag = candidate; break; }
  }

  if (!nextTag) {
    // Every node is bad. Clear the blacklist and try once more — TTLs may have lapsed
    // since they were set, and a stuck blacklist is worse than re-trying a flaky node.
    console.log(`[Proxy] All ${_state.nodeTags.length} nodes are blacklisted; clearing and rotating fresh`);
    _state.badNodes.clear();
    if (_state.rotationStrategy === 'random') {
      nextTag = _state.nodeTags[Math.floor(Math.random() * _state.nodeTags.length)];
    } else {
      _state.rotationIndex = (_state.rotationIndex + 1) % _state.nodeTags.length;
      nextTag = _state.nodeTags[_state.rotationIndex];
    }
  }

  await clashApi.switchSelector(SELECTOR_TAG, nextTag);
  _state.currentNode = nextTag;
  return nextTag;
}

/** Switch to a specific node by name. */
async function switchTo(nodeTag) {
  if (!_state.nodeTags.includes(nodeTag)) throw new Error(`节点不存在: ${nodeTag}`);
  await clashApi.switchSelector(SELECTOR_TAG, nodeTag);
  _state.currentNode = nodeTag;
  return nodeTag;
}

/** Detect current exit IP through the proxy. Uses HTTP CONNECT tunnel to HTTPS endpoint. */
async function detectExit() {
  if (!_state.enabled) return '';
  try {
    const net = require('net');
    const tls = require('tls');
    const host = 'api.ipify.org';
    const exitIp = await new Promise((resolve, reject) => {
      const sock = net.connect(HTTP_PORT, '127.0.0.1', () => {
        sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      });
      let preamble = '';
      sock.once('error', reject);
      sock.setTimeout(15000, () => { sock.destroy(new Error('timeout')); });
      sock.on('data', function onData(chunk) {
        preamble += chunk.toString('binary');
        const headerEnd = preamble.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        sock.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(preamble)) {
          return reject(new Error(`CONNECT failed: ${preamble.split('\r\n')[0]}`));
        }
        const tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
          tlsSock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`);
        });
        let resp = '';
        tlsSock.on('data', c => resp += c.toString('utf-8'));
        tlsSock.on('end', () => {
          const bodyIdx = resp.indexOf('\r\n\r\n');
          const body = bodyIdx > -1 ? resp.slice(bodyIdx + 4).trim() : resp.trim();
          const m = body.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          resolve(m ? m[1] : body.slice(0, 60));
        });
        tlsSock.on('error', reject);
      });
    });
    _state.exitIp = exitIp;
    return exitIp;
  } catch (e) {
    _state.exitIp = `error: ${(e.message || '').slice(0, 60)}`;
    return _state.exitIp;
  }
}

function getProxyUrl() {
  return _state.enabled ? `http://127.0.0.1:${HTTP_PORT}` : '';
}

module.exports = {
  getState,
  refresh,
  stop,
  rotate,
  switchTo,
  markBad,
  isBad,
  detectExit,
  getProxyUrl,
  buildSingboxConfig,
  SELECTOR_TAG,
  HTTP_PORT,
  CLASH_API_PORT,
};
