// Spawn checkout_link.py to fetch a pay.openai.com link via Python curl_cffi
// (Chrome JA3 fingerprint). undici was Cloudflare-blocked on this endpoint;
// curl_cffi passes. Same spawn protocol as protocol-engine.js:runProtocolRegister.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'checkout_link.py');

function fetchCheckoutLink(accessToken, opts = {}) {
  return new Promise((resolve) => {
    const jpUrl = proxyMgr.getJpProxyUrl();
    if (!jpUrl) {
      resolve({
        link: '',
        title: '',
        raw: 'NO_JP_PROXY: JP checkout channel unavailable',
        pk: '',
        noJpProxy: true,
      });
      return;
    }
    const proxy = jpUrl;
    const currentJpNode = proxyMgr.getState().jp?.currentNode || '';

    const input = JSON.stringify({
      access_token: accessToken,
      country: opts.country || 'US',
      currency: opts.currency || 'USD',
      promo_id: opts.promoCampaignId || 'plus-1-month-free',
      proxy,
    });

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
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

module.exports = { fetchCheckoutLink };
