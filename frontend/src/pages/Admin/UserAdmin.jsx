/**
 * pages/Admin/UserAdmin.jsx
 * User management interface — Admin role only.
 * Lists all users, allows create/edit/deactivate, BU assignment,
 * horizon override, and per-BU customer restrictions.
 */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import client from '../../api/client'

// ── API helpers ───────────────────────────────────────────────────────────────
const fetchAllUsers   = () => client.get('/admin/users/all').then(r => r.data)
const fetchRoles      = () => client.get('/reference/roles').then(r => r.data)
const fetchBUs        = () => client.get('/reference/business-units').then(r => r.data)
const fetchCustomers  = (buCode) => client.get(`/reference/customers/${buCode}`).then(r => r.data)

// ── Helpers ───────────────────────────────────────────────────────────────────
const ROLE_COLOURS = {
  Admin:     { bg: '#fdebd0', color: '#784212' },
  PowerUser: { bg: '#d6eaf8', color: '#1a5276' },
  Manager:   { bg: '#d5f5e3', color: '#1e8449' },
  SalesUser: { bg: '#f2f3f4', color: '#566573' },
}
function RoleBadge({ name }) {
  const s = ROLE_COLOURS[name] || { bg: '#f2f3f4', color: '#566573' }
  return (
    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600, background: s.bg, color: s.color }}>
      {name}
    </span>
  )
}

