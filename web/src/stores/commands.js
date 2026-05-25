/**
 * Command palette registry — reactive list of executable commands,
 * grouped and labeled. Views register/unregister commands as they
 * mount / unmount; AppLayout also registers a permanent core set
 * (navigation, theme).
 *
 * Filtering is intentionally simple: case-insensitive substring match
 * on (label + keywords + group). Sorting prioritises exact prefix on
 * label, then group order, then insertion order.
 */

import { reactive, computed } from 'vue'

export const paletteState = reactive({
  open: false,
  query: '',
})

// Map<id, command> — using a Map keeps insertion order for stable display.
const _commands = reactive(new Map())

/** Group priority for sort — lower is higher. */
const GROUP_ORDER = ['导航', '账号', '执行', '代理', '配置', '主题', '高级']

export function openPalette() { paletteState.open = true; paletteState.query = '' }
export function closePalette() { paletteState.open = false }

/**
 * Register a command. Returns an unregister function.
 *
 *   const off = registerCommand({
 *     id: 'execute.run-all',
 *     group: '执行',
 *     label: '执行全部账号',
 *     keywords: 'run all start pipeline',
 *     action: () => { ... },
 *   })
 *   onUnmounted(off)
 */
export function registerCommand(cmd) {
  if (!cmd || !cmd.id || typeof cmd.action !== 'function') return () => {}
  _commands.set(cmd.id, cmd)
  return () => _commands.delete(cmd.id)
}

export function unregisterCommand(id) { _commands.delete(id) }

export const allCommands = computed(() => Array.from(_commands.values()))

export const filteredCommands = computed(() => {
  const q = paletteState.query.trim().toLowerCase()
  const items = Array.from(_commands.values())
  let matched
  if (!q) {
    matched = items
  } else {
    matched = items.filter((c) => {
      const hay = `${c.label} ${c.keywords || ''} ${c.group || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }
  // Sort: prefix-match first, then by group order, then alphabetical
  return matched.sort((a, b) => {
    if (q) {
      const aPrefix = a.label.toLowerCase().startsWith(q) ? 0 : 1
      const bPrefix = b.label.toLowerCase().startsWith(q) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
    }
    const ga = GROUP_ORDER.indexOf(a.group)
    const gb = GROUP_ORDER.indexOf(b.group)
    if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb)
    return (a.label || '').localeCompare(b.label || '')
  })
})

/** Grouped view for the palette UI — array of { group, items[] }. */
export const groupedFilteredCommands = computed(() => {
  const groups = new Map()
  for (const c of filteredCommands.value) {
    const g = c.group || '其他'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(c)
  }
  // Order by GROUP_ORDER then by insertion.
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      const ia = GROUP_ORDER.indexOf(a)
      const ib = GROUP_ORDER.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
    .map(([group, items]) => ({ group, items }))
})
