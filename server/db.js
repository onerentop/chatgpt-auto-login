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
  `);

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
  list() { return db.exec("SELECT * FROM accounts ORDER BY rowid")[0]?.values.map(rowToAccount) || []; },
  get(email) { const stmt = db.prepare("SELECT * FROM accounts WHERE email = ?"); stmt.bind([email]); const row = stmt.step() ? stmt.get() : null; stmt.free(); return row ? rowToAccount(row) : null; },
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
  get(email) { const stmt = db.prepare("SELECT * FROM account_status WHERE email=?"); stmt.bind([email]); const row = stmt.step() ? stmt.get() : null; stmt.free(); return row ? rowToStatus(row) : null; },
  list() { return db.exec("SELECT * FROM account_status")[0]?.values.map(rowToStatus) || []; },
  set(email, data) {
    const { status, phase, progress, reason, has_auth_file } = { status:'idle', phase:'', progress:'', reason:'', has_auth_file:0, ...data };
    db.run("INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress||'', reason||'', has_auth_file?1:0]);
    save();
  },
  reset(email) { db.run("UPDATE account_status SET status='idle', phase='', progress='', reason='' WHERE email=?", [email]); save(); },
  resetAll() { db.run("UPDATE account_status SET status='idle', phase='', progress='', reason=''"); save(); },
  resetRunning() { db.run("UPDATE account_status SET status='idle', phase='', reason='Stopped' WHERE status='running'"); save(); },
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
    while (stmt.step()) results.push(rowToLog(stmt.get()));
    stmt.free();
    return results.reverse();
  },
  flush() { save(); },
  cleanup() { db.run("DELETE FROM execution_logs WHERE id NOT IN (SELECT id FROM execution_logs ORDER BY id DESC LIMIT 5000)"); save(); },
};

function rowToAccount(v) {
  return { email: v[0], password: v[1], totp_secret: v[2], client_id: v[3], refresh_token: v[4], login_type: v[5], created_at: v[6] };
}
function rowToStatus(v) {
  return { email: v[0], status: v[1], phase: v[2], progress: v[3], reason: v[4], has_auth_file: v[5], updated_at: v[6] };
}
function rowToLog(v) {
  return { id: v[0], email: v[1], phase: v[2], message: v[3], timestamp: v[4], run_id: v[5] };
}

module.exports = { initDB, accountsDB, statusDB, logsDB, save };