// ── Customer selector for a single BU ─────────────────────────────────────────
function BUCustomerPanel({ userId, buCode, assignedCodes, roleDefault, onUpdate }) {
  const [horizon, setHorizon] = useState(roleDefault ?? 0)
  const [saving,  setSaving]  = useState(false)
  const [search,  setSearch]  = useState('')

  const { data: customers = [] } = useQuery({
    queryKey: ['admin-customers', buCode],
    queryFn: () => fetchCustomers(buCode),
    staleTime: 60000,
  })

  const filtered = search.trim()
    ? customers.filter(c => c.Name.toLowerCase().includes(search.toLowerCase()))
    : customers

  const [selected, setSelected] = useState(new Set(assignedCodes))
  const allSelected = customers.length > 0 && selected.size === 0  // empty = unrestricted

  function toggle(code) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(code) ? next.delete(code) : next.add(code)
      return next
    })
  }

  async function save() {
    setSaving(true)
    try {
      // Update horizon
      await client.put(`/admin/users/${userId}/bus/${buCode}`, {
        BusinessUnitCode: buCode,
        HorizonOverrideMonthsBack: horizon,
      })
      // Update customer restrictions
      await client.put(`/admin/users/${userId}/bus/${buCode}/customers`, {
        CustomerCodes: [...selected],
      })
      onUpdate()
    } catch (e) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--c-border)', borderRadius: 6, padding: 14, marginBottom: 10, background: 'var(--c-bg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{buCode}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--c-muted)' }}>
          <span>Editing locked for</span>
          <input
            type="number" min={0} max={99} value={horizon}
            onChange={e => setHorizon(Number(e.target.value))}
            style={{ width: 36, minWidth: 36, maxWidth: 36, height: 28, padding: '0 4px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 12, textAlign: 'center', boxSizing: 'border-box' }}
          />
          <span>future months</span>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 8 }}>
        Customer access —{' '}
        <strong style={{ color: selected.size === 0 ? '#1e8449' : 'var(--c-text)' }}>
          {selected.size === 0 ? 'All customers (unrestricted)' : `${selected.size} of ${customers.length} customers`}
        </strong>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="text" placeholder="Search customers…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, height: 28, padding: '0 8px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 12, background: 'var(--c-surface)' }}
        />
        <button
          onClick={() => setSelected(new Set())}
          style={{ fontSize: 11, padding: '0 10px', height: 28, border: '1px solid var(--c-border)', borderRadius: 4, background: selected.size === 0 ? '#d5f5e3' : 'var(--c-surface)', cursor: 'pointer', color: selected.size === 0 ? '#1e8449' : 'var(--c-muted)' }}
        >
          Unrestricted
        </button>
      </div>

      <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--c-border)', borderRadius: 4 }}>
        {filtered.map((c, i) => (
          <label key={c.Code} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13,
            background: selected.has(c.Code) ? '#eaf4fb' : i % 2 === 0 ? 'var(--c-surface)' : 'transparent',
            borderBottom: '1px solid var(--c-border)',
          }}>
            <input
              type="checkbox"
              checked={selected.has(c.Code)}
              onChange={() => toggle(c.Code)}
              style={{ accentColor: 'var(--c-accent)', width: 14, height: 14 }}
            />
            <span style={{ flex: 1 }}>{c.Name}</span>
            <span style={{ fontSize: 11, color: 'var(--c-muted)' }}>{c.Code}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '10px 12px', color: 'var(--c-muted)', fontSize: 12 }}>No customers found</div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button
          onClick={save} disabled={saving}
          style={{ padding: '6px 16px', background: 'var(--c-primary)', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── User detail panel ─────────────────────────────────────────────────────────
function UserDetailPanel({ user, roles, allBUs, onClose, onSaved }) {
  const qc = useQueryClient()

  // Editable fields
  const [displayName, setDisplayName] = useState(user?.DisplayName || '')
  const [email,       setEmail]       = useState(user?.Email || '')
  const [roleCode,    setRoleCode]    = useState(user?.RoleCode || '')
  const [isActive,    setIsActive]    = useState(user?.IsActive ?? true)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  // BU assignment
  const [addingBU,    setAddingBU]    = useState(false)
  const [newBUCode,   setNewBUCode]   = useState('')

  const isNew = !user?.UserID

  // username + ExternalIdentityID only for new users
  const [username, setUsername] = useState('')

  const selectedRole = roles.find(r => r.Code === Number(roleCode))
  const assignedBUCodes = new Set((user?.bu_assignments || []).map(b => b.BusinessUnitCode))
  const availableBUs = allBUs.filter(bu => !assignedBUCodes.has(bu.Code))

  async function saveUser() {
    setSaving(true)
    setError('')
    try {
      if (isNew) {
        await client.post('/admin/users', {
          Username: username,
          DisplayName: displayName,
          Email: email,
          ExternalIdentityID: username,
          RoleCode: Number(roleCode),
          IsActive: isActive,
        })
      } else {
        await client.put(`/admin/users/${user.UserID}`, {
          DisplayName: displayName,
          Email: email,
          RoleCode: Number(roleCode),
          IsActive: isActive,
        })
      }
      qc.invalidateQueries(['all-users'])
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function addBU() {
    if (!newBUCode) return
    try {
      await client.post(`/admin/users/${user.UserID}/bus`, {
        BusinessUnitCode: newBUCode,
        HorizonOverrideMonthsBack: selectedRole?.HorizonMonthsBack ?? 0,
      })
      qc.invalidateQueries(['all-users'])
      onSaved()
      setAddingBU(false)
      setNewBUCode('')
    } catch (e) {
      alert(e.message)
    }
  }

  async function removeBU(buCode) {
    if (!confirm(`Remove ${buCode} assignment? This will also remove any customer restrictions for this BU.`)) return
    try {
      await client.delete(`/admin/users/${user.UserID}/bus/${buCode}`)
      qc.invalidateQueries(['all-users'])
      onSaved()
    } catch (e) {
      alert(e.message)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', zIndex: 1000,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        width: 520, height: '100vh', overflowY: 'auto',
        background: 'var(--c-surface)', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
        padding: 24,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: 'var(--c-primary)' }}>
            {isNew ? 'New User' : user.DisplayName}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--c-muted)' }}>✕</button>
        </div>

        {error && <div style={{ background: '#fdecea', border: '1px solid #f1948a', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#c0392b', marginBottom: 12 }}>{error}</div>}

        {/* Core fields */}
        <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
          {isNew && (
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Username / UPN *</label>
              <input value={username} onChange={e => setUsername(e.target.value)}
                placeholder="firstname.lastname"
                style={{ width: '100%', height: 34, padding: '0 10px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' }} />
            </div>
          )}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Display Name *</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)}
              style={{ width: '100%', height: 34, padding: '0 10px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Email *</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email"
              style={{ width: '100%', height: 34, padding: '0 10px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Role *</label>
            <select value={roleCode} onChange={e => setRoleCode(e.target.value)}
              style={{ width: '100%', height: 34, padding: '0 8px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 13 }}>
              <option value="">— Select role —</option>
              {roles.map(r => <option key={r.Code} value={r.Code}>{r.Name}</option>)}
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--c-primary)' }} />
            Active user
          </label>
        </div>

        <button onClick={saveUser} disabled={saving || !displayName || !email || !roleCode}
          style={{ width: '100%', height: 36, background: 'var(--c-primary)', color: '#fff', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer', marginBottom: 24 }}>
          {saving ? 'Saving…' : isNew ? 'Create User' : 'Save Changes'}
        </button>

        {/* BU assignments — only shown for existing users */}
        {!isNew && (
          <>
            <div style={{ borderTop: '1px solid var(--c-border)', paddingTop: 16, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 13 }}>Responsibility Assignments</h4>
                {availableBUs.length > 0 && (
                  <button onClick={() => setAddingBU(v => !v)}
                    style={{ fontSize: 12, padding: '4px 12px', background: 'var(--c-primary)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                    + Add
                  </button>
                )}
              </div>

              {addingBU && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <select value={newBUCode} onChange={e => setNewBUCode(e.target.value)}
                    style={{ flex: 1, height: 32, padding: '0 8px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 12 }}>
                    <option value="">— Select responsibility —</option>
                    {availableBUs.map(bu => <option key={bu.Code} value={bu.Code}>{bu.Name} ({bu.Code})</option>)}
                  </select>
                  <button onClick={addBU} disabled={!newBUCode}
                    style={{ padding: '0 14px', height: 32, background: '#1e8449', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>
                    Assign
                  </button>
                  <button onClick={() => { setAddingBU(false); setNewBUCode('') }}
                    style={{ padding: '0 10px', height: 32, background: 'none', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              )}

              {user.bu_assignments.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--c-muted)', fontStyle: 'italic' }}>No responsibilities assigned.</p>
              )}

              {user.bu_assignments.map(ba => (
                <div key={ba.BusinessUnitCode} style={{ marginBottom: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <button onClick={() => removeBU(ba.BusinessUnitCode)}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid #f1948a', borderRadius: 4, color: '#c0392b', cursor: 'pointer' }}>
                      Remove {ba.BusinessUnitCode}
                    </button>
                  </div>
                  <BUCustomerPanel
                    userId={user.UserID}
                    buCode={ba.BusinessUnitCode}
                    assignedCodes={ba.customer_assignments.map(c => c.CustomerCode)}
                    roleDefault={selectedRole?.HorizonMonthsBack ?? 0}
                    onUpdate={() => { qc.invalidateQueries(['all-users']); onSaved() }}
                  />
                </div>
              ))}
            </div>

            {/* Audit info */}
            {user.CreatedDate && (
              <div style={{ fontSize: 11, color: 'var(--c-muted)', borderTop: '1px solid var(--c-border)', paddingTop: 12 }}>
                Created: {new Date(user.CreatedDate).toLocaleDateString()}<br />
                Last modified: {user.ModifiedDate ? new Date(user.ModifiedDate).toLocaleDateString() : '—'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function UserAdmin() {
  const qc = useQueryClient()
  const [selected,  setSelected]  = useState(null)  // user being edited
  const [showNew,   setShowNew]   = useState(false)
  const [search,    setSearch]    = useState('')

  const { data: users = [],  isLoading } = useQuery({ queryKey: ['all-users'],  queryFn: fetchAllUsers })
  const { data: roles = [] }             = useQuery({ queryKey: ['roles'],       queryFn: fetchRoles })
  const { data: allBUs = [] }            = useQuery({ queryKey: ['bus'],         queryFn: fetchBUs })

  const filtered = search.trim()
    ? users.filter(u =>
        u.DisplayName.toLowerCase().includes(search.toLowerCase()) ||
        u.Username.toLowerCase().includes(search.toLowerCase()) ||
        u.Email.toLowerCase().includes(search.toLowerCase())
      )
    : users

  function handleSaved() {
    // Invalidate the list so it refreshes in the background.
    // Do NOT update selected here — doing so after the user clicks X
    // would reopen the panel if the promise resolves after close.
    qc.invalidateQueries(['all-users'])
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--c-primary)' }}>User Management</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--c-muted)' }}>
            {users.length} users · {users.filter(u => u.IsActive).length} active
          </p>
        </div>
        <button onClick={() => { setShowNew(true); setSelected(null) }}
          style={{ padding: '8px 18px', background: 'var(--c-primary)', color: '#fff', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + New User
        </button>
      </div>

      <input
        type="text" placeholder="Search by name, username or email…" value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', height: 36, padding: '0 12px', border: '1px solid var(--c-border)', borderRadius: 4, fontSize: 13, marginBottom: 16, boxSizing: 'border-box', background: 'var(--c-surface)' }}
      />

      {isLoading ? (
        <p style={{ color: 'var(--c-muted)', fontSize: 13 }}>Loading users…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#8B1A12' }}>
              {['Name', 'Username', 'Role', 'Responsibilities', 'Status', ''].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#fff', fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u, i) => (
              <tr key={u.UserID}
                style={{ background: i % 2 === 0 ? 'var(--c-surface)' : 'var(--c-bg)', borderBottom: '1px solid var(--c-border)', cursor: 'pointer' }}
                onClick={() => { setSelected(u); setShowNew(false) }}
              >
                <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                  {u.DisplayName}
                  {!u.IsActive && <span style={{ marginLeft: 6, fontSize: 10, background: '#f2f3f4', color: '#999', padding: '1px 6px', borderRadius: 8 }}>Inactive</span>}
                </td>
                <td style={{ padding: '10px 12px', color: 'var(--c-muted)', fontSize: 12 }}>{u.Username}</td>
                <td style={{ padding: '10px 12px' }}><RoleBadge name={u.RoleName || ''} /></td>
                <td style={{ padding: '10px 12px' }}>
                  {u.bu_assignments?.length > 0
                    ? u.bu_assignments.map(b => (
                        <span key={b.BusinessUnitCode} style={{ fontSize: 11, marginRight: 4, padding: '1px 6px', background: '#eaf4fb', borderRadius: 8, color: '#1a5276' }}>
                          {b.BusinessUnitCode}
                          {b.customer_assignments?.length > 0 && ` (${b.customer_assignments.length})`}
                        </span>
                      ))
                    : <span style={{ color: 'var(--c-muted)', fontStyle: 'italic', fontSize: 12 }}>None</span>
                  }
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: u.IsActive ? '#d5f5e3' : '#f2f3f4', color: u.IsActive ? '#1e8449' : '#999' }}>
                    {u.IsActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--c-muted)', fontSize: 12 }}>Edit →</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--c-muted)', fontStyle: 'italic' }}>No users found</td></tr>
            )}
          </tbody>
        </table>
      )}

      {(selected || showNew) && (
        <UserDetailPanel
          user={showNew ? null : selected}
          roles={roles}
          allBUs={allBUs}
          onClose={() => { setSelected(null); setShowNew(false) }}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
