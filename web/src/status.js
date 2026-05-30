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
  canceled: 'warning',
  token_expired: 'warning',
  login_fail: 'danger',
  paypal_captcha: 'warning',
  aborted: 'info',
  phone_pool_empty: 'warning',
  phone_verify_fail: 'danger',
  no_idr_link: 'warning',
  no_midtrans: 'warning',
  gopay_reg_fail: 'danger',
  gopay_pay_fail: 'danger',
  gopay_fraud: 'danger',
  plus_gopay: 'success',
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
  canceled: '已取消',
  token_expired: 'Token失效',
  login_fail: '登录失败',
  paypal_captcha: 'PayPal人机验证',
  aborted: '已停止',
  phone_pool_empty: '号池已用尽',
  phone_verify_fail: '手机验证失败',
  no_idr_link: 'IDR链接失败',
  no_midtrans: '无Midtrans',
  gopay_reg_fail: 'GoPay注册失败',
  gopay_pay_fail: 'GoPay支付失败',
  gopay_fraud: 'GoPay风控拒绝',
  plus_gopay: 'Plus(GoPay)',
}

export function statusType(s) {
  return TYPE_MAP[s] || 'info'
}

export function statusLabel(s) {
  return LABEL_MAP[s] || s || '空闲'
}

// v2.33.0: 给 <el-table> :row-class-name 用。
// 返回 'row-status-{type}' 或 '' (idle/empty 时不高亮)。
// 大部分 status 直接复用 statusType()；唯一例外是 running ——
// v2.33.1: running 用专属 class 'row-status-running'（不复用 warning），
// 因为 warning 还有 plus_no_rt / token_expired / no_link / canceled 等多
// 个共用，会导致"运行中"和这些终态颜色相同看不出差异。专属 class 配合
// 单独的 CSS（浅蓝 + 左边框）让"正在跑"视觉突出。
export function rowClassFor(status) {
  const st = (status || '').toLowerCase()
  if (!st || st === 'idle') return ''
  if (st === 'running') return 'row-status-running'
  const type = statusType(st) || 'info'
  return `row-status-${type}`
}

export const PLUS_STATUSES = ['plus', 'plus_no_rt', 'plus_gopay']
export const ERROR_STATUSES = ['error', 'no_link', 'deactivated', 'no_promo', 'canceled', 'token_expired', 'login_fail', 'phone_pool_empty', 'phone_verify_fail']

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

// === Execute page grouping ===

// 固定业务排序：成功资产优先 → 运行中 → 错误类 → 闲置/其他
export const GROUP_ORDER = [
  'plus',           // Plus(有RT)
  'plus_no_rt',     // Plus(无RT)
  'running',        // 运行中
  'error',          // 错误
  'deactivated',    // 已删除
  'canceled',       // 已取消（测活同步）
  'token_expired',  // Token失效（测活同步）
  'login_fail',     // 登录失败（测活同步）
  'phone_pool_empty', // 号池已用尽（v2.38.0）
  'phone_verify_fail', // 手机验证失败（v2.38.0）
  'no_link',        // 无链接
  'no_promo',       // 无0元资格
  'verify_error',   // Stripe验证失败
  'no_jp_proxy',    // JP节点不可用
  'paypal_captcha', // PayPal人机验证
  'aborted',        // 已停止
  'idle',           // 空闲
]

// 页面打开时默认展开的组（含数据时才生效）
export const DEFAULT_EXPANDED_STATUSES = ['plus', 'plus_no_rt']

/**
 * 按状态分桶 + 按 GROUP_ORDER 排序 + 隐藏空组
 * @param {Array} rows — 账户行（优先读 _groupStatus，未设回退 _status，缺失视为 'idle'）
 * @returns {Array<{ status, label, type, rows, count }>}
 */
export function groupAccountsByStatus(rows) {
  if (!Array.isArray(rows)) return []
  const buckets = new Map()
  for (const row of rows) {
    // v2.34.0: 分组优先看 _groupStatus（执行时快照，sticky grouping）；
    // 未设回退 _status。Execute.vue 调 startExec 时给 batch rows 设
    // _groupStatus = _status，之后 socket 更新只动 _status（驱动行
    // 颜色），row 不跨组。Accounts.vue 没 _groupStatus 概念，自动
    // fallback 到 _status 行为不变。
    const s = row._groupStatus || row._status || 'idle'
    if (!buckets.has(s)) buckets.set(s, [])
    buckets.get(s).push(row)
  }
  const orderIndex = new Map(GROUP_ORDER.map((s, i) => [s, i]))
  const groups = []
  for (const [status, list] of buckets.entries()) {
    if (list.length === 0) continue
    groups.push({
      status,
      label: statusLabel(status),
      type: statusType(status),
      rows: list,
      count: list.length,
    })
  }
  groups.sort((a, b) => {
    const ia = orderIndex.has(a.status) ? orderIndex.get(a.status) : 999
    const ib = orderIndex.has(b.status) ? orderIndex.get(b.status) : 999
    return ia - ib
  })
  return groups
}

// === Execute page retry / filter helpers ===

// 所有 "未拿到 Plus 但非账号死亡" 的终态 — "重试失败" 按钮的目标集
// 排除 deactivated（账号已删）、plus / plus_no_rt（已成功）、
// idle / running（未到终态）、checking / unknown（liveness 中间态）
export const FAILED_TO_RETRY_STATUSES = [
  'error',
  'no_link',
  'no_promo',
  'verify_error',
  'paypal_captcha',
  'login_fail',
  'token_expired',
  'aborted',
  'no_jp_proxy',
]

export function isFailedToRetry(status) {
  return FAILED_TO_RETRY_STATUSES.includes((status || '').toLowerCase())
}

// statusFilter 下拉的动态选项 — 从 LABEL_MAP 全集生成，避免下拉与状态体系脱节
// 排除纯 liveness 维度（checking 只在 ALIVE_LABEL_MAP，未来防御性过滤）
// canceled 自 v2.32.0 起被 runner.dispatchOne 同步到 pipeline status，
// 因此保留为可筛选项
export const EXECUTE_STATUS_FILTER_OPTIONS = Object.entries(LABEL_MAP)
  .filter(([k]) => k !== 'checking')
  .map(([value, label]) => ({ value, label }))
