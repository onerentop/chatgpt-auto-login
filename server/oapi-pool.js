// v2.50.0 — oapi CDK 池管理（仿 server/smscloud-pool.js 风格）
// CDK 是用户预先导入的固定池，不动态扩张。一号多绑通过 bindings_used + maxBindingsPerPhone 实现。

function acquireCdk(db, email, maxBindingsPerPhone, baseUrl, takeOrderFn) {
  const r = db.exec(`
    SELECT cdk, phone, base_url, remaining
    FROM oapi_cdk_pool
    WHERE status = 'available'
      AND bindings_used < ?
      AND (remaining IS NULL OR remaining != 0)
      AND (phone IS NULL OR phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?))
    ORDER BY bindings_used ASC, created_at ASC
    LIMIT 1
  `, [maxBindingsPerPhone, email]);
  if (!r.length || !r[0].values.length) {
    return Promise.resolve(null);
  }
  const [cdk, phone, entryBaseUrl, remaining] = r[0].values[0];
  if (phone === null) {
    return Promise.resolve(takeOrderFn(cdk, entryBaseUrl)).then(({ phone: newPhone, remaining: newRemaining }) => {
      const takenAtMs = Date.now();
      db.run(
        `UPDATE oapi_cdk_pool SET phone=?, taken_at_ms=?, remaining=? WHERE cdk=?`,
        [newPhone, takenAtMs, newRemaining ?? null, cdk]
      );
      db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [newPhone, email]);
      db.run('UPDATE oapi_cdk_pool SET bindings_used = bindings_used + 1 WHERE cdk = ?', [cdk]);
      return { cdk, phone: newPhone, baseUrl: entryBaseUrl, remaining: newRemaining, reused: false };
    });
  }
  db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email]);
  db.run('UPDATE oapi_cdk_pool SET bindings_used = bindings_used + 1 WHERE cdk = ?', [cdk]);
  return Promise.resolve({ cdk, phone, baseUrl: entryBaseUrl, remaining, reused: true });
}

function markRejected(db, cdk) {
  db.run("UPDATE oapi_cdk_pool SET status = 'rejected' WHERE cdk = ?", [cdk]);
}

function releaseBinding(db, cdk, email, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ? AND email = ?', [phone, email]);
  db.run('UPDATE oapi_cdk_pool SET bindings_used = MAX(0, bindings_used - 1) WHERE cdk = ?', [cdk]);
}

function updateRemaining(db, cdk, remaining) {
  db.run('UPDATE oapi_cdk_pool SET remaining = ? WHERE cdk = ?', [remaining, cdk]);
}

function listCdks(db) {
  const r = db.exec(`
    SELECT cdk, phone, status, bindings_used, remaining, taken_at_ms
    FROM oapi_cdk_pool
    ORDER BY created_at DESC
  `);
  if (!r.length) return [];
  const rows = r[0].values.map(([cdk, phone, status, bindings_used, remaining, taken_at_ms]) => ({
    cdk, phone, status, bindings_used, remaining, taken_at_ms, boundEmails: [],
  }));
  const bindingsR = db.exec('SELECT phone, email FROM phone_bindings');
  if (bindingsR.length) {
    const byPhone = new Map();
    for (const [phone, email] of bindingsR[0].values) {
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(email);
    }
    for (const row of rows) {
      if (row.phone) row.boundEmails = byPhone.get(row.phone) || [];
    }
  }
  return rows;
}

function importCdks(db, text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim());
  let added = 0, skipped = 0;
  for (const line of lines) {
    if (!line) { skipped++; continue; }
    if (!/^SMS-[A-Z0-9-]+$/i.test(line)) { skipped++; continue; }
    db.run('INSERT OR IGNORE INTO oapi_cdk_pool (cdk, base_url) VALUES (?, ?)', [line.toUpperCase(), baseUrl]);
    if (db.getRowsModified() > 0) added++;
    else skipped++;
  }
  return { added, skipped };
}

function deleteCdk(db, cdk) {
  const r = db.exec('SELECT phone FROM oapi_cdk_pool WHERE cdk = ?', [cdk]);
  const phone = r.length && r[0].values.length ? r[0].values[0][0] : null;
  if (phone) {
    db.run('DELETE FROM phone_bindings WHERE phone = ?', [phone]);
  }
  db.run('DELETE FROM oapi_cdk_pool WHERE cdk = ?', [cdk]);
}

module.exports = { acquireCdk, markRejected, releaseBinding, updateRemaining, listCdks, importCdks, deleteCdk };
