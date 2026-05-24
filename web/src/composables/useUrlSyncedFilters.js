/**
 * Bidirectionally sync a set of refs with the current route's query string.
 *
 *   useUrlSyncedFilters({ search, statusFilter, planFilter })
 *
 * On mount: each ref's value is replaced from route.query if a matching key
 * exists. Array refs read comma-separated query strings; boolean refs read
 * '1'/'0'.
 *
 * Whenever any of the refs change, the URL query is rebuilt and written
 * via `router.replace` (no history entry; reloading the page keeps the
 * filter state). Empty strings, empty arrays, and `false` are omitted to
 * keep the URL short.
 *
 * The refs themselves keep their existing types — the helper only handles
 * serialization at the URL boundary.
 */

import { watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

function fromQuery(value, sample) {
  if (Array.isArray(sample)) {
    if (value == null || value === '') return []
    return String(value).split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (typeof sample === 'boolean') {
    return value === '1' || value === 'true'
  }
  return value == null ? '' : String(value)
}

function toQueryValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : undefined
  if (typeof value === 'boolean') return value ? '1' : undefined
  if (value === '' || value == null) return undefined
  return String(value)
}

export function useUrlSyncedFilters(refsMap) {
  const route = useRoute()
  const router = useRouter()

  onMounted(() => {
    let changed = false
    for (const [key, ref] of Object.entries(refsMap)) {
      const qv = route.query[key]
      if (qv !== undefined) {
        const next = fromQuery(qv, ref.value)
        // Avoid spurious mutations when query==='' would reset arrays etc.
        ref.value = next
        changed = true
      }
    }
    // Trigger a single watcher run after restoration so we don't immediately
    // re-write the URL on first paint.
    if (!changed) return
  })

  const writeUrl = () => {
    const next = { ...route.query }
    let dirty = false
    for (const [key, ref] of Object.entries(refsMap)) {
      const v = toQueryValue(ref.value)
      if (v === undefined) {
        if (key in next) { delete next[key]; dirty = true }
      } else if (next[key] !== v) {
        next[key] = v; dirty = true
      }
    }
    if (dirty) router.replace({ query: next }).catch(() => {})
  }

  for (const ref of Object.values(refsMap)) {
    watch(ref, writeUrl, { deep: true, flush: 'post' })
  }
}
