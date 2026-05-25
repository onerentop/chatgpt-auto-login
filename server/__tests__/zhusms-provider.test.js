const test = require('node:test')
const assert = require('node:assert')

let zhusms

test.before(() => {
  zhusms = require('../zhusms-provider')
})

test.beforeEach(() => {
  zhusms.__resetForTest()
})

function mockFetch(handler) {
  const orig = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return handler(url, opts, calls)
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

test('Z1 activate 成功后缓存 cookie，第二次 take 复用不重新 activate', async () => {
  const { calls, restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      return {
        ok: true, status: 200,
        headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=abc123; Path=/' : null },
        json: async () => ({ ok: true }),
      }
    }
    if (url.includes('/api/order/take')) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ order_no: 'ORD-1', phone: '+15551234567' }),
      }
    }
    throw new Error('unexpected ' + url)
  })
  try {
    const r1 = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    const r2 = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.strictEqual(r1.order_no, 'ORD-1')
    assert.strictEqual(r2.order_no, 'ORD-1')
    const activateCount = calls.filter(c => c.url.includes('/api/guest/activate')).length
    const takeCount = calls.filter(c => c.url.includes('/api/order/take')).length
    assert.strictEqual(activateCount, 1, 'activate 只调一次')
    assert.strictEqual(takeCount, 2, 'take 调 2 次')
  } finally { restore() }
})

test('Z2 takeOrder 返回 {order_no, phone}', async () => {
  const { restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=x' : null }, json: async () => ({}) }
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ order_no: 'ORD-99', phone: '+18889990000', extra: 'whatever' }),
    }
  })
  try {
    const r = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.deepStrictEqual(r, { order_no: 'ORD-99', phone: '+18889990000' })
  } finally { restore() }
})

test('Z3 pollOrderSms 超时抛 sms-poll-timeout', async () => {
  const { restore } = mockFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({ status: 'waiting' }),
  }))
  try {
    await assert.rejects(
      () => zhusms.pollOrderSms('ORD-1', 'https://zhusms.com', { pollIntervalMs: 1, maxAttempts: 3 }),
      /sms-poll-timeout/
    )
  } finally { restore() }
})

test('Z4 pollOrderSms 拿到 6 位数字返回 code', async () => {
  const { restore } = mockFetch(async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => ({ status: 'done', sms: 'Your verification code is 654321 — expires in 10m' }),
  }))
  try {
    const code = await zhusms.pollOrderSms('ORD-1', 'https://zhusms.com', { pollIntervalMs: 1, maxAttempts: 3 })
    assert.strictEqual(code, '654321')
  } finally { restore() }
})

test('Z5 cancelOrder 调用正确 endpoint + form body', async () => {
  let captured
  const { restore } = mockFetch(async (url, opts) => {
    if (url.includes('/api/guest/activate')) {
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? 'session=x' : null }, json: async () => ({}) }
    }
    if (url.includes('/api/order/cancel')) {
      captured = { url, body: opts?.body?.toString() }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) }
    }
    throw new Error('unexpected ' + url)
  })
  try {
    await zhusms.cancelOrder('ORD-XYZ', 'https://zhusms.com', 'CARD1', null)
    assert.ok(captured, 'cancel endpoint called')
    assert.match(captured.url, /\/api\/order\/cancel$/)
    assert.match(captured.body || '', /order_no=ORD-XYZ/)
  } finally { restore() }
})

test('Z6 take 401 时清 session 重试一次', async () => {
  let activateCount = 0, takeCount = 0
  const { restore } = mockFetch(async (url) => {
    if (url.includes('/api/guest/activate')) {
      activateCount++
      return { ok: true, status: 200, headers: { get: (k) => k.toLowerCase() === 'set-cookie' ? `session=v${activateCount}` : null }, json: async () => ({}) }
    }
    if (url.includes('/api/order/take')) {
      takeCount++
      if (takeCount === 1) return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: 'session expired' }) }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ order_no: 'ORD-2', phone: '+18001234567' }) }
    }
    throw new Error('unexpected')
  })
  try {
    const r = await zhusms.takeOrder('CARD1', 'https://zhusms.com', 'codex', null)
    assert.strictEqual(r.order_no, 'ORD-2')
    assert.strictEqual(activateCount, 2, 'activate 调 2 次（401 后重新 activate）')
    assert.strictEqual(takeCount, 2, 'take 调 2 次（一次 401 + 一次成功）')
  } finally { restore() }
})
