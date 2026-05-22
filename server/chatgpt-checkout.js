// Spawn checkout_link.py to fetch a pay.openai.com link via Python curl_cffi
// (Chrome JA3 fingerprint). undici was Cloudflare-blocked on this endpoint;
// curl_cffi passes. Same spawn protocol as protocol-engine.js:runProtocolRegister.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'checkout_link.py');

function fetchCheckoutLink(accessToken, opts = {}) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; py.kill();
      resolve({ link: '', title: '', raw: 'ERROR: Python timeout (60s)' });
    }, 60000);

    const input = JSON.stringify({
      access_token: accessToken,
      country: opts.country || 'JP',
      currency: opts.currency || 'JPY',
      promo_id: opts.promoCampaignId || 'plus-1-month-free',
      proxy: proxyMgr.getProxyUrl(),
    });

    let stdout = '';
    let stderr = '';
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
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        const r = JSON.parse(stdout);
        resolve({ link: r.link || '', title: '', raw: r.raw || r.error || '' });
      } catch {
        resolve({ link: '', title: '', raw: `ERROR: ${stderr.slice(-200) || 'Python parse failed'}` });
      }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

module.exports = { fetchCheckoutLink };
