/**
 * Global notification center.
 *
 *   pushNotification({ level: 'error', title: '保存失败', message: '...' })
 *
 * Stores the last 100 entries reactively so the bell icon in AppLayout can
 * show an unread count and the drawer can show a scrollable history.
 * ElMessage / ElNotification toasts are still emitted at the call site —
 * the notification center is additive (recordable history), not a replacement.
 */

import { reactive, computed } from 'vue'

const MAX_ITEMS = 100

export const notificationState = reactive({
  items: [],   // { id, level, title, message, ts }
  unread: 0,
})

let _nextId = 1

export function pushNotification({ level = 'info', title = '', message = '' } = {}) {
  const item = {
    id: _nextId++,
    level,
    title: String(title).slice(0, 120),
    message: String(message).slice(0, 600),
    ts: Date.now(),
  }
  notificationState.items.unshift(item)
  if (notificationState.items.length > MAX_ITEMS) {
    notificationState.items.length = MAX_ITEMS
  }
  notificationState.unread += 1
  return item.id
}

export function markAllRead() {
  notificationState.unread = 0
}

export function clearAll() {
  notificationState.items = []
  notificationState.unread = 0
}

export const unreadCount = computed(() => notificationState.unread)
