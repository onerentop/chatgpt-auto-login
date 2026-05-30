// Proxy orchestration: subscription → sing-box → urltest auto-failover
//
// v2.42 Task 8 重构：
// - 删除 runHealthProbe / rotate / rotateJp / markBad / failCount / failReasons /
//   probeResults / probeSummary / recordBad+GoodAttempt 内部投票逻辑（sing-box
//   urltest 自做 latency probe + dead-node 自跳）。
// - 新增 getActiveNode / banFromUrltest / unbanNode / getJpNodeCount / regenerateAndReload
//   / reloadSingbox：业务遇到 Cloudflare 403 / rate_limited 等显式失败时
//   fire-and-forget 让 sing-box 把当前 active 节点踢出 urltest 一段时间。
// - 旧的 rotate / recordBadAttempt / markBad / getProxyUrl 等 export 保留为
//   no-op / env-based stub，避免老调用点（engine.js / protocol-engine.js /
//   stripe-verify.js / chatgpt-checkout.js）整片连环改动。
const fs = require('fs');
const path = require('path');
const singbox = require('./singbox');
const { fetchAndParse, filterByRegion, filterByJpKddi, filterByWhitelist, US_PATTERNS } = require('./subscription');
const clashApi = require('./clash-api');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// urltest outbound tag — Clash API 路径 /proxies/main、/proxies/jp 都按这个走。
const SELECTOR_TAG = 'main';
const HTTP_PORT = 7890;
const CLASH_API_PORT = 9090;

const JP_HTTP_PORT = 7891;
const JP_SELECTOR_TAG = 'jp';
const JP_DEFAULT_KEYWORD = 'KDDI';

// inbound tag → mixed-7890 / mixed-7891，与端口对应（看 sing-box log 直接定位入口）
const MAIN_INBOUND_TAG = 'mixed-7890';
const JP_INBOUND_TAG = 'mixed-7891';

const BAD_NODE_TTL_MS = 30 * 60 * 1000;  // 30 min — nodes recover eventually

// 留作 backwards-compat 常量，老调用点 (engine / protocol-engine) 还 import 这个。
// v2.42 实际投票逻辑已删，stub 化的 recordBadAttempt 永远不达阈值，FAIL_THRESHOLD
// 仅给 UI / 测试断言保留语义。
const FAIL_THRESHOLD = 3;
const blacklist = require('./blacklist');

const PROXY_NET_ERROR_RE = /ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|ECONNREFUSED|tunneling socket|net::ERR_(PROXY|TUNNEL|CONNECTION_RESET|TIMED_OUT|EMPTY_RESPONSE)/i;

