// Spawn pkce_oauth.py to perform PKCE OAuth code flow via main proxy.
// Returns refresh_token compatible with existing saveCPAAuthFile() shape.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'pkce_oauth.py');
const TIMEOUT_MS = 25000;

// OAuth client constants. Defaults from utils.js:130-134; can be overridden via env vars.
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:1455/auth/callback';
const OAUTH_SCOPE = process.env.OAUTH_SCOPE || 'openid email profile offline_access';

function extractAuthCode(url) {
  if (typeof url !== 'string' || !url) return null;
  const m = url.match(/[?&#]code=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function parsePkceResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'pkce_unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return {
      ok: true,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      id_token: data.id_token,
    };
  }
  return { ok: false, reason: parsed.reason || 'pkce_error', raw: parsed.body };
}

function fetchPkceTokensProtocol(accessToken, account) {
  return new Promise((resolve) => {
    if (!OAUTH_CLIENT_ID || !OAUTH_REDIRECT_URI) {
      resolve({ ok: false, reason: 'pkce_missing_oauth_config' });
      return;
    }
    const input = {
      access_token: accessToken,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPE,
      proxy: proxyMgr.getProxyUrl() || '',
    };

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'pkce_timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parsePkceResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'pkce_unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { extractAuthCode, parsePkceResponse, fetchPkceTokensProtocol };
