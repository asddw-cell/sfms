/**
 * auth/AuthProvider.jsx
 * Single auth entry-point component, mirroring the backend's one-resolved-
 * dependency pattern (app/auth/__init__.py switches on ENVIRONMENT).
 *
 * Switch VITE_AUTH_MODE=entra to enable real Entra ID authentication.
 * Leave at VITE_AUTH_MODE=dev (or unset) for the local-dev no-op path.
 */
import { useEffect } from 'react'
import { InteractionStatus } from '@azure/msal-browser'
import { MsalProvider, useIsAuthenticated, useMsal } from '@azure/msal-react'
import { msalInstance, apiScopes } from './msalConfig.js'

/**
 * Inner gate rendered only in entra mode.
 * Triggers a loginRedirect when no active account is present.
 *
 * DECISION POINT — deep-link preservation on session expiry:
 * After a redirect login the user lands at the app root (/), not the page they
 * were on before re-authenticating. To add deep-link preservation later:
 *   1. Stash window.location.pathname in sessionStorage immediately before
 *      calling instance.loginRedirect().
 *   2. Read it back here (after isAuthenticated becomes true) and call
 *      navigate() to the stashed path.
 */
function EntraAuthGate({ children }) {
  const isAuthenticated = useIsAuthenticated()
  const { instance, inProgress } = useMsal()

  // Guard against interaction_in_progress BrowserAuthError: only call
  // loginRedirect when MSAL has no interaction already in flight.
  useEffect(() => {
    if (!isAuthenticated && inProgress === InteractionStatus.None) {
      instance.loginRedirect(apiScopes)
    }
  }, [isAuthenticated, inProgress, instance])

  if (!isAuthenticated) {
    return <div>Redirecting to sign-in...</div>
  }

  return children
}

export default function AuthProvider({ children }) {
  // Read at render time (not module level) so vi.stubEnv works in tests
  // without requiring module reloads.
  const authMode = import.meta.env.VITE_AUTH_MODE

  // dev mode: intentional no-op — renders children directly with no MSAL
  // wrapping, identical to the current behaviour before auth was added.
  if (authMode !== 'entra') {
    return children
  }

  return (
    <MsalProvider instance={msalInstance}>
      <EntraAuthGate>{children}</EntraAuthGate>
    </MsalProvider>
  )
}
