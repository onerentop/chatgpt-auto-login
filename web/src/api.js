import axios from 'axios'
import { pushNotification } from './notifications'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

// FX-13: automatically record server-side errors (5xx) and network failures
// into the notification center so users can review past errors. 4xx is
// left to the calling code — those are usually expected business rejections
// (e.g. 409 "pipeline already running") that have their own UI feedback.
api.interceptors.response.use(
  (resp) => resp,
  (err) => {
    const status = err?.response?.status
    const url = err?.config?.url || ''
    const method = (err?.config?.method || 'get').toUpperCase()
    if (!status) {
      // Network error / timeout / CORS — surface unconditionally.
      pushNotification({
        level: 'error',
        title: '网络请求失败',
        message: `${method} ${url} — ${err.message || 'no response'}`,
      })
    } else if (status >= 500) {
      pushNotification({
        level: 'error',
        title: `服务端 ${status}`,
        message: `${method} ${url} — ${err.response?.data?.error || err.message}`,
      })
    }
    // 4xx: caller's responsibility (they'll typically ElMessage.error it).
    return Promise.reject(err)
  },
)

export default api
