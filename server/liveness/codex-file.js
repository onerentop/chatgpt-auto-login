// server/liveness/codex-file.js
// Read / write cpa-auth/codex-<email>.json without ever touching sub2api-*.json.

const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.LIVENESS_AUTH_DIR || path.join(__dirname, '..', '..', 'cpa-auth');

function authDir() { return AUTH_DIR; }

function sanitize(email) {
  return String(email || '').replace(/@/g, '-at-').replace(/\./g, '-');
}

function codexPath(email) {
  return path.join(AUTH_DIR, `codex-${sanitize(email)}.json`);
}

function decodeAccountIdFromJwt(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    const claim = payload['https://api.openai.com/auth'] || {};
    return claim.chatgpt_account_id || '';
  } catch { return ''; }
}

function nowCstIso() {
  const t = new Date(Date.now() + 8 * 3600_000);
  return t.toISOString().replace('Z', '+08:00');
}

async function read(email) {
  const p = codexPath(email);
  try {
    const raw = await fs.promises.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function write(email, { accessToken, expiresAtIso, accountId }) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const resolvedAccountId = decodeAccountIdFromJwt(accessToken) || accountId || '';
  const payload = {
    access_token: accessToken,
    account_id: resolvedAccountId,
    email,
    expired: expiresAtIso || '',
    id_token: '',
    last_refresh: nowCstIso(),
    refresh_token: '',
    type: 'codex',
  };
  await fs.promises.writeFile(codexPath(email), JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { authDir, codexPath, read, write, decodeAccountIdFromJwt };
