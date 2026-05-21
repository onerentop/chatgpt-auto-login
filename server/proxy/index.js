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
};

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function getState() {
  return { ..._state, available: _state.nodeTags.length };
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
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  const filtered = filterByRegion(all, _state.rotationKeyword);
  console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
  if (filtered.length === 0) throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);

  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  _state.rotationIndex = 0;

  const sbConfig = buildSingboxConfig(filtered);
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

/** Switch to the next node according to rotation strategy. */
async function rotate() {
  if (!_state.enabled || _state.nodeTags.length === 0) throw new Error('代理未启用');
  let nextTag;
  if (_state.rotationStrategy === 'random') {
    nextTag = _state.nodeTags[Math.floor(Math.random() * _state.nodeTags.length)];
  } else {
    _state.rotationIndex = (_state.rotationIndex + 1) % _state.nodeTags.length;
    nextTag = _state.nodeTags[_state.rotationIndex];
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

/** Detect current exit IP through the proxy. */
async function detectExit() {
  if (!_state.enabled) return '';
  try {
    const http = require('http');
    const { request } = http;
    const result = await new Promise((resolve, reject) => {
      const req = request('http://api.ipify.org', {
        agent: new (require('http').Agent)(),
        hostname: '127.0.0.1', port: HTTP_PORT, path: 'http://api.ipify.org', method: 'GET', timeout: 10000,
      }, (res) => {
        let buf = '';
        res.on('data', (c) => buf += c);
        res.on('end', () => resolve(buf.trim()));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    _state.exitIp = result || '';
    return _state.exitIp;
  } catch (e) {
    _state.exitIp = `error: ${e.message?.slice(0, 40)}`;
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
  detectExit,
  getProxyUrl,
  SELECTOR_TAG,
  HTTP_PORT,
  CLASH_API_PORT,
};
