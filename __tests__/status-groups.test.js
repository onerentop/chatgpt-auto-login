const test = require('node:test')
const assert = require('node:assert')

let groupAccountsByStatus, GROUP_ORDER, DEFAULT_EXPANDED_STATUSES

test.before(async () => {
  const mod = await import('../web/src/status.js')
  groupAccountsByStatus = mod.groupAccountsByStatus
  GROUP_ORDER = mod.GROUP_ORDER
  DEFAULT_EXPANDED_STATUSES = mod.DEFAULT_EXPANDED_STATUSES
})

test('G1 空数组返回空数组', () => {
  assert.deepStrictEqual(groupAccountsByStatus([]), [])
})

test('G2 按 GROUP_ORDER 排序', () => {
  const rows = [
    { email: 'a', _status: 'error' },
    { email: 'b', _status: 'plus' },
    { email: 'c', _status: 'running' },
  ]
  const groups = groupAccountsByStatus(rows)
  assert.deepStrictEqual(groups.map(g => g.status), ['plus', 'running', 'error'])
})

test('G3 隐藏空组', () => {
  const rows = [{ email: 'a', _status: 'plus' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].status, 'plus')
})

test('G4 同状态行聚到同一组', () => {
  const rows = [
    { email: 'a', _status: 'plus' },
    { email: 'b', _status: 'plus' },
    { email: 'c', _status: 'error' },
  ]
  const groups = groupAccountsByStatus(rows)
  const plus = groups.find(g => g.status === 'plus')
  assert.strictEqual(plus.count, 2)
  assert.deepStrictEqual(plus.rows.map(r => r.email), ['a', 'b'])
})

test('G5 _status 缺失视为 idle', () => {
  const rows = [{ email: 'a' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups[0].status, 'idle')
})

test('G6 GROUP_ORDER 之外的 status 排到末尾', () => {
  const rows = [
    { email: 'a', _status: 'plus' },
    { email: 'b', _status: 'unknown_new_status' },
    { email: 'c', _status: 'error' },
  ]
  const groups = groupAccountsByStatus(rows)
  assert.deepStrictEqual(groups.map(g => g.status), ['plus', 'error', 'unknown_new_status'])
})

test('G7 group.label / type 用 statusLabel / statusType 派生', () => {
  const rows = [{ email: 'a', _status: 'plus_no_rt' }]
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups[0].label, 'Plus(无RT)')
  assert.strictEqual(groups[0].type, 'warning')
})

test('G8 DEFAULT_EXPANDED_STATUSES 是 [plus, plus_no_rt]', () => {
  assert.deepStrictEqual(DEFAULT_EXPANDED_STATUSES, ['plus', 'plus_no_rt'])
})
