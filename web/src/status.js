// Single source of truth for account status display

const TYPE_MAP = {
  idle: 'info',
  running: '',
  plus: 'success',
  plus_no_rt: 'warning',
  no_link: 'warning',
  error: 'danger',
  deactivated: 'danger',
  no_jp_proxy: 'warning',
  no_promo: 'info',
  verify_error: 'danger',
  paypal_captcha: 'warning',
  aborted: 'info',
}

const LABEL_MAP = {
  idle: '空闲',
  running: '运行中',
  plus: 'Plus(有RT)',
  plus_no_rt: 'Plus(无RT)',
  no_link: '无链接',
  error: '错误',
  deactivated: '已删除',
  no_jp_proxy: 'JP节点不可用',
  no_promo: '无0元资格',
  verify_error: 'Stripe验证失败',
  paypal_captcha: 'PayPal人机验证',
  aborted: '已停止',
}

export function statusType(s) {
  return TYPE_MAP[s] || 'info'
}

export function statusLabel(s) {
  return LABEL_MAP[s] || s || '空闲'
}

export const PLUS_STATUSES = ['plus', 'plus_no_rt']
export const ERROR_STATUSES = ['error', 'no_link', 'deactivated', 'no_promo']

export function isPlus(status) {
  return PLUS_STATUSES.includes((status || '').toLowerCase())
}

export function isError(status) {
  return ERROR_STATUSES.includes((status || '').toLowerCase())
}

// === Liveness probe display helpers ===

const ALIVE_TYPE_MAP = {
  plus: 'success',
  canceled: 'warning',
  deactivated: 'danger',
  login_fail: 'danger',
  token_expired: 'danger',
  proxy_error: 'warning',
  network_error: 'warning',
  unknown: 'info',
  checking: 'info',
}

const ALIVE_LABEL_MAP = {
  plus: 'Plus',
  canceled: '已取消',
  deactivated: '已删除',
  login_fail: '登录失败',
  token_expired: 'Token过期',
  proxy_error: '代理异常',
  network_error: '网络异常',
  unknown: '未测试',
  checking: '检测中',
}

export function aliveStatusType(s) {
  return ALIVE_TYPE_MAP[s] || 'info'
}

export function aliveStatusLabel(s) {
  return ALIVE_LABEL_MAP[s] || s || '未测试'
}

export const ALIVE_FILTER_OPTIONS = Object.entries(ALIVE_LABEL_MAP).map(([value, label]) => ({ value, label }))
