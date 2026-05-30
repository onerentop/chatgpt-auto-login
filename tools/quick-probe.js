#!/usr/bin/env node
// Quick probe: start sing-box JP proxy → run IDR checkout probe → stop
const { refresh, stop, getState } = require('../server/proxy/index');
const { spawn } = require('child_process');

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node tools/quick-probe.js <access_token>'); process.exit(1); }

(async () => {
  try {
    console.log('[probe] Starting sing-box proxy...');
    await refresh();
    const st = getState();
    console.log(`[probe] Proxy ready: main=${st.enabled} jp=${st.jp?.enabled}`);
    if (!st.jp?.enabled) {
      console.error('[probe] JP channel not available!');
      await stop();
      process.exit(1);
    }

    console.log('[probe] Running IDR checkout probe via JP proxy (7891)...');
    const child = spawn('py', ['-3', 'tools/probe_idr_checkout.py'], {
      cwd: process.cwd(),
      env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:7891', HTTP_PROXY: 'http://127.0.0.1:7891' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(JSON.stringify({ access_token: TOKEN }));
    child.stdin.end();

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { err += d; process.stderr.write(d); });

    child.on('exit', async (code) => {
      console.log(`\n[probe] Python exit code: ${code}`);
      if (err) console.log(`[probe] stderr: ${err}`);
      await stop();
      process.exit(code || 0);
    });

    setTimeout(async () => {
      console.log('[probe] Timeout (60s)');
      child.kill();
      await stop();
      process.exit(1);
    }, 60000);
  } catch (e) {
    console.error(`[probe] Error: ${e.message}`);
    try { await stop(); } catch {}
    process.exit(1);
  }
})();
