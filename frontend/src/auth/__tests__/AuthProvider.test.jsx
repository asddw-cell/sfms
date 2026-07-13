/**
 * src/auth/__tests__/AuthProvider.test.jsx
 *
 * Tests for AuthProvider:
 *  1. dev mode  — renders children directly, no MsalProvider wrapper
 *  2. entra mode, no account — wraps in MsalProvider, calls loginRedirect
 */
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mocks ─────────────────────────────────────────────────────────────
// These are hoisted before any imports by Vitest's mock-hoisting transform.

const mockLoginRedirect = vi.fn()

vi.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }) => (
    <div data-testid="msal-provider">{children}</div>
  ),
  useIsAuthenticated: vi.fn(),
  useMsal: vi.fn(),
}))

vi.mock('../../auth/msalConfig.js', () => ({
  msalInstance: { /* stub — never actually used in these tests */ },
  apiScopes: { scopes: ['api://sfms-api/forecast.readwrite'] },
}))

// Resolve the mocked hooks lazily so we can change behaviour per test.
import { useIsAuthenticated, useMsal } from '@azure/msal-react'

// ── Dev mode ─────────────────────────────────────────────────────────────────

describe('AuthProvider — dev mode (VITE_AUTH_MODE=dev)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'dev')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders children directly with no MsalProvider wrapper', async () => {
    // Re-import after stubbing the env so the component sees the new value.
    vi.resetModules()
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    render(
      <AuthProvider>
        <span data-testid="child">Hello</span>
      </AuthProvider>
    )

    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('msal-provider')).not.toBeInTheDocument()
  })
})

// ── Entra mode ───────────────────────────────────────────────────────────────

describe('AuthProvider — entra mode (VITE_AUTH_MODE=entra)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'entra')
    useIsAuthenticated.mockReturnValue(false)
    useMsal.mockReturnValue({ instance: { loginRedirect: mockLoginRedirect } })
    mockLoginRedirect.mockReset()
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('wraps children in MsalProvider', async () => {
    useIsAuthenticated.mockReturnValue(true)
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    render(
      <AuthProvider>
        <span data-testid="child">Hello</span>
      </AuthProvider>
    )

    expect(screen.getByTestId('msal-provider')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('calls loginRedirect when no account is authenticated', async () => {
    useIsAuthenticated.mockReturnValue(false)
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    await act(async () => {
      render(
        <AuthProvider>
          <span data-testid="child">Hello</span>
        </AuthProvider>
      )
    })

    expect(mockLoginRedirect).toHaveBeenCalledOnce()
    // Children are not rendered while unauthenticated
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
    // Placeholder is shown instead
    expect(screen.getByText('Redirecting to sign-in...')).toBeInTheDocument()
  })
})
