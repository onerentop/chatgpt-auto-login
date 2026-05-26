// Proxy orchestration: subscription → sing-box → Clash API rotation
const fs = require('fs');
const path = require('path');
const singbox = require('./singbox');
const { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist, US_PATTERNS } = require('./subscription');
const clashApi = require('./clash-api');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// v2.42 Task 7: outbound type 从 selector 改为 urltest。tag 也跟着改成 spec
// §3.1 的简短命名（'main' / 'jp'），让 Clash API 路径 /proxies/main、
// /proxies/jp/delay 和 spec 文档一致。Task 8 会删除所有 switchSelector 调用，
// 那之后这两个常量主要给 Clash API 查询 (getActiveNode / testNodeDelay) 使用。
const SELECTOR_TAG = 'main';
const HTTP_PORT = 7890;
const CLASH_API_PORT = 9090;

const JP_HTTP_PORT = 7891;
const JP_SELECTOR_TAG = 'jp';
const JP_DEFAULT_KEYWORD = 'KDDI';

// v2.42 Task 7: inbound tag 改名为 mixed-7890 / mixed-7891（与端口对应，
// 便于看 sing-box log 直接定位入口）。route rules 用这两个 tag 做分流。
const MAIN_INBOUND_TAG = 'mixed-7890';
const JP_INBOUND_TAG = 'mixed-7891';

const BAD_NODE_TTL_MS = 30 * 60 * 1000;  // 30 min — nodes recover eventually

const FAIL_THRESHOLD = 3;
const blacklist = require('./blacklist');

const PROXY_NET_ERROR_RE = /ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|ECONNREFUSED|tunneling socket|net::ERR_(PROXY|TUNNEL|CONNECTION_RESET|TIMED_OUT|EMPTY_RESPONSE)/i;

function isProxyNetError(msg) {
  return PROXY_NET_ERROR_RE.test(String(msg || ''));
}

// Serialize selector mutations. Without this, fire-and-forget rotate
// (recordBadAttempt) + explicit await rotate (engine catch) can race the
// Clash API PUT /proxies (not a transaction) and leave _state.currentNode
// disagreeing with sing-box's actually-selected node — the next
// recordBadAttempt would then blame the wrong tag.
let _rotateLock = Promise.resolve();
function withRotateLock(fn) {
  const next = _rotateLock.then(fn, fn);
  _rotateLock = next.catch(() => {});  // never let the lock chain reject
  return next;                          // propagate errors to the caller
}

function _ns(channel) {
  if (channel !== 'main' && channel !== 'jp') throw new Error(`channel must be 'main' or 'jp', got: ${channel}`);
  return channel === 'jp' ? _state.jp : _state;
}

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
  badNodes: new Map(),   // tag → { expiresAt, reason, source }. Nodes that produced repeated TLS/network errors.
  failCount: new Map(),     // tag → 0..2
  failReasons: new Map(),   // tag → 最近一次原因 (60 字截断)
  whitelist: [],          // 用户配置的 tag 数组（与 _state.jp.whitelist 同语义）
  whitelistMisses: [],    // 订阅中缺失的 tag（UI 黄色提示）
  allTags: [],   // 订阅里全部节点 tag (refresh 时缓存，供 /api/proxy/nodes 用)
  // PX-7 active health probe — tag → { alive: bool, delayMs, lastTested }.
  // rotate() prefers alive nodes when at least one alive exists; otherwise
  // ignores probe results to avoid deadlock.
  probeResults: new Map(),
  probeSummary: { alive: 0, dead: 0, total: 0, lastRunAt: 0 },
  jp: {
    enabled: false,
    keyword: JP_DEFAULT_KEYWORD,
    whitelist: [],
    whitelistMisses: [],
    outbounds: [],
    nodeTags: [],
    currentNode: '',
    rotationStrategy: 'sequential',
    rotationIndex: 0,
    badNodes: new Map(),
    failCount: new Map(),
    failReasons: new Map(),
    exitIp: '',
    lastError: '',
    probeResults: new Map(),
    probeSummary: { alive: 0, dead: 0, total: 0, lastRunAt: 0 },
  },
};

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function isBad(tag) {
  const entry = _state.badNodes.get(tag);
  if (!entry) return false;
  // Support legacy number value (defensive); new value is { expiresAt, reason, source }
  const expiresAt = typeof entry === 'number' ? entry : entry.expiresAt;
  if (Date.now() > expiresAt) {
    _state.badNodes.delete(tag);
    try { blacklist.remove(tag, 'main'); } catch {}
    return false;
  }
  return true;
}

