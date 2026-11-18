/**
 * MigrateItemModal.jsx
 *
 * Wizard to move forecast quantities from one item variant to a sibling variant.
 * Steps: target selection → date range + type selection → preview → confirm → result.
 *
 * Props:
 *   sourceItem  — { itemNo, description, brandName } from the grid row
 *   buCode      — active business unit code
 *   dateFrom    — YYYY-MM string (pre-filled from grid range)
 *   dateTo      — YYYY-MM string (pre-filled from grid range)
 *   forecastTypes — array of { Code, Name } (all types from reference data)
 *   me          — current user object (for all_customers logic)
 *   onClose     — called when the modal is dismissed
 *   onDone      — called after a successful execute (triggers grid refresh)
 */
import { useState, useEffect } from 'react'
import MonthPicker from './MonthPicker'
import {
  fetchMigrateTargets,
  fetchMigrateTypeCounts,
  previewMigration,
  executeMigration,
} from '../api/sfms'

function todayYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function elevenMonthsAheadYM() {
  const d = new Date()
  d.setMonth(d.getMonth() + 11)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function formatMonthDisplay(ym) {
  if (!ym) return ''
  const [y, m] = ym.split('-')
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('default', { month: 'short', year: 'numeric' })
}

const STEP_CONFIG   = 0   // target, dates, types
const STEP_PREVIEW  = 1   // preview rows
const STEP_CONFIRM  = 2   // confirm screen
const STEP_RESULT   = 3   // result screen

export default function MigrateItemModal({
  sourceItem,
  buCode,
  customerCode,         // code of the clicked row's customer; empty string in item view
  customerName,         // display name for the customer (may be empty)
  dateFrom: initialDateFrom,
  dateTo:   initialDateTo,
  forecastTypes,
  me,
  onClose,
  onDone,
}) {
  // When no specific customer context (item view), default to all-customers mode
  const hasCustomer = !!customerCode

  const [step,             setStep]             = useState(STEP_CONFIG)
  const [targetItemNo,     setTargetItemNo]     = useState('')
  const [dateFrom,         setDateFrom]         = useState(todayYM())
  const [dateTo,           setDateTo]           = useState(initialDateTo   || elevenMonthsAheadYM())
  const [selectedTypes,    setSelectedTypes]    = useState([])
  const [allCustomers,     setAllCustomers]     = useState(!hasCustomer)
  const [onConflict,       setOnConflict]       = useState('skip')
  const [typeCustomerCount, setTypeCustomerCount] = useState(0)

  const [targets,          setTargets]          = useState([])
  const [targetSearch,     setTargetSearch]     = useState('')
  const [typeCounts,       setTypeCounts]       = useState([])
  const [previewRows,      setPreviewRows]      = useState([])
  const [previewValid,     setPreviewValid]     = useState(false)  // false → must re-preview
  const [result,           setResult]           = useState(null)

  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState('')

  // Load sibling targets on mount
  useEffect(() => {
    setLoading(true)
    fetchMigrateTargets(buCode, sourceItem.itemNo)
      .then(setTargets)
      .catch(e => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))
  }, [buCode, sourceItem.itemNo])

  // Load type counts whenever source, dates, BU, scope toggle or customerCode change
  useEffect(() => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return
    if (!allCustomers && !customerCode) return  // no scope to query
    fetchMigrateTypeCounts({
      bu_code:        buCode,
      source_item_no: sourceItem.itemNo,
      date_from:      dateFrom + '-01',
      date_to:        dateTo   + '-01',
      customer_code:  allCustomers ? null : customerCode,
      all_customers:  allCustomers,
    })
      .then(rows => {
        setTypeCounts(rows)
        setTypeCustomerCount(rows[0]?.customer_count ?? 0)
        // Keep previously ticked types that still have rows; auto-select all if first load
        const availableCodes = new Set(rows.map(r => r.forecast_type_code))
        setSelectedTypes(prev =>
          prev.length === 0
            ? rows.map(r => r.forecast_type_code)
            : prev.filter(c => availableCodes.has(c))
        )
        // Invalidate any existing preview so the user must re-run it
        setPreviewValid(false)
        setPreviewRows([])
      })
      .catch(() => {})
  }, [buCode, sourceItem.itemNo, dateFrom, dateTo, allCustomers, customerCode])

  // ── Step handlers ──────────────────────────────────────────────────────────

  async function handlePreview() {
    setError('')
    if (!targetItemNo)           { setError('Select a target item.'); return }
    if (!dateFrom || !dateTo)    { setError('Select a date range.'); return }
    if (dateFrom > dateTo)       { setError('"From" must be before "To".'); return }
    if (!selectedTypes.length)   { setError('Select at least one forecast type.'); return }

    setLoading(true)
    try {
      const rows = await previewMigration({
        bu_code:             buCode,
        source_item_no:      sourceItem.itemNo,
        target_item_no:      targetItemNo,
        date_from:           dateFrom + '-01',
        date_to:             dateTo   + '-01',
        forecast_type_codes: selectedTypes,
        customer_code:       allCustomers ? null : customerCode,
        all_customers:       allCustomers,
      })
      setPreviewRows(rows)
      setPreviewValid(true)
      setStep(STEP_PREVIEW)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleExecute() {
    setError('')
    setLoading(true)
    try {
      const res = await executeMigration({
        bu_code:             buCode,
        source_item_no:      sourceItem.itemNo,
        target_item_no:      targetItemNo,
        date_from:           dateFrom + '-01',
        date_to:             dateTo   + '-01',
        forecast_type_codes: selectedTypes,
        customer_code:       allCustomers ? null : customerCode,
        all_customers:       allCustomers,
        on_conflict:         onConflict,
      })
      setResult(res)
      setStep(STEP_RESULT)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDone() {
    onDone?.()
    onClose()
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget && !loading) onClose()
  }

  const conflictCount = previewRows.filter(r => r.has_conflict).length
  const targetItem    = targets.find(t => t.ItemNo === targetItemNo)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{ width: 580, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>

        {/* ── STEP_RESULT ── */}
        {step === STEP_RESULT && result && (
          <>
            <h3 style={{ color: 'var(--c-success)', marginBottom: 12 }}>✓ Migration Complete</h3>
            <div style={{ fontSize: 13, lineHeight: 1.9, marginBottom: 20 }}>
              <div><strong>Source:</strong> {sourceItem.itemNo}</div>
              <div><strong>Target:</strong> {targetItemNo}</div>
              <div><strong>Rows moved:</strong> {result.moved}</div>
              {result.overwritten > 0 && <div><strong>Rows overwritten:</strong> {result.overwritten}</div>}
              {result.skipped > 0     && <div><strong>Rows skipped (conflict):</strong> {result.skipped}</div>}
              {result.not_editable > 0 && <div><strong>Rows skipped (locked period):</strong> {result.not_editable}</div>}
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={handleDone}>Close &amp; Refresh</button>
            </div>
          </>
        )}

        {/* ── STEP_CONFIRM ── */}
        {step === STEP_CONFIRM && (
          <>
            <h3 style={{ marginBottom: 4 }}>Confirm Migration</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 16 }}>
              This will permanently move {previewRows.length - (onConflict === 'skip' ? 0 : 0)} rows from{' '}
              <strong>{sourceItem.itemNo}</strong> to <strong>{targetItemNo}</strong>. This cannot be undone.
            </p>

            {conflictCount > 0 && (
              <div style={{
                background: 'var(--c-alert-danger-bg)',
                border: '1px solid var(--c-alert-danger-border)',
                borderRadius: 'var(--radius)', padding: '10px 14px',
                fontSize: 12, color: 'var(--c-danger)', marginBottom: 16,
              }}>
                ⚠ <strong>{conflictCount}</strong> row(s) already exist on the target item.
              </div>
            )}

            {conflictCount > 0 && (
              <div className="modal-row" style={{ marginBottom: 16 }}>
                <label>On conflict</label>
                <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="radio" name="conflict" value="skip"      checked={onConflict === 'skip'}      onChange={() => setOnConflict('skip')}      />
                    Skip — keep existing target quantity
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="radio" name="conflict" value="overwrite" checked={onConflict === 'overwrite'} onChange={() => setOnConflict('overwrite')} />
                    Overwrite — replace with source quantity
                  </label>
                </div>
              </div>
            )}

            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setStep(STEP_PREVIEW)} disabled={loading}>Back</button>
              <button className="btn btn-primary" onClick={handleExecute} disabled={loading}>
                {loading ? 'Migrating…' : 'Confirm Migration'}
              </button>
            </div>
          </>
        )}

        {/* ── STEP_PREVIEW ── */}
        {step === STEP_PREVIEW && (
          <>
            <h3 style={{ marginBottom: 4 }}>Preview</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 12 }}>
              {previewRows.length} row(s) will be moved from <strong>{sourceItem.itemNo}</strong>{' '}
              to <strong>{targetItemNo}</strong>
              {' '}({formatMonthDisplay(dateFrom)} – {formatMonthDisplay(dateTo)}).
              {conflictCount > 0 && <span style={{ color: 'var(--c-danger)' }}> {conflictCount} conflict(s) detected.</span>}
            </p>

            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 12, minHeight: 0 }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--c-hover-row)', position: 'sticky', top: 0 }}>
                    <th style={thStyle}>Type</th>
                    <th style={thStyle}>Customer</th>
                    <th style={thStyle}>Month</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                    <th style={thStyle}>Conflict?</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} style={{ background: row.has_conflict ? 'var(--c-alert-danger-bg)' : undefined }}>
                      <td style={tdStyle}>{row.forecast_type_name}</td>
                      <td style={tdStyle}>{row.customer_code}</td>
                      <td style={tdStyle}>{row.forecast_date?.slice(0, 7)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {row.quantity != null ? Number(row.quantity).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
                      </td>
                      <td style={{ ...tdStyle, color: row.has_conflict ? 'var(--c-danger)' : 'var(--c-success)' }}>
                        {row.has_conflict ? '⚠ Yes' : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setStep(STEP_CONFIG)} disabled={loading}>Back</button>
              <button className="btn btn-primary" onClick={() => setStep(STEP_CONFIRM)} disabled={loading || !previewRows.length || !previewValid}>
                Continue
              </button>
            </div>
          </>
        )}

        {/* ── STEP_CONFIG ── */}
        {step === STEP_CONFIG && (
          <>
            <h3 style={{ marginBottom: 4 }}>Migrate Item Forecast</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 16 }}>
              Move forecast quantities from <strong>{sourceItem.itemNo}</strong>
              {sourceItem.description ? ` — ${sourceItem.description}` : ''} to a sibling variant.
            </p>

            {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

            <div className="modal-row">
              <label>Target item *</label>
              {loading && !targets.length ? (
                <div style={{ fontSize: 12, color: 'var(--c-muted)' }}>Loading items…</div>
              ) : targets.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--c-muted)' }}>No sibling items found for this brand in this BU.</div>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Search by item no. or description…"
                    value={targetSearch}
                    onChange={e => setTargetSearch(e.target.value)}
                    disabled={loading}
                    style={{ width: '100%', marginBottom: 6 }}
                    autoComplete="off"
                  />
                  <div style={{
                    border: '1px solid var(--c-border)',
                    borderRadius: 'var(--radius)',
                    maxHeight: 240, overflowY: 'auto',
                  }}>
                    {targets
                      .filter(t => {
                        const q = targetSearch.toLowerCase()
                        return !q || t.ItemNo.toLowerCase().includes(q) || t.Description.toLowerCase().includes(q)
                      })
                      .map(t => (
                        <div
                          key={t.ItemNo}
                          onClick={() => { setTargetItemNo(t.ItemNo); setTargetSearch('') }}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid var(--c-border)',
                            background: targetItemNo === t.ItemNo ? 'var(--c-cell-edited-bg)' : 'transparent',
                          }}
                          onMouseEnter={e => {
                            if (targetItemNo !== t.ItemNo)
                              e.currentTarget.style.background = 'var(--c-bg)'
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = targetItemNo === t.ItemNo
                              ? 'var(--c-cell-edited-bg)'
                              : 'transparent'
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--c-accent)' }}>{t.ItemNo}</div>
                          <div style={{ fontSize: 11, color: 'var(--c-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.Description}
                          </div>
                        </div>
                      ))
                    }
                  </div>
                </>
              )}
            </div>

            <div className="modal-row">
              <label>From month *</label>
              <MonthPicker value={dateFrom} onChange={setDateFrom} />
            </div>

            <div className="modal-row">
              <label>To month *</label>
              <MonthPicker value={dateTo} onChange={setDateTo} />
            </div>

            <div className="modal-row">
              <label>Forecast types *</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {typeCounts.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                    {dateFrom && dateTo && dateFrom <= dateTo
                      ? 'No forecast rows found for this item in the selected range.'
                      : 'Select a date range to see available types.'}
                  </span>
                ) : typeCounts.map(tc => (
                  <label key={tc.forecast_type_code} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedTypes.includes(tc.forecast_type_code)}
                      onChange={e => setSelectedTypes(prev =>
                        e.target.checked
                          ? [...prev, tc.forecast_type_code]
                          : prev.filter(c => c !== tc.forecast_type_code)
                      )}
                      style={{ width: 14, height: 14, accentColor: 'var(--c-accent)' }}
                    />
                    {tc.name} <span style={{ color: 'var(--c-muted)', fontSize: 11 }}>({tc.row_count} rows)</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Scope: single customer (default) vs all customers opt-in */}
            <div className="modal-row">
              <label>Scope</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allCustomers}
                    onChange={e => setAllCustomers(e.target.checked)}
                    disabled={!hasCustomer}
                    style={{ width: 14, height: 14, accentColor: 'var(--c-accent)' }}
                  />
                  Include all customers (same Responsibility &amp; Sales Channel)
                </label>
                <div style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                  {allCustomers
                    ? typeCustomerCount > 0
                      ? `All customers — ${typeCustomerCount} with source rows`
                      : 'All customers'
                    : customerCode
                      ? `Customer: ${customerCode}${customerName ? ` — ${customerName}` : ''}`
                      : 'No customer selected'}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
              <button className="btn btn-primary" onClick={handlePreview} disabled={loading || !targetItemNo || !selectedTypes.length || (!allCustomers && !customerCode)}>
                {loading ? 'Loading…' : 'Preview →'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const thStyle = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 600,
  borderBottom: '1px solid var(--c-border)',
  whiteSpace: 'nowrap',
}
const tdStyle = {
  padding: '4px 8px',
  borderBottom: '1px solid var(--c-border)',
  whiteSpace: 'nowrap',
}
