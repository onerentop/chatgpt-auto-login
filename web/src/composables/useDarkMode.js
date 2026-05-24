/**
 * Dark mode toggle + persistence.
 *
 * Element Plus reads dark variables from `html.dark`, so we just flip the
 * class on `documentElement`. main.js applies the saved preference (or the
 * OS preference, when no override has been stored) before mount so first
 * paint matches.
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'

const isDark = ref(false)

function syncFromDom() {
  isDark.value = document.documentElement.classList.contains('dark')
}

let mediaQuery = null
function onSystemPrefChange() {
  // Only follow the OS preference when the user hasn't explicitly chosen.
  if (localStorage.getItem('theme')) return
  syncFromDom()
}

export function useDarkMode() {
  onMounted(() => {
    syncFromDom()
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (mediaQuery) {
      mediaQuery.addEventListener('change', onSystemPrefChange)
    }
  })
  onUnmounted(() => {
    if (mediaQuery) mediaQuery.removeEventListener('change', onSystemPrefChange)
  })

  const dark = computed(() => isDark.value)
  function toggle() {
    const next = !isDark.value
    if (next) document.documentElement.classList.add('dark')
    else document.documentElement.classList.remove('dark')
    localStorage.setItem('theme', next ? 'dark' : 'light')
    isDark.value = next
  }

  return { dark, toggle }
}
