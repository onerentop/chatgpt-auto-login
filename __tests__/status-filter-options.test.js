const test = require('node:test')
const assert = require('node:assert')

let EXECUTE_STATUS_FILTER_OPTIONS

test.before(async () => {
  const mod = await import('../web/src/status.js')
  EXECUTE_STATUS_FILTER_OPTIONS = mod.EXECUTE_STATUS_FILTER_OPTIONS
})

test('S1 EXECUTE_STATUS_FILTER_OPTIONS 含所有 LABEL_MAP 状态除 checking / canceled', () => {
  const values = EXECUTE_STATUS_FILTER_OPTIONS.map(o => o.value)
  // 必须包含的（4 个新增的，原 Execute.vue 硬编码下拉缺失）
  for (const s of ['paypal_captcha', 'login_fail', 'token_expired', 'aborted']) {
    assert.ok(values.includes(s), `${s} 应在下拉中`)
  }
  // 必须包含的（旧 11 个）
  for (const s of ['plus', 'plus_no_rt', 'error', 'deactivated', 'no_link', 'idle', 'running', 'no_jp_proxy', 'no_promo', 'verify_error']) {
    assert.ok(values.includes(s), `${s} 应在下拉中`)
  }
  // 必须排除的（纯 liveness 维度）
  assert.ok(!values.includes('checking'), 'checking 不应在下拉中')
  assert.ok(!values.includes('canceled'), 'canceled 不应在下拉中')
  // 每个 option 有 label + value
  for (const opt of EXECUTE_STATUS_FILTER_OPTIONS) {
    assert.ok(typeof opt.value === 'string' && opt.value, `option.value 必须为非空 string`)
    assert.ok(typeof opt.label === 'string' && opt.label, `option.label 必须为非空 string`)
  }
})
