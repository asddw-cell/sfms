/**
 * ActualsComparison.jsx
 * Side-by-side forecast vs actuals view with quantity variance and %.
 * Cycle removed — comparison is filtered by BU, Customer and date range only.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchBusinessUnits, fetchCustomers, fetchComparison,
} from '../../api/sfms'
import MonthPicker from '../../components/MonthPicker'

function fmt(val, decimals = 0) {
  if (val == null) return '—'
  return Number(val).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function varianceBadge(variance, pct) {
  if (variance == null) return '—'
  const cls  = variance > 0 ? 'pos' : variance < 0 ? 'neg' : ''
  const sign = variance > 0 ? '+' : ''
  return (
    <span className={cls}>
      {sign}{fmt(variance, 1)}
      {pct != null && ` (${sign}${fmt(pct, 1)}%)`}
    </span>
  )
}

function firstOfMonth(ym) { return ym + '-01' }

function todayYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function sixMonthsBackYM() {
  const d = new Date()
  d.setMonth(d.getMonth() - 6)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function ActualsComparison() {
  const [buCode,       setBuCode]       = useState('')
  const [customerCode, setCustomerCode] = useState('')
  const [dateFrom,     setDateFrom]     = useState(sixMonthsBackYM())
  const [dateTo,       setDateTo]       = useState(todayYM())

  const { data: bus       = [] } = useQuery({ queryKey: ['bus'], queryFn: fetchBusinessUnits })
  const { data: customers = [] } = useQuery({
    queryKey: ['customers', buCode],
    queryFn:  () => fetchCustomers(buCode),
    enabled:  !!buCode,
  })

  const canLoad = !!(buCode && customerCode)

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['comparison', buCode, customerCode, dateFrom, dateTo],
    queryFn:  () => fetchComparison(buCode, {
      customer_code: customerCode,
      date_from:     firstOfMonth(dateFrom),
      date_to:       firstOfMonth(dateTo),
    }),
    enabled: canLoad,
  })

  return (
    <div>
      <div className="card">
        <div className="card-title">Forecast vs Actuals Comparison</div>

        <div className="toolbar">
          <div className="field-group">
            <label>Responsibility *</label>
            <select value={buCode} onChange={e => { setBuCode(e.target.value); setCustomerCode('') }}>
              <option value="">— Select —</option>
              {bus.map(b => <option key={b.Code} value={b.Code}>{b.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Customer *</label>
            <select value={customerCode} onChange={e => setCustomerCode(e.target.value)} disabled={!buCode}>
              <option value="">— Select —</option>
              {customers.map(c => <option key={c.Code} value={c.Code}>{c.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>From (month)</label>
            <MonthPicker value={dateFrom} onChange={setDateFrom} />
          </div>

          <div className="field-group">
            <label>To (month)</label>
            <MonthPicker value={dateTo} onChange={setDateTo} />
          </div>
        </div>

        {!canLoad && (
          <p className="text-muted" style={{ fontSize: 13 }}>
            Select Responsibility and Customer to load the comparison.
          </p>
        )}

        {error && <div className="error-banner">{error.message}</div>}

        {canLoad && isLoading && <div className="loading">Loading comparison data…</div>}

        {canLoad && !isLoading && rows.length === 0 && (
          <p className="text-muted mt-8" style={{ fontSize: 13 }}>
            No data found for the selected filters.
          </p>
        )}

        {canLoad && !isLoading && rows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Item</th>
                  <th>Description</th>
                  <th>Channel</th>
                  <th>Actuals Type</th>
                  <th className="num">Forecast Qty</th>
                  <th className="num">Actuals Qty</th>
                  <th className="num">Variance (Qty)</th>
                  <th className="num">Forecast Price</th>
                  <th className="num">Actuals Price</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.ForecastDate?.slice(0, 7)}</td>
                    <td><code style={{ fontSize: 12 }}>{r.ItemNo}</code></td>
                    <td>{r.Description}</td>
                    <td>{r.SalesChannelCode}</td>
                    <td>
                      {r.ActualsType
                        ? <span className="badge badge-muted">{r.ActualsType}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="num">{fmt(r.ForecastQty, 2)}</td>
                    <td className="num">{fmt(r.ActualsQty, 2)}</td>
                    <td className="num">{varianceBadge(r.QtyVariance, r.QtyVariancePct)}</td>
                    <td className="num">{fmt(r.ForecastPrice, 4)}</td>
                    <td className="num">{fmt(r.ActualsPrice, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