function _addToBlacklist(tag, channel, ttlMs, reason, source) {
  const expiresAt = Date.now() + ttlMs;
  const entry = { expiresAt, reason: String(reason).slice(0, 60), source };
  const ns = _ns(channel);
  ns.badNodes.set(tag, entry);
  try { blacklist.add(tag, channel, ttlMs, reason, source); } catch (e) { console.log(`[Proxy] blacklist.add failed: ${e.message?.slice(0, 60)}`); }
}

// v2.31.1: rotate 钩子 — module-init 后指向真实 rotate/rotateJp（见文件下方）；
// 测试可用 __setAutoRotateForTest 替换。传 null 恢复默认。
let _autoRotateFn = null;
let _autoRotateJpFn = null;

function __setAutoRotateForTest(mainFn, jpFn) {
  _autoRotateFn = (mainFn === null) ? rotate : (mainFn || _autoRotateFn);
  _autoRotateJpFn = (jpFn === null) ? rotateJp : (jpFn || _autoRotateJpFn);
}

function recordBadAttempt(tag, channel, reason = '') {
  if (!tag) return { blacklisted: false, count: 0 };
  const ns = _ns(channel);
  const next = (ns.failCount.get(tag) || 0) + 1;
  ns.failCount.set(tag, next);
  ns.failReasons.set(tag, String(reason).slice(0, 60));
  console.log(`[Proxy${channel === 'jp' ? ':JP' : ''}] Bad attempt ${next}/${FAIL_THRESHOLD} on ${tag} (${String(reason).slice(0, 40)})`);
  if (next >= FAIL_THRESHOLD) {
    _addToBlacklist(tag, channel, BAD_NODE_TTL_MS, reason, 'auto');
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
    // v2.31.1: 拉黑后 fire-and-forget rotate，让 currentNode 立即切到下一个非黑名单节点。
    const doRotate = channel === 'jp' ? _autoRotateJpFn : _autoRotateFn;
    if (typeof doRotate === 'function') {
      Promise.resolve().then(() => doRotate()).catch((e) => {
        console.log(`[Proxy] auto-rotate after blacklist failed: ${e?.message?.slice(0, 60)}`);
      });
    }
    return { blacklisted: true, count: next };
  }
  return { blacklisted: false, count: next };
}

function recordGoodAttempt(tag, channel) {
  if (!tag) return;
  const ns = _ns(channel);
  if (ns.failCount.has(tag)) {
    ns.failCount.delete(tag);
    ns.failReasons.delete(tag);
  }
}

function blacklistManually(tag, channel, ttlMs = BAD_NODE_TTL_MS, reason = 'manual') {
  if (!tag) throw new Error('tag required');
  _addToBlacklist(tag, channel, ttlMs, reason, 'manual');
  const ns = _ns(channel);
  ns.failCount.delete(tag);
  ns.failReasons.delete(tag);
}

function removeFromBlacklist(tag, channel) {
  const ns = _ns(channel);
  ns.badNodes.delete(tag);
  try { blacklist.remove(tag, channel); } catch {}
}

function clearBlacklist(channel) {
  const ns = _ns(channel);
  ns.badNodes.clear();
  try { blacklist.removeAll(channel); } catch {}
}

// Legacy aliases — preserve existing call sites in engine / chatgpt-checkout
function markBad(tag) { return recordBadAttempt(tag, 'main', 'legacy markBad'); }
function markJpBad(tag) { return recordBadAttempt(tag, 'jp', 'legacy markJpBad'); }

