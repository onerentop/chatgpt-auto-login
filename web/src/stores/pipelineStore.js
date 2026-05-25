/**
 * Pipeline progress store — global tracker for "what is the engine doing
 * right now". Driven by socket events; consumed by PipelineHUD which
 * floats above any view so the user always sees in-flight progress.
 *
 * Lifecycle:
 *   - Execute.vue calls beginPipeline(total) when /api/execute POST fires
 *   - socket 'account-status' updates currentEmail / currentPhase
 *   - socket 'execution-complete' calls endPipeline()
 *   - Engine status polling (Execute.vue) can also call beginPipeline if
 *     it detects status === 'running' but store is idle (recover after
 *     page refresh while pipeline is still going).
 *
 * ETA: averages the last 5 per-account durations, multiplies by remaining.
 * Falls back to "—" while fewer than 2 samples exist.
 */

import { reactive, computed } from 'vue'

export const pipelineStore = reactive({
  running: false,
  total: 0,
  done: 0,
  currentEmail: '',
  currentPhase: '',
  startedAt: 0,           // ms — pipeline start
  lastEventAt: 0,         // ms — last account-status event
  recentDurations: [],    // ms[] — last 5 per-account durations
  _accountStartedAt: 0,   // ms — current account's start
  _lastEmail: '',
})

export function beginPipeline(total) {
  pipelineStore.running = true
  pipelineStore.total = total || 0
  pipelineStore.done = 0
  pipelineStore.currentEmail = ''
  pipelineStore.currentPhase = ''
  pipelineStore.startedAt = Date.now()
  pipelineStore.lastEventAt = Date.now()
  pipelineStore.recentDurations = []
  pipelineStore._accountStartedAt = 0
  pipelineStore._lastEmail = ''
}

export function endPipeline() {
  pipelineStore.running = false
  pipelineStore.currentEmail = ''
  pipelineStore.currentPhase = ''
  pipelineStore._accountStartedAt = 0
  pipelineStore._lastEmail = ''
}

/**
 * Called for each `account-status` socket event. Tracks the current
 * account + phase, and records duration when an account terminates
 * (status leaves 'running' / 'idle' / 'checking').
 */
const TERMINAL_OR_IDLE = new Set([
  'plus', 'plus_no_rt', 'error', 'no_link', 'no_promo', 'verify_error',
  'no_jp_proxy', 'paypal_captcha', 'login_fail', 'token_expired',
  'aborted', 'canceled', 'deactivated', 'idle',
])

export function recordAccountStatus({ email, status, phase }) {
  if (!pipelineStore.running) return
  pipelineStore.lastEventAt = Date.now()
  // New account?
  if (email && email !== pipelineStore._lastEmail) {
    // Previous account terminated — record its duration.
    if (pipelineStore._lastEmail && pipelineStore._accountStartedAt > 0) {
      const dur = Date.now() - pipelineStore._accountStartedAt
      if (dur > 1000 && dur < 30 * 60 * 1000) {
        pipelineStore.recentDurations.push(dur)
        if (pipelineStore.recentDurations.length > 5) {
          pipelineStore.recentDurations.shift()
        }
      }
    }
    pipelineStore._accountStartedAt = Date.now()
    pipelineStore._lastEmail = email
    pipelineStore.currentEmail = email
  }
  if (phase) pipelineStore.currentPhase = phase
  // Tick done if status moved to a terminal state.
  if (status && TERMINAL_OR_IDLE.has(status) && status !== 'idle' && status !== 'running') {
    pipelineStore.done = Math.min(pipelineStore.total, pipelineStore.done + 1)
  }
}

export const etaSeconds = computed(() => {
  const remaining = Math.max(0, pipelineStore.total - pipelineStore.done)
  if (remaining === 0) return 0
  const samples = pipelineStore.recentDurations
  if (samples.length < 2) return null
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length
  return Math.round((avg * remaining) / 1000)
})

export const elapsedSeconds = computed(() => {
  if (!pipelineStore.startedAt) return 0
  return Math.round((Date.now() - pipelineStore.startedAt) / 1000)
})

export function formatDuration(sec) {
  if (sec == null) return '—'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
