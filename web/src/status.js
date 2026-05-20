// Single source of truth for account status display

const TYPE_MAP = {
  idle: 'info',
  running: '',
  plus: 'success',
  plus_no_rt: 'warning',
  no_link: 'warning',
  error: 'danger',
}

const LABEL_MAP = {
  idle: '空闲',
  running: '运行中',
  plus: 'Plus(有RT)',
  plus_no_rt: 'Plus(无RT)',
  no_link: '无链接',
  error: '错误',
}

export function statusType(s) {
  return TYPE_MAP[s] || 'info'
}

export function statusLabel(s) {
  return LABEL_MAP[s] || s || '空闲'
}

export const PLUS_STATUSES = ['plus', 'plus_no_rt']
export const ERROR_STATUSES = ['error', 'no_link']

export function isPlus(status) {
  return PLUS_STATUSES.includes((status || '').toLowerCase())
}

export function isError(status) {
  return ERROR_STATUSES.includes((status || '').toLowerCase())
}
