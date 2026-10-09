/**
 * src/api/__tests__/client.test.js
 *
 * Tests for the client.js request interceptor:
 *  1. dev mode  — X-Dev-User default header is set from VITE_DEV_USER
 *  2. entra mode — Authorization: Bearer <token> is set; X-Dev-User is absent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock getAccessToken so the entra interceptor never calls real MSAL.
// This mock is registered before any module is imported and persists across
// vi.resetModules() calls (mock registry is separate from the module cache).
vi.mock('../../auth/getAccessToken.js', () => ({
  getAccessToken: vi.fn(),
}))

// msalConfig.js is imported transitively by getAccessToken.js; mock it so
// no PublicClientApplication is ever constructed in tests.
vi.mock('../../auth/msalConfig.js', () => ({
  msalInstance: null,
  apiScopes: { scopes: ['api://test'] },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadClient() {
  // Always re-import after vi.resetModules() so AUTH_MODE is re-evaluated.
  const { default: client } = await import('../client.js')
  return client
}

function getRequestInterceptorFn(client) {
  // Axios stores interceptors as {fulfilled, rejected, ...} objects.
  // The first handler added is index 0.
  return client.interceptors.request.handlers[0].fulfilled
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('client — dev mode (VITE_AUTH_MODE=dev)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'dev')
    vi.stubEnv('VITE_DEV_USER', 'test-user')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sets X-Dev-User default from VITE_DEV_USER', async () => {
    const client = await loadClient()
    expect(client.defaults.headers.common['X-Dev-User']).toBe('test-user')
  })

  it('request interceptor does not add Authorization header', async () => {
    const client = await loadClient()
    const intercept = getRequestInterceptorFn(client)

    const config = { headers: {} }
    const result = await intercept(config)

    expect(result.headers['Authorization']).toBeUndefined()
  })
})

describe('client — entra mode (VITE_AUTH_MODE=entra)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'entra')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('request interceptor sets Authorization: Bearer <token>', async () => {
    // Configure the mock return value for this test run.
    const { getAccessToken } = await import('../../auth/getAccessToken.js')
    getAccessToken.mockResolvedValue('mock-access-token')

    const client = await loadClient()
    const intercept = getRequestInterceptorFn(client)

    const config = { headers: {} }
    const result = await intercept(config)

    expect(result.headers['Authorization']).toBe('Bearer mock-access-token')
  })

  it('request interceptor removes X-Dev-User if present', async () => {
    const { getAccessToken } = await import('../../auth/getAccessToken.js')
    getAccessToken.mockResolvedValue('mock-access-token')

    const client = await loadClient()
    const intercept = getRequestInterceptorFn(client)

    const config = { headers: { 'X-Dev-User': 'stale-dev-user' } }
    const result = await intercept(config)

    expect(result.headers['X-Dev-User']).toBeUndefined()
    expect(result.headers['Authorization']).toBe('Bearer mock-access-token')
  })

  it('does not set X-Dev-User default header', async () => {
    const client = await loadClient()
    expect(client.defaults.headers.common['X-Dev-User']).toBeUndefined()
  })
})
