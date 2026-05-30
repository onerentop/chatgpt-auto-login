import { reactive } from 'vue'

// Reactive store: email → stepId → { status, reason }
// Driven by `step-status` socket events; consumed by AccountStepDrawer.
export const stepStore = reactive({ byEmail: {} })

export function recordStepStatus({ email, stepId, status, reason }) {
  if (!email || !stepId) return
  if (!stepStore.byEmail[email]) stepStore.byEmail[email] = {}
  stepStore.byEmail[email][stepId] = { status, reason: reason || '' }
}

export function clearSteps(email) {
  if (stepStore.byEmail[email]) delete stepStore.byEmail[email]
}
