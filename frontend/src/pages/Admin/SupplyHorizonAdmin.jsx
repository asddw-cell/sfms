/**
 * SupplyHorizonAdmin.jsx
 *
 * Admin page for managing the supply horizon rules (tblSupplyHorizon).
 * Lists all BU+channel horizon rules. Allows add, edit (horizon months),
 * and deactivate. Displays the system default (3 months) as a read-only
 * reference row at the top of the table.
 *
 * Route: /admin/supply-horizon
 * Min role: Admin (CanManageUsers)
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchSupplyHorizons, fetchBusinessUnits, fetchSalesChannels,
  createSupplyHorizon, updateSupplyHorizon, deactivateSupplyHorizon,
} from '../../api/sfms'

const DEFAULT_HORIZON = 3

export default function SupplyHorizonAdmin() {
  const qc = useQueryClient()

  const { data: horizons  = [], isLoading } = useQuery({ queryKey: ['supply-horizons'],  queryFn: fetchSupplyHorizons })
  const { data: bus        = [] }            = useQuery({ queryKey: ['bus'],              queryFn: fetchBusinessUnits })
  const { data: channels   = [] }            = useQuery({ queryKey: ['chns'],             queryFn: fetchSalesChannels })

  const [editing,   setEditing]   = useState(null)  // { horizonId, months } | null
  const [adding,    setAdding]    = useState(false)
  const [newRule,   setNewRule]   = useState({ BusinessUnitCode: '', SalesChannelCode: '', HorizonMonths: 3 })
  const [error,     setError]     = useState('')
  const [saving,    setSaving]    = useState(false)

  async function handleSaveEdit() {
    if (editing.months < 0 || isNaN(editing.months)) {
      setError('Horizon months must be 0 or greater.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await updateSupplyHorizon(editing.horizonId, { HorizonMonths: Number(editing.months) })
      await qc.invalidateQueries({ queryKey: ['supply-horizons'] })
      setEditing(null)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeactivate(horizonId) {
    if (!window.confirm('Deactivate this horizon rule? The system default will apply for this BU/channel.')) return
    setSaving(true)
    setError('')
    try {
      await deactivateSupplyHorizon(horizonId)
      await qc.invalidateQueries({ queryKey: ['supply-horizons'] })
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleAdd() {
    if (!newRule.BusinessUnitCode || !newRule.SalesChannelCode) {
      setError('Select a Business Unit and Sales Channel.')
      return
    }
    if (newRule.HorizonMonths < 0 || isNaN(newRule.HorizonMonths)) {
      setError('Horizon months must be 0 or greater.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await createSupplyHorizon({ ...newRule, HorizonMonths: Number(newRule.HorizonMonths) })
      await qc.invalidateQueries({ queryKey: ['supply-horizons'] })
      setAdding(false)
      setNewRule({ BusinessUnitCode: '', SalesChannelCode: '', HorizonMonths: 3 })
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card">
      <div className="card-title">Supply Horizon Configuration</div>

      <p style={{ fontSize: 13, color: 'var(--c-muted)', marginBottom: 16 }}>
        Defines the lead-time horizon (in months) per Business Unit and Sales Channel.
        Supply forecast rows within the horizon window are locked from auto-sync.
        The system default is <strong>{DEFAULT_HORIZON} months</strong> for any
        BU/channel combination not listed below.
      </p>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      {isLoading ? (
        <div className="loading">Loading…</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--c-bg)', borderBottom: '2px solid var(--c-border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Business Unit</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Sales Channel</th>
              <th style={{ textAlign: 'center', padding: '8px 12px' }}>Horizon (months)</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }} />
            </tr>
          </thead>
          <tbody>
            {/* System default reference row */}
            <tr style={{ borderBottom: '1px solid var(--c-border)', background: 'var(--c-bg)', color: 'var(--c-muted)' }}>
              <td style={{ padding: '8px 12px', fontStyle: 'italic' }}>System default</td>
              <td style={{ padding: '8px 12px', fontStyle: 'italic' }}>All (fallback)</td>
              <td style={{ padding: '8px 12px', textAlign: 'center', fontStyle: 'italic' }}>{DEFAULT_HORIZON}</td>
              <td style={{ padding: '8px 12px', fontStyle: 'italic' }}>Read-only</td>
              <td />
            </tr>

            {horizons.map(h => (
              <tr key={h.HorizonID} style={{ borderBottom: '1px solid var(--c-border)' }}>
                <td style={{ padding: '8px 12px' }}>
                  {bus.find(b => b.Code === h.BusinessUnitCode)?.Name || h.BusinessUnitCode}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {h.SalesChannelCode}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  {editing?.horizonId === h.HorizonID ? (
                    <input
                      type="number"
                      min="0"
                      value={editing.months}
                      onChange={e => setEditing(ed => ({ ...ed, months: e.target.value }))}
                      style={{ width: 60, textAlign: 'center' }}
                      disabled={saving}
                    />
                  ) : (
                    h.HorizonMonths
                  )}
                </td>
                <td style={{ padding: '8px 12px', color: h.IsActive ? 'var(--c-success)' : 'var(--c-muted)' }}>
                  {h.IsActive ? 'Active' : 'Inactive'}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {editing?.horizonId === h.HorizonID ? (
                    <>
                      <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving} style={{ marginRight: 6 }}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={saving}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {h.IsActive && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => { setEditing({ horizonId: h.HorizonID, months: h.HorizonMonths }); setError('') }}
                          style={{ marginRight: 6 }}
                        >
                          Edit
                        </button>
                      )}
                      {h.IsActive && (
                        <button className="btn btn-ghost" onClick={() => handleDeactivate(h.HorizonID)} disabled={saving}
                          style={{ color: 'var(--c-danger)', borderColor: 'var(--c-danger)' }}>
                          Deactivate
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}

            {/* Add new rule row */}
            {adding && (
              <tr style={{ borderBottom: '1px solid var(--c-border)', background: 'var(--c-bg)' }}>
                <td style={{ padding: '8px 12px' }}>
                  <select value={newRule.BusinessUnitCode} onChange={e => setNewRule(r => ({ ...r, BusinessUnitCode: e.target.value }))} style={{ width: '100%' }}>
                    <option value="">— Select BU —</option>
                    {bus.map(b => <option key={b.Code} value={b.Code}>{b.Name}</option>)}
                  </select>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <select value={newRule.SalesChannelCode} onChange={e => setNewRule(r => ({ ...r, SalesChannelCode: e.target.value }))} style={{ width: '100%' }}>
                    <option value="">— Select Channel —</option>
                    {channels.map(c => <option key={c.Code} value={c.Code}>{c.Name}</option>)}
                  </select>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <input type="number" min="0" value={newRule.HorizonMonths}
                    onChange={e => setNewRule(r => ({ ...r, HorizonMonths: e.target.value }))}
                    style={{ width: 60, textAlign: 'center' }} />
                </td>
                <td />
                <td style={{ padding: '8px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-primary" onClick={handleAdd} disabled={saving} style={{ marginRight: 6 }}>
                    {saving ? 'Adding…' : 'Add'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setAdding(false); setError('') }}>Cancel</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {!adding && (
        <button
          className="btn btn-primary"
          onClick={() => { setAdding(true); setError('') }}
          style={{ marginTop: 16 }}
        >
          + Add Rule
        </button>
      )}
    </div>
  )
}
