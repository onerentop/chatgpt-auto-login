/**
 * Standardized danger confirmation.
 *
 *   await confirmDanger('删除选中的 47 个账号？')
 *
 *   // High-risk variant: must type the exact phrase before the confirm
 *   // button becomes effective. Used when an accidental click would be
 *   // expensive (mass delete, blacklist clear).
 *   await confirmDanger('删除选中的 142 个账号？', { requireText: '142' })
 *
 * Resolves to `true` on confirm, `false` on cancel / dismiss / mismatched
 * input. Never throws — callers can use a single `if` check.
 */

import { ElMessageBox } from 'element-plus'

const baseOpts = {
  type: 'warning',
  confirmButtonText: '确认',
  cancelButtonText: '取消',
  closeOnClickModal: false,
  closeOnPressEscape: true,
}

export async function confirmDanger(message, opts = {}) {
  const title = opts.title || '危险操作'
  if (opts.requireText) {
    try {
      const { value } = await ElMessageBox.prompt(
        `${message}\n\n请输入 "${opts.requireText}" 确认：`,
        title,
        {
          ...baseOpts,
          confirmButtonText: '确认',
          inputErrorMessage: '输入不匹配',
          inputValidator: (v) => v === opts.requireText,
        },
      )
      return value === opts.requireText
    } catch {
      return false
    }
  }
  try {
    await ElMessageBox.confirm(message, title, { ...baseOpts, confirmButtonText: opts.confirmButtonText || '确认' })
    return true
  } catch {
    return false
  }
}
