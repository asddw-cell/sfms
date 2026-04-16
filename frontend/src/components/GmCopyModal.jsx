/**
 * GmCopyModal.jsx
 * Allows PowerUser / Admin to copy a Sales forecast to GM for an entire BU.
 * Accessible from the Forecast Entry toolbar.
 */
import { useState } from 'react'
import MonthPicker from './MonthPicker'

function todayYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function elevenMonthsAheadYM() {
  const d = new Date()
  d.setMonth(d.getMonth() + 11)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function GmCopyModal({
  buCode,
  forecastTypes,   // all forecast types
  onCopy,          // fn(payload) → Promise<{deleted, inserted}>
  onClose,
}) {
  const salesTypes = forecastTypes.filter(ft => ft.Name.toLowerCase().includes('sales') || ft.Code)
  const gmTypes    = forecastTypes.filter(ft => ft.Name.toLowerCase().includes('gm')    || ft.Code)

  // Default source to first non-GM type, target to first GM type
  const defaultSource = forecastTypes.find(ft => !ft.Name.toLowerCase().includes('gm'))?.Code ?? ''
  const defaultTarget = forecastTypes.find(ft =>  ft.Name.toLowerCase().includes('gm'))?.Code ?? ''

  const [sourceFtCode, setSourceFtCode] = useState(String(defaultSource))
  const [targetFtCode, setTargetFtCode] = useState(String(defaultTarget))
  const [dateFrom,     setDateFrom]     = useState(todayYM())
  const [dateTo,       setDateTo]       = useState(elevenMonthsAheadYM())
  const [confirmed,    setConfirmed]    = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [result,       setResult]       = useState(null)
  const [error,        setError]        = useState('')

  async function handleCopy() {
    if (!sourceFtCode || !targetFtCode) { setError('Please select source and target forecast types.'); return }
    if (sourceFtCode === targetFtCode)  { setError('Source and target must be different.'); return }
    if (!dateFrom || !dateTo)           { setError('Please select a date range.'); return }
    if (dateFrom > dateTo)              { setError('"From" must be before "To".'); return }
    if (!confirmed)                     { setError('Please confirm you want to overwrite existing GM data.'); return }

    setSaving(true)
    setError('')
    try {
      const res = await onCopy({
        source_forecast_type_code: Number(sourceFtCode),
        target_forecast_type_code: Number(targetFtCode),
        date_from: dateFrom + '-01',
        date_to:   dateTo   + '-01',
      })
      setResult(res)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget && !saving) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{ width: 480 }}>
        {result ? (
          // ── Success state ──
          <>
            <h3 style={{ color: 'var(--c-success)', marginBottom: 12 }}>✓ Copy Complete</h3>
            <div style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.8 }}>
              <div><strong>Responsibility:</strong> {buCode}</div>
              <div><strong>Rows deleted:</strong> {result.deleted}</div>
              <div><strong>Rows inserted:</strong> {result.inserted}</div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          // ── Input state ──
          <>
            <h3 style={{ marginBottom: 4 }}>Copy Forecast to GM</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 16 }}>
              Copies all forecast rows from the selected source type to GM for <strong>{buCode}</strong>,
              across all customers and items in the date range.
            </p>

            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

            <div className="modal-row">
              <label>Copy from (source)</label>
              <select
                value={sourceFtCode}
                onChange={e => setSourceFtCode(e.target.value)}
                style={{ width: '100%', height: 34 }}
                disabled={saving}
              >
                <option value="">— Select —</option>
                {forecastTypes.map(ft => (
                  <option key={ft.Code} value={ft.Code}>{ft.Name}</option>
                ))}
              </select>
            </div>

            <div className="modal-row">
              <label>Copy to (target)</label>
              <select
                value={targetFtCode}
                onChange={e => setTargetFtCode(e.target.value)}
                style={{ width: '100%', height: 34 }}
                disabled={saving}
              >
                <option value="">— Select —</option>
                {forecastTypes.map(ft => (
                  <option key={ft.Code} value={ft.Code}>{ft.Name}</option>
                ))}
              </select>
            </div>

            <div className="modal-row">
              <label>From month</label>
              <MonthPicker value={dateFrom} onChange={setDateFrom} />
            </div>

            <div className="modal-row">
              <label>To month</label>
              <MonthPicker value={dateTo} onChange={setDateTo} />
            </div>

            <div style={{
              background: '#fdf0ee',
              border: '1px solid #f1948a',
              borderRadius: 'var(--radius)',
              padding: '10px 14px',
              fontSize: 12,
              color: '#922b21',
              marginTop: 16,
              marginBottom: 12,
            }}>
              ⚠ All existing <strong>{forecastTypes.find(ft => String(ft.Code) === targetFtCode)?.Name || 'target'}</strong> forecast
              rows for <strong>{buCode}</strong> between the selected months will be
              permanently deleted and replaced with the source data.
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
                disabled={saving}
                style={{ width: 15, height: 15, accentColor: 'var(--c-danger)' }}
              />
              I understand this will overwrite existing data and cannot be undone
            </label>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleCopy}
                disabled={saving || !confirmed}
                style={{ background: confirmed ? undefined : 'var(--c-muted)' }}
              >
                {saving ? 'Copying…' : 'Copy Forecast'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
