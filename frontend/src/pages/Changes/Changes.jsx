/**
 * Changes.jsx — Forecast Change Management screen
 * Shows a filterable audit trail of all quantity changes, with delta
 * highlighting when the change exceeds ±500 units.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as XLSX from 'xlsx'
import {
  fetchBusinessUnits, fetchCustomers, fetchChanges,
} from '../../api/sfms'
import MonthPicker from '../../components/MonthPicker'

const DELTA_THRESHOLD = 500

function fmt(val, decimals = 0) {
  if (val == null) return '—'
  return Number(val).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function fmtDate(dtStr) {
  if (!dtStr) return '—'
  const d = new Date(dtStr)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateTime(dtStr) {
  if (!dtStr) return '—'
  const d = new Date(dtStr)
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function todayYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function sixMonthsBackYM() {
  const d = new Date()
  d.setMonth(d.getMonth() - 6)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function Changes() {
  const [buCode,       setBuCode]       = useState('')
  const [customerCode, setCustomerCode] = useState('')
  const [itemNo,       setItemNo]       = useState('')
  const [dateFrom,     setDateFrom]     = useState(sixMonthsBackYM())
  const [dateTo,       setDateTo]       = useState(todayYM())

  const { data: bus       = [] } = useQuery({ queryKey: ['bus'],  queryFn: fetchBusinessUnits })
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', buCode],
    queryFn:  () => fetchCustomers(buCode),
    enabled:  !!buCode,
  })

  const canLoad = !!buCode

  const { data: changes = [], isLoading, error } = useQuery({
    queryKey: ['changes', buCode, customerCode, itemNo, dateFrom, dateTo],
    queryFn: () => fetchChanges(buCode, {
      date_from:     dateFrom ? dateFrom + '-01' : undefined,
      date_to:       dateTo   ? dateTo   + '-01' : undefined,
      customer_code: customerCode || undefined,
      item_no:       itemNo       || undefined,
    }),
    enabled: canLoad,
  })

  const largeChanges = changes.filter(r => Math.abs(Number(r.QtyDelta)) > DELTA_THRESHOLD).length

  function handleExport() {
    if (!changes.length) return

    const rows = changes.map(r => ({
      'Changed At':      fmtDateTime(r.ChangedAt),
      'Changed By':      r.ChangedBy,
      'Change Type':     r.ChangeType || '',
      'Responsibility':  r.BusinessUnitCode,
      'Sales Channel':   r.SalesChannelCode,
      'Customer':        r.CustomerName || r.CustomerCode,
      'Item No':         r.ItemNo,
      'Description':     r.ItemDescription || '',
      'Forecast Period': fmtDate(r.ForecastDate),
      'Qty Before':      r.QtyBefore != null ? Number(r.QtyBefore) : null,
      'Qty After':       r.QtyAfter  != null ? Number(r.QtyAfter)  : null,
      'Qty Delta':       r.QtyDelta  != null ? Number(r.QtyDelta)  : null,
      'Price Before':    r.PriceBefore != null ? Number(r.PriceBefore) : null,
      'Price After':     r.PriceAfter  != null ? Number(r.PriceAfter)  : null,
    }))

    const ws = XLSX.utils.json_to_sheet(rows)

    // Auto-fit column widths
    const colWidths = Object.keys(rows[0]).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] ?? '').length))
    }))
    ws['!cols'] = colWidths

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Change History')

    const date = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `SFMS_Change_History_${date}.xlsx`)
  }

  return (
    <div>
      <div className="card">
        <div className="card-title">Forecast Change History</div>

        {/* ── Filters ── */}
        <div className="toolbar">
          <div className="field-group">
            <label>Responsibility *</label>
            <select value={buCode} onChange={e => { setBuCode(e.target.value); setCustomerCode('') }}>
              <option value="">— Select —</option>
              {bus.map(b => <option key={b.Code} value={b.Code}>{b.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Customer</label>
            <select value={customerCode} onChange={e => setCustomerCode(e.target.value)} disabled={!buCode}>
              <option value="">All customers</option>
              {customers.map(c => <option key={c.Code} value={c.Code}>{c.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Item No</label>
            <input
              type="text"
              value={itemNo}
              onChange={e => setItemNo(e.target.value)}
              placeholder="Filter by item…"
              style={{ minWidth: 140 }}
            />
          </div>

          <div className="field-group">
            <label>Forecast period from</label>
            <MonthPicker value={dateFrom} onChange={setDateFrom} />
          </div>

          <div className="field-group">
            <label>Forecast period to</label>
            <MonthPicker value={dateTo} onChange={setDateTo} />
          </div>
        </div>

        {!canLoad && (
          <p className="text-muted" style={{ fontSize: 13 }}>
            Select a Responsibility to load the change history.
          </p>
        )}

        {error && <div className="error-banner">{error.message}</div>}

        {canLoad && isLoading && <div className="loading">Loading change history…</div>}

        {canLoad && !isLoading && changes.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13 }}>
            No changes found for the selected filters.
          </p>
        )}

        {canLoad && !isLoading && changes.length > 0 && (
          <>
            {/* ── Summary banner ── */}
            <div style={{
              display: 'flex', gap: 20, marginBottom: 14,
              fontSize: 13, alignItems: 'center',
            }}>
              <span className="text-muted">
                {changes.length} change{changes.length !== 1 ? 's' : ''} found
              </span>
              {largeChanges > 0 && (
                <span style={{
                  background: '#fdf0ee', color: '#c0392b',
                  border: '1px solid #f1948a',
                  borderRadius: 'var(--radius)', padding: '3px 10px',
                  fontWeight: 600, fontSize: 12,
                }}>
                  ⚠ {largeChanges} change{largeChanges !== 1 ? 's' : ''} exceed ±{DELTA_THRESHOLD.toLocaleString()} units
                </span>
              )}
              <div style={{ marginLeft: 'auto' }}>
                <button className="btn btn-ghost" onClick={handleExport}>
                  ↓ Export to Excel
                </button>
              </div>
            </div>

            {/* ── Table ── */}
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Changed At</th>
                    <th>Changed By</th>
                    <th>Type</th>
                    <th>Resp.</th>
                    <th>Channel</th>
                    <th>Customer</th>
                    <th>Item</th>
                    <th>Description</th>
                    <th>Forecast Period</th>
                    <th className="num">Qty Before</th>
                    <th className="num">Qty After</th>
                    <th className="num">Qty Delta</th>
                    <th className="num">Price Before</th>
                    <th className="num">Price After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((r, i) => {
                    const delta    = Number(r.QtyDelta ?? 0)
                    const isLarge  = Math.abs(delta) > DELTA_THRESHOLD
                    const deltaPos = delta > 0
                    const deltaNeg = delta < 0

                    return (
                      <tr key={i} style={isLarge ? { background: '#fef9f9' } : {}}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                          {fmtDateTime(r.ChangedAt)}
                        </td>
                        <td style={{ fontWeight: 500 }}>{r.ChangedBy}</td>
                        <td>
                          <span className={`badge ${
                            r.ChangeType === 'Price' || r.ChangeType === 'PriceType'
                              ? 'badge-warn'
                              : r.ChangeType === 'New'
                              ? 'badge-success'
                              : 'badge-muted'
                          }`}>
                            {r.ChangeType || 'Edit'}
                          </span>
                        </td>
                        <td><span className="badge badge-muted">{r.BusinessUnitCode}</span></td>
                        <td>{r.SalesChannelCode}</td>
                        <td>{r.CustomerName || r.CustomerCode}</td>
                        <td><code style={{ fontSize: 11 }}>{r.ItemNo}</code></td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.ItemDescription || '—'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {fmtDate(r.ForecastDate)}
                        </td>
                        <td className="num" style={{ color: 'var(--c-muted)' }}>
                          {fmt(r.QtyBefore)}
                        </td>
                        <td className="num" style={{ fontWeight: 600 }}>
                          {fmt(r.QtyAfter)}
                        </td>
                        <td className="num">
                          <span style={{
                            fontWeight: 700,
                            color: isLarge
                              ? '#c0392b'
                              : deltaPos ? 'var(--c-success)' : deltaNeg ? '#c0392b' : 'var(--c-muted)',
                            background: isLarge ? '#fdf0ee' : 'transparent',
                            borderRadius: 3,
                            padding: isLarge ? '2px 6px' : 0,
                            display: 'inline-block',
                          }}>
                            {delta > 0 ? '+' : ''}{fmt(delta)}
                            {isLarge && ' ⚠'}
                          </span>
                        </td>
                        <td className="num" style={{ color: 'var(--c-muted)' }}>
                          {r.PriceBefore != null ? Number(r.PriceBefore).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}
                        </td>
                        <td className="num" style={{ fontWeight: r.ChangeType === 'Price' ? 700 : 400, color: r.ChangeType === 'Price' ? 'var(--c-warn)' : 'inherit' }}>
                          {r.PriceAfter != null ? Number(r.PriceAfter).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
