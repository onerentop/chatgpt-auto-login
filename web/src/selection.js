// Cross-route persistent selection state
// Each view (execute / accounts) has its own Set of selected emails.
// Components subscribe + push updates here so selection survives route
// switches.

import { reactive } from 'vue'

const state = reactive({
  execute: new Set(),
  accounts: new Set(),
})

export function getSelectionSet(page) {
  if (!state[page]) state[page] = new Set()
  return state[page]
}

export function setSelectionFromRows(page, rows) {
  state[page] = new Set(rows.map(r => r.email))
}

export function clearSelection(page) {
  state[page] = new Set()
}