function getState() {
  const now = Date.now();
  const project = (map) => {
    const out = {};
    for (const [tag, entry] of map.entries()) {
      const obj = typeof entry === 'number' ? { expiresAt: entry, reason: '', source: 'auto' } : entry;
      if (obj.expiresAt > now) out[tag] = obj;
      // do NOT delete here — isBad/isJpBad/pruneExpired own cleanup paths
    }
    return out;
  };
  // Explicit field whitelist — DO NOT spread _state. The subscriptionUrl
  // (and any future credential-bearing field) must never reach the
  // dashboard or server.log. Frontends consume `hasSubscription` /
  // `subscriptionHost` instead so users can still see "configured ✓"
  // without exposing the token.
  let subscriptionHost = null;
  if (_state.subscriptionUrl) {
    try { subscriptionHost = new URL(_state.subscriptionUrl).hostname; } catch { subscriptionHost = null; }
  }
  // Note: outbounds is intentionally omitted — parsed nodes can contain
  // credentials (vmess UUID, ss password, trojan password). nodeTags / allTags
  // are just label strings and safe to expose. failCount / failReasons are
  // internal Maps that don't round-trip well to JSON.
  // Project probeResults Map → plain object so it JSON-serializes for the UI.
  const projectProbe = (map) => {
    const out = {};
    for (const [tag, entry] of map.entries()) out[tag] = entry;
    return out;
  };
  return {
    enabled: _state.enabled,
    hasSubscription: !!_state.subscriptionUrl,
    subscriptionHost,
    nodeTags: _state.nodeTags,
    currentNode: _state.currentNode,
    rotationStrategy: _state.rotationStrategy,
    rotationIndex: _state.rotationIndex,
    rotationKeyword: _state.rotationKeyword,
    exitIp: _state.exitIp,
    lastError: _state.lastError,
    whitelist: _state.whitelist,
    whitelistMisses: _state.whitelistMisses,
    allTags: _state.allTags,
    available: _state.nodeTags.length,
    badNodes: project(_state.badNodes),
    probeResults: projectProbe(_state.probeResults),
    probeSummary: { ..._state.probeSummary },
    jp: {
      enabled: _state.jp.enabled,
      keyword: _state.jp.keyword,
      whitelist: _state.jp.whitelist,
      whitelistMisses: _state.jp.whitelistMisses,
      nodeTags: _state.jp.nodeTags,
      currentNode: _state.jp.currentNode,
      rotationStrategy: _state.jp.rotationStrategy,
      rotationIndex: _state.jp.rotationIndex,
      exitIp: _state.jp.exitIp,
      lastError: _state.jp.lastError,
      available: _state.jp.nodeTags.length,
      badNodes: project(_state.jp.badNodes),
      probeResults: projectProbe(_state.jp.probeResults),
      probeSummary: { ..._state.jp.probeSummary },
    },
  };
}

/**
 * Decide main-channel node pool.
 * 与 pickJpNodes 同构：whitelist 非空时优先精确 tag 匹配；空时回退 regionFilter 关键字；
 * 双空时（regionFilter 为空字符串/未设）返回全部节点。
 *
 * @param {Array} all                 — 订阅解析后的全部节点
 * @param {Object} mainCfg            — cfg.proxy 子对象
 * @param {Array<string>} mainCfg.whitelist
 * @param {string} mainCfg.regionFilter
 * @returns {{ filtered: Array, misses: string[], usedWhitelist: boolean }}
 */
function pickMainNodes(all, mainCfg) {
  if (!mainCfg) return { filtered: [], misses: [], usedWhitelist: false };
  const whitelist = Array.isArray(mainCfg.whitelist) ? mainCfg.whitelist : [];
  if (whitelist.length > 0) {
    const filtered = filterByWhitelist(all, whitelist);
    const presentTags = new Set(all.map(o => o.tag));
    const misses = whitelist.filter(t => typeof t === 'string' && t && !presentTags.has(t));
    return { filtered, misses, usedWhitelist: true };
  }
  // ?? 而不是 ||：仅在 regionFilter 字段缺失（undefined/null）时默认 'US'；
  // 显式空字符串透传给 filterByRegion，触发其 "不过滤" 分支（subscription.js:174）。
  const filtered = filterByRegion(all, mainCfg.regionFilter ?? 'US');
  return { filtered, misses: [], usedWhitelist: false };
}

function pickJpNodes(all, jpCfg) {
  if (!jpCfg || jpCfg.enabled === false) {
    return { filtered: [], misses: [], usedWhitelist: false };
  }
  const whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : [];
  if (whitelist.length > 0) {
    const filtered = filterByWhitelist(all, whitelist);
    const presentTags = new Set(all.map(o => o.tag));
    const misses = whitelist.filter(t => typeof t === 'string' && t && !presentTags.has(t));
    return { filtered, misses, usedWhitelist: true };
  }
  const filtered = filterByJpKddi(all, jpCfg.keyword || 'KDDI');
  return { filtered, misses: [], usedWhitelist: false };
}

/**
 * 生成 sing-box config。
 *
 * v2.42 Task 7: main / jp outbound 从 selector 改为 urltest，让 sing-box
 * 自己做 latency-based 选最优 + dead-node 自动跳，业务层不再调
 * rotate / switchSelector / runHealthProbe（Task 8 一并删除）。
 *
 * 新签名（spec §3.1，opts 对象形式）：
 *   buildSingboxConfig({
 *     mainNodes,                  // Array<outbound>，主代理节点池
 *     jpNodes,                    // Array<outbound>，JP 通道节点池
 *     mainPort = 7890,
 *     jpPort = 7891,
 *     excludeNodes = [],          // banFromUrltest 用：从 urltest.outbounds 排除
 *   })
 *
 * 兼容旧位置签名 `buildSingboxConfig(us, jp)`：refresh() 仍这么调（Task 8 改）。
 */
