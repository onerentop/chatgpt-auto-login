// 强制走 7891 JP-KDDI 代理拿 osxti6295 的 link（绕过 proxyMgr）
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const TOKEN = fs.readFileSync('token-osxti6295.txt', 'utf8').trim();
const JP_PROXY = 'http://127.0.0.1:7891';

function fetchCheckoutForced(token, country, currency, proxy) {
  return new Promise((resolve) => {
    const py = spawn('py', ['-3', 'checkout_link.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { py.kill(); resolve({ link: '', raw: 'timeout' }); }, 60000);
    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('close', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ link: '', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify({
      access_token: token,
      country, currency,
      promo_id: 'plus-1-month-free',
      proxy,
    }));
    py.stdin.end();
  });
}

(async () => {
  console.log('Token len=', TOKEN.length);
  console.log(`Forcing proxy: ${JP_PROXY} (7891 JP-KDDI)`);
  console.log('Body: country=US, currency=USD, promo=plus-1-month-free\n');

  const r = await fetchCheckoutForced(TOKEN, 'US', 'USD', JP_PROXY);
  if (!r.link) {
    console.error('❌ no link:', (r.raw || '').slice(0, 300));
    process.exit(1);
  }
  console.log('\n✅ LINK (forced 7891 JP):');
  console.log(r.link);
})();
