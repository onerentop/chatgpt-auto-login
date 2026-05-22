// Proxy orchestration: subscription → sing-box → Clash API rotation
const fs = require('fs');
const path = require('path');
const singbox = require('./singbox');
const { fetchAndParse, filterByRegion } = require('./subscription');
const clashApi = require('./clash-api');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const SELECTOR_TAG = 'auto-rotate';
const HTTP_PORT = 7890;
const CLASH_API_PORT = 9090;

const BAD_NODE_TTL_MS = 30 * 60 * 1000;  // 30 min — nodes recover eventually

let _state = {
  enabled: false,
  subscriptionUrl: '',
  outbounds: [],         // parsed nodes (filtered by region)
  nodeTags: [],          // names of available nodes (main rotation pool)
  currentNode: '',
  rotationStrategy: 'sequential',  // sequential | random
  rotationIndex: 0,
  rotationKeyword: 'US', // region filter (main pool)
  lastError: '',
  exitIp: '',
  badNodes: new Map(),   // tag → expiry timestamp (ms). Nodes that produced repeated TLS/network errors.
  checkoutRegionKeyword: '日本', // region filter for the checkout-only pool (used by withCheckoutNode)
  checkoutNodeTags: [],  // names of checkout-only nodes (e.g., JP nodes for the /payments/checkout API call)
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
  // Surface badNodes as a plain object for JSON serialization.
  // Skip expired entries on read so the API view is always current.
  const now = Date.now();
  const badNodes = {};
  for (const [tag, expiry] of _state.badNodes.entries()) {
    if (expiry > now) badNodes[tag] = expiry;
    else _state.badNodes.delete(tag);
  }
  return { ..._state, available: _state.nodeTags.length, badNodes };
}

function buildSingboxConfig(outbounds) {
  return {
    log: { level: 'warn' },
    inbounds: [
      { type: 'mixed', tag: 'in-mixed', listen: '127.0.0.1', listen_port: HTTP_PORT, sniff: true },
    ],
    outbounds: [
      { type: 'selector', tag: SELECTOR_TAG, outbounds: outbounds.map(o => o.tag), default: outbounds[0]?.tag },
      ...outbounds,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${CLASH_API_PORT}`,
        default_mode: 'rule',
      },
    },
    route: {
      final: SELECTOR_TAG,
    },
  };
}

/** Refresh subscription and (re)start sing-box. Returns the number of nodes loaded. */
async function refresh() {
  const cfg = readCfg().proxy || {};
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter || 'US';
  _state.checkoutRegionKeyword = cfg.checkoutRegionFilter || '日本';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);

  const filtered = filterByRegion(all, _state.rotationKeyword);
  console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
  if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);

  const checkoutFiltered = filterByRegion(all, _state.checkoutRegionKeyword);
  console.log(`[Proxy] Checkout region filter (${_state.checkoutRegionKeyword}): ${checkoutFiltered.length}`);

  // Merge: main pool + any checkout-only nodes (de-duplicated by tag). This is
  // what we feed to sing-box so its selector can switch to either set.
  const merged = [...filtered];
  for (const o of checkoutFiltered) {
    if (!merged.some(m => m.tag === o.tag)) merged.push(o);
  }

  _state.outbounds = merged;
  _state.nodeTags = filtered.map(o => o.tag);                  // rotation pool (main region only)
  _state.checkoutNodeTags = checkoutFiltered.map(o => o.tag);  // checkout pool (may overlap with main)
  _state.rotationIndex = 0;

  const sbConfig = buildSingboxConfig(merged);
  await singbox.start(sbConfig);
  _state.enabled = true;
  _state.currentNode = filtered[0].tag;
  _state.lastError = '';
  console.log(`[Proxy] sing-box running on http://127.0.0.1:${HTTP_PORT} (Clash API on ${CLASH_API_PORT})`);
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

/** Run `fn` while the proxy selector is switched to a random checkout-region
 * (JP by default) node. Restores the previous node afterward — even if `fn`
 * throws. If no checkout nodes are loaded (or proxy disabled), runs `fn`
 * on the current setup; the caller is responsible for the consequences
 * (the /payments/checkout API will likely return a region-mismatch error). */
async function withCheckoutNode(fn) {
  if (!_state.enabled) return await fn();
  if (_state.checkoutNodeTags.length === 0) {
    console.log('[Proxy] No checkout-region nodes loaded; running on current node');
    return await fn();
  }
  const prevNode = _state.currentNode;
  const jpNode = _state.checkoutNodeTags[
    Math.floor(Math.random() * _state.checkoutNodeTags.length)
  ];
  try {
    await clashApi.switchSelector(SELECTOR_TAG, jpNode);
    _state.currentNode = jpNode;
    console.log(`[Proxy] Checkout switch → ${jpNode}`);
    return await fn();
  } finally {
    try {
      await clashApi.switchSelector(SELECTOR_TAG, prevNode);
      _state.currentNode = prevNode;
      console.log(`[Proxy] Checkout restore → ${prevNode}`);
    } catch (e) {
      console.log(`[Proxy] Checkout restore failed: ${e.message?.slice(0, 60)}`);
    }
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
  withCheckoutNode,
  markBad,
  isBad,
  detectExit,
  getProxyUrl,
  SELECTOR_TAG,
  HTTP_PORT,
  CLASH_API_PORT,
};
