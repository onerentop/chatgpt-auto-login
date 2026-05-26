// Spawn checkout_link.py to fetch a pay.openai.com link via Python curl_cffi
// (Chrome JA3 fingerprint). undici was Cloudflare-blocked on this endpoint;
// curl_cffi passes. Same spawn protocol as protocol-engine.js:runProtocolRegister.
//
// v2.42 Task 6: 系统级透明代理设计下，本模块是「唯一」保留显式 proxy 例外的
// 业务路径 —— JP 通道走独立 7891 端口（sing-box 不支持 path_regex 路由，无法
// 通过 setGlobalDispatcher 区分目的 host 选 outbound）。
//
// - Node 侧（如果将来有 fetch 调用）：用 undici.ProxyAgent 经 dispatcher 选项注入。
// - Python 子进程：spawn 时显式 env override HTTPS_PROXY=jp:7891，覆盖 global.js
//   注入的 7890（main / US）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ProxyAgent } = require('undici');
const proxyMgr = require('./proxy');
// v2.42 Task 11: fetchWithRetry / reportBadNode helper（spec §4.2）。
// 本模块当前没有直接 fetch(...) 调用（OpenAI checkout 走 spawn checkout_link.py
// Python 子进程），所以 fetchWithRetry 仅作为「未来如果新增 Node 侧 fetch」时
// 的预留 import。Python 子进程的风控检测在 checkout_link.py 内部自行处理。
// eslint-disable-next-line no-unused-vars
const { fetchWithRetry, reportBadNode } = require('./proxy/with-retry');

const SCRIPT = path.join(__dirname, '..', 'checkout_link.py');

// ---- JP dispatcher (lazy) -------------------------------------------------
let _jpDispatcher = null;
let _jpPort = 7891;
let _jpPortLoaded = false;

function _ensureJpPort() {
  if (_jpPortLoaded) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
    _jpPort = cfg.proxy?.jpPort || 7891;
  } catch { /* keep default */ }
  _jpPortLoaded = true;
}

function getJpDispatcher() {
  if (_jpDispatcher) return _jpDispatcher;
  _ensureJpPort();
  _jpDispatcher = new ProxyAgent(`http://127.0.0.1:${_jpPort}`);
  return _jpDispatcher;
}

function getJpProxyUrlForSpawn() {
  _ensureJpPort();
  return `http://127.0.0.1:${_jpPort}`;
}

// v2.19 fail-fast: JP 池为空时不能 silently 走 US 出口（会拿到 $20 link 浪费
// 整条 PayPal pipeline）。必须立刻 resolve {noJpProxy:true} 让 engine 把账号
// 标 no_jp_proxy。
//
// TODO(v2.42 Task 8): proxyMgr.getJpNodeCount() 在 Task 8 才加。当前 fallback
// 用既有的 getJpProxyUrl() —— 它在 _state.jp.enabled === false（JP 池空 / 被
// disable）时返回空字符串，足以触发 fail-fast。
function _jpAvailable() {
  if (typeof proxyMgr.getJpNodeCount === 'function') {
    return proxyMgr.getJpNodeCount() > 0;
  }
  // Fallback: getJpProxyUrl() 返回 '' 即 JP 池不可用
  try {
    return Boolean(proxyMgr.getJpProxyUrl && proxyMgr.getJpProxyUrl());
  } catch {
    return false;
  }
}

function fetchCheckoutLink(accessToken, opts = {}) {
  return new Promise((resolve) => {
    if (!_jpAvailable()) {
      resolve({
        link: '',
        title: '',
        raw: 'NO_JP_PROXY: JP checkout channel unavailable',
        pk: '',
        noJpProxy: true,
      });
      return;
    }
    const currentJpNode = proxyMgr.getState().jp?.currentNode || '';

    const input = JSON.stringify({
      access_token: accessToken,
      country: opts.country || 'US',
      currency: opts.currency || 'USD',
      promo_id: opts.promoCampaignId || 'plus-1-month-free',
      // v2.42 Task 6: 不再通过 stdin 传 proxy —— checkout_link.py 通过 env 读取，
      // 而我们这里 spawn 时显式 override HTTPS_PROXY 到 JP 端口（覆盖 global.js
      // 注入的 main / 7890）。
    });

    const jpProxyUrl = getJpProxyUrlForSpawn();
    const py = spawn('py', ['-3', SCRIPT], {
      env: {
        ...process.env,
        HTTPS_PROXY: jpProxyUrl,
        HTTP_PROXY: jpProxyUrl,
        NO_PROXY: '127.0.0.1,localhost',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      if (currentJpNode) {
        try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_timeout'); } catch {}
      }
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)', pk: '' });
    }, 60000);

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // spawn-error means local Python binary issue (missing, permission, ENOMEM).
      // Not a JP-node problem — do NOT markJpBad, that would poison the node pool.
      resolve({ link: '', title: '', raw: `ERROR: spawn failed: ${e.message?.slice(0, 200)}`, pk: '' });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        const link = r.link || '';
        const raw = r.raw || r.error || '';
        if (currentJpNode) {
          if (link === '') {
            try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_empty_link'); } catch {}
          } else {
            // G4: 拿到非空 link 算成功
            try { proxyMgr.recordGoodAttempt(currentJpNode, 'jp'); } catch {}
          }
        }
        resolve({ link, title: '', raw, pk: r.pk || '' });
      } catch {
        if (currentJpNode) {
          try { proxyMgr.recordBadAttempt(currentJpNode, 'jp', 'checkout_parse_failed'); } catch {}
        }
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}`, pk: '' });
      }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

module.exports = { fetchCheckoutLink, getJpDispatcher, getJpProxyUrlForSpawn };
