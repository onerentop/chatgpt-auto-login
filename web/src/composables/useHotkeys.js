/**
 * Global keyboard shortcuts.
 *
 *  / — focus the first element marked data-hotkey="search" on the current
 *      view (typically the search input). Suppressed while another input /
 *      textarea / contenteditable holds focus, so typing "/" inside a field
 *      still works.
 *
 *  Ctrl+Enter — click the first element marked data-hotkey="submit". Used
 *      for "Save config" and "Add account" main confirm actions.
 *
 *  Esc — left to Element Plus; el-dialog / el-drawer already handle it.
 */

import { onMounted, onUnmounted } from 'vue'

function isEditableTarget(t) {
  if (!t) return false
  const tag = (t.tagName || '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (t.isContentEditable) return true
  return false
}

export function useHotkeys() {
  function onKeyDown(e) {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'Enter')) {
      const submit = document.querySelector('[data-hotkey="submit"]:not([disabled])')
      if (submit) {
        e.preventDefault()
        submit.click()
      }
      return
    }
    if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (isEditableTarget(e.target)) return
      const search = document.querySelector('[data-hotkey="search"] input, input[data-hotkey="search"]')
      if (search && typeof search.focus === 'function') {
        e.preventDefault()
        search.focus()
        if (typeof search.select === 'function') search.select()
      }
    }
  }
  onMounted(() => { window.addEventListener('keydown', onKeyDown) })
  onUnmounted(() => { window.removeEventListener('keydown', onKeyDown) })
}
