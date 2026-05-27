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
      last_access_token TEXT DEFAULT '',
      last_session_json TEXT DEFAULT '',
      last_access_token_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      proxy_node TEXT DEFAULT '',
      exit_ip TEXT DEFAULT ''
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
    CREATE TABLE IF NOT EXISTS liveness_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      email     TEXT DEFAULT '',
      level     TEXT DEFAULT 'info',
      message   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_liveness_logs_id_desc ON liveness_logs(id DESC);

    -- v2.37.0 phone pool
    CREATE TABLE IF NOT EXISTS phone_pool (
      phone          TEXT PRIMARY KEY,
      sms_api_url    TEXT NOT NULL,
      bindings_used  INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS phone_bindings (
      phone    TEXT NOT NULL,
      email    TEXT NOT NULL,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (phone, email)
    );
    CREATE INDEX IF NOT EXISTS idx_phone_bindings_phone ON phone_bindings(phone);
    CREATE INDEX IF NOT EXISTS idx_phone_bindings_email ON phone_bindings(email);
    -- v2.45.0 smscloud phone cache
    CREATE TABLE IF NOT EXISTS smscloud_phone_cache (
      order_no       TEXT PRIMARY KEY,
      phone          TEXT NOT NULL,
      api_key        TEXT NOT NULL,
      base_url       TEXT NOT NULL,
      taken_at_ms    INTEGER NOT NULL,
      bindings_used  INTEGER NOT NULL DEFAULT 0,
      status         TEXT NOT NULL DEFAULT 'active',
      country_code   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_phone ON smscloud_phone_cache(phone);
    CREATE INDEX IF NOT EXISTS idx_smscloud_phone_cache_active ON smscloud_phone_cache(status, taken_at_ms);

    -- v2.50.0 oapi CDK 池
    CREATE TABLE IF NOT EXISTS oapi_cdk_pool (
      cdk           TEXT PRIMARY KEY,
      phone         TEXT,
      base_url      TEXT NOT NULL,
      taken_at_ms   INTEGER,
      bindings_used INTEGER NOT NULL DEFAULT 0,
      remaining     INTEGER,
      status        TEXT NOT NULL DEFAULT 'available',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_oapi_cdk_pool_status ON oapi_cdk_pool(status);
    CREATE INDEX IF NOT EXISTS idx_oapi_cdk_pool_phone ON oapi_cdk_pool(phone);
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
  if (!existingCols.has('last_access_token')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_access_token TEXT DEFAULT ''");
  }
  if (!existingCols.has('last_session_json')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_session_json TEXT DEFAULT ''");
  }
  if (!existingCols.has('last_access_token_at')) {
    db.run("ALTER TABLE account_status ADD COLUMN last_access_token_at TEXT DEFAULT ''");
  }
  if (!existingCols.has('proxy_node')) {
    db.run("ALTER TABLE account_status ADD COLUMN proxy_node TEXT DEFAULT ''");
  }
  if (!existingCols.has('exit_ip')) {
    db.run("ALTER TABLE account_status ADD COLUMN exit_ip TEXT DEFAULT ''");
  }

  // v2.47.0: smscloud_phone_cache.country_code — fraud-retry 跨 country fallback
  const smscloudCacheCols = db.exec("PRAGMA table_info(smscloud_phone_cache)");
  const smscloudCacheColsSet = new Set(smscloudCacheCols[0]?.values.map((row) => row[1]) || []);
  if (!smscloudCacheColsSet.has('country_code')) {
    db.run("ALTER TABLE smscloud_phone_cache ADD COLUMN country_code INTEGER");
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

// Serialize all on-disk writes through this promise chain. db.export() still
// runs synchronously at the call site (capturing the current in-memory state),
// but the file write/rename is awaited inside the queue so concurrent save()
// calls cannot interleave half-written buffers.
let _saveQueue = Promise.resolve();

async function _actualSave(buf) {
  const tmp = DB_PATH + '.tmp';
  await fs.promises.writeFile(tmp, buf);
  // fs.promises.rename is atomic within the same filesystem on Windows/POSIX.
  await fs.promises.rename(tmp, DB_PATH);
}

function save() {
  if (!db) return _saveQueue;
  const buf = Buffer.from(db.export());
  _saveQueue = _saveQueue.then(() => _actualSave(buf), () => _actualSave(buf));
  return _saveQueue;
}

// Tests / shutdown can await this to make sure all pending writes hit disk.
save.flush = function flush() { return _saveQueue; };

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
  /**
   * Delete multiple accounts in one transactional sweep — single save() at
   * the end so N=200 deletes take one disk flush instead of 200. Returns
   * { deleted: emails[], notFound: emails[] } so the caller can report
   * partial results. Idempotent on missing rows.
   */
  bulkDelete(emails) {
    if (!Array.isArray(emails)) return { deleted: [], notFound: [] };
    const deleted = [];
    const notFound = [];
    const stmtCheck = db.prepare("SELECT email FROM accounts WHERE email = ?");
    const stmtDelete = db.prepare("DELETE FROM accounts WHERE email = ?");
    try {
      for (const email of emails) {
        if (typeof email !== 'string' || !email.trim()) continue;
        stmtCheck.bind([email]);
        const exists = stmtCheck.step();
        stmtCheck.reset();
        if (!exists) { notFound.push(email); continue; }
        stmtDelete.bind([email]);
        stmtDelete.step();
        stmtDelete.reset();
        deleted.push(email);
      }
    } finally {
      stmtCheck.free();
      stmtDelete.free();
    }
    if (deleted.length > 0) save();
    return { deleted, notFound };
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
    const last_access_token = 'accessToken' in incoming
      ? (incoming.accessToken || '')
      : (existing.last_access_token || '');
    const last_session_json = 'sessionJson' in incoming
      ? (incoming.sessionJson || '')
      : (existing.last_session_json || '');
    const last_access_token_at = ('accessToken' in incoming && incoming.accessToken)
      ? new Date().toISOString()
      : (existing.last_access_token_at || '');
    // proxy_node / exit_ip — only override when caller explicitly passed the key
    const proxy_node = 'proxyNode' in incoming
      ? (incoming.proxyNode || '')
      : (existing.proxy_node || '');
    const exit_ip = 'exitIp' in incoming
      ? (incoming.exitIp || '')
      : (existing.exit_ip || '');
    const existingAlive = {
      alive_status: existing.alive_status || 'unknown',
      alive_checked_at: existing.alive_checked_at || '',
      alive_reason: existing.alive_reason || '',
    };
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, last_access_token, last_session_json, last_access_token_at, proxy_node, exit_ip, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email, status, phase, progress || '', reason || '', has_auth_file ? 1 : 0,
       payment_link, payment_link_pk, payment_link_at,
       existingAlive.alive_status, existingAlive.alive_checked_at, existingAlive.alive_reason,
       last_access_token, last_session_json, last_access_token_at,
       proxy_node, exit_ip]
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
    const alive_status = ('alive_status' in incoming)
      ? (incoming.alive_status || 'unknown')
      : (existing.alive_status || 'unknown');
    const alive_reason = ('alive_reason' in incoming) ? (incoming.alive_reason || '') : (existing.alive_reason || '');
    const alive_checked_at = new Date().toISOString();
    db.run(
      "INSERT OR REPLACE INTO account_status (email, status, phase, progress, reason, has_auth_file, payment_link, payment_link_pk, payment_link_at, alive_status, alive_checked_at, alive_reason, last_access_token, last_session_json, last_access_token_at, proxy_node, exit_ip, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))",
      [email,
       existing.status || 'idle', existing.phase || '', existing.progress || '', existing.reason || '',
       existing.has_auth_file ? 1 : 0,
       existing.payment_link || '', existing.payment_link_pk || '', existing.payment_link_at || '',
       alive_status, alive_checked_at, alive_reason,
       existing.last_access_token || '', existing.last_session_json || '', existing.last_access_token_at || '',
       existing.proxy_node || '', existing.exit_ip || '']
    );
    save();
  },
  clearAlive(email) {
    db.run("UPDATE account_status SET alive_status='unknown', alive_checked_at='', alive_reason='' WHERE email=?", [email]);
    save();
  },
  clearAccessToken(email) {
    db.run("UPDATE account_status SET last_access_token='', last_session_json='', last_access_token_at='' WHERE email=?", [email]);
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

let _livenessLogWriteCount = 0;
const LIVENESS_LOGS_MAX = 5000;
const livenessLogsDB = {
  add({ email, level, message, timestamp }) {
    db.run("INSERT INTO liveness_logs (timestamp, email, level, message) VALUES (?,?,?,?)",
      [timestamp || new Date().toISOString(), email || '', level || 'info', message || '']);
    if (++_livenessLogWriteCount % 20 === 0) {
      db.run(`DELETE FROM liveness_logs WHERE id NOT IN (SELECT id FROM liveness_logs ORDER BY id DESC LIMIT ${LIVENESS_LOGS_MAX})`);
      save();
    } else if (_livenessLogWriteCount % 5 === 0) {
      save();  // periodic disk flush — every 5 entries
    }
  },
  recent(limit = 200) {
    const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const results = [];
    const stmt = db.prepare(`SELECT timestamp, email, level, message FROM liveness_logs ORDER BY id DESC LIMIT ${lim}`);
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results.reverse();  // chronological order for UI
  },
  clear() {
    db.run("DELETE FROM liveness_logs");
    save();
  },
};

// v2.42 Task 9: proxyDB —— bad-node API 路由的薄包装层。
// 复用既有 proxy_blacklist schema (tag, channel, expires_at, reason, source)。
// 与 server/proxy/blacklist.js 同一张表，但提供 untilMs 直接传值的 API（routes 友好），
// 而 blacklist 模块 add(ttlMs) 是从 now 起算的 TTL，语义不同。
const proxyDB = {
  /**
   * 直接写入 expires_at（绝对时间戳）。channel 默认 'main'（bad-node API 主要给主通道用）。
   */
  banNode(tag, reason, untilMs, channel = 'main') {
    if (!db) return;
    db.run(
      "INSERT OR REPLACE INTO proxy_blacklist (tag, channel, expires_at, reason, source, added_at) VALUES (?,?,?,?,?,datetime('now'))",
      [tag, channel, untilMs, String(reason || '').slice(0, 60), 'auto'],
    );
    save();
  },
  /**
   * 列出当前 channel 下未过期的 banned 节点。
   */
  listBanned(channel = 'main') {
    if (!db) return [];
    const stmt = db.prepare('SELECT tag, reason, expires_at FROM proxy_blacklist WHERE channel=? AND expires_at > ?');
    stmt.bind([channel, Date.now()]);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  },
  unbanNode(tag, channel = 'main') {
    if (!db) return;
    db.run('DELETE FROM proxy_blacklist WHERE tag=? AND channel=?', [tag, channel]);
    save();
  },
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

module.exports = { initDB, accountsDB, statusDB, logsDB, livenessLogsDB, proxyDB, save, getRawDb: () => db };
