import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { fetchMe } from './api/sfms'
import ForecastGrid from './pages/ForecastGrid/ForecastGrid'
import Changes from './pages/Changes/Changes'
import UserAdmin from './pages/Admin/UserAdmin'
import './index.css'
import DevUserSwitcher from './components/DevUserSwitcher'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function Nav() {
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe })
  return (
    <nav className="nav">
      <img src="/goliath-logo.png" alt="Goliath" className="nav-logo" />
      <NavLink to="/forecast">Forecast Entry</NavLink>
      <NavLink to="/changes">Change History</NavLink>
      {me?.role?.CanManageUsers && (
        <NavLink to="/admin/users">User Admin</NavLink>
      )}
      <span className="nav-spacer" />
      {me && (
        <span className="nav-user">
          {me.DisplayName} &middot; {me.role?.Name}
        </span>
      )}
      <DevUserSwitcher />
    </nav>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="app-shell">
          <Nav />
          <main className="app-content">
            <Routes>
              <Route path="/" element={<Navigate to="/forecast" replace />} />
              <Route path="/forecast" element={<ForecastGrid />} />
              <Route path="/changes" element={<Changes />} />
              <Route path="/admin/users" element={<UserAdmin />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
