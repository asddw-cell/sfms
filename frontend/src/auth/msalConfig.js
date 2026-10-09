/**
 * auth/msalConfig.js
 * MSAL configuration and singleton instance — only meaningful when
 * VITE_AUTH_MODE=entra. The instance is guarded so that importing this
 * file in dev mode (where VITE_ENTRA_CLIENT_ID is unset) does not throw.
 */
import { PublicClientApplication } from '@azure/msal-browser'

export const msalConfig = {
  auth: {
    clientId:    import.meta.env.VITE_ENTRA_CLIENT_ID ?? '',
    authority:   import.meta.env.VITE_ENTRA_AUTHORITY ?? '',
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation:        'sessionStorage',
    storeAuthStateInCookie: false,
  },
}

export const apiScopes = {
  scopes: [import.meta.env.VITE_API_SCOPE ?? ''],
}

// Only create and initialize the PCA when the required env vars are present.
// If VITE_AUTH_MODE=dev the env vars will be absent, msalInstance will be null,
// and no MSAL network call is made.
const _canInit = Boolean(
  import.meta.env.VITE_ENTRA_CLIENT_ID && import.meta.env.VITE_ENTRA_AUTHORITY
)

// Initialize in the app bootstrap (main.jsx) via msalInstance.initialize(),
// not here — top-level await is not supported in esbuild's default target.
export const msalInstance = _canInit
  ? new PublicClientApplication(msalConfig)
  : null
