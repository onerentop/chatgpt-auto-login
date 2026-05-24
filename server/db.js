const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.db');
let db = null;

async function initDB() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      email TEXT PRIMARY KEY,
      password TEXT NOT NULL DEFAULT '',
      totp_secret TEXT DEFAULT '',
      client_id TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      login_type TEXT DEFAULT 'outlook',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS account_status (
      email TEXT PRIMARY KEY,
      status TEXT DEFAULT 'idle',
      phase TEXT DEFAULT '',
      progress TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      has_auth_file INTEGER DEFAULT 0,
      payment_link TEXT DEFAULT '',
      payment_link_pk TEXT DEFAULT '',
      payment_link_at TEXT DEFAULT '',
      alive_status TEXT DEFAULT 'unknown',
      alive_checked_at TEXT DEFAULT '',
      alive_reason TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS execution_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phase TEXT DEFAULT '',
      message TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now')),
      run_id TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS proxy_blacklist (
      tag        TEXT NOT NULL,
      channel    TEXT NOT NULL,
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL,
      reason     TEXT DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'auto',
      PRIMARY KEY (tag, channel)
    );
    CREATE INDEX IF NOT EXISTS idx_proxy_blacklist_expires ON proxy_blacklist(expires_at);
  `);

  // Wire blacklist persistence module to the live DB
  try { require('./proxy/blacklist').__setDb(db, save); } catch {}

  // Defensive column migration: add payment_link / payment_link_pk / payment_link_at
  // to account_status if absent. SQLite has no ALTER TABLE ADD COLUMN IF NOT
  // EXISTS, so we PRAGMA first. Newly-created tables already have the columns
  // from CREATE TABLE; this branch only fires on upgrades from data.db files
  // created before v2.25.
  const colsResult = db.exec("PRAGMA table_info(account_status)");
  const existingCols = new Set(
    colsResult[0]?.values.map((row) => row[1]) || []
  );
  if (!existingCols.has('payment_link')) {
    db.run("ALTER TABLE account_status ADD COLUMN payment_link TEXT DEFAULT ''");
  }
  if (!existingCols.has('payment_link_pk')) {
    db.run("ALTER TABLE account_status ADD COLUMN payment_link_pk TEXT DEFAULT ''");
  }
  if (!existingCols.has('payment_link_at')) {
    db.run("ALTER TABLE account_status ADD COLUMN payment_link_at TEXT DEFAULT ''");
  }
  if (!existingCols.has('alive_status')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_status TEXT DEFAULT 'unknown'");
  }
  if (!existingCols.has('alive_checked_at')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_checked_at TEXT DEFAULT ''");
  }
  if (!existingCols.has('alive_reason')) {
    db.run("ALTER TABLE account_status ADD COLUMN alive_reason TEXT DEFAULT ''");
  }

  // One-time migration of old status values
  const hasOld = db.exec("SELECT COUNT(*) FROM account_status WHERE status IN ('needs_phone','oauth_failed','success','already_plus','failed','pending')");
  if (hasOld[0]?.values?.[0]?.[0] > 0) {
    db.run(`UPDATE account_status SET status = 'plus_no_rt' WHERE status IN ('needs_phone', 'oauth_failed', 'success')`);
    db.run(`UPDATE account_status SET status = 'plus_no_rt' WHERE status = 'already_plus'`);
    db.run(`UPDATE account_status SET status = 'error' WHERE status = 'failed'`);
    db.run(`UPDATE account_status SET status = 'idle' WHERE status = 'pending'`);
  }

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function detectLoginType(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  if (domain === 'gmail.com') return 'google';
  return 'other';
}

const accountsDB = {
  list() { return mapRows(db.exec("SELECT * FROM accounts ORDER BY rowid")); },
  get(email) {
    const stmt = db.prepare("SELECT * FROM accounts WHERE email = ?");
    stmt.bind([email]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  },
  add(a) { db.run("INSERT OR IGNORE INTO accounts (email, password, totp_secret, client_id, refresh_token, login_type) VALUES (?,?,?,?,?,?)", [a.email, a.password, a.totp_secret||'', a.client_id||'', a.refresh_token||'', detectLoginType(a.email)]); save(); },
  update(email, a) { db.run("UPDATE accounts SET password=?, totp_secret=?, client_id=?, refresh_token=?, login_type=? WHERE email=?", [a.password||'', a.totp_secret||'', a.client_id||'', a.refresh_token||'', detectLoginType(a.email||email), email]); save(); },
  delete(email) { db.run("DELETE FROM accounts WHERE email=?", [email]); save(); },
  bulkAdd(accounts) {
    for (const a of accounts) {
      db.run("INSERT OR IGNORE INTO accounts (email, password, totp_secret, client_id, refresh_token, login_type) VALUES (?,?,?,?,?,?)", [a.email, a.password, a.totp_secret||'', a.client_id||'', a.refresh_token||'', detectLoginType(a.email)]);
    }
    save();
  },
};

const statusDB = {
  get(email) {
    const stmt = db.prepare("SELECT * FROM account_status WHERE email=?");
    stmt.bind([email]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  },
  list() { return mapRows(db.exec("SELECT * FROM account_status")); },
  set(email, data) {
    // Merge with existing row so callers can update just a subset of fields.
    // Critical invariant: NOT passing `paymentLink` must keep the existing
    // DB value — otherwise every transient emitStatus call (which doesn't
    // know about cached links) would silently wipe the cache.
    const existing = this.get(email) || {};
    const incoming = data || {};
    const { status, phase, progress, reason, has_auth_file } = {
      status: 'idle', phase: '', progress: '', reason: '', has_auth_file: 0,
      ...incoming,
    };
    // camelCase → snake_case for the new payment_link* fields. Only override
    // when the caller explicitly passed the key.
    const payment_link = 'paymentLink' in incoming
      ? (incoming.paymentLink || '')
      : (existing.payment_link || '');
    const payment_link_pk = 'paymentLinkPk' in incoming
      ? (incoming.paymentLinkPk || '')
      : (existing.payment_link_pk || '');
    const payment_link_at = ('paymentLink' in incoming && incoming.paymentLink)
      ? new Date().toISOString()
      : (existing.payment_link_at || '');
    const existingAlive = {
      alive_status: existing.alive_status || 'unknown',
      alive_checked_at: existing.alive_checked_at || '',
      alive_reason: existing.alive_reason || '',
    };
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress || '', reason || '', has_auth_file ? 1 : 0,
       payment_link, payment_link_pk, payment_link_at,
       existingAlive.alive_status, existingAlive.alive_checked_at, existingAlive.alive_reason]
    );
    save();
  },
  reset(email) { db.run("UPDATE account_status SET status='idle', phase='', progress='', reason='' WHERE email=?", [email]); save(); },
  resetAll() { db.run("UPDATE account_status SET status='idle', phase='', progress='', reason=''"); save(); },
  resetRunning() { db.run("UPDATE account_status SET status='idle', phase='', reason='Stopped' WHERE status='running'"); save(); },
  clearPaymentLink(email) {
    db.run("UPDATE account_status SET payment_link='', payment_link_pk='', payment_link_at='' WHERE email=?", [email]);
    save();
  },
  setAlive(email, data) {
    const existing = this.get(email) || {};
    const incoming = data || {};
    const alive_status = incoming.alive_status || existing.alive_status || 'unknown';
    const alive_reason = ('alive_reason' in incoming) ? (incoming.alive_reason || '') : (existing.alive_reason || '');
    const alive_checked_at = new Date().toISOString();
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email,
       existing.status || 'idle', existing.phase || '', existing.progress || '', existing.reason || '',
       existing.has_auth_file ? 1 : 0,
       existing.payment_link || '', existing.payment_link_pk || '', existing.payment_link_at || '',
       alive_status, alive_checked_at, alive_reason]
    );
    save();
  },
  clearAlive(email) {
    db.run("UPDATE account_status SET alive_status='unknown', alive_checked_at='', alive_reason='' WHERE email=?", [email]);
    save();
  },
};

let _logWriteCount = 0;
const logsDB = {
  add(email, phase, message, timestamp, runId) {
    db.run("INSERT INTO execution_logs (email, phase, message, timestamp, run_id) VALUES (?,?,?,?,?)", [email, phase, message, timestamp, runId||'']);
    if (++_logWriteCount % 10 === 0) save();
  },
  getByEmail(email) {
    const results = [];
    const stmt = db.prepare("SELECT * FROM execution_logs WHERE email=? ORDER BY id DESC LIMIT 200");
    stmt.bind([email]);
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results.reverse();
  },
  flush() { save(); },
  cleanup() { db.run("DELETE FROM execution_logs WHERE id NOT IN (SELECT id FROM execution_logs ORDER BY id DESC LIMIT 5000)"); save(); },
};

// Map a sql.js exec() result to an array of objects using column names.
// Robust to schema changes (column reorder / new columns).
function mapRows(result) {
  if (!result || !result[0]) return [];
  const cols = result[0].columns;
  return result[0].values.map((row) => {
    const out = {};
    for (let i = 0; i < cols.length; i++) out[cols[i]] = row[i];
    return out;
  });
}

module.exports = { initDB, accountsDB, statusDB, logsDB, save };
