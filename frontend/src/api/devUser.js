/**
 * api/devUser.js
 * Helpers for the dev auth user switcher.
 * Kept separate from DevUserSwitcher.jsx so Vite Fast Refresh works correctly.
 */
import client from './client'

export const DEV_USER_KEY = 'sfms_dev_user'

export function getDevUser() {
  return localStorage.getItem(DEV_USER_KEY) || ''
}

export function setDevUser(username) {
  if (username) {
    localStorage.setItem(DEV_USER_KEY, username)
    client.defaults.headers.common['X-Dev-User'] = username
  }
}