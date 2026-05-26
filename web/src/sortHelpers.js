// web/src/sortHelpers.js
// v2.41.7: 账号列表表头排序通用 sort 函数
//
// 抽出原 Accounts.vue (v2.41.6) 本地 const ALIVE_TIER / PLAN_PRIORITY，
// 配合新增的 byXxx 比较函数，供 AccountsTable.vue（账号管理）和
// AccountTableRows.vue（执行控制）的 el-table-column 共享：
//
//   <el-table-column ... sortable :sort-method="byPlan" />
//
// 比较函数签名 (a, b) => number，符合 element-plus el-table-column
// :sort-method 协议。返负 a 在前，返正 b 在前。

import { GROUP_ORDER } from './status'

// 计划优先级：Plus 在前，未知次之，Free 在后
export const PLAN_PRIORITY = { plus: 0, unknown: 1, free: 2 }

// 活性分档（v2.41.6 from Accounts.vue）：
//   0 = 能用、1 = 未知/可恢复（含 checking / 测活错误）、2 = 不能用
export const ALIVE_TIER = {
  // 能用 (tier 0)
  plus: 0,
  // 未知 / 介于 (tier 1) — 测活失败 / canceled 等可恢复 / 未测试
  unknown: 1, checking: 1, canceled: 1, proxy_error: 1, network_error: 1,
  // 不能用 (tier 2)
  deactivated: 2, login_fail: 2, token_expired: 2,
}

// 执行状态业务序：与 status.js GROUP_ORDER 一致（Plus / running / error / ...）。
// Map 查找 O(1)，避免每次比较都跑 indexOf。
const EXECUTE_STATUS_ORDER = new Map(GROUP_ORDER.map((s, i) => [s, i]))

// === 排序函数（返 number，配 el-table-column :sort-method）===

export function byPlan(a, b) {
  return (PLAN_PRIORITY[a._plan] ?? 99) - (PLAN_PRIORITY[b._plan] ?? 99)
}

export function byAliveStatus(a, b) {
  return (ALIVE_TIER[a._aliveStatus] ?? 99) - (ALIVE_TIER[b._aliveStatus] ?? 99)
}

export function byExecuteStatus(a, b) {
  return (EXECUTE_STATUS_ORDER.get(a._status) ?? 999) - (EXECUTE_STATUS_ORDER.get(b._status) ?? 999)
}

export function byAliveCheckedAt(a, b) {
  // 升序时旧的在前、新的在后；用户点两下即"最新在前"。
  // 未测试视为 epoch 0（始终最早）。
  const ta = a._aliveCheckedAt ? new Date(a._aliveCheckedAt).getTime() : 0
  const tb = b._aliveCheckedAt ? new Date(b._aliveCheckedAt).getTime() : 0
  return ta - tb
}

export function byHasAuth(a, b) {
  // true > false：升序时 false 在前（未生成在前 → 方便筛查待生成的账号）
  return (a._hasAuth ? 1 : 0) - (b._hasAuth ? 1 : 0)
}
