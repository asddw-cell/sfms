/**
 * src/auth/__tests__/AuthProvider.test.jsx
 *
 * Tests for AuthProvider:
 *  1. dev mode  — renders children directly, no MsalProvider wrapper
 *  2. entra mode, authenticated — wraps in MsalProvider, renders children
 *  3. entra mode, no account, inProgress=None — calls loginRedirect, shows placeholder
 *  4. entra mode, no account, inProgress≠None — does NOT call loginRedirect (interaction in flight)
 */
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mocks ──────────────────────────────────────────────────────────────
// Hoisted before any imports by Vitest's mock-hoisting transform.

const mockLoginRedirect = vi.fn()

vi.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }) => (
    <div data-testid="msal-provider">{children}</div>
  ),
  useIsAuthenticated: vi.fn(),
  useMsal: vi.fn(),
}))

vi.mock('@azure/msal-browser', () => ({
  InteractionStatus: { None: 'none', Login: 'login', HandleRedirect: 'handleRedirect' },
  PublicClientApplication: vi.fn(),
}))

vi.mock('../../auth/msalConfig.js', () => ({
  msalInstance: {},
  apiScopes: { scopes: ['api://sfms-api/forecast.readwrite'] },
}))

import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'

// ── Dev mode ──────────────────────────────────────────────────────────────────

describe('AuthProvider — dev mode (VITE_AUTH_MODE=dev)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'dev')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('renders children directly with no MsalProvider wrapper', async () => {
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

// ── Entra mode ────────────────────────────────────────────────────────────────

describe('AuthProvider — entra mode (VITE_AUTH_MODE=entra)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'entra')
    mockLoginRedirect.mockReset()
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('wraps children in MsalProvider when authenticated', async () => {
    useIsAuthenticated.mockReturnValue(true)
    useMsal.mockReturnValue({ instance: { loginRedirect: mockLoginRedirect }, inProgress: InteractionStatus.None })
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    render(
      <AuthProvider>
        <span data-testid="child">Hello</span>
      </AuthProvider>
    )

    expect(screen.getByTestId('msal-provider')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
  })

  it('calls loginRedirect when unauthenticated and inProgress=None', async () => {
    useIsAuthenticated.mockReturnValue(false)
    useMsal.mockReturnValue({ instance: { loginRedirect: mockLoginRedirect }, inProgress: InteractionStatus.None })
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    await act(async () => {
      render(
        <AuthProvider>
          <span data-testid="child">Hello</span>
        </AuthProvider>
      )
    })

    expect(mockLoginRedirect).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
    expect(screen.getByText('Redirecting to sign-in...')).toBeInTheDocument()
  })

  it('does NOT call loginRedirect when a redirect is already in flight', async () => {
    useIsAuthenticated.mockReturnValue(false)
    useMsal.mockReturnValue({ instance: { loginRedirect: mockLoginRedirect }, inProgress: InteractionStatus.HandleRedirect })
    const { default: AuthProvider } = await import('../AuthProvider.jsx')

    await act(async () => {
      render(
        <AuthProvider>
          <span data-testid="child">Hello</span>
        </AuthProvider>
      )
    })

    expect(mockLoginRedirect).not.toHaveBeenCalled()
    expect(screen.getByText('Redirecting to sign-in...')).toBeInTheDocument()
  })
})
