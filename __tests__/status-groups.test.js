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

test('G3 GROUP_ORDER 中无数据的状态不出现在结果里', () => {
  const rows = [{ email: 'a', _status: 'plus' }]  // 其他 11 个 status 全空
  const groups = groupAccountsByStatus(rows)
  assert.strictEqual(groups.length, 1)  // 不是 12，证明空组被隐藏
  assert.strictEqual(groups[0].status, 'plus')
  // 显式断言其他常见空组不出现
  assert.strictEqual(groups.find(g => g.status === 'idle'), undefined)
  assert.strictEqual(groups.find(g => g.status === 'running'), undefined)
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

test('G9 非数组输入返回空数组（防 Vue computed 提前触发崩溃）', () => {
  assert.deepStrictEqual(groupAccountsByStatus(null), [])
  assert.deepStrictEqual(groupAccountsByStatus(undefined), [])
  assert.deepStrictEqual(groupAccountsByStatus('not an array'), [])
})

test('G10 多个未知 status 按首次出现顺序', () => {
  const rows = [
    { email: 'a', _status: 'plus' },
    { email: 'b', _status: 'zzz_new' },
    { email: 'c', _status: 'aaa_new' },
  ]
  assert.deepStrictEqual(
    groupAccountsByStatus(rows).map(g => g.status),
    ['plus', 'zzz_new', 'aaa_new']
  )
})
