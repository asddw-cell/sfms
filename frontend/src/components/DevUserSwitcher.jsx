/**
 * DevUserSwitcher.jsx
 * DEV ONLY — shows a user picker in the nav bar that updates the X-Dev-User
 * header used by the dev auth stub. Remove this component before production.
 * Reads available users from /api/v1/admin/users and persists the selection
 * to localStorage so it survives page refresh.
 */
import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import client from '../api/client'
import { getDevUser, setDevUser } from '../api/devUser'

export default function DevUserSwitcher() {
  const [open, setOpen] = useState(false)
  const ref = useRef()

  const { data: users = [], isLoading, error } = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => client.get('/admin/users').then(r => r.data),
    staleTime: Infinity,
    retry: false,
  })

  const [currentUser, setCurrentUser] = useState(getDevUser)

  // Close on outside click
  useEffect(() => {
    function handle(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function switchUser(username) {
    setDevUser(username)
    setCurrentUser(username)
    setOpen(false)
    // Reload the page so all queries re-run with the new user
    window.location.reload()
  }

  const displayUser = users.find(u => u.Username === currentUser)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(255,255,255,0.15)',
          border: '1px solid rgba(255,255,255,0.3)',
          borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
          color: '#fff', fontSize: 12,
        }}
        title="DEV: Switch user (not available in production)"
      >
        <span style={{ opacity: 0.7, fontSize: 10 }}>DEV</span>
        <span>{displayUser?.DisplayName || currentUser || 'Select user'}</span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0,
          background: 'var(--c-surface)', border: '1px solid var(--c-border)',
          borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          minWidth: 240, zIndex: 2000, overflow: 'hidden',
        }}>
          <div style={{
            padding: '6px 12px', fontSize: 11, fontWeight: 600,
            color: 'var(--c-muted)', background: 'var(--c-bg)',
            borderBottom: '1px solid var(--c-border)',
            textTransform: 'uppercase', letterSpacing: '.4px',
          }}>
            Dev — Switch user
          </div>
          {isLoading && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--c-muted)' }}>
              Loading users…
            </div>
          )}
          {error && (
            <div style={{ padding: '10px 12px', fontSize: 12, color: '#c0392b' }}>
              Error: {error.message}
            </div>
          )}
          {users.map(u => (
            <div
              key={u.Username}
              onClick={() => switchUser(u.Username)}
              style={{
                padding: '9px 12px', cursor: 'pointer', fontSize: 13,
                background: u.Username === currentUser ? '#EAF0FB' : 'transparent',
                borderBottom: '1px solid var(--c-border)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.background = u.Username === currentUser ? '#daedf7' : 'var(--c-bg)'}
              onMouseLeave={e => e.currentTarget.style.background = u.Username === currentUser ? '#EAF0FB' : 'transparent'}
            >
              <div>
                <div style={{ fontWeight: u.Username === currentUser ? 600 : 400 }}>
                  {u.DisplayName}
                </div>
                <div style={{ fontSize: 11, color: 'var(--c-muted)' }}>
                  {u.Username}
                </div>
              </div>
              <span style={{
                fontSize: 11, padding: '2px 7px',
                background: '#e8f4fd', color: '#1a5276',
                borderRadius: 10, fontWeight: 600,
              }}>
                {u.RoleName || u.RoleCode}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
