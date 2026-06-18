/**
 * ItemViewGrid.jsx
 *
 * Item view: rows are customers (grouped by price type), columns are months.
 * Data is read-only for creation — edits go to existing PUT endpoint.
 * Editability is driven by IsEditable flag returned per row by the API.
 */
import { useMemo, useRef, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'

import { fetchForecastByItem, updateForecastRow } from '../../api/sfms'
import { useTheme } from '../../ThemeContext'

// ── Helpers ────────────────────────────────────────────────────────────────────
function monthKey(dateStr) { return dateStr ? dateStr.slice(0, 7) : '' }
function firstOfMonth(ym)  { return ym + '-01' }

function formatMonth(ym) {
  const [y, m] = ym.split('-')
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('default', { month: 'short', year: '2-digit' })
}

function monthsBetween(fromYM, toYM) {
  const months = []
  const [fy, fm] = fromYM.split('-').map(Number)
  const [ty, tm] = toYM.split('-').map(Number)
  let y = fy, m = fm
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return months
}

// ── Cell renderer: quantity value ─────────────────────────────────────────────
function QtyCellRenderer(params) {
  const val    = params.value
  const rt     = params.data?.rowType
  if (rt === 'subtotal' || rt === 'grandtotal') {
    if (val == null || val === 0) return ''
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        height: '100%', padding: '0 8px', boxSizing: 'border-box',
        fontSize: 11, fontWeight: 700,
        color: rt === 'grandtotal' ? 'var(--c-accent)' : 'var(--c-muted)',
      }}>
        {Number(val).toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </div>
    )
  }
  if (val == null || val === 0) return ''
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      height: '100%', padding: '0 8px', boxSizing: 'border-box', fontSize: 11,
    }}>
      {Number(val).toLocaleString(undefined, { maximumFractionDigits: 0 })}
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function ItemViewGrid({
  buCode,
  ftCode,
  channelCode,
  dateFrom,
  dateTo,
  itemNo,
  itemDetails,   // { ItemNo, Description, BrandCode, UnitOfMeasure }
  me,
  pts,           // price types reference array
  currencySymbol,
  onError,
}) {
  const qc      = useQueryClient()
  const gridRef = useRef()
  const { theme } = useTheme()

  const months = useMemo(() => monthsBetween(dateFrom, dateTo), [dateFrom, dateTo])

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const queryKey = ['forecast-by-item', buCode, itemNo, channelCode, ftCode, dateFrom, dateTo]

  const { data: rawRows = [], isLoading, error: fetchError } = useQuery({
    queryKey,
    queryFn: () => fetchForecastByItem(buCode, {
      item_no:            itemNo,
      sales_channel_code: channelCode,
      forecast_type_code: ftCode,
      date_from:          firstOfMonth(dateFrom),
      date_to:            firstOfMonth(dateTo),
    }),
    enabled: !!(buCode && itemNo && channelCode && ftCode && dateFrom && dateTo),
  })

  useEffect(() => {
    if (fetchError) onError?.(fetchError.message)
    else onError?.('')
  }, [fetchError])

  // ── Pivot flat API rows → grid rows ────────────────────────────────────────
  // One grid row per (CustomerCode, PriceTypeCode) pair.
  // Structure: { rowType:'customer', customerCode, customerName, priceTypeCode, priceTypeName, price, months:{ym:{entryNo,qty,isEditable}} }
  const { customerRows, priceTypeOrder } = useMemo(() => {
    const rowMap = new Map()        // key: `${customerCode}|${priceTypeCode}`
    const ptOrder = []              // price type codes in appearance order

    for (const fr of rawRows) {
      const ym  = monthKey(fr.ForecastDate)
      const key = `${fr.CustomerCode}|${fr.PriceTypeCode ?? 'null'}`

      if (!rowMap.has(key)) {
        rowMap.set(key, {
          rowType:       'customer',
          customerCode:  fr.CustomerCode,
          customerName:  fr.CustomerName,
          priceTypeCode: fr.PriceTypeCode,
          priceTypeName: fr.PriceTypeName ?? '',
          price:         parseFloat(fr.Price),
          months:        {},
        })
        if (!ptOrder.includes(fr.PriceTypeCode)) ptOrder.push(fr.PriceTypeCode)
      }

      rowMap.get(key).months[ym] = {
        entryNo:    fr.EntryNo,
        quantity:   parseFloat(fr.Quantity),
        isEditable: fr.IsEditable,
      }
    }

    // Sort rows: price type order, then customer name within each price type
    const rows = Array.from(rowMap.values()).sort((a, b) => {
      const ptA = ptOrder.indexOf(a.priceTypeCode)
      const ptB = ptOrder.indexOf(b.priceTypeCode)
      if (ptA !== ptB) return ptA - ptB
      return a.customerName.localeCompare(b.customerName)
    })

    return { customerRows: rows, priceTypeOrder: ptOrder }
  }, [rawRows])

  // ── Build rows with subtotals and grand total ──────────────────────────────
  const rowData = useMemo(() => {
    const result = []
    const grandTotals = {}

    // Group customer rows by price type
    const groups = new Map()
    for (const pt of priceTypeOrder) {
      groups.set(pt, customerRows.filter(r => r.priceTypeCode === pt))
    }

    for (const [ptCode, rows] of groups) {
      result.push(...rows)

      // Subtotal row for this price type
      const subtotals = {}
      for (const ym of months) {
        const sum = rows.reduce((acc, r) => acc + (r.months[ym]?.quantity ?? 0), 0)
        subtotals[ym] = { quantity: sum }
        grandTotals[ym] = (grandTotals[ym] ?? 0) + sum
      }
      const ptName = rows[0]?.priceTypeName ?? String(ptCode ?? '')
      result.push({
        rowType:      'subtotal',
        priceTypeCode: ptCode,
        priceTypeName: ptName,
        customerName:  `Subtotal — ${ptName}`,
        months:        subtotals,
      })
    }

    // Grand total row
    if (customerRows.length > 0) {
      const grandMonths = {}
      for (const ym of months) grandMonths[ym] = { quantity: grandTotals[ym] ?? 0 }
      result.push({
        rowType:     'grandtotal',
        customerName: 'Total',
        months:       grandMonths,
      })
    }

    return result
  }, [customerRows, priceTypeOrder, months])

  // Stable ref for onCellValueChanged
  const rowDataRef = useRef([])
  rowDataRef.current = rowData

  // ── Cell edit handler ──────────────────────────────────────────────────────
  const onCellValueChanged = useCallback(async (params) => {
    const colId = params.column.getColId()
    const match = colId.match(/^months\.(\d{4}-\d{2})\.quantity$/)
    if (!match) return
    const ym = match[1]

    if (params.node?.rowPinned) return
    const rt = params.data?.rowType
    if (rt === 'subtotal' || rt === 'grandtotal') return

    const customerCode  = params.data?.customerCode
    const priceTypeCode = params.data?.priceTypeCode
    const key = `${customerCode}|${priceTypeCode ?? 'null'}`
    const liveRow = rowDataRef.current.find(
      r => r.rowType === 'customer' && r.customerCode === customerCode && r.priceTypeCode === priceTypeCode
    )
    const cell    = liveRow?.months?.[ym]
    if (!cell?.entryNo) return  // no entry for this cell — item view is read-only for creates

    const rawValue = params.newValue
    // null / '' → send null to API which stores 0
    const quantity = (rawValue === '' || rawValue == null) ? null : parseFloat(rawValue)

    try {
      const updated = await updateForecastRow(buCode, cell.entryNo, {
        Quantity:      quantity,
        Notes:         null,
      })
      // Optimistic cache update
      qc.setQueryData(queryKey, old => (old ?? []).map(r =>
        r.EntryNo === cell.entryNo
          ? { ...r, Quantity: String(updated.Quantity) }
          : r
      ))
    } catch (e) {
      onError?.(e.message)
      qc.invalidateQueries({ queryKey })
    }
  }, [buCode, queryKey, qc, onError])

  // ── Column definitions ─────────────────────────────────────────────────────
  const colDefs = useMemo(() => {
    const fixed = [
      {
        headerName: 'Customer',
        field: 'customerName',
        flex: 2,
        minWidth: 200,
        pinned: 'left',
        editable: false,
        cellStyle: params => {
          const rt = params.data?.rowType
          if (rt === 'grandtotal') return { fontWeight: 700, fontSize: 11 }
          if (rt === 'subtotal')   return { fontStyle: 'italic', fontSize: 11, color: 'var(--c-muted)' }
          return { fontSize: 11 }
        },
      },
      {
        headerName: 'Price Type',
        field: 'priceTypeName',
        width: 110,
        pinned: 'left',
        editable: false,
        cellStyle: { fontSize: 11 },
        valueGetter: params => {
          const rt = params.data?.rowType
          if (rt === 'subtotal' || rt === 'grandtotal') return ''
          return params.data?.priceTypeName ?? ''
        },
      },
      {
        headerName: `Price (${currencySymbol})`,
        field: 'price',
        width: 95,
        pinned: 'left',
        editable: false,
        type: 'numericColumn',
        cellStyle: { fontSize: 11 },
        valueGetter: params => {
          const rt = params.data?.rowType
          if (rt === 'subtotal' || rt === 'grandtotal') return null
          const p = params.data?.price
          return p != null ? Number(p) : null
        },
        valueFormatter: params => {
          if (params.value == null) return ''
          return `${currencySymbol}${Number(params.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        },
      },
    ]

    const monthCols = months.map(ym => ({
      headerName: formatMonth(ym),
      field: `months.${ym}.quantity`,
      flex: 1,
      minWidth: 75,
      maxWidth: 130,
      type: 'numericColumn',
      editable: params => {
        const rt = params.data?.rowType
        if (!params.data || rt === 'subtotal' || rt === 'grandtotal') return false
        const cell = params.data?.months?.[ym]
        return !!(cell?.entryNo && cell?.isEditable)
      },
      valueParser: params => {
        if (params.newValue === '' || params.newValue == null) return null
        const n = Number(params.newValue)
        return isNaN(n) ? null : n
      },
      valueSetter: params => {
        if (!params.data.months[ym]) params.data.months[ym] = {}
        params.data.months[ym].quantity = params.newValue
        return true
      },
      cellStyle: params => {
        const rt   = params.data?.rowType
        const cell = params.data?.months?.[ym]
        if (rt === 'grandtotal') return { background: 'var(--c-row-pinned-bg)', fontWeight: 700, padding: 0 }
        if (rt === 'subtotal')   return { background: 'var(--c-hover-row)', padding: 0 }
        if (!cell?.isEditable)   return { background: 'var(--c-locked)', padding: 0 }
        if (cell?.quantity != null && cell.quantity !== 0) return { background: 'var(--c-cell-edited-bg)', fontWeight: 600, padding: 0 }
        return { padding: 0 }
      },
      cellRenderer: QtyCellRenderer,
      tooltipValueGetter: params => {
        const rt   = params.data?.rowType
        if (rt === 'subtotal' || rt === 'grandtotal') return null
        const cell = params.data?.months?.[ym]
        if (!cell?.entryNo) return 'No forecast row — switch to Customer view to create one'
        if (!cell?.isEditable) return `Period is locked — Qty: ${cell?.quantity ?? '—'}`
        return `Qty: ${cell?.quantity ?? '—'}  |  Click to edit`
      },
    }))

    const totalCol = {
      headerName: 'Units',
      field: 'rowTotal',
      width: 80,
      suppressSizeToFit: true,
      type: 'numericColumn',
      editable: false,
      pinned: 'right',
      cellStyle: params => {
        const rt = params.data?.rowType
        if (rt === 'grandtotal') return { fontWeight: 700, background: 'var(--c-row-pinned-bg)', padding: 0 }
        if (rt === 'subtotal')   return { fontWeight: 600, background: 'var(--c-hover-row)', padding: 0 }
        return { fontWeight: 700, background: 'var(--c-hover-row)', padding: 0 }
      },
      cellRenderer: QtyCellRenderer,
    }

    return [...fixed, ...monthCols, totalCol]
  }, [months, currencySymbol])

  // Add rowTotal to each row for the totals column
  const rowDataWithTotals = useMemo(() =>
    rowData.map(row => ({
      ...row,
      rowTotal: months.reduce((sum, ym) => sum + (row.months?.[ym]?.quantity ?? 0), 0),
    })),
  [rowData, months])

  // Re-fit when months change
  useEffect(() => {
    gridRef.current?.api?.sizeColumnsToFit()
  }, [months])

  // ── Visible customer count (for context bar) ────────────────────────────────
  const customerCount = customerRows.length

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isLoading) return <div className="loading">Loading item forecast data…</div>

  if (!rawRows.length) {
    return (
      <div className="text-muted" style={{ fontSize: 13, marginTop: 12 }}>
        No forecast rows found for this item. To add a forecast, switch to{' '}
        <strong>Customer view</strong> and select a customer.
      </div>
    )
  }

  return (
    <>
      {/* Context bar */}
      <div style={{
        fontSize: 12, color: 'var(--c-muted)',
        marginBottom: 8, display: 'flex', gap: 16, flexWrap: 'wrap',
      }}>
        <span><strong>Item:</strong> {itemNo}</span>
        {itemDetails?.Description && <span><strong>Description:</strong> {itemDetails.Description}</span>}
        <span><strong>Channel:</strong> {channelCode}</span>
        <span><strong>BU:</strong> {buCode}</span>
        <span><strong>Customers:</strong> {customerCount}</span>
      </div>

      <div
        className={`ag-theme-alpine${theme === 'dark' ? '-dark' : ''}`}
        style={{ height: 'calc(100vh - 340px)', minHeight: 350, width: '100%' }}
      >
        <AgGridReact
          ref={gridRef}
          rowData={rowDataWithTotals}
          getRowId={params => {
            const rt = params.data?.rowType
            if (rt === 'grandtotal') return 'grandtotal'
            if (rt === 'subtotal')   return `subtotal-${params.data.priceTypeCode}`
            return `${params.data.customerCode}-${params.data.priceTypeCode ?? 'null'}`
          }}
          columnDefs={colDefs}
          suppressRowClickSelection
          onGridReady={p => p.api.sizeColumnsToFit()}
          onGridSizeChanged={() => gridRef.current?.api?.sizeColumnsToFit()}
          onCellValueChanged={onCellValueChanged}
          stopEditingWhenCellsLoseFocus
          enterNavigatesVertically={false}
          tooltipShowDelay={600}
          defaultColDef={{ resizable: true, sortable: false, filter: false }}
          rowHeight={28}
          headerHeight={34}
          getRowStyle={params => {
            const rt = params.data?.rowType
            if (rt === 'grandtotal') return { background: 'var(--c-row-pinned-bg)', fontWeight: 700, borderTop: '2px solid var(--c-row-pinned-border)' }
            if (rt === 'subtotal')   return { background: 'var(--c-hover-row)', borderBottom: '2px solid var(--c-row-pinned-border)' }
            return {}
          }}
        />
      </div>
    </>
  )
}
