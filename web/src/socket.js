import { reactive } from 'vue'
import { io } from 'socket.io-client'

let socket = null

export const socketState = reactive({
  connected: false,
  logs: [],
  accountStatuses: {},
})

export function connectSocket() {
  if (socket && socket.connected) return

  const token = localStorage.getItem('token')
  socket = io({
    autoConnect: false,
    auth: { token },
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
    socketState.logs.push({
      timestamp: new Date().toISOString(),
      email: '',
      message: `Execution complete: ${data.success} success, ${data.failed} failed`,
      level: 'success',
    })
  })

  socket.connect()
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
    socketState.connected = false
  }
}
