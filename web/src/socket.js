import { reactive } from 'vue'
import { io } from 'socket.io-client'

let socket = null

export const socketState = reactive({
  connected: false,
  logs: [],
  accountStatuses: {},
  aliveStatuses: {},   // email -> { alive_status, alive_reason, alive_checked_at }
  liveness: {          // batch-level
    running: false,
    done: 0,
    total: 0,
    failed: 0,
    summary: null,
  },
})

export function connectSocket() {
  if (socket && socket.connected) return

  socket = io({
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  })

  socket.on('connect', () => {
    socketState.connected = true
  })

  socket.on('disconnect', () => {
    socketState.connected = false
  })

  socket.on('log', (data) => {
    socketState.logs.push({
      timestamp: data.timestamp || new Date().toISOString(),
      email: data.email || '',
      message: data.message || data,
      level: data.level || 'info',
    })
    // Keep last 500 log entries
    if (socketState.logs.length > 500) {
      socketState.logs.splice(0, socketState.logs.length - 500)
    }
  })

  socket.on('account-status', (data) => {
    socketState.accountStatuses[data.email] = {
      email: data.email,
      phase: data.phase || 'idle',
      progress: data.progress || 0,
      status: data.status || 'pending',
    }
  })

  socket.on('execution-complete', (data) => {
    const s = data.summary || data;
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: '',
      message: `Execution complete: ${s.success ?? 0} success, ${s.error ?? 0} error, ${s.noLink ?? 0} no-link`,
      level: 'success',
    })
  })

  function pushLivenessLog(email, level, message, isHistorical = false) {
    const prefixed = message?.startsWith('[') ? message : `[liveness] ${message}`;
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: email || '',
      level,
      message: prefixed,
      source: 'liveness',
      isHistorical,
    });
    if (socketState.logs.length > 500) {
      socketState.logs.splice(0, socketState.logs.length - 500);
    }
  }

  socket.on('liveness-status', (data) => {
    socketState.aliveStatuses[data.email] = {
      alive_status: data.alive_status,
      alive_reason: data.alive_reason || '',
      alive_checked_at: data.alive_status === 'checking' ? '' : new Date().toISOString(),
    }
    const level = data.alive_status === 'plus' ? 'success'
                : data.alive_status === 'checking' ? 'info'
                : data.alive_status === 'canceled' ? 'warning'
                : data.alive_status === 'deactivated' || data.alive_status === 'token_expired' || data.alive_status === 'login_fail' ? 'error'
                : 'warning'
    pushLivenessLog(data.email, level, `${data.alive_status}${data.alive_reason ? ': ' + data.alive_reason : ''}`)
  })

  socket.on('liveness-progress', (data) => {
    socketState.liveness.done = data.done || 0
    socketState.liveness.total = data.total || 0
    socketState.liveness.failed = data.failed || 0
    socketState.liveness.running = (data.done || 0) < (data.total || 0)
  })

  socket.on('liveness-complete', (data) => {
    socketState.liveness.running = false
    socketState.liveness.summary = data.summary || null
    const s = data.summary || {}
    pushLivenessLog('', 'success', `done (${Math.round((data.durationMs||0)/1000)}s): plus=${s.plus||0} canceled=${s.canceled||0} login_fail=${s.login_fail||0} token_expired=${s.token_expired||0} proxy_error=${s.proxy_error||0} network_error=${s.network_error||0}`)
  })

  socket.on('liveness-log', (data) => {
    pushLivenessLog(data.email, data.level || 'info', data.message);
  });

  socket.connect()
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
    socketState.connected = false
  }
}

// Manual reconnect — for the AppLayout "重连" button when the socket has
// exhausted its automatic retries.
export function reconnectSocket() {
  if (socket && !socket.connected) {
    socket.connect()
    return
  }
  if (!socket) {
    connectSocket()
  }
}
