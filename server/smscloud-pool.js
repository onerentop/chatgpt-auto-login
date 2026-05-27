// v2.45.0 — smscloud 一号多绑缓存。配 phone-pool.js 的 SQL-first 风格。
// 表 smscloud_phone_cache 由 server/db.js 在 initDB 时建。
// acquirePhone 优先复用未过期 + 未满 max + 未绑过本 email 的 entry，否则 takeOrderFn 拿新号。

/**
 * 优先复用 cache 中未过期 / 未满 max / 未绑该 email / 未被 exclude 的 entry。
 * 找不到则调 takeOrderFn() 拿新号 → 写 cache + binding。
 *
 * @param {Object} db sql.js Database
 * @param {string} email 要绑定的邮箱
 * @param {number} maxBindingsPerPhone 单号最多绑几个 email（满即跳过）
 * @param {number} expiryMs taken_at_ms 之后多少毫秒视为过期（smscloud 一般 18min）
 * @param {string[]} excludePhones 同一次 retry session 已尝试过的号
 * @param {() => Promise<{orderNo, phone, apiKey, baseUrl}> | {orderNo, phone, apiKey, baseUrl}} takeOrderFn
 *   cache miss 时调用，向 smscloud 取新号。可 sync / async。
 * @returns {Promise<{orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used, reused}>}
 */
function acquirePhone(db, email, maxBindingsPerPhone, expiryMs, excludePhones, takeOrderFn, preferredCountryCode = null) {
  const now = Date.now();
  const exclusionClause = excludePhones.length > 0
    ? `AND phone NOT IN (${excludePhones.map(() => '?').join(',')})`
    : '';
  const countryClause = preferredCountryCode != null
    ? 'AND (country_code = ? OR country_code IS NULL)'
    : '';
  const countryParams = preferredCountryCode != null ? [preferredCountryCode] : [];
  const r = db.exec(`
    SELECT order_no, phone, api_key, base_url, taken_at_ms, bindings_used
    FROM smscloud_phone_cache
    WHERE status = 'active'
      AND taken_at_ms + ? > ?
      AND bindings_used < ?
      AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
      ${countryClause}
      ${exclusionClause}
    ORDER BY bindings_used ASC, taken_at_ms ASC
    LIMIT 1
  `, [expiryMs, now, maxBindingsPerPhone, email, ...countryParams, ...excludePhones]);
  if (r.length && r[0].values.length) {
    const [orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used] = r[0].values[0];
    db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email]);
    db.run('UPDATE smscloud_phone_cache SET bindings_used = bindings_used + 1 WHERE order_no = ?', [orderNo]);
    return Promise.resolve({ orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used: bindings_used + 1, reused: true });
  }
  return Promise.resolve(takeOrderFn()).then(({ orderNo, phone, apiKey, baseUrl, countryCode }) => {
    const taken_at_ms = Date.now();
    db.run(
      `INSERT INTO smscloud_phone_cache (order_no, phone, api_key, base_url, taken_at_ms, bindings_used, status, country_code)
       VALUES (?, ?, ?, ?, ?, 1, 'active', ?)`,
      [orderNo, phone, apiKey, baseUrl, taken_at_ms, countryCode ?? null]
    );
    db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email]);
    return { orderNo, phone, apiKey, baseUrl, taken_at_ms, bindings_used: 1, reused: false };
  });
}

/**
 * 把 entry 标 rejected（OpenAI 拒该号时调）。
 * 不可逆：后续 acquirePhone 的 SQL `WHERE status='active'` 会自动跳过。
 */
function markRejected(db, orderNo) {
  db.run("UPDATE smscloud_phone_cache SET status = 'rejected' WHERE order_no = ?", [orderNo]);
}

/**
 * 撤销刚刚 acquirePhone 建立的 binding（OpenAI fraud/rate-limit 等回退场景）。
 * 删 phone_bindings 行 + bindings_used MAX(0, -1)。按 orderNo 精确，不影响同号其他 entry。
 */
function releaseBinding(db, orderNo, email, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ? AND email = ?', [phone, email]);
  db.run('UPDATE smscloud_phone_cache SET bindings_used = MAX(0, bindings_used - 1) WHERE order_no = ?', [orderNo]);
}

/**
 * 删过期 active entry（taken_at_ms + expiryMs < now 且 status='active'）。
 * rejected 行不动（监管用，保留历史）。返回 { expired: 删除条数 }。
 */
function expireOldEntries(db, expiryMs) {
  const now = Date.now();
  const before = db.exec("SELECT COUNT(*) FROM smscloud_phone_cache WHERE status = 'active' AND taken_at_ms + ? < ?", [expiryMs, now]);
  const expired = before[0]?.values[0][0] || 0;
  db.run("DELETE FROM smscloud_phone_cache WHERE status = 'active' AND taken_at_ms + ? < ?", [expiryMs, now]);
  return { expired };
}

/**
 * 给未来 UI 列 cache。本 task 不单测（同 phone-pool.listPhones 风格）。
 */
function listCache(db) {
  const r = db.exec(`
    SELECT order_no, phone, taken_at_ms, bindings_used, status
    FROM smscloud_phone_cache
    ORDER BY taken_at_ms DESC
  `);
  if (!r.length) return [];
  return r[0].values.map(([orderNo, phone, taken_at_ms, bindings_used, status]) => ({
    orderNo, phone, taken_at_ms, bindings_used, status,
  }));
}

module.exports = { acquirePhone, markRejected, releaseBinding, expireOldEntries, listCache };
