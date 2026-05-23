// Persistence layer for proxy blacklist. Style mirrors server/db.js (accountsDB / statusDB).
// In tests, __setDb() injects an in-memory sql.js database; production wires server/db.js.

let _db = null;
let _save = null;

function __setDb(db, saveFn) {
  _db = db;
  _save = saveFn || (() => {});
}

function add(tag, channel, ttlMs, reason = '', source = 'auto') {
  if (!_db) throw new Error('blacklist: db not initialized');
  const expiresAt = Date.now() + ttlMs;
  _db.run(
    'INSERT OR REPLACE INTO proxy_blacklist (tag, channel, expires_at, reason, source, added_at) VALUES (?,?,?,?,?,datetime(\'now\'))',
    [tag, channel, expiresAt, String(reason).slice(0, 60), source],
  );
  _save();
}

function remove(tag, channel) {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE tag=? AND channel=?', [tag, channel]);
  _save();
}

function removeAll(channel) {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE channel=?', [channel]);
  _save();
}

function loadAll(channel) {
  if (!_db) return [];
  const now = Date.now();
  const stmt = _db.prepare('SELECT tag, expires_at, reason, source FROM proxy_blacklist WHERE channel=? AND expires_at > ?');
  stmt.bind([channel, now]);
  const out = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    out.push({ tag: row.tag, expiresAt: row.expires_at, reason: row.reason || '', source: row.source || 'auto' });
  }
  stmt.free();
  return out;
}

function pruneExpired() {
  if (!_db) return;
  _db.run('DELETE FROM proxy_blacklist WHERE expires_at <= ?', [Date.now()]);
  _save();
}

module.exports = { __setDb, add, remove, removeAll, loadAll, pruneExpired };
