const test = require('node:test')
const assert = require('node:assert')

let rowClassFor

test.before(async () => {
  const mod = await import('../web/src/status.js')
  rowClassFor = mod.rowClassFor
})

test('rowClassFor: idle 不高亮', () => {
  assert.strictEqual(rowClassFor('idle'), '')
  assert.strictEqual(rowClassFor(''), '')
  assert.strictEqual(rowClassFor(null), '')
  assert.strictEqual(rowClassFor(undefined), '')
})

test('rowClassFor: running 强制 warning（即便 TYPE_MAP=空字符串）', () => {
  assert.strictEqual(rowClassFor('running'), 'row-status-warning')
})

test('rowClassFor: success 状态（plus）', () => {
  assert.strictEqual(rowClassFor('plus'), 'row-status-success')
})

test('rowClassFor: danger 状态（error / deactivated / login_fail）', () => {
  assert.strictEqual(rowClassFor('error'), 'row-status-danger')
  assert.strictEqual(rowClassFor('deactivated'), 'row-status-danger')
  assert.strictEqual(rowClassFor('login_fail'), 'row-status-danger')
})

test('rowClassFor: warning 状态（plus_no_rt / no_link / token_expired）', () => {
  assert.strictEqual(rowClassFor('plus_no_rt'), 'row-status-warning')
  assert.strictEqual(rowClassFor('no_link'), 'row-status-warning')
  assert.strictEqual(rowClassFor('token_expired'), 'row-status-warning')
})

test('rowClassFor: info 状态（no_promo / aborted）', () => {
  assert.strictEqual(rowClassFor('no_promo'), 'row-status-info')
  assert.strictEqual(rowClassFor('aborted'), 'row-status-info')
})

test('rowClassFor: 未知状态 fallback info', () => {
  assert.strictEqual(rowClassFor('made_up_status'), 'row-status-info')
})

test('rowClassFor: 大小写不敏感', () => {
  assert.strictEqual(rowClassFor('PLUS'), 'row-status-success')
  assert.strictEqual(rowClassFor('Running'), 'row-status-warning')
})
