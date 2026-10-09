/**
 * auth/getAccessToken.js
 * Acquires a Bearer access token from MSAL for the configured API scope.
 * Only called in entra mode — never imported's side effects fire in dev mode
 * because the client interceptor never invokes this function.
 *
 * Flow:
 *  1. Try silent acquisition (MSAL returns a cached/refreshed token).
 *  2. On InteractionRequiredAuthError (or any error suggesting the silent path
 *     is unavailable), fall back to redirect — the browser navigates away and
 *     re-enters the app via the standard redirect-handling path, so no return
 *     value is expected from the fallback branch.
 */
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { msalInstance, apiScopes } from './msalConfig.js'

export async function getAccessToken() {
  const account = msalInstance.getAllAccounts()[0]

  try {
    const result = await msalInstance.acquireTokenSilent({ ...apiScopes, account })
    return result.accessToken
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      // Silent acquisition is not possible (consent required, session expired, etc.).
      // Redirect to Entra login — this navigates away; the token will be picked up
      // on return via the same redirect handling that initial login uses.
      await msalInstance.acquireTokenRedirect(apiScopes)
    } else {
      throw err
    }
  }
}