function buildSingboxConfig(usOrOpts /* nullable | opts */, jpArg /* nullable */) {
  // 解析两种签名 — opts 对象 vs 位置参数
  let mainNodes, jpNodes, mainPort, jpPort, excludeNodes;
  if (usOrOpts !== null && typeof usOrOpts === 'object' && !Array.isArray(usOrOpts)) {
    // 新签名：buildSingboxConfig({ mainNodes, jpNodes, ... })
    mainNodes = Array.isArray(usOrOpts.mainNodes) ? usOrOpts.mainNodes : [];
    jpNodes = Array.isArray(usOrOpts.jpNodes) ? usOrOpts.jpNodes : [];
    mainPort = usOrOpts.mainPort || HTTP_PORT;
    jpPort = usOrOpts.jpPort || JP_HTTP_PORT;
    excludeNodes = Array.isArray(usOrOpts.excludeNodes) ? usOrOpts.excludeNodes : [];
  } else {
    // 旧签名：buildSingboxConfig(us, jp)
    mainNodes = Array.isArray(usOrOpts) ? usOrOpts : [];
    jpNodes = Array.isArray(jpArg) ? jpArg : [];
    mainPort = HTTP_PORT;
    jpPort = JP_HTTP_PORT;
    excludeNodes = [];
  }

  // 排除 banned 节点 —— 整体从节点池 filter，节点本身的 outbound 也不进
  // cfg.outbounds（保持 outbound 列表与 urltest.outbounds 一致；sing-box
  // 不允许 urltest.outbounds 引用不存在的 tag）。
  const banned = new Set(excludeNodes);
  const mainAvailable = mainNodes.filter(n => !banned.has(n.tag));
  const jpAvailable = jpNodes.filter(n => !banned.has(n.tag));

  const hasUs = mainAvailable.length > 0;
  const hasJp = jpAvailable.length > 0;
  if (!hasUs && !hasJp) {
    throw new Error('buildSingboxConfig: 主代理与 JP 通道至少需要一个有节点');
  }

  const inbounds = [];
  const outbounds = [];
  // sing-box 1.11+ removed the legacy inbound 'sniff: true' field; sniff is now
  // a route rule action. Run it first so subsequent rules can match on the
  // sniffed destination domain. We don't actually use the sniffed value for
  // routing (rules below are inbound-based), but the action populates request
  // metadata that some outbounds (e.g. VLESS with reality SNI) may consult.
  const rules = [{ action: 'sniff' }];

  if (hasUs) {
    inbounds.push({ type: 'mixed', tag: MAIN_INBOUND_TAG, listen: '127.0.0.1', listen_port: mainPort });
    // urltest 自动选 latency 最低的节点；interval 每 3 分钟重新探活；
    // tolerance 50ms 防抖（避免延迟抖动导致频繁切节点中断 inflight 流量）。
    // idle_timeout 30m 控制空闲时 probe 频率。
    outbounds.push({
      type: 'urltest',
      tag: SELECTOR_TAG,
      outbounds: mainAvailable.map(o => o.tag),
      url: 'https://www.gstatic.com/generate_204',
      interval: '3m',
      tolerance: 50,
      idle_timeout: '30m',
    });
    outbounds.push(...mainAvailable);
    rules.push({ inbound: MAIN_INBOUND_TAG, outbound: SELECTOR_TAG });
  }

  if (hasJp) {
    inbounds.push({ type: 'mixed', tag: JP_INBOUND_TAG, listen: '127.0.0.1', listen_port: jpPort });
    outbounds.push({
      type: 'urltest',
      tag: JP_SELECTOR_TAG,
      outbounds: jpAvailable.map(o => o.tag),
      url: 'https://www.gstatic.com/generate_204',
      interval: '3m',
      tolerance: 50,
      idle_timeout: '30m',
    });
    outbounds.push(...jpAvailable);
    rules.push({ inbound: JP_INBOUND_TAG, outbound: JP_SELECTOR_TAG });
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
      final: hasUs ? SELECTOR_TAG : JP_SELECTOR_TAG,
      rules,
    },
  };
}

/** Refresh subscription and (re)start sing-box. Returns the number of US-channel nodes loaded.
 *  Main channel (US) and JP-Checkout channel are independently enabled via
 *  config.proxy.enabled and config.proxy.jpCheckout.enabled. At least one must be true.
 */