function isProxyNetError(msg) {
  return PROXY_NET_ERROR_RE.test(String(msg || ''));
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
  currentNode: '',       // v2.42: kept for backwards-compat (Clash API /proxies/main.now 也可查)
  regionFilter: 'US',    // v2.42.1: 区域过滤（原 rotationKeyword，纯展示用，不参与 rotate）
  lastError: '',
  exitIp: '',
  badNodes: new Map(),   // tag → { expiresAt, reason, source }. Manual blacklist (用户在 UI 手 pin)。
  whitelist: [],
  whitelistMisses: [],
  allTags: [],
  // v2.42 Task 8: banned 节点 — tag → expiresAt(ms)。业务遇 Cloudflare 403 / 速率限制时
  // 通过 banFromUrltest() 加入，到期 setTimeout 自动 unban。与 badNodes（manual）分开 —
  // banned 走 sing-box config regenerate 路径，从 urltest.outbounds 排除。
  bannedNodes: new Map(),
  jp: {
    enabled: false,
    keyword: JP_DEFAULT_KEYWORD,
    whitelist: [],
    whitelistMisses: [],
    outbounds: [],
    nodeTags: [],
    currentNode: '',
    badNodes: new Map(),
    exitIp: '',
    lastError: '',
  },
};

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function isBad(tag) {
  const entry = _state.badNodes.get(tag);
  if (!entry) return false;
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

// v2.42 Task 8: recordBadAttempt / recordGoodAttempt 改成 no-op stub。
// 投票阈值逻辑由 sing-box urltest 自做（间隔 3m 重新 probe，dead 自动跳）。
// 业务调用点（engine.js / protocol-engine.js / stripe-verify.js）保留 try/catch
// 包裹 + 用 stub 返回稳定 shape；显式遇 403/rate-limit 时改用 banFromUrltest。
function recordBadAttempt(tag, channel, reason = '') {
  if (!tag) return { blacklisted: false, count: 0 };
  _ns(channel);  // 保留 channel 参数校验（旧测试用 I2 仍验）
  return { blacklisted: false, count: 0 };
}

function recordGoodAttempt(_tag, _channel) {
  // no-op since v2.42 Task 8
}

function blacklistManually(tag, channel, ttlMs = BAD_NODE_TTL_MS, reason = 'manual') {
  if (!tag) throw new Error('tag required');
  _addToBlacklist(tag, channel, ttlMs, reason, 'manual');
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

// Legacy aliases — 老调用点（engine 的 markBad / chatgpt-checkout 的 markJpBad）
// 仍 import 这两个名字。v2.42 后等价于 no-op stub（recordBadAttempt 也已 stub）。
function markBad(tag) { return recordBadAttempt(tag, 'main', 'legacy markBad'); }
function markJpBad(tag) { return recordBadAttempt(tag, 'jp', 'legacy markJpBad'); }

function getState() {
  const now = Date.now();
  const project = (map) => {
    const out = {};
    for (const [tag, entry] of map.entries()) {
      const obj = typeof entry === 'number' ? { expiresAt: entry, reason: '', source: 'auto' } : entry;
      if (obj.expiresAt > now) out[tag] = obj;
    }
    return out;
  };
  let subscriptionHost = null;
  if (_state.subscriptionUrl) {
    try { subscriptionHost = new URL(_state.subscriptionUrl).hostname; } catch { subscriptionHost = null; }
  }
  // v2.42 Task 8: 投影 bannedNodes 为 plain object（UI / health endpoint 可读）。
  const projectBanned = (map) => {
    const out = {};
    for (const [tag, expiresAt] of map.entries()) {
      if (typeof expiresAt === 'number' && expiresAt > now) {
        out[tag] = { expiresAt, ttlRemainingMs: Math.max(0, expiresAt - now) };
      }
    }
    return out;
  };
  return {
    enabled: _state.enabled,
    hasSubscription: !!_state.subscriptionUrl,
    subscriptionHost,
    nodeTags: _state.nodeTags,
    currentNode: _state.currentNode,
    regionFilter: _state.regionFilter,
    exitIp: _state.exitIp,
    lastError: _state.lastError,
    whitelist: _state.whitelist,
    whitelistMisses: _state.whitelistMisses,
    allTags: _state.allTags,
    available: _state.nodeTags.length,
    badNodes: project(_state.badNodes),
    bannedNodes: projectBanned(_state.bannedNodes),
    jp: {
      enabled: _state.jp.enabled,
      keyword: _state.jp.keyword,
      whitelist: _state.jp.whitelist,
      whitelistMisses: _state.jp.whitelistMisses,
      nodeTags: _state.jp.nodeTags,
      currentNode: _state.jp.currentNode,
      exitIp: _state.jp.exitIp,
      lastError: _state.jp.lastError,
      available: _state.jp.nodeTags.length,
      badNodes: project(_state.jp.badNodes),
    },
  };
}

/**
 * Decide main-channel node pool — whitelist 优先于 regionFilter。
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
 * v2.42 Task 7-8: main / jp outbound 为 urltest，sing-box 自做 latency-based 选最优
 * + dead-node 自动跳。banFromUrltest 通过 excludeNodes 把节点从 urltest.outbounds
 * 排除，触发 sing-box 重新挑选 active 节点。
 *
 * 签名（opts 对象优先 / 兼容旧位置签名）：
 *   buildSingboxConfig({ mainNodes, jpNodes, mainPort?, jpPort?, excludeNodes? })
 *   buildSingboxConfig(us, jp)   // legacy positional
 */
function buildSingboxConfig(usOrOpts /* nullable | opts */, jpArg /* nullable */) {
  let mainNodes, jpNodes, mainPort, jpPort, excludeNodes;
  if (usOrOpts !== null && typeof usOrOpts === 'object' && !Array.isArray(usOrOpts)) {
    mainNodes = Array.isArray(usOrOpts.mainNodes) ? usOrOpts.mainNodes : [];
    jpNodes = Array.isArray(usOrOpts.jpNodes) ? usOrOpts.jpNodes : [];
    mainPort = usOrOpts.mainPort || HTTP_PORT;
    jpPort = usOrOpts.jpPort || JP_HTTP_PORT;
    excludeNodes = Array.isArray(usOrOpts.excludeNodes) ? usOrOpts.excludeNodes : [];
  } else {
    mainNodes = Array.isArray(usOrOpts) ? usOrOpts : [];
    jpNodes = Array.isArray(jpArg) ? jpArg : [];
    mainPort = HTTP_PORT;
    jpPort = JP_HTTP_PORT;
    excludeNodes = [];
  }

  const banned = new Set(excludeNodes);
  const mainAvailable = mainNodes.filter(n => !banned.has(n.tag));
  const jpAvailable = jpNodes.filter(n => !banned.has(n.tag));

  // 绑定物理网卡绕过 Karing/Clash TUN — Windows 用 WLAN 接口名
  const BIND_IFACE = process.platform === 'win32' ? 'WLAN' : '';
  if (BIND_IFACE) {
    for (const node of [...mainAvailable, ...jpAvailable]) {
      node.bind_interface = BIND_IFACE;
    }
  }

  const hasUs = mainAvailable.length > 0;
  const hasJp = jpAvailable.length > 0;
  if (!hasUs && !hasJp) {
    throw new Error('buildSingboxConfig: 主代理与 JP 通道至少需要一个有节点');
  }

  const inbounds = [];
  const outbounds = [];
  const rules = [{ action: 'sniff' }];

  // GoPay 印尼代理端口：gopay_activate.py 的 tls_client 通过此端口出站。
  // sing-box route 把流量转发到 iproyal-id outbound（印尼住宅 IP）。
  // 解决 Karing TUN fake-ip (198.20.0.0/15) 与 IPRoyal IP 冲突问题。
  if (BIND_IFACE) {
    try {
      const mainCfg = readCfg();
      const idCfg = mainCfg.proxy?.idGopay || {};
      const proxyTpl = idCfg.enabled ? (idCfg.proxyTemplate || '') : '';
      if (proxyTpl) {
        const m = proxyTpl.match(/^(https?:\/\/)(.+?)@(.+?):(\d+)$/);
        if (m) {
          const [, , userpass, server, port] = m;
          const [user, pass] = userpass.split(':');
          const sid = Math.random().toString(36).slice(2, 10);
          const resolvedPass = pass.replace('{sid}', sid);
          inbounds.push({ type: 'mixed', tag: 'mixed-gopay', listen: '127.0.0.1', listen_port: 27890 });
          outbounds.push({
            type: 'http', tag: 'iproyal-id',
            server: server, server_port: parseInt(port),
            username: user, password: resolvedPass,
            bind_interface: BIND_IFACE,
          });
          rules.push({ inbound: 'mixed-gopay', outbound: 'iproyal-id' });
        }
      }
    } catch { /* no gopay config, skip */ }
  }

  if (hasUs) {
    inbounds.push({ type: 'mixed', tag: MAIN_INBOUND_TAG, listen: '127.0.0.1', listen_port: mainPort });
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

  const directOut = { type: 'direct', tag: 'direct' };
  if (BIND_IFACE) directOut.bind_interface = BIND_IFACE;
  outbounds.push(directOut, { type: 'block', tag: 'block' });

  return {
    log: { level: 'warn' },
    dns: {
      servers: [
        { tag: 'direct-dns', type: 'udp', server: '1.1.1.1', detour: 'direct' },
      ],
      rules: [],
      final: 'direct-dns',
    },
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

/** Refresh subscription and (re)start sing-box. */
async function refresh() {
  const cfg = readCfg().proxy || {};
  _state.subscriptionUrl = cfg.subscriptionUrl || '';
  _state.regionFilter = cfg.regionFilter ?? 'US';
  _state.whitelist = Array.isArray(cfg.whitelist) ? cfg.whitelist : [];

  const mainEnabledByConfig = cfg.enabled !== false;

  const jpCfg = cfg.jpCheckout || {};
  const jpEnabledByConfig = jpCfg.enabled !== false;
  _state.jp.keyword = jpCfg.keyword || JP_DEFAULT_KEYWORD;
  _state.jp.whitelist = Array.isArray(jpCfg.whitelist) ? jpCfg.whitelist : [];

  if (!mainEnabledByConfig && !jpEnabledByConfig) {
    throw new Error('主代理与 JP 通道均未启用，至少需启用一个');
  }
  if (!_state.subscriptionUrl) throw new Error('未配置机场订阅 URL');

  console.log(`[Proxy] Fetching subscription...`);
  const all = await fetchAndParse(_state.subscriptionUrl);
  console.log(`[Proxy] Total nodes parsed: ${all.length}`);
  _state.allTags = all.map(o => o.tag);

  let filtered = [];
  let mainPick = { filtered: [], misses: [], usedWhitelist: false };
  if (mainEnabledByConfig) {
    mainPick = pickMainNodes(all, cfg);
    filtered = mainPick.filtered;
    if (mainPick.usedWhitelist) {
      console.log(`[Proxy] Main whitelist: ${filtered.length}/${_state.whitelist.length} matched (${mainPick.misses.length} missing${mainPick.misses.length > 0 ? ': ' + mainPick.misses.join(', ') : ''})`);
    } else {
      console.log(`[Proxy] After region filter (${_state.regionFilter}): ${filtered.length}`);
    }
    if (mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`主代理白名单 [${_state.whitelist.filter(t => typeof t === 'string' && t).join(', ')}] 在订阅中无任何匹配`);
    }
    if (!mainPick.usedWhitelist && filtered.length === 0) {
      throw new Error(`没有匹配地区 "${_state.regionFilter}" 的节点`);
    }
  } else {
    console.log(`[Proxy] Main channel disabled by config`);
  }
  _state.whitelistMisses = mainPick.misses;

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
  // v2.42.1: rotationIndex 已删；urltest 自做 latency 选最优。currentNode 仅作为 fallback display
  // (实际 active 走 Clash API /proxies/main.now)，取 filtered[0]。
  _state.currentNode = filtered[0]?.tag || '';

  _state.jp.outbounds = jpFiltered;
  _state.jp.nodeTags = jpFiltered.map(o => o.tag);
  _state.jp.currentNode = jpFiltered[0]?.tag || '';
  _state.jp.lastError = '';

  // v2.42 Task 8: refresh 用新 opts 签名（excludeNodes 含 banned）。
  const excludeNodes = Array.from(_state.bannedNodes.keys());
  const sbConfig = buildSingboxConfig({
    mainNodes: mainEnabledByConfig ? filtered : [],
    jpNodes: jpEnabledByConfig ? jpFiltered : [],
    excludeNodes,
  });

  try {
    await singbox.start(sbConfig);
    _state.enabled = mainEnabledByConfig;
    _state.jp.enabled = jpEnabledByConfig;
  } catch (err) {
    if (mainEnabledByConfig && jpEnabledByConfig && /failed to bind port 7891/i.test(err.message || '')) {
      console.log(`[Proxy] 7891 端口被占用，降级关闭 JP 通道: ${err.message}`);
      _state.jp.lastError = `端口 7891 被占用，JP 通道已禁用: ${(err.message || '').slice(0, 120)}`;
      const fallbackConfig = buildSingboxConfig({
        mainNodes: filtered,
        jpNodes: [],
        excludeNodes,
      });
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

  // Hydrate manual blacklist from DB on cold start. (v2.42: bannedNodes 不持久化，
  // 进程重启后 urltest probe 会自然重选节点，无需 hydrate。)
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

  return filtered.length;
}

async function stop() {
  await singbox.stop();
  _state.enabled = false;
  _state.exitIp = '';
}

// ===========================================================================
// v2.42 Task 8: Clash API helpers + ban / unban
// ===========================================================================

/**
 * 查 sing-box 当前 active 节点（urltest 选最优）。channel='main'/'jp'。
 * 失败返回 null。fire-and-forget 友好。
 */
async function getActiveNode(channel = 'main') {
  try {
    return await clashApi.getCurrentSelected(channel);
  } catch (e) {
    console.warn(`[Proxy] getActiveNode(${channel}) failed: ${e.message?.slice(0, 60)}`);
    return null;
  }
}

/**
 * 把节点踢出 urltest 一段时间。重生成 sing-box config + reload，setTimeout 到期自动 unban。
 * 调用方：业务遇 Cloudflare 403 / rate_limited / OpenAI 403 等显式失败时 fire-and-forget。
 */
async function banFromUrltest(node, durationMinutes = 5) {
  if (!node) return;
  if (!_state.bannedNodes) _state.bannedNodes = new Map();
  _state.bannedNodes.set(node, Date.now() + durationMinutes * 60_000);
  await regenerateAndReload();
  setTimeout(async () => {
    if (_state.bannedNodes.delete(node)) {
      try {
        await regenerateAndReload();
        console.log(`[Proxy] Unbanned ${node} (duration expired)`);
      } catch (e) {
        console.warn(`[Proxy] Auto-unban ${node} reload failed: ${e.message?.slice(0, 60)}`);
      }
    }
  }, durationMinutes * 60_000);
}

async function unbanNode(node) {
  if (!node) return;
  _state.bannedNodes?.delete(node);
  await regenerateAndReload();
}

/**
 * 重新生成 sing-box config（excludeNodes = 当前 banned 集合）+ reload。
 */
async function regenerateAndReload() {
  const excludeNodes = Array.from(_state.bannedNodes?.keys() || []);
  const cfg = buildSingboxConfig({
    mainNodes: _state.enabled ? _state.outbounds : [],
    jpNodes: _state.jp.enabled ? _state.jp.outbounds : [],
    excludeNodes,
  });
  await reloadSingbox(cfg);
}

/**
 * reload sing-box —— stop + start。sing-box 启动后 1.5s 给 urltest 自跑首轮 probe 余量。
 */
async function reloadSingbox(newConfig) {
  await singbox.stop();
  await singbox.start(newConfig);
  // 给 urltest 一点时间挑出 active 节点
  await new Promise(r => setTimeout(r, 1500));
}

/**
 * JP fail-fast 节点数 —— chatgpt-checkout.js v2.42+ 用这个判断是否启动 Python。
 * 排除 banned 节点。
 */
function getJpNodeCount() {
  const banned = new Set(Array.from(_state.bannedNodes?.keys() || []));
  return (_state.jp.outbounds || []).filter(n => !banned.has(n.tag)).length;
}

// ===========================================================================
// v2.42 Task 8: 老 API stub —— 避免 cascade 改老 caller (engine / protocol-engine /
// chatgpt-checkout / stripe-verify / proxy 路由)
// ===========================================================================

/**
 * v2.42 stub: rotate() 概念已被 sing-box urltest 内化（间隔 3m 自切到 latency 最低）。
 * 业务老调用点仍 await proxy.rotate()，stub 返回当前 active 节点并打 log。
 */
async function rotate() {
  console.log('[Proxy] rotate() is a no-op since v2.42 (sing-box urltest auto-selects)');
  return _state.currentNode || (await getActiveNode('main')) || '';
}

async function rotateJp() {
  console.log('[Proxy:JP] rotateJp() is a no-op since v2.42 (sing-box urltest auto-selects)');
  return _state.jp.currentNode || (await getActiveNode('jp')) || '';
}

async function switchTo(nodeTag) {
  // v2.42: urltest outbound 不接受 PUT /proxies 切换（selector 才行）。stub 化保留。
  if (!_state.nodeTags.includes(nodeTag)) throw new Error(`节点不存在: ${nodeTag}`);
  console.log(`[Proxy] switchTo(${nodeTag}) is a no-op since v2.42 (use banFromUrltest to exclude unwanted nodes)`);
  return nodeTag;
}

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

// v2.42 Task 4: 业务侧已改读 process.env.HTTPS_PROXY；这两个 stub 仅给少数仍调用的
// 老路径（如 chatgpt-checkout.js fallback / 单测）返 env-based fallback URL。
function getProxyUrl() {
  return process.env.HTTPS_PROXY || (_state.enabled ? `http://127.0.0.1:${HTTP_PORT}` : '');
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
  // v2.42 Task 8 新增 API
  getActiveNode,
  banFromUrltest,
  unbanNode,
  getJpNodeCount,
  regenerateAndReload,
  // 核心 lifecycle
  getState,
  refresh,
  stop,
  buildSingboxConfig,
  pickJpNodes,
  pickMainNodes,
  US_PATTERNS,
  detectExit,
  detectJpExit,
  isBad,
  isJpBad,
  blacklistManually,
  removeFromBlacklist,
  clearBlacklist,
  isProxyNetError,
  FAIL_THRESHOLD,
  // ----- 以下 export 为 v2.42 backwards-compat stub，避免 cascade 改 caller -----
  rotate,
  rotateJp,
  switchTo,
  markBad,
  markJpBad,
  recordBadAttempt,
  recordGoodAttempt,
  getProxyUrl,
  getJpProxyUrl,
  // constants
  SELECTOR_TAG,
  JP_SELECTOR_TAG,
  HTTP_PORT,
  JP_HTTP_PORT,
  CLASH_API_PORT,
};
