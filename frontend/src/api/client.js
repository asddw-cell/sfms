/**
 * api/client.js
 * Axios instance pre-configured for the SFMS API.
 *
 * Auth mode is controlled by VITE_AUTH_MODE:
 *   "dev"   — injects X-Dev-User header (FastAPI dev_auth.py stub).
 *             DevUserSwitcher writes to localStorage; this module picks it up
 *             via client.defaults, so no reload is needed.
 *   "entra" — acquires a Bearer token via MSAL and sets Authorization header.
 *
 * MODE MISMATCH WARNING: A mismatch between VITE_AUTH_MODE and the backend's
 * ENVIRONMENT fails loudly as 401s on every request — backend entra.py reads
 * only "Authorization: Bearer …" and dev_auth.py reads only "X-Dev-User".
 * There is no silent fall-through between the two modes.
 */
import axios from 'axios'
import { getAccessToken } from '../auth/getAccessToken.js'

const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || 'dev'

const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
})

// dev mode: set the initial X-Dev-User default so devUser.js's runtime
// updates (client.defaults.headers.common['X-Dev-User'] = …) are reflected
// on subsequent requests without a page reload.
if (AUTH_MODE === 'dev') {
  const devUser = localStorage.getItem('sfms_dev_user')
    || import.meta.env.VITE_DEV_USER
    || 'admin'
  client.defaults.headers.common['X-Dev-User'] = devUser
}

// Request interceptor: attach the appropriate auth header per request.
client.interceptors.request.use(async (config) => {
  if (AUTH_MODE === 'entra') {
    const token = await getAccessToken()
    config.headers['Authorization'] = `Bearer ${token}`
    // Belt-and-suspenders: remove any stale X-Dev-User that might have leaked
    // into the merged defaults (e.g. from a mis-configured dev build).
    delete config.headers['X-Dev-User']
  }
  // dev mode: X-Dev-User already set in client.defaults — Axios merges it into
  // config.headers automatically; devUser.js updates client.defaults directly.
  return config
})

// Global response error handler — surfaces API error detail messages.
client.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = error.response?.data?.detail || error.message || 'Unknown error'
    console.error('[SFMS API Error]', detail)
    return Promise.reject(new Error(detail))
  }
)

export default client
