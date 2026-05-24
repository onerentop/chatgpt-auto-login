const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-file-test-'));

process.env.LIVENESS_AUTH_DIR = tmpDir;
const codexFile = require('../codex-file');

function jwtWithClaims(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('codexPath sanitizes email (@ -> -at-, . -> -)', () => {
  assert.strictEqual(
    path.basename(codexFile.codexPath('alice.smith@outlook.com')),
    'codex-alice-smith-at-outlook-com.json'
  );
});

test('write creates new json with required keys', async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const at = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-abc' } });
  await codexFile.write('alice@outlook.com', { accessToken: at, expiresAtIso: '2026-06-07T12:00:00+08:00' });
  const j = await codexFile.read('alice@outlook.com');
  assert.strictEqual(j.email, 'alice@outlook.com');
  assert.strictEqual(j.type, 'codex');
  assert.strictEqual(j.account_id, 'acc-abc');
  assert.strictEqual(j.access_token, at);
  assert.strictEqual(j.expired, '2026-06-07T12:00:00+08:00');
  assert.strictEqual(j.refresh_token, '', 'refresh_token blank by design');
  assert.strictEqual(j.id_token, '', 'id_token blank by design');
  assert.ok(j.last_refresh && j.last_refresh.length > 0);
});

test('write overwrites existing file (refreshes last_refresh)', async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const at1 = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } });
  const at2 = jwtWithClaims({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-2' } });
  await codexFile.write('bob@x.com', { accessToken: at1, expiresAtIso: 'iso-1' });
  const last1 = (await codexFile.read('bob@x.com')).last_refresh;
  await new Promise(r => setTimeout(r, 10));
  await codexFile.write('bob@x.com', { accessToken: at2, expiresAtIso: 'iso-2' });
  const after = await codexFile.read('bob@x.com');
  assert.strictEqual(after.access_token, at2);
  assert.strictEqual(after.account_id, 'acc-2');
  assert.strictEqual(after.expired, 'iso-2');
  assert.notStrictEqual(after.last_refresh, last1, 'last_refresh updated');
});

test('write extracts account_id from chatgpt_account_id claim', async () => {
  const at = jwtWithClaims({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-claim-id' },
  });
  await codexFile.write('claim@x.com', { accessToken: at, expiresAtIso: 'x' });
  assert.strictEqual((await codexFile.read('claim@x.com')).account_id, 'acc-claim-id');
});

test('write falls back to accountId override when JWT missing claim', async () => {
  const at = jwtWithClaims({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await codexFile.write('fall@x.com', { accessToken: at, expiresAtIso: 'x', accountId: 'override-id' });
  assert.strictEqual((await codexFile.read('fall@x.com')).account_id, 'override-id');
});

test('write does NOT touch sub2api file', async () => {
  const at = jwtWithClaims({ exp: Math.floor(Date.now() / 1000) + 3600 });
  fs.writeFileSync(path.join(tmpDir, 'sub2api-keep-at-x-com.json'), '{"marker":"keep"}');
  await codexFile.write('keep@x.com', { accessToken: at, expiresAtIso: 'x' });
  const sub = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sub2api-keep-at-x-com.json'), 'utf-8'));
  assert.strictEqual(sub.marker, 'keep', 'sub2api file untouched');
});

test('read returns null when file missing', async () => {
  const r = await codexFile.read('nonexistent@x.com');
  assert.strictEqual(r, null);
});
