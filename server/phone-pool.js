// v2.37.0 — Phone pool service for OAuth PKCE phone verification.
// Phase 1: 不消费 pool，只交付 CRUD + acquire API + SMS poll helper。
// Phase 2 PKCE 集成时调用 acquirePhone() + fetchSmsCode()。

const E164_RE = /^\+\d{10,15}$/

/**
 * 行 -> {phone, smsApiUrl, bindings_used, created_at, boundEmails}
 * @param {Object} db sql.js Database
 */
function listPhones(db) {
  const r = db.exec('SELECT phone, sms_api_url, bindings_used, created_at FROM phone_pool ORDER BY created_at DESC')
  if (!r.length) return []
  const rows = r[0].values.map(v => ({
    phone: v[0],
    smsApiUrl: v[1],
    bindings_used: v[2],
    created_at: v[3],
    boundEmails: [],
  }))
  const bindingsR = db.exec('SELECT phone, email FROM phone_bindings')
  if (bindingsR.length) {
    const byPhone = new Map()
    for (const [phone, email] of bindingsR[0].values) {
      if (!byPhone.has(phone)) byPhone.set(phone, [])
      byPhone.get(phone).push(email)
    }
    for (const row of rows) {
      row.boundEmails = byPhone.get(row.phone) || []
    }
  }
  return rows
}

/**
 * 解析 `phone|url\n...` 文本，逐行 INSERT OR IGNORE，跳过非法 / 重复。
 * 返回 { added, skipped }。
 */
function importPhones(db, text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim())
  let added = 0, skipped = 0
  for (const line of lines) {
    if (!line) { skipped++; continue }
    const idx = line.indexOf('|')
    if (idx < 0) { skipped++; continue }
    const phone = line.slice(0, idx).trim()
    const url = line.slice(idx + 1).trim()
    if (!phone || !url) { skipped++; continue }
    if (!E164_RE.test(phone)) { skipped++; continue }
    db.run('INSERT OR IGNORE INTO phone_pool (phone, sms_api_url) VALUES (?, ?)', [phone, url])
    const changed = db.getRowsModified()
    if (changed > 0) added++
    else skipped++
  }
  return { added, skipped }
}

/**
 * 导出与导入相同格式：`phone|url` 每行一条。
 */
function exportPhones(db) {
  const r = db.exec('SELECT phone, sms_api_url FROM phone_pool ORDER BY created_at ASC')
  if (!r.length) return ''
  return r[0].values.map(([phone, url]) => `${phone}|${url}`).join('\n')
}

/**
 * 删除 phone + cascade 所有 bindings。bindings_used 计数不动（监管），
 * 但因为 phone 行也没了，下次 list 看不到任何数据。
 */
function deletePhone(db, phone) {
  db.run('DELETE FROM phone_bindings WHERE phone = ?', [phone])
  db.run('DELETE FROM phone_pool WHERE phone = ?', [phone])
}

/**
 * 拿一个未满绑定 + 未与本 email 绑过 的 phone。
 * 排序：bindings_used ASC + created_at ASC（轮转使用 + FIFO）。
 * 找到 → 写 binding + 自增 bindings_used → 返回 { phone, smsApiUrl }
 * 没找到 → null
 *
 * @param {string[]} excludePhones v2.40.1: 同一次 retry session 已尝试过的号，acquire
 *   时排除。修复 v2.39.4 的 issue：retry 时 releaseBinding 后 bindings_used 回 0 又
 *   排序最高 → 反复取同号。caller 维护 list，每次失败 attempt 后 push 进入。
 */
function acquirePhone(db, email, maxBindingsPerPhone, excludePhones = []) {
  const exclusionClause = excludePhones.length > 0
    ? `AND phone NOT IN (${excludePhones.map(() => '?').join(',')})`
    : ''
  const r = db.exec(`
    SELECT phone, sms_api_url
    FROM phone_pool
    WHERE bindings_used < ?
      AND phone NOT IN (SELECT phone FROM phone_bindings WHERE email = ?)
      ${exclusionClause}
    ORDER BY bindings_used ASC, created_at ASC
    LIMIT 1
  `, [maxBindingsPerPhone, email, ...excludePhones])
  if (!r.length || !r[0].values.length) return null
  const [phone, smsApiUrl] = r[0].values[0]
  db.run('INSERT INTO phone_bindings (phone, email) VALUES (?, ?)', [phone, email])
  db.run('UPDATE phone_pool SET bindings_used = bindings_used + 1 WHERE phone = ?', [phone])
  return { phone, smsApiUrl }
}

/**
 * v2.39.4: 撤销刚刚 acquirePhone 建立的临时 binding。
 * 当 OpenAI 拒绝该号（"无法发送验证码"红字）时，号本身没被 OpenAI 用 →
 * 不该消耗 bindings_used 名额 → 删除 binding 行 + bindings_used MAX(0, -1)。
 * v2.37.0 原设计是「永久 binding」，本函数仅用于"OpenAI 上没真正发短信"的回退场景。
 */
function releaseBinding(db, phone, email) {
  db.run('DELETE FROM phone_bindings WHERE phone = ? AND email = ?', [phone, email])
  db.run('UPDATE phone_pool SET bindings_used = MAX(0, bindings_used - 1) WHERE phone = ?', [phone])
}

/**
 * 轮询 smsApiUrl，regex /\b(\d{6})\b/ 提取 6 位数字。
 * - signal 支持 AbortController
 * - proxyUrl (v2.38.0) 可选，提供时走 HttpsProxyAgent（跟 server/discord-gateway.js 同模式），
 *   undefined 时 fetch 直连（向后兼容 Phase 1 调用方）
 * - 跟 payment.js:586 现有 PayPal 路径 regex 一致，Phase 2 复用
 */
async function fetchSmsCode(smsApiUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {}) {
  // v2.38.0: proxyUrl 提供时走 HttpsProxyAgent（跟 server/discord-gateway.js 同模式），
  // undefined 时 fetch 直连（向后兼容 Phase 1 调用方）。
  let agent
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    agent = new HttpsProxyAgent(proxyUrl)
  }
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      // v2.37.0 final-review fix: 抛 AbortError 而非通用 Error，
      // 让调用方 (Phase 2 PKCE) catch e?.name === 'AbortError' 不漏预检路径
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    try {
      const resp = await fetch(smsApiUrl, { signal, agent })
      // v2.37.0 final-review fix: HTTP 4xx/5xx 错误体里恰好含 6 位数字
      // 不应被误识别为验证码（e.g. {"error":"rate limit 123456"}）
      if (!resp.ok) {
        // 继续下一轮轮询（短时网络/接码方服务抖动可能恢复）
      } else {
        const text = await resp.text()
        const m = text.match(/\b(\d{6})\b/)
        if (m) return m[1]
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }
  }
  throw new Error('sms-poll-timeout')
}

module.exports = { listPhones, importPhones, exportPhones, deletePhone, acquirePhone, releaseBinding, fetchSmsCode }
