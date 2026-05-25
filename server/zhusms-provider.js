// v2.39.0 — zhusms 远程接码 provider
// API spec: https://zhusms.com/openapi.json
// Guest mode：卡密 activate 拿 session cookie，订单 take/poll/cancel。
// 一卡多次（每次 take 扣 1 余额）。

const { URLSearchParams } = require('url')

// Session cookie 缓存 (baseUrl → { cookie, activatedAt })
const sessions = new Map()
const SESSION_TTL_MS = 3600_000  // 1 小时

function __resetForTest() { sessions.clear() }

function _getAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  const { HttpsProxyAgent } = require('https-proxy-agent')
  return new HttpsProxyAgent(proxyUrl)
}

async function _postForm(url, fields, { cookie, proxyUrl } = {}) {
  const body = new URLSearchParams(fields)
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookie) headers['Cookie'] = cookie
  return await fetch(url, { method: 'POST', headers, body, agent: _getAgent(proxyUrl) })
}

async function _activate(cardKey, baseUrl, proxyUrl) {
  const resp = await _postForm(`${baseUrl}/api/guest/activate`, { code: cardKey }, { proxyUrl })
  if (!resp.ok) throw new Error(`zhusms activate failed: HTTP ${resp.status}`)
  const setCookie = resp.headers.get('set-cookie')
  if (!setCookie) throw new Error('zhusms activate: no Set-Cookie in response')
  // 简单提取 name=value (取第一段，去掉 Path / Expires 等)
  const cookie = setCookie.split(';')[0].trim()
  return cookie
}

async function ensureSession(cardKey, baseUrl, proxyUrl) {
  const cached = sessions.get(baseUrl)
  if (cached && Date.now() - cached.activatedAt < SESSION_TTL_MS) {
    return cached.cookie
  }
  const cookie = await _activate(cardKey, baseUrl, proxyUrl)
  sessions.set(baseUrl, { cookie, activatedAt: Date.now() })
  return cookie
}

async function takeOrder(cardKey, baseUrl, service, proxyUrl) {
  let cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  let resp = await _postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  if (resp.status === 401 || resp.status === 403) {
    // session 过期 → 清缓存重试一次
    sessions.delete(baseUrl)
    cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
    resp = await _postForm(`${baseUrl}/api/order/take`, { service }, { cookie, proxyUrl })
  }
  if (!resp.ok) return null  // 余额耗尽 / 服务异常
  const data = await resp.json()
  if (!data?.order_no || !data?.phone) return null
  return { order_no: data.order_no, phone: data.phone }
}

async function pollOrderSms(orderNo, baseUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal, proxyUrl } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }
    try {
      const resp = await fetch(`${baseUrl}/api/order/status?order_no=${encodeURIComponent(orderNo)}`, {
        agent: _getAgent(proxyUrl), signal,
      })
      if (resp.ok) {
        const data = await resp.json()
        // sms 字段名实测可能是 data.sms / data.code / data.body — 用 stringify + regex tolerant
        const text = JSON.stringify(data)
        const m = text.match(/\b(\d{6})\b/)
        if (m) return m[1]
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e
    }
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  throw new Error('sms-poll-timeout')
}

async function cancelOrder(orderNo, baseUrl, cardKey, proxyUrl) {
  try {
    const cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
    await _postForm(`${baseUrl}/api/order/cancel`, { order_no: orderNo }, { cookie, proxyUrl })
  } catch {
    // 释放失败不影响主流程（错误路径下尽力释放）
  }
}

async function getBalance(cardKey, baseUrl, proxyUrl) {
  const cookie = await ensureSession(cardKey, baseUrl, proxyUrl)
  const resp = await fetch(`${baseUrl}/api/guest/me`, {
    headers: { Cookie: cookie },
    agent: _getAgent(proxyUrl),
  })
  if (!resp.ok) throw new Error(`zhusms getBalance failed: HTTP ${resp.status}`)
  return await resp.json()
}

module.exports = {
  takeOrder, pollOrderSms, cancelOrder, getBalance,
  __resetForTest,
}