async function refresh() {
  const cfg = readCfg().proxy || {};
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.rotationKeyword = cfg.regionFilter ?? 'US';
  _state.rotationStrategy = cfg.rotationStrategy || 'sequential';
  _state.whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist : [];

  // Default true keeps backward-compat for configs without an explicit `enabled` field.
  const mainEnabledByConfig = cfg.enabled !== false;

  const jpCfg = cfg.jpCheckout || {};
  const jpEnabledByConfig = jpCfg.enabled !== false;
  _state.jp.keyword = jpCfg.keyword || JP_DEFAULT_KEYWORD;
  _state.jp.rotationStrategy = jpCfg.rotationStrategy || 'sequential';
  _state.jp.whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : [];

  if (!mainEnabledByConfig && !jpEnabledByConfig) {
    throw new Error('主代理与 JP 通道均未启用，至少需启用一个');
  }
  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  _state.allTags = all.map(o => o.tag);

  // Main channel filtering — strict only when enabled by config.
  let filtered = [];
  let mainPick = { filtered: [], misses: [], usedWhitelist: false };
  if (mainEnabledByConfig) {
    mainPick = pickMainNodes(all, cfg);
    filtered = mainPick.filtered;
    if (mainPick.usedWhitelist) {
      console.log(`[Proxy] Main whitelist: ${filtered.length}/${_state.whitelist.length} matched (${mainPick.misses.length} missing${mainPick.misses.length > 0 ? ': ' + mainPick.misses.join(', ') : ''})`);
    } else {
      console.log(`[Proxy] After region filter (${_state.rotationKeyword}): ${filtered.length}`);
    }
    if (mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`主代理白名单 [${_state.whitelist.filter(t => typeof t === 'string' && t).join(', ')}] 在订阅中无任何匹配`);
    }
    if (!mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`没有匹配地区 "${_state.rotationKeyword}" 的节点`);
    }
  } else {
    console.log(`[Proxy] Main channel disabled by config`);
  }
  _state.whitelistMisses = mainPick.misses;

  // JP channel filtering — strict only when enabled by config.
  let jpFiltered = [];
  let jpPick = { filtered: [], misses: [], usedWhitelist: false };
  if (jpEnabledByConfig) {
    jpPick = pickJpNodes(all, jpCfg);
    jpFiltered = jpPick.filtered;
    if (jpPick.usedWhitelist) {
      console.log(`[Proxy] JP whitelist: ${jpFiltered.length}/${_state.jp.whitelist.length} matched (${jpPick.misses.length} missing${jpPick.misses.length > 0 ? ': ' + jpPick.misses.join(', ') : ''})`);
    } else {
      console.log(`[Proxy] JP-KDDI filter (keyword=${_state.jp.keyword}): ${jpFiltered.length}`);
    }
    if (jpPick.usedWhitelist && jpFiltered.length === 0) {
      throw new Error(`JP 白名单 [${_state.jp.whitelist.join(', ')}] 在订阅中无任何匹配`);
    }
    if (!jpPick.usedWhitelist && jpFiltered.length === 0) {
      throw new Error(`JP 通道：订阅中未找到关键字 "${_state.jp.keyword}" 的节点`);
    }
  } else {
    console.log(`[Proxy] JP-Checkout channel disabled by config`);
  }
  _state.jp.whitelistMisses = jpPick.misses;

  _state.outbounds = filtered;
  _state.nodeTags = filtered.map(o => o.tag);
  if (filtered.length === 0) {
    _state.rotationIndex = 0;
  } else if (_state.rotationIndex >= filtered.length) {
    _state.rotationIndex = _state.rotationIndex % filtered.length;
  }
  _state.currentNode = filtered[_state.rotationIndex]?.tag || '';

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  if (jpFiltered.length === 0) {
    _state.jp.rotationIndex = 0;
  } else if (_state.jp.rotationIndex >= jpFiltered.length) {
    _state.jp.rotationIndex = _state.jp.rotationIndex % jpFiltered.length;
  }
  _state.jp.currentNode = jpFiltered[_state.jp.rotationIndex]?.tag || '';
  _state.jp.lastError = '';

  const sbConfig = buildSingboxConfig(
    mainEnabledByConfig ? filtered : null,
    jpEnabledByConfig ? jpFiltered : null,
  );

  try {
    await singbox.start(sbConfig);
    _state.enabled = mainEnabledByConfig;
    _state.jp.enabled = jpEnabledByConfig;
  } catch (err) {
    // Degrade to US-only when sing-box reports a *real* bind failure on :7891.
    // We deliberately match only "failed to bind port" (the literal string our
    // singbox.start throws when its net.connect probe fails) — not the generic
    // "exited unexpectedly" message, whose boilerplate hint contains the
    // substring "7890/7891" and previously caused config-error exits to be
    // mis-classified as port collisions, masking the real cause.
    if (mainEnabledByConfig && jpEnabledByConfig && /failed to bind port 7891/i.test(err.message || '')) {
      console.log(`[Proxy] 7891 端口被占用，降级关闭 JP 通道: ${err.message}`);
      _state.jp.lastError = `端口 7891 被占用，JP 通道已禁用: ${(err.message || '').slice(0, 120)}`;
      const fallbackConfig = buildSingboxConfig(filtered, null);
      await singbox.start(fallbackConfig);
      _state.enabled = true;
      _state.jp.enabled = false;
    } else {
      _state.enabled = false;
      _state.jp.enabled = false;
      throw err;
    }
  }

  _state.lastError = '';

  // Hydrate blacklist from DB on first refresh of this process.
  // Manual or auto entries added at runtime go through _addToBlacklist directly,
  // so the size === 0 guard only triggers on cold start.
  if (_state.badNodes.size === 0 && _state.jp.badNodes.size === 0) {
    try {
      blacklist.pruneExpired();
      for (const row of blacklist.loadAll('main')) {
        _state.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
      }
      for (const row of blacklist.loadAll('jp')) {
        _state.jp.badNodes.set(row.tag, { expiresAt: row.expiresAt, reason: row.reason, source: row.source });
      }
    } catch (e) {
      console.log(`[Proxy] hydrate blacklist failed: ${e.message?.slice(0, 60)}`);
    }
  }

  const mainDesc = _state.enabled ? `:${HTTP_PORT}(${filtered.length})` : 'disabled';
  const jpDesc = _state.jp.enabled ? `:${JP_HTTP_PORT}(${jpFiltered.length})` : 'disabled';
  console.log(`[Proxy] sing-box running: main=${mainDesc} jp=${jpDesc}`);

  // PX-3: singbox config writes default = filtered[0], but _state.currentNode
  // may have been preserved by rotationIndex from a previous run. If they
  // diverge, the Clash selector still points to filtered[0] until the next
  // rotate() — meanwhile recordBadAttempt would blame the wrong tag for the
  // next failure. Force a selector switch to align state.
  await withRotateLock(async () => {
    if (_state.enabled && _state.currentNode && _state.rotationIndex !== 0) {
      try { await clashApi.switchSelector(SELECTOR_TAG, _state.currentNode); }
      catch (e) { console.log(`[Proxy] selector sync failed: ${e.message?.slice(0, 60)}`); }
    }
    if (_state.jp.enabled && _state.jp.currentNode && _state.jp.rotationIndex !== 0) {
      try { await clashApi.switchSelector(JP_SELECTOR_TAG, _state.jp.currentNode); }
      catch (e) { console.log(`[Proxy:JP] selector sync failed: ${e.message?.slice(0, 60)}`); }
    }
  });

  // PX-7 active health probe — fire-and-forget so refresh() returns
  // immediately; rotate() consults probeResults to prefer alive nodes.
  // Setting `activeHealthCheck: false` in config.proxy disables it.
  // NB: `cfg` here was assigned `readCfg().proxy || {}`, so the field is at
  // `cfg.activeHealthCheck`, not `cfg.proxy.activeHealthCheck`.
  const probeEnabled = cfg.activeHealthCheck !== false;
  if (probeEnabled) {
    Promise.resolve().then(() => runHealthProbe()).catch((e) => {
      console.log(`[Proxy] health probe failed: ${e.message?.slice(0, 80)}`);
    });
  }

  return filtered.length;
}

