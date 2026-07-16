import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { fetchMe } from './api/sfms'
import ForecastGrid from './pages/ForecastGrid/ForecastGrid'
import Changes from './pages/Changes/Changes'
import UserAdmin from './pages/Admin/UserAdmin'
import SupplyHorizonAdmin from './pages/Admin/SupplyHorizonAdmin'
import PriceMaintenance from './pages/PriceMaintenance/PriceMaintenance'
import './index.css'
import DevUserSwitcher from './components/DevUserSwitcher'
import { ThemeProvider, useTheme } from './ThemeContext'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}

function Nav() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe })
  const { theme, toggle } = useTheme()
  return (
    <nav className="nav">
      <img src="/goliath-logo.png" alt="Goliath" className="nav-logo" />
      <NavLink to="/forecast">Forecast Entry</NavLink>
      <NavLink to="/changes">Change History</NavLink>
      {me?.role?.CanManageRefData && (
        <NavLink to="/prices">Prices</NavLink>
      )}
      {me?.role?.CanManageUsers && (
        <NavLink to="/admin/users">User Admin</NavLink>
      )}
      {me?.role?.CanManageUsers && (
        <NavLink to="/admin/supply-horizon">Supply Horizons</NavLink>
      )}
      <span className="nav-spacer" />
      {me && (
        <span className="nav-user">
          {me.DisplayName} &middot; {me.role?.Name}
        </span>
      )}
      <button
        className="theme-toggle"
        onClick={toggle}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      {import.meta.env.VITE_AUTH_MODE === 'dev' && <DevUserSwitcher />}
    </nav>
  )
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <div className="app-shell">
            <Nav />
            <main className="app-content">
              <Routes>
                <Route path="/" element={<Navigate to="/forecast" replace />} />
                <Route path="/forecast" element={<ForecastGrid />} />
                <Route path="/changes" element={<Changes />} />
                <Route path="/prices" element={<PriceMaintenance />} />
                <Route path="/admin/users" element={<UserAdmin />} />
                <Route path="/admin/supply-horizon" element={<SupplyHorizonAdmin />} />
              </Routes>
            </main>
          </div>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

export default App
