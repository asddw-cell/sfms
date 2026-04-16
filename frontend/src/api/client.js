/**
 * api/client.js
 * Axios instance pre-configured for the SFMS API.
 * In dev mode, injects X-Dev-User header on every request so the
 * FastAPI dev auth stub knows which user to resolve.
 * DevUserSwitcher writes to localStorage and reloads the page —
 * this file picks up the new value automatically on reload.
 */
import axios from 'axios'

// DEV AUTH STUB — read active dev user from localStorage.
// Falls back to VITE_DEV_USER (from .env) if nothing has been selected yet.
// Remove this and replace with MSAL Bearer token injection for production.
const DEV_USER = localStorage.getItem('sfms_dev_user')
  || import.meta.env.VITE_DEV_USER
  || 'admin'

const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
    'X-Dev-User': DEV_USER,
  },
})

// Global error handler — surfaces API error detail messages
client.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = error.response?.data?.detail || error.message || 'Unknown error'
    console.error('[SFMS API Error]', detail)
    return Promise.reject(new Error(detail))
  }
)

export default client