/**
 * v2.34.1: 验证 currentNode 是否在 probe 结果里 alive；不活就 fire-and-forget rotate。
 * 纯函数 + 注入 rotate，便于单测。
 * - currentTag 为空串 / falsy → 跳过
 * - probeResults 未含此 tag（未探过）→ 跳过（保守，避免假阳性）
 * - 含此 tag 且 alive === false → 调度 rotate
 * - 含此 tag 且 alive === true → 跳过
 *
 * @param {string} currentTag
 * @param {Map<string, {alive: boolean}>} probeResults
 * @param {() => Promise<any> | any} rotateFn
 */
function _autoRotateIfCurrentDead(currentTag, probeResults, rotateFn) {
  if (!currentTag) return
  const r = probeResults?.get(currentTag)
  if (r && r.alive === false) {
    Promise.resolve().then(() => rotateFn()).catch((e) => {
      console.log(`[Proxy] auto-rotate after dead probe failed: ${e?.message?.slice(0, 60)}`)
    })
  }
}

async function runHealthProbe() {
  const { probeAllNodes } = require('./health-probe');
  // Main channel
  if (_state.enabled && _state.nodeTags.length > 0) {
    const summary = await probeAllNodes(_state.nodeTags, _state.probeResults, {
      shouldSkip: (tag) => isBad(tag),  // don't probe blacklisted nodes
    });
    _state.probeSummary = { ...summary, lastRunAt: Date.now() };
    console.log(`[Proxy] health probe: main ${summary.alive}/${summary.total} alive`);
  }
  // JP channel
  if (_state.jp.enabled && _state.jp.nodeTags.length > 0) {
    const summary = await probeAllNodes(_state.jp.nodeTags, _state.jp.probeResults, {
      shouldSkip: (tag) => isJpBad(tag),
    });
    _state.jp.probeSummary = { ...summary, lastRunAt: Date.now() };
    console.log(`[Proxy:JP] health probe: ${summary.alive}/${summary.total} alive`);
  }

  // v2.34.1: 探针完成后自我修复。若 currentNode 被探出 alive=false，fire-and-forget
  // rotate 切到下一个活节点。覆盖启动场景（refresh() 同步选定第一个白名单节点，
  // probe 跑完发现死）和运行时定时探针后场景。jp 通道对称处理。
  _autoRotateIfCurrentDead(_state.currentNode, _state.probeResults, rotate);
  _autoRotateIfCurrentDead(_state.jp.currentNode, _state.jp.probeResults, rotateJp);
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
  return withRotateLock(async () => {
    if (!_state.enabled || _state.nodeTags.length === 0) throw new Error('代理未启用');

    // PX-7: if the health probe identified at least one alive non-bad node,
    // prefer alive ones; this prevents wasting accounts on a known-dead node
    // that hasn't yet hit the 3-strike blacklist threshold. When no alive
    // node exists (or probe never ran), fall through to the original logic.
    const hasAlive = _state.nodeTags.some(
      (t) => !isBad(t) && _state.probeResults.get(t)?.alive === true,
    );

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
      if (isBad(candidate)) continue;
      if (hasAlive && _state.probeResults.get(candidate)?.alive === false) continue;
      nextTag = candidate; break;
    }

    if (!nextTag) {
      // Every node is bad. First try clearing only auto-blacklisted entries —
      // user-pinned manual bans should survive unless they're the *only*
      // thing keeping every node out. If after clearing autos we still have
      // no candidates, fall back to a full clear.
      const autoTags = [];
      for (const [tag, entry] of _state.badNodes.entries()) {
        const obj = typeof entry === 'number' ? { source: 'auto' } : entry;
        if (obj.source !== 'manual') autoTags.push(tag);
      }
      if (autoTags.length > 0) {
        console.log(`[Proxy] All ${_state.nodeTags.length} nodes blacklisted; clearing ${autoTags.length} auto entries (manual entries preserved)`);
        for (const tag of autoTags) {
          _state.badNodes.delete(tag);
          try { blacklist.remove(tag, 'main'); } catch {}
        }
      }
      // Try again to find a candidate.
      for (let i = 0; i < _state.nodeTags.length; i++) {
        if (_state.rotationStrategy === 'random') {
          nextTag = _state.nodeTags[Math.floor(Math.random() * _state.nodeTags.length)];
        } else {
          _state.rotationIndex = (_state.rotationIndex + 1) % _state.nodeTags.length;
          nextTag = _state.nodeTags[_state.rotationIndex];
        }
        if (!isBad(nextTag)) break;
        nextTag = null;
      }
      if (!nextTag) {
        // Even after clearing autos, every remaining node is manually banned.
        // Last-resort clear so we don't deadlock with no proxy at all.
        console.log(`[Proxy] All nodes remain blacklisted (all manual); clearing everything to avoid deadlock`);
        _state.badNodes.clear();
        try { blacklist.removeAll('main'); } catch {}
        if (_state.rotationStrategy === 'random') {
          nextTag = _state.nodeTags[Math.floor(Math.random() * _state.nodeTags.length)];
        } else {
          _state.rotationIndex = (_state.rotationIndex + 1) % _state.nodeTags.length;
          nextTag = _state.nodeTags[_state.rotationIndex];
        }
      }
    }

    await clashApi.switchSelector(SELECTOR_TAG, nextTag);
    _state.currentNode = nextTag;
    return nextTag;
  });
}

