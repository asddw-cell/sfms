/**
 * ForecastSummaryPanel.jsx
 * Collapsible panel below the forecast grid showing:
 *   - Bar chart: current forecast qty vs LY forecast qty (same months -12)
 *   - Line overlay: actuals qty for past months
 *   - Summary table: month-by-month breakdown with vs LY %
 *   - Stat cards: totals and key metrics
 *
 * LY forecast is fetched independently with date range shifted back 12 months.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell,
} from 'recharts'
import { fetchForecast, fetchComparison } from '../api/sfms'

const FORECAST_COLOR = '#8B1A12'
const LY_COLOR       = '#B0BEC5'
const ACTUALS_COLOR  = '#1D9E75'

function fmt(n)   { return n == null ? '—' : Math.round(n).toLocaleString() }
function fmtV(n, sym) { return (!n || n === 0) ? '—' : `${sym}${Math.round(n).toLocaleString()}` }
function pct(a, b) { return (!b || b === 0) ? null : ((a - b) / b) * 100 }

function shortMon(ym) {
  const [y, m] = ym.split('-')
  return new Date(+y, +m - 1, 1).toLocaleString('default', { month: 'short' }) + ' ' + String(y).slice(2)
}

function shiftYMBack12(ym) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 - 12, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function firstOfMonth(ym) { return ym ? `${ym}-01` : undefined }

const todayYM = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const CustomTooltip = ({ active, payload, label, currencySymbol }) => {
  if (!active || !payload?.length) return null
  const get = key => payload.find(p => p.dataKey === key)?.value ?? 0
  const f = get('forecastQty'), ly = get('lyQty'), a = get('actualsQty')
  const vLY  = ly  > 0 ? pct(f, ly)  : null
  const vAct = a   > 0 ? pct(a, f)   : null
  return (
    <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 6, padding: '8px 12px', fontSize: 12, minWidth: 180 }}>
      <div style={{ fontWeight: 500, marginBottom: 6, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ color: FORECAST_COLOR }}>Forecast: {fmt(f)}</div>
      {ly > 0 && <div style={{ color: '#607D8B' }}>LY forecast: {fmt(ly)}</div>}
      {ly > 0 && vLY != null && <div style={{ color: vLY >= 0 ? FORECAST_COLOR : '#607D8B', marginTop: 2 }}>{vLY >= 0 ? '+' : ''}{vLY.toFixed(1)}% vs LY</div>}
      {a  > 0 && <div style={{ color: ACTUALS_COLOR, marginTop: 4 }}>Actuals: {fmt(a)}</div>}
      {a  > 0 && vAct != null && <div style={{ color: vAct >= 0 ? ACTUALS_COLOR : '#E24B4A' }}>{vAct >= 0 ? '+' : ''}{vAct.toFixed(1)}% vs forecast</div>}
    </div>
  )
}

export default function ForecastSummaryPanel({
  buCode, ftCode, channelCode, customerCode,
  dateFrom, dateTo, months, currencySymbol, customerName,
  selectedBrands = [],
}) {
  const [collapsed, setCollapsed] = useState(false)
  const currentYM = todayYM()

  const canLoad = !!(buCode && ftCode && channelCode && customerCode && dateFrom && dateTo)

  // ── LY date range — shift back 12 months ────────────────────────────────────
  const lyDateFrom = dateFrom ? shiftYMBack12(dateFrom) : undefined
  const lyDateTo   = dateTo   ? shiftYMBack12(dateTo)   : undefined

  // ── Current forecast (already loaded by grid, but re-query here for isolation) ─
  const { data: forecastRows = [] } = useQuery({
    queryKey: ['panel-forecast', buCode, ftCode, channelCode, customerCode, dateFrom, dateTo],
    queryFn: () => fetchForecast(buCode, {
      forecast_type_code: ftCode,
      sales_channel_code: channelCode,
      customer_code:      customerCode,
      date_from:          firstOfMonth(dateFrom),
      date_to:            firstOfMonth(dateTo),
    }),
    enabled: canLoad && !collapsed,
    staleTime: 30000,
  })

  // ── LY forecast ─────────────────────────────────────────────────────────────
  const { data: lyRows = [], isFetching: lyLoading } = useQuery({
    queryKey: ['panel-ly-forecast', buCode, ftCode, channelCode, customerCode, lyDateFrom, lyDateTo],
    queryFn: () => fetchForecast(buCode, {
      forecast_type_code: ftCode,
      sales_channel_code: channelCode,
      customer_code:      customerCode,
      date_from:          firstOfMonth(lyDateFrom),
      date_to:            firstOfMonth(lyDateTo),
    }),
    enabled: canLoad && !collapsed && !!lyDateFrom,
    staleTime: 30000,
  })

  // ── Actuals / comparison ────────────────────────────────────────────────────
  const { data: actualsRows = [] } = useQuery({
    queryKey: ['panel-actuals', buCode, channelCode, customerCode, dateFrom, dateTo],
    queryFn: () => fetchComparison(buCode, {
      sales_channel_code: channelCode,
      customer_code:      customerCode,
      date_from:          firstOfMonth(dateFrom),
      date_to:            firstOfMonth(dateTo),
    }),
    enabled: canLoad && !collapsed,
    staleTime: 30000,
  })

  // ── Aggregate by month ──────────────────────────────────────────────────────
  const forecastByMonth = useMemo(() => {
    const map = {}
    const brandFiltered = selectedBrands.length > 0
      ? forecastRows.filter(r => selectedBrands.includes(r.BrandName))
      : forecastRows
    for (const r of brandFiltered) {
      const ym = r.ForecastDate?.slice(0, 7)
      if (!ym) continue
      if (!map[ym]) map[ym] = { qty: 0, value: 0 }
      map[ym].qty   += Number(r.Quantity ?? 0)
      map[ym].value += Number(r.Quantity ?? 0) * Number(r.Price ?? 0)
    }
    return map
  }, [forecastRows, selectedBrands])

  const lyByMonth = useMemo(() => {
    const map = {}
    const lyBrandFiltered = selectedBrands.length > 0
      ? lyRows.filter(r => selectedBrands.includes(r.BrandName))
      : lyRows
    for (const r of lyBrandFiltered) {
      // LY row ForecastDate is 12 months ago — map it to current year month
      const lyYM = r.ForecastDate?.slice(0, 7)
      if (!lyYM) continue
      const [y, m] = lyYM.split('-').map(Number)
      const d = new Date(y, m - 1 + 12, 1)
      const currentYM2 = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!map[currentYM2]) map[currentYM2] = { qty: 0, value: 0 }
      map[currentYM2].qty   += Number(r.Quantity ?? 0)
      map[currentYM2].value += Number(r.Quantity ?? 0) * Number(r.Price ?? 0)
    }
    return map
  }, [lyRows, selectedBrands])

  const actualsByMonth = useMemo(() => {
    const map = {}
    const actualsBrandFiltered = selectedBrands.length > 0
      ? actualsRows.filter(r => selectedBrands.includes(r.BrandName))
      : actualsRows
    for (const r of actualsBrandFiltered) {
      const ym = r.ForecastDate?.slice(0, 7)
      if (!ym) continue
      if (!map[ym]) map[ym] = { qty: 0, value: 0 }
      map[ym].qty   += Number(r.ActualsQty       ?? 0)
      map[ym].value += Number(r.ActualsTotalValue ?? 0)
    }
    return map
  }, [actualsRows, selectedBrands])

  // ── Chart data ──────────────────────────────────────────────────────────────
  const chartData = useMemo(() => months.map(ym => {
    const fQty = Math.round(forecastByMonth[ym]?.qty   ?? 0)
    const lQty = Math.round(lyByMonth[ym]?.qty         ?? 0)
    const aQty = Math.round(actualsByMonth[ym]?.qty    ?? 0)
    const isPast = ym < currentYM
    return {
      ym,
      month:        shortMon(ym),
      forecastQty:  fQty,
      forecastVal:  Math.round(forecastByMonth[ym]?.value ?? 0),
      lyQty:        lQty,
      lyVal:        Math.round(lyByMonth[ym]?.value       ?? 0),
      actualsQty:   isPast ? aQty : null,
      actualsVal:   Math.round(actualsByMonth[ym]?.value  ?? 0),
      isPast,
    }
  }), [months, forecastByMonth, lyByMonth, actualsByMonth, currentYM])

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totForecastQty = chartData.reduce((s, r) => s + r.forecastQty, 0)
  const totForecastVal = chartData.reduce((s, r) => s + r.forecastVal, 0)
  const totLYQty       = chartData.reduce((s, r) => s + r.lyQty,       0)
  const totActualsQty  = chartData.reduce((s, r) => s + (r.actualsQty ?? 0), 0)
  const totActualsVal  = chartData.reduce((s, r) => s + r.actualsVal,  0)
  const vsLY           = pct(totForecastQty, totLYQty)

  const brandLabel = selectedBrands.length > 0
    ? ` · ${selectedBrands.length === 1 ? selectedBrands[0] : selectedBrands.length + ' brands'}`
    : ''
  const subtitle = [buCode, channelCode, customerName].filter(Boolean).join(' · ') + brandLabel

  const statCard = (label, value, sub, subColor) => (
    <div style={{ background: 'var(--color-background-secondary)', borderRadius: 6, padding: '10px 12px', flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, color: 'var(--color-text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: subColor || 'var(--color-text-secondary)', marginTop: 2 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ marginTop: 12, border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, overflow: 'hidden' }}>

      {/* Toggle header */}
      <div
        onClick={() => setCollapsed(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', cursor: 'pointer',
          background: 'var(--color-background-secondary)',
          borderBottom: collapsed ? 'none' : '0.5px solid var(--color-border-tertiary)',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .15s' }}>▼</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>Forecast summary</span>
        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>— {subtitle}</span>
        {lyLoading && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 8 }}>Loading LY data…</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {collapsed ? 'Expand' : 'Collapse'}
        </span>
      </div>

      {!collapsed && (
        <div style={{ background: 'var(--color-background-primary)', padding: 16 }}>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

            {/* Chart + table */}
            <div style={{ flex: 2, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                Forecast qty vs LY forecast · actuals line for completed months
              </div>

              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={chartData} barCategoryGap="20%" barGap={2} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-tertiary)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} axisLine={false} tickLine={false}
                    tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} width={36} />
                  <Tooltip content={<CustomTooltip currencySymbol={currencySymbol} />} />
                  <Legend iconType="square" iconSize={10}
                    formatter={(v, entry) => {
                      const labels = { forecastQty: 'Forecast', lyQty: 'LY forecast', actualsQty: 'Actuals' }
                      return <span style={{ fontSize: 11, color: entry.color }}>{labels[v] || v}</span>
                    }}
                    wrapperStyle={{ paddingTop: 6 }}
                  />
                  <Bar dataKey="forecastQty" name="forecastQty" fill={FORECAST_COLOR} radius={[2,2,0,0]}>
                    {chartData.map((e, i) => (
                      <Cell key={i} fill={FORECAST_COLOR} opacity={e.isPast ? 0.9 : 0.5} />
                    ))}
                  </Bar>
                  <Bar dataKey="lyQty" name="lyQty" fill={LY_COLOR} radius={[2,2,0,0]} opacity={0.7} />
                  <Line dataKey="actualsQty" name="actualsQty" type="monotone"
                    stroke={ACTUALS_COLOR} strokeWidth={2} dot={{ r: 3, fill: ACTUALS_COLOR }}
                    connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Monthly table */}
              <div style={{ marginTop: 14, overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-background-secondary)' }}>
                      {['Month', 'Forecast qty', 'LY forecast', 'vs LY', 'Actuals qty', 'vs forecast', 'Forecast value'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', textAlign: h === 'Month' ? 'left' : 'right', fontWeight: 600, fontSize: 11, color: '#fff', background: '#8B1A12', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.map((r, i) => {
                      const vly  = r.lyQty       > 0 ? pct(r.forecastQty, r.lyQty)      : null
                      const vact = r.actualsQty   > 0 ? pct(r.actualsQty, r.forecastQty) : null
                      const posColor = '#1D9E75', negColor = '#E24B4A'
                      return (
                        <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)', background: r.isPast ? 'var(--color-background-secondary)' : 'transparent' }}>
                          <td style={{ padding: '5px 10px', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', fontWeight: r.isPast ? 400 : 400 }}>{r.month}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.forecastQty)}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>{r.lyQty > 0 ? fmt(r.lyQty) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: vly == null ? 'var(--color-text-secondary)' : vly >= 0 ? posColor : negColor }}>
                            {vly != null ? `${vly >= 0 ? '+' : ''}${vly.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.actualsQty > 0 ? posColor : 'var(--color-text-secondary)' }}>
                            {r.actualsQty > 0 ? fmt(r.actualsQty) : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: vact == null ? 'var(--color-text-secondary)' : vact >= 0 ? posColor : negColor }}>
                            {vact != null ? `${vact >= 0 ? '+' : ''}${vact.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtV(r.forecastVal, currencySymbol)}</td>
                        </tr>
                      )
                    })}
                    <tr style={{ fontWeight: 500, background: 'var(--color-background-secondary)', borderTop: '1px solid var(--color-border-secondary)' }}>
                      <td style={{ padding: '6px 10px', color: 'var(--color-text-primary)' }}>Total</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmt(totForecastQty)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>{totLYQty > 0 ? fmt(totLYQty) : '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: vsLY == null ? 'var(--color-text-secondary)' : vsLY >= 0 ? '#1D9E75' : '#E24B4A' }}>
                        {vsLY != null ? `${vsLY >= 0 ? '+' : ''}${vsLY.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#1D9E75' }}>{totActualsQty > 0 ? fmt(totActualsQty) : '—'}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--color-text-secondary)' }}>—</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtV(totForecastVal, currencySymbol)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 160, width: 180 }}>
              {statCard('Total forecast units', fmt(totForecastQty), dateFrom + ' – ' + dateTo)}
              {statCard('Total forecast value', fmtV(totForecastVal, currencySymbol), 'at entered price')}
              {totLYQty > 0 && statCard('vs LY forecast',
                vsLY != null ? `${vsLY >= 0 ? '+' : ''}${vsLY.toFixed(1)}%` : '—',
                `LY: ${fmt(totLYQty)} units`,
                vsLY != null ? (vsLY >= 0 ? '#1D9E75' : '#E24B4A') : undefined,
              )}
              {totActualsQty > 0 && statCard('Actuals to date', fmt(totActualsQty),
                `${fmtV(totActualsVal, currencySymbol)} invoiced`,
                '#1D9E75',
              )}
              {statCard('Months with data',
                `${chartData.filter(r => r.forecastQty > 0).length} / ${months.length}`,
                'months have forecast',
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