async function rotateJp() {
  return withRotateLock(async () => {
    if (!_state.jp.enabled || _state.jp.nodeTags.length === 0) throw new Error('JP 通道未启用');

    const hasAlive = _state.jp.nodeTags.some(
      (t) => !isJpBad(t) && _state.jp.probeResults.get(t)?.alive === true,
    );

    let nextTag = null;
    for (let i = 0; i < _state.jp.nodeTags.length; i++) {
      let candidate;
      if (_state.jp.rotationStrategy === 'random') {
        candidate = _state.jp.nodeTags[Math.floor(Math.random() * _state.jp.nodeTags.length)];
      } else {
        _state.jp.rotationIndex = (_state.jp.rotationIndex + 1) % _state.jp.nodeTags.length;
        candidate = _state.jp.nodeTags[_state.jp.rotationIndex];
      }
      if (isJpBad(candidate)) continue;
      if (hasAlive && _state.jp.probeResults.get(candidate)?.alive === false) continue;
      nextTag = candidate; break;
    }

    if (!nextTag) {
      // Auto-vs-manual cleared in two passes: preserve manual bans first.
      const autoTags = [];
      for (const [tag, entry] of _state.jp.badNodes.entries()) {
        const obj = typeof entry === 'number' ? { source: 'auto' } : entry;
        if (obj.source !== 'manual') autoTags.push(tag);
      }
      if (autoTags.length > 0) {
        console.log(`[Proxy:JP] All ${_state.jp.nodeTags.length} KDDI nodes blacklisted; clearing ${autoTags.length} auto entries (manual preserved)`);
        for (const tag of autoTags) {
          _state.jp.badNodes.delete(tag);
          try { blacklist.remove(tag, 'jp'); } catch {}
        }
      }
      for (let i = 0; i < _state.jp.nodeTags.length; i++) {
        if (_state.jp.rotationStrategy === 'random') {
          nextTag = _state.jp.nodeTags[Math.floor(Math.random() * _state.jp.nodeTags.length)];
        } else {
          _state.jp.rotationIndex = (_state.jp.rotationIndex + 1) % _state.jp.nodeTags.length;
          nextTag = _state.jp.nodeTags[_state.jp.rotationIndex];
        }
        if (!isJpBad(nextTag)) break;
        nextTag = null;
      }
      if (!nextTag) {
        console.log(`[Proxy:JP] All KDDI nodes remain blacklisted (all manual); clearing to avoid deadlock`);
        _state.jp.badNodes.clear();
        try { blacklist.removeAll('jp'); } catch {}
        if (_state.jp.rotationStrategy === 'random') {
          nextTag = _state.jp.nodeTags[Math.floor(Math.random() * _state.jp.nodeTags.length)];
        } else {
          _state.jp.rotationIndex = (_state.jp.rotationIndex + 1) % _state.jp.nodeTags.length;
          nextTag = _state.jp.nodeTags[_state.jp.rotationIndex];
        }
      }
    }

    await clashApi.switchSelector(JP_SELECTOR_TAG, nextTag);
    _state.jp.currentNode = nextTag;
    return nextTag;
  });
}

// v2.31.1: 把真实 rotate 注入 recordBadAttempt 的 fire-and-forget 钩子（在 rotate/rotateJp
// 已定义之后赋值，避免 TDZ）。
_autoRotateFn = rotate;
_autoRotateJpFn = rotateJp;

/** Switch to a specific node by name. Serialized through the same rotate lock
 *  so this can't race with rotate / rotateJp. */
async function switchTo(nodeTag) {
  return withRotateLock(async () => {
    if (!_state.nodeTags.includes(nodeTag)) throw new Error(`节点不存在: ${nodeTag}`);
    await clashApi.switchSelector(SELECTOR_TAG, nodeTag);
    _state.currentNode = nodeTag;
    return nodeTag;
  });
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

async function detectJpExit() {
  if (!_state.jp.enabled) return '';
  try {
    const net = require('net');
    const tls = require('tls');
    const host = 'api.ipify.org';
    const exitIp = await new Promise((resolve, reject) => {
      const sock = net.connect(JP_HTTP_PORT, '127.0.0.1', () => {
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
    _state.jp.exitIp = exitIp;
    return exitIp;
  } catch (e) {
    _state.jp.exitIp = `error: ${(e.message || '').slice(0, 60)}`;
    return _state.jp.exitIp;
  }
}

function getProxyUrl() {
  return _state.enabled ? `http://127.0.0.1:${HTTP_PORT}` : '';
}

function getJpProxyUrl() {
  return _state.jp.enabled ? `http://127.0.0.1:${JP_HTTP_PORT}` : '';
}

function isJpBad(tag) {
  const entry = _state.jp.badNodes.get(tag);
  if (!entry) return false;
  const expiresAt = typeof entry === 'number' ? entry : entry.expiresAt;
  if (Date.now() > expiresAt) {
    _state.jp.badNodes.delete(tag);
    try { blacklist.remove(tag, 'jp'); } catch {}
    return false;
  }
  return true;
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
  pickJpNodes,
  pickMainNodes,
  US_PATTERNS,
  // JP-Checkout channel
  getJpProxyUrl,
  rotateJp,
  detectJpExit,
  markJpBad,
  isJpBad,
  // blacklist + counter API
  recordBadAttempt,
  recordGoodAttempt,
  // PX-7 health probe
  runHealthProbe,
  __setAutoRotateForTest,
  __autoRotateIfCurrentDeadForTest: _autoRotateIfCurrentDead,
  blacklistManually,
  removeFromBlacklist,
  clearBlacklist,
  isProxyNetError,
  FAIL_THRESHOLD,
  // constants
  SELECTOR_TAG,
  JP_SELECTOR_TAG,
  HTTP_PORT,
  JP_HTTP_PORT,
  CLASH_API_PORT,
};
