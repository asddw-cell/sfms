/**
 * ForecastGrid.jsx
 *
 * Interaction model:
 *  - Single click / Tab into cell → inline quantity edit directly in the grid
 *  - Double click → open modal for Price, Price Type, Notes
 *  - Tab key → moves to the next month cell (skips locked months)
 *  - Enter / click away → commits the inline quantity change
 */
import { useState, useMemo, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'

import {
  fetchBusinessUnits, fetchForecastTypes, fetchSalesChannels,
  fetchCustomers, fetchBrands, fetchPriceTypes, fetchCurrencies, fetchItems, fetchMe,
  fetchForecast, createForecastRow, updateForecastRow, deleteForecastRow, copyForecastToGM,
  fetchComparison,
} from '../../api/sfms'
import EditModal from '../../components/EditModal'
import MultiSelect from '../../components/MultiSelect'
import AddItemsModal from '../../components/AddItemsModal'
import GmCopyModal          from '../../components/GmCopyModal'
import ForecastSummaryPanel from '../../components/ForecastSummaryPanel'
import MonthPicker from '../../components/MonthPicker'

// ── Helpers ────────────────────────────────────────────────────────────────────
function monthKey(dateStr) { return dateStr ? dateStr.slice(0, 7) : '' }
function firstOfMonth(ym)  { return ym + '-01' }

function formatMonth(ym) {
  const [y, m] = ym.split('-')
  const d = new Date(Number(y), Number(m) - 1, 1)
  return d.toLocaleString('default', { month: 'short', year: '2-digit' })
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

function isLockedMonth(ym, horizonMonthsBack = 0) {
  const today = new Date()
  // Earliest editable month = current month + horizon
  // e.g. horizon=2, today=March → earliest editable = May
  const earliest = new Date(today.getFullYear(), today.getMonth() + horizonMonthsBack, 1)
  const earliestYM = `${earliest.getFullYear()}-${String(earliest.getMonth() + 1).padStart(2, '0')}`
  return ym < earliestYM
}

function todayYM() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function twelveMonthsAheadYM() {
  const d = new Date()
  d.setMonth(d.getMonth() + 12)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ── Component ──────────────────────────────────────────────────────────────────
// ── Shared cell value formatter ───────────────────────────────────────────────
// Both F and A rows render through here so alignment is identical.
// A rows are coloured based on forecast attainment; no % badge.
function ForecastCellRenderer(params) {
  const val    = params.value
  const isA    = params.data?.rowType === 'A'
  const isLE   = params.data?.rowType === 'LE'
  const field  = params.colDef?.field
  const itemNo = params.data?.itemNo

  const locked = params.locked ?? false

  // Resolve colour for A rows by comparing to paired F row
  // Locked (past) months still get attainment colouring — good performance indicator
  const ym = field?.match(/months\.(.+)\.quantity/)?.[1]

  let color = 'inherit'
  if (isLE) {
    color = '#7D3C98'  // purple throughout — LE is always a single colour
  } else if (isA) {
    const rowData = params.context?.rowData ?? []
    const fRow    = rowData.find(r => r.itemNo === itemNo && r.rowType === 'F')
    const fQty    = fRow
      ? (field === 'rowTotal' ? fRow.rowTotal : fRow.months?.[ym]?.quantity)
      : null
    const aQty = val ?? 0
    if (fQty != null && fQty !== 0) {
      color = aQty >= fQty ? '#1e8449'   // green — met or exceeded forecast
                           : '#c0392b'   // red — below forecast
    } else {
      // No forecast to compare — colour by sign of actuals value
      color = (val ?? 0) < 0 ? '#c0392b'   // red — negative actuals
            : (val ?? 0) > 0 ? '#1e8449'   // green — positive actuals
            :                  '#1e8449'   // zero — green
    }
  }

  // Blank when no value
  if (val == null) return ''
  // F row: blank when zero (no entry)
  if (!isA && val === 0) return ''
  // A row: blank when zero AND the paired F row also has no entry for this period
  if (isA && val === 0) {
    const rowData2 = params.context?.rowData ?? []
    const fRow2    = rowData2.find(r => r.itemNo === itemNo && r.rowType === 'F')
    const ym2      = field?.match(/months\.(.+)\.quantity/)?.[1]
    const fQty2    = fRow2
      ? (field === 'rowTotal' ? fRow2.rowTotal : fRow2.months?.[ym2]?.quantity)
      : null
    if (fQty2 == null || fQty2 === 0) return ''
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      height: '100%', width: '100%', padding: '0 8px', boxSizing: 'border-box',
      fontStyle: (isA || isLE) ? 'italic' : 'normal',
      fontSize: 11,
      color,
    }}>
      {Number(val).toLocaleString(undefined, { maximumFractionDigits: 0 })}
    </div>
  )
}

// ── Persist toolbar selections to localStorage ────────────────────────────────
const STORAGE_KEY = 'sfms_forecast_filters'

function loadFilters() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? JSON.parse(saved) : {}
  } catch { return {} }
}

function saveFilters(filters) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(filters)) } catch {}
}

export default function ForecastGrid() {
  const qc      = useQueryClient()
  const gridRef = useRef()

  // Initialise from localStorage, falling back to defaults
  const _f = loadFilters()

  const [buCode,        setBuCode]        = useState(_f.buCode        || '')
  const [ftCode,        setFtCode]        = useState(_f.ftCode        || '')
  const [channelCode,   setChannelCode]   = useState(_f.channelCode   || '')
  const [customerCode,  setCustomerCode]  = useState(_f.customerCode  || '')
  const [selectedBrands, setSelectedBrands] = useState(_f.selectedBrands || [])

  const [dateFrom,      setDateFrom]      = useState(_f.dateFrom      || todayYM())
  const [dateTo,        setDateTo]        = useState(_f.dateTo        || twelveMonthsAheadYM())

  // Persist whenever any filter changes — always read fresh from storage to avoid stale captures
  const updateBuCode       = v => { setBuCode(v);        saveFilters({ ...loadFilters(), buCode: v, customerCode: '' }) }
  const updateFtCode       = v => { setFtCode(v);        saveFilters({ ...loadFilters(), ftCode: v }) }
  const updateChannelCode  = v => { setChannelCode(v);   saveFilters({ ...loadFilters(), channelCode: v }) }
  const updateCustomerCode = v => { setCustomerCode(v);  saveFilters({ ...loadFilters(), customerCode: v }) }
  const updateSelectedBrands = v => { setSelectedBrands(v); saveFilters({ ...loadFilters(), selectedBrands: v }) }

  const updateDateFrom = v => {
    setDateFrom(v)
    // Auto-set To to 11 months after the new From
    if (v) {
      const [y, m] = v.split('-').map(Number)
      const toDate  = new Date(y, m - 1 + 11, 1)
      const toYM    = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, '0')}`
      setDateTo(toYM)
      saveFilters({ ...loadFilters(), dateFrom: v, dateTo: toYM })
    } else {
      saveFilters({ ...loadFilters(), dateFrom: v })
    }
  }
  const updateDateTo       = v => { setDateTo(v);        saveFilters({ ...loadFilters(), dateTo: v }) }

  const [modalCell,    setModalCell]    = useState(null)
  const [showAddItems, setShowAddItems] = useState(false)
  const [showGmCopy,   setShowGmCopy]   = useState(false)
  const [showActuals,  setShowActuals]  = useState(false)
  const [showLE,       setShowLE]       = useState(false)
  const [showEmpty,    setShowEmpty]    = useState(false)
  const [importing,    setImporting]    = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importProgress, setImportProgress] = useState(null)
  // { current, total, currentItem, updated, created, skipped }
  const [saving,       setSaving]       = useState(false)
  const [gridError,    setGridError]    = useState('')
  const [contextMenu,  setContextMenu]  = useState(null) // { x, y, row }
  const [bulkPrice,    setBulkPrice]    = useState(null) // { row, fromYM, toYM, price, priceTypeCode, saving, error }
  const fileInputRef = useRef()

  // ── Reference data ─────────────────────────────────────────────────────────
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: fetchMe })
  const { data: bus  = [] } = useQuery({ queryKey: ['bus'],  queryFn: fetchBusinessUnits })

  // Only show BUs the current user is assigned to, unless they can view all
  const permittedBUs = me?.role?.CanViewAllBU
    ? bus
    : bus.filter(bu => me?.bu_assignments?.some(a => a.BusinessUnitCode === bu.Code))
  const { data: fts  = [] } = useQuery({ queryKey: ['fts'],  queryFn: fetchForecastTypes })
  const { data: chns = [] } = useQuery({ queryKey: ['chns'], queryFn: fetchSalesChannels })


  const { data: pts        = [] } = useQuery({ queryKey: ['pts'],        queryFn: fetchPriceTypes })
  const { data: brands     = [] } = useQuery({ queryKey: ['brands'],     queryFn: fetchBrands })
  const { data: currencies = [] } = useQuery({ queryKey: ['currencies'], queryFn: fetchCurrencies })

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', buCode],
    queryFn:  () => fetchCustomers(buCode),
    enabled:  !!buCode,
  })

  // Full item catalogue for the BU — used by AddItemsModal
  const { data: allItems = [] } = useQuery({
    queryKey: ['items', buCode],
    queryFn:  () => fetchItems(buCode),
    enabled:  !!buCode,
  })

  const selectedBU      = bus.find(b => b.Code === buCode)
  // Forward horizon: how many months ahead the user can edit
  // Stored in HorizonMonthsBack column (repurposed as forward-looking)
  const horizonMonthsBack = me?.role?.HorizonMonthsBack ?? 0
  const selectedCurrency = currencies.find(c => c.Code === selectedBU?.CurrencyCode)
  const buCurrencySymbol = selectedCurrency?.Symbol || selectedBU?.CurrencyCode || ''
  // FOB channel always uses USD ($); Domestic/DDP use the BU home currency
  const currencySymbol   = channelCode === 'FOB' ? '$' : buCurrencySymbol

  // ── Forecast query ─────────────────────────────────────────────────────────
  const canLoad = !!(buCode && ftCode && channelCode && customerCode)

  const { data: forecastRows = [], isLoading, error: fetchError } = useQuery({
    queryKey: ['forecast', buCode, ftCode, channelCode, customerCode, dateFrom, dateTo, selectedBrands],
    queryFn: () => fetchForecast(buCode, {
      forecast_type_code: ftCode,
      sales_channel_code: channelCode,
      customer_code:      customerCode,
      date_from:          firstOfMonth(dateFrom),
      date_to:            firstOfMonth(dateTo),
    }),
    enabled: canLoad,
  })

  // Client-side brand filter applied after fetch
  const filteredForecastRows = useMemo(() =>
    selectedBrands.length === 0
      ? forecastRows
      : forecastRows.filter(r => selectedBrands.includes(r.BrandName)),
  [forecastRows, selectedBrands])

  // ── Actuals query — runs alongside forecast ───────────────────────────────
  const { data: actualsRows = [] } = useQuery({
    queryKey: ['grid-actuals', buCode, channelCode, customerCode, dateFrom, dateTo],
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    queryFn: () => fetchComparison(buCode, {
      customer_code: customerCode,
      date_from:     firstOfMonth(dateFrom),
      date_to:       firstOfMonth(dateTo),
    }),
    enabled: canLoad,
  })

  // ── Build month columns ────────────────────────────────────────────────────
  const months = useMemo(() => monthsBetween(dateFrom, dateTo), [dateFrom, dateTo])

  // ── Pivot forecast rows → one F row per item ─────────────────────────────
  const forecastItemMap = useMemo(() => {
    const map = new Map()
    for (const fr of filteredForecastRows) {
      if (!map.has(fr.ItemNo)) {
        map.set(fr.ItemNo, {
          itemNo:      fr.ItemNo,
          description: fr.ItemDescription || fr.ItemNo,
          brandName:   fr.BrandName || '',
          rowType:     'F',
          months:      {},
        })
      }
      const mk = monthKey(fr.ForecastDate)
      map.get(fr.ItemNo).months[mk] = {
        entryNo:       fr.EntryNo,
        priceTypeCode: fr.PriceTypeCode,
        quantity:      parseFloat(fr.Quantity),
        price:         parseFloat(fr.Price),
        notes:         fr.Notes,
      }
    }
    return map
  }, [filteredForecastRows])

  // ── Pivot actuals rows → one A row per item ────────────────────────────────
  const actualsItemMap = useMemo(() => {
    const map = new Map()
    for (const ar of actualsRows) {
      // Only include actuals matching the selected sales channel
      if (channelCode && ar.SalesChannelCode !== channelCode) continue
      const itemNo = ar.ItemNo
      if (!map.has(itemNo)) {
        map.set(itemNo, {
          itemNo,
          description: ar.ItemDescription || ar.Description || itemNo,
          brandName:   ar.BrandName || '',
          rowType:     'A',
          months:      {},
        })
      }
      // Only store months where actuals data actually exists
      if (ar.ActualsQty != null) {
        const mk = monthKey(ar.ForecastDate)
map.get(itemNo).months[mk] = {
          quantity:   parseFloat(ar.ActualsQty),
          totalValue: parseFloat(ar.ActualsTotalValue ?? 0),
        }
      }
    }
    return map
  }, [actualsRows, channelCode])

  // ── Merge into paired F/A rows, one pair per item ─────────────────────────
  const rowData = useMemo(() => {
    // Build the item number set:
    // - No brand filter → full union of forecast + actuals items
    // - Brand filter active → forecast items for that brand, PLUS actuals-only
    //   items whose brand (resolved from the allItems catalogue) matches the filter
    let allItemNoSet
    if (selectedBrands.length === 0) {
      allItemNoSet = new Set([...forecastItemMap.keys(), ...actualsItemMap.keys()])
    } else {
      allItemNoSet = new Set(forecastItemMap.keys())
      // Add actuals-only items whose brand matches the selected brands
      const catalogueBrandMap = new Map(allItems.map(i => [i.ItemNo, i.BrandCode]))
      for (const itemNo of actualsItemMap.keys()) {
        if (forecastItemMap.has(itemNo)) continue // already included
        const brandCode  = catalogueBrandMap.get(itemNo)
        const brandName  = brands.find(b => b.Code === brandCode)?.Name || ''
        if (selectedBrands.includes(brandName)) allItemNoSet.add(itemNo)
      }
    }
    const allItemNos = Array.from(allItemNoSet)
    // no pre-sort — we sort after building rows so we can sort by brand name

    // Build one F+A pair per item.
    // For actuals-only items, resolve brand name from the allItems catalogue.
    const itemCatalogueMap = new Map(allItems.map(i => [i.ItemNo, i]))

    const pairs = [] // [{itemNo, brandName, description, fRow, aRow}]
    for (const itemNo of allItemNos) {
      const fRow      = forecastItemMap.get(itemNo)
      const aRow      = actualsItemMap.get(itemNo)
      const catalogue = itemCatalogueMap.get(itemNo)

      // Brand name: prefer F row (already enriched by API),
      // fall back to A row (from comparison endpoint),
      // then catalogue, then empty string
      const brandCode = catalogue?.BrandCode
      const brandName = fRow?.brandName
        || aRow?.brandName
        || brands.find(b => b.Code === brandCode)?.Name
        || ''

      // Description: prefer F row, fall back to actuals, then catalogue
      const description = fRow?.description
        || aRow?.description
        || catalogue?.Description
        || itemNo

      // Skip items where the F row has no entries in the visible range
      // (unless showEmpty is true or the item has actuals)
      const fRowHasData = fRow && Object.values(fRow.months || {}).some(c => c?.entryNo)
      const aRowHasData = !!aRow
      if (!showEmpty && !fRowHasData && !aRowHasData) continue

      pairs.push({ itemNo, brandName, description, fRow, aRow })
    }

    // Sort: single brand selected → ItemNo asc only
    //       multiple/none → Brand name asc, then ItemNo asc
    if (selectedBrands.length === 1) {
      pairs.sort((a, b) => a.itemNo.localeCompare(b.itemNo))
    } else {
      pairs.sort((a, b) => {
        // Items with no brand sort to the bottom
        const aBrand = a.brandName || '￿'
        const bBrand = b.brandName || '￿'
        const bc = aBrand.localeCompare(bBrand)
        return bc !== 0 ? bc : a.itemNo.localeCompare(b.itemNo)
      })
    }

    // Current month as YYYY-MM for LE row calculation
    const today = new Date()
    const currentYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`

    const rows = []
    for (const { itemNo, brandName, description, fRow, aRow } of pairs) {
      // Forecast row — always present (empty shell if actuals-only)
      rows.push(fRow ?? {
        itemNo,
        description,
        brandName,
        rowType: 'F',
        months:  {},
      })

      // Actuals row — always present, defaulting missing months to 0
      const actualsMonths = {}
      for (const ym of months) {
        const aCell = aRow?.months?.[ym]
        actualsMonths[ym] = {
          quantity:   aCell?.quantity   ?? 0,
          totalValue: aCell?.totalValue ?? 0,
        }
      }
      rows.push({
        itemNo,
        description,
        brandName,
        rowType: 'A',
        months:  actualsMonths,
      })

      // LE row — actuals for past months, forecast for current month and future
      const leMonths = {}
      for (const ym of months) {
        if (ym < currentYM) {
          // Past — use actuals
          const aCell = aRow?.months?.[ym]
          leMonths[ym] = {
            quantity:   aCell?.quantity   ?? 0,
            totalValue: aCell?.totalValue ?? 0,
            isActuals:  true,
          }
        } else {
          // Current month and future — use forecast
          const fCell = fRow?.months?.[ym]
          leMonths[ym] = {
            quantity:   fCell?.quantity ?? 0,
            totalValue: fCell ? (fCell.quantity ?? 0) * (fCell.price ?? 0) : 0,
            isActuals:  false,
          }
        }
      }
      rows.push({
        itemNo,
        description,
        brandName,
        rowType: 'LE',
        months:  leMonths,
      })
    }
    return rows
  }, [forecastItemMap, actualsItemMap, months, selectedBrands, showEmpty])

  // ── Row totals ─────────────────────────────────────────────────────────────
  const rowDataWithTotals = useMemo(() => {
    const source = rowData.filter(r => {
      if (r.rowType === 'A')  return showActuals
      if (r.rowType === 'LE') return showLE
      return true  // F rows always visible
    })
    const withTotals = source.map(row => ({
      ...row,
      rowTotal: months.reduce((sum, ym) => sum + (row.months?.[ym]?.quantity ?? 0), 0),
      rowValue: months.reduce((sum, ym) => {
        const cell = row.months?.[ym]
        if (row.rowType === 'A' || row.rowType === 'LE') return sum + (cell?.totalValue ?? 0)
        return sum + ((cell?.quantity ?? 0) * (cell?.price ?? 0))
      }, 0),
    }))

    // Mark the last row of each brand group so getRowStyle can draw a divider.
    // When actuals are shown the last A row gets the border.
    // When actuals are hidden the last F row gets it instead.
    for (let i = 0; i < withTotals.length; i++) {
      const row  = withTotals[i]
      const next = withTotals[i + 1]
      const isBrandBoundary = !next || next.brandName !== row.brandName
      // Border on the last visible row of each brand group
      const lastVisibleType = showLE ? 'LE' : showActuals ? 'A' : 'F'
      row.isLastInBrand = row.rowType === lastVisibleType && isBrandBoundary
    }
    return withTotals
  }, [rowData, months, showActuals, showLE])

  // ── Set of item numbers already in the grid (for AddItemsModal exclusion) ──
  const existingItemNos = useMemo(
    () => new Set(rowData.filter(r => r.rowType === 'F').map(r => r.itemNo)),
    [rowData]
  )

  // ── Pinned top totals row — forecast totals only ───────────────────────────
  const pinnedBottomRow = useMemo(() => {
    if (!rowData.length) return []
    const fRows = rowData.filter(r => r.rowType === 'F')  // totals always from F rows only
    const totals = { brandName: '', itemNo: '', description: 'Total', rowType: '', months: {}, rowTotal: 0, rowValue: 0 }
    for (const ym of months) {
      const colSum = fRows.reduce((sum, row) => sum + (row.months?.[ym]?.quantity ?? 0), 0)
      const valSum = fRows.reduce((sum, row) => {
        const cell = row.months?.[ym]
        return sum + ((cell?.quantity ?? 0) * (cell?.price ?? 0))
      }, 0)
      totals.months[ym] = { quantity: colSum }
      totals.rowTotal += colSum
      totals.rowValue += valSum
    }
    return [totals]
  }, [rowData, months])

  // ── Column definitions ─────────────────────────────────────────────────────
  const colDefs = useMemo(() => {
    const fixed = [
      {
        headerName: 'Item',
        field: 'itemNo',
        width: 260,
        pinned: 'left',
        editable: false,
        filter: 'agTextColumnFilter',
        filterParams: { buttons: ['clear'] },
        floatingFilter: true,
        filterValueGetter: params => params.data
          ? `${params.data.itemNo} ${params.data.description}`
          : '',
        tooltipValueGetter: params => params.data?.brandName ? `Brand: ${params.data.brandName}` : null,
        valueGetter: params => params.data
          ? `${params.data.itemNo}  —  ${params.data.description}`
          : '',
        cellStyle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 },
        onCellContextMenu: params => {
          if (!params.data || params.data.rowType !== 'F') return
          params.event.preventDefault()
          setContextMenu({ x: params.event.clientX, y: params.event.clientY, row: params.data })
        },
      },
      {
        headerName: '',
        field: 'rowType',
        width: 42,
        pinned: 'left',
        editable: false,
        cellStyle: params => ({
          fontWeight: 700,
          fontSize: 11,
          color: params.value === 'F' ? 'var(--c-primary)'
               : params.value === 'LE' ? '#7D3C98'
               : 'var(--c-success)',
          textAlign: 'center',
          padding: 0,
        }),
      },
    ]
    const monthCols = months.map(ym => ({
      headerName: formatMonth(ym),
      field: `months.${ym}.quantity`,
      width: 90,
      type: 'numericColumn',
      // Only F rows in unlocked months are editable
      editable: params => params.data?.rowType === 'F' && !isLockedMonth(ym, horizonMonthsBack),
      cellStyle: params => {
        if (params.data?.rowType === 'A') return { background: '#f9fdfb', padding: 0 }
        if (isLockedMonth(ym, horizonMonthsBack)) return { background: 'var(--c-locked)', padding: 0 }
        if (params.value != null && params.value !== 0) return { background: '#eaf4fb', fontWeight: 600, padding: 0 }
        return { padding: 0 }
      },
      cellRendererParams: { ym, locked: isLockedMonth(ym, horizonMonthsBack) },
      cellRenderer: ForecastCellRenderer,
      tooltipValueGetter: params => {
        if (params.node?.rowPinned) return null           // no tooltip on total row
        if (params.data?.rowType === 'LE') return null    // no tooltip on LE rows
        if (params.data?.rowType === 'A') {
          const fRow = params.context?.rowData?.find(r => r.itemNo === params.data?.itemNo && r.rowType === 'F')
          const fQty = fRow?.months?.[ym]?.quantity
          const aQty = params.value ?? 0
          const pct  = fQty != null && fQty !== 0 ? Math.round((aQty / fQty) * 100) : null
          return pct != null ? `Actuals: ${aQty} (${pct}% of forecast ${fQty})` : `Actuals: ${aQty}`
        }
        const cell = params.data?.months?.[ym]
        if (isLockedMonth(ym, horizonMonthsBack)) return `Period is locked — Qty: ${cell?.quantity ?? '—'}`
        if (!cell) return 'Click to add quantity  |  Double-click for price & notes'
        return `Qty: ${cell.quantity}  |  Price: ${currencySymbol}${cell.price}  —  Double-click for details`
      },
    }))
    const totalCol = {
      headerName: 'Units',
      field: 'rowTotal',
      width: 80,
      type: 'numericColumn',
      editable: false,
      pinned: 'right',
      cellStyle: params => params.data?.rowType === 'A'
        ? { background: '#f9fdfb', padding: 0 }
        : { fontWeight: 700, background: '#f0f3f7', padding: 0 },
      cellRenderer: ForecastCellRenderer,
    }
    const valueCol = {
      headerName: 'Value',
      field: 'rowValue',
      width: 95,
      type: 'numericColumn',
      editable: false,
      pinned: 'right',
      cellStyle: params => params.data?.rowType === 'A'
        ? { background: '#f9fdfb', padding: 0, fontStyle: 'italic' }
        : { fontWeight: 700, background: '#eaf0fb', padding: 0 },
      cellRenderer: params => {
        if (params.value == null) return null
        const isA = params.data?.rowType === 'A' || params.data?.rowType === 'LE'
        const val = Number(params.value)
        const formatted = val.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
        return (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            height: '100%', padding: '0 8px', boxSizing: 'border-box',
            fontSize: 11,
            fontStyle: isA ? 'italic' : 'normal',
            color: isA ? 'var(--c-muted)' : 'var(--c-primary)',
          }}>
            {currencySymbol}{formatted}
          </div>
        )
      },
    }
    return [...fixed, ...monthCols, totalCol, valueCol]
  }, [months, currencySymbol, horizonMonthsBack])

  // Keep a ref to latest rowData so onCellValueChanged always sees current entryNos
  const rowDataRef = useRef([])
  rowDataRef.current = rowDataWithTotals

  // ── Inline cell value changed (quantity saved directly) ───────────────────
  const onCellValueChanged = useCallback(async (params) => {
    const colId = params.column.getColId()
    const match = colId.match(/^months\.(\d{4}-\d{2})\.quantity$/)
    if (!match) return

    const ym       = match[1]
    if (params.node?.rowPinned) return           // ignore edits on total row
    // Actuals rows are never editable
    if (params.data?.rowType === 'A') return
    const itemNo   = params.data?.itemNo
    // Look up the current F row from the ref — params.data may be a stale snapshot
    const liveRow  = rowDataRef.current.find(r => r.itemNo === itemNo && r.rowType === 'F')
    const cell     = liveRow?.months?.[ym]
    const rawValue = params.newValue
    const quantity = rawValue === '' || rawValue == null ? null : parseFloat(rawValue)

    setGridError('')

    try {
      if (cell?.entryNo) {
        // Existing row — update quantity
        if (quantity === null) {
          // Cleared → delete the row
          await deleteForecastRow(buCode, cell.entryNo)
        } else {
          await updateForecastRow(buCode, cell.entryNo, { Quantity: quantity, Notes: cell.notes })
        }
      } else {
        // New row — create with quantity only (price/price type optional)
        if (quantity === null || isNaN(quantity)) return
        await createForecastRow(buCode, {
          ForecastTypeCode: Number(ftCode),
          SalesChannelCode: channelCode,
          CustomerCode:     customerCode,
          ItemNo:           itemNo,
          ForecastDate:     firstOfMonth(ym),
          PriceTypeCode:    null,  // user sets price type via double-click modal
          Price:            0,
          Quantity:         quantity,
          Notes:            null,
        })
      }
      qc.invalidateQueries({ queryKey: ['forecast'] })
    } catch (e) {
      setGridError(e.message)
      qc.invalidateQueries({ queryKey: ['forecast'] }) // revert optimistic display
    }
  }, [buCode, ftCode, channelCode, customerCode, qc])

  // ── Double click → open modal for price / notes ───────────────────────────
  const onCellDoubleClicked = useCallback((params) => {
    if (params.node?.rowPinned) return              // ignore double-click on total row
    const colId = params.column.getColId()
    const match = colId.match(/^months\.(\d{4}-\d{2})\.quantity$/)
    if (!match) return
    const ym = match[1]
    if (isLockedMonth(ym, horizonMonthsBack)) return
    if (params.data?.rowType === 'A')  return  // actuals are read-only
    if (params.data?.rowType === 'LE') return  // LE rows are read-only

    // Stop any active inline edit before opening modal
    gridRef.current?.api?.stopEditing(true)

    const row      = params.data
    const cell     = row?.months?.[ym]
    const customer = customers.find(c => c.Code === customerCode)
    setModalCell({
      ym,
      period:         formatMonth(ym),
      itemNo:         row.itemNo,
      description:    row.description,
      channelCode,
      customerCode,
      customerName:   customer?.Name || customerCode,
      currencySymbol: currencySymbol,
      entryNo:        cell?.entryNo      ?? null,
      priceTypeCode:  cell?.priceTypeCode ?? null,
      quantity:       cell?.quantity     ?? null,
      price:          cell?.price        ?? null,
      notes:          cell?.notes        ?? '',
    })
  }, [customers, customerCode, selectedBU, channelCode, horizonMonthsBack])

  // ── Tab navigation — skip locked and non-month columns ────────────────────
  const tabToNextCell = useCallback((params) => {
    const allCols   = params.api.getAllDisplayedColumns()
    const monthCols = allCols.filter(c => /^months\.\d{4}-\d{2}\.quantity$/.test(c.getColId()))

    // Use previousCellPosition as the source — nextCellPosition is where AG Grid
    // wants to go, which may already be outside the month columns
    const fromCol    = params.previousCellPosition?.column
    const fromRow    = params.previousCellPosition?.rowIndex ?? 0
    const currentIdx = monthCols.indexOf(fromCol)

    const direction = params.backwards ? -1 : 1

    // If we're not currently in a month column, find the first/last unlocked one
    let startIdx = currentIdx === -1
      ? (params.backwards ? monthCols.length - 1 : 0)
      : currentIdx + direction

    // Walk forward/backward to find the next unlocked editable month column
    for (let idx = startIdx; idx >= 0 && idx < monthCols.length; idx += direction) {
      const colId = monthCols[idx].getColId()
      const ym    = colId.match(/^months\.(\d{4}-\d{2})\.quantity$/)?.[1]
      if (ym && !isLockedMonth(ym, horizonMonthsBack)) {
        return { rowIndex: fromRow, column: monthCols[idx] }
      }
    }

    // No more unlocked month columns in this row — let AG Grid handle naturally
    return params.nextCellPosition
  }, [horizonMonthsBack])

  // ── Export to Excel ───────────────────────────────────────────────────────
  function handleExport() {
    if (!rowDataWithTotals.length) return

    // Only export F rows (not A/actuals rows, not the totals row)
    const fRows = rowDataWithTotals.filter(r => r.rowType === 'F')
    if (!fRows.length) return

    const exportRows = fRows.map(row => {
      const r = { 'Item No': row.itemNo, 'Description': row.description }
      for (const ym of months) {
        const qty = row.months?.[ym]?.quantity
        r[formatMonth(ym)] = qty != null ? Number(qty) : ''
      }
      return r
    })

    const ws = XLSX.utils.json_to_sheet(exportRows)

    // Auto-fit column widths
    const keys = Object.keys(exportRows[0])
    ws['!cols'] = keys.map(k => ({
      wch: Math.max(k.length, ...exportRows.map(r => String(r[k] ?? '').length))
    }))

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Forecast')
    const date = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `SFMS_Forecast_${buCode}_${date}.xlsx`)
  }

  // ── Import from Excel ──────────────────────────────────────────────────────
  async function handleImportFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    setImporting(true)
    setImportResult(null)
    setImportProgress(null)
    setGridError('')

    try {
      const data   = await file.arrayBuffer()
      const wb     = XLSX.read(data)
      const ws     = wb.Sheets[wb.SheetNames[0]]
      const parsed = XLSX.utils.sheet_to_json(ws)

      if (!parsed.length) {
        setGridError('The spreadsheet appears to be empty.')
        setImporting(false)
        return
      }

      // Build month header → YYYY-MM map
      const monthHeaderMap = {}
      for (const ym of months) {
        monthHeaderMap[formatMonth(ym)] = ym
      }

      // Filter to rows that have at least one editable month value
      const validRows = parsed.filter(row => {
        const itemNo = String(row['Item No'] ?? '').trim()
        if (!itemNo) return false
        return Object.entries(monthHeaderMap).some(([header]) => {
          const rawQty = row[header]
          return rawQty !== '' && rawQty !== undefined && rawQty !== null && !isNaN(parseFloat(rawQty))
        })
      })

      const total = validRows.length
      let updated = 0, created = 0, skipped = 0, errors = []

      for (let i = 0; i < validRows.length; i++) {
        const row    = validRows[i]
        const itemNo = String(row['Item No'] ?? '').trim()

        // Update progress — yield to React to render between items
        setImportProgress({
          current:     i + 1,
          total,
          currentItem: itemNo,
          updated,
          created,
          skipped,
        })
        await new Promise(r => setTimeout(r, 0))  // yield to UI thread

        for (const [header, ym] of Object.entries(monthHeaderMap)) {
          const rawQty = row[header]
          if (rawQty === '' || rawQty === undefined || rawQty === null) continue
          const qty = parseFloat(rawQty)
          if (isNaN(qty)) continue

          if (isLockedMonth(ym, horizonMonthsBack)) { skipped++; continue }

          const existingRow  = rowDataWithTotals.find(r => r.itemNo === itemNo && r.rowType === 'F')
          const existingCell = existingRow?.months?.[ym]

          try {
            if (existingCell?.entryNo) {
              await updateForecastRow(buCode, existingCell.entryNo, { Quantity: qty, Notes: null })
              updated++
            } else {
              const itemMeta = allItems.find(i => i.ItemNo === itemNo)
              if (!itemMeta) { skipped++; continue }
              await createForecastRow(buCode, {
                ForecastTypeCode: Number(ftCode),
                SalesChannelCode: channelCode,
                CustomerCode:     customerCode,
                ItemNo:           itemNo,
                ForecastDate:     firstOfMonth(ym),
                PriceTypeCode:    pts[0]?.Code ?? null,
                Price:            0,
                Quantity:         qty,
                Notes:            null,
              })
              created++
            }
          } catch (err) {
            if (err.message.includes('before the current month') ||
                err.message.includes('editing horizon') ||
                err.message.includes('actuals exist')) {
              skipped++
            } else {
              errors.push(`${itemNo} ${formatMonth(ym)}: ${err.message}`)
            }
          }
        }
      }

      await qc.invalidateQueries({ queryKey: ['forecast'] })
      setImportProgress(null)
      setImportResult({ updated, created, skipped, errors })
    } catch (err) {
      setGridError(`Import failed: ${err.message}`)
    } finally {
      setImporting(false)
    }
  }

  // ── Bulk price update ────────────────────────────────────────────────────────
  async function handleBulkPriceUpdate() {
    if (!bulkPrice) return
    const { row, fromYM, toYM, price, priceTypeCode: bpPriceType } = bulkPrice
    const newPrice = parseFloat(price)
    if (isNaN(newPrice) || newPrice < 0) {
      setBulkPrice(bp => ({ ...bp, error: 'Please enter a valid price.' }))
      return
    }
    if (!bpPriceType) {
      setBulkPrice(bp => ({ ...bp, error: 'Please select a Price Type.' }))
      return
    }
    if (!fromYM || !toYM || fromYM > toYM) {
      setBulkPrice(bp => ({ ...bp, error: 'Please select a valid date range.' }))
      return
    }

    setBulkPrice(bp => ({ ...bp, saving: true, error: '' }))
    setGridError('')

    try {
      // Find all F row cells for this item within the selected range
      const fRow = rowDataWithTotals.find(r => r.itemNo === row.itemNo && r.rowType === 'F')
      if (!fRow) return

      const targetMonths = months.filter(ym => ym >= fromYM && ym <= toYM)
      let updated = 0, created = 0

      for (const ym of targetMonths) {
        if (isLockedMonth(ym, horizonMonthsBack)) continue
        const cell = fRow.months?.[ym]

        if (cell?.entryNo) {
          // Existing row — simple update (price no longer part of unique key)
          await updateForecastRow(buCode, cell.entryNo, {
            Quantity:      cell.quantity ?? 0,
            Price:         newPrice,
            PriceTypeCode: Number(bpPriceType),
            Notes:         null,
          })
          updated++
        } else {
          // No existing row — create with quantity 0
          await createForecastRow(buCode, {
            ForecastTypeCode: Number(ftCode),
            SalesChannelCode: channelCode,
            CustomerCode:     customerCode,
            ItemNo:           row.itemNo,
            ForecastDate:     firstOfMonth(ym),
            PriceTypeCode:    Number(bpPriceType),
            Price:            newPrice,
            Quantity:         0,
            Notes:            null,
          })
          created++
        }
      }

      await qc.invalidateQueries({ queryKey: ['forecast'] })
      setBulkPrice(null)
      if (updated + created > 0) {
        setGridError('')
      }
    } catch (err) {
      setBulkPrice(bp => ({ ...bp, saving: false, error: err.message }))
    }
  }

  // ── Bulk add items ─────────────────────────────────────────────────────────
  async function handleBulkAdd({ selectedItems, monthFrom, monthTo, priceTypeCode: modalPriceType }) {
    setSaving(true)
    setGridError('')

    // Build list of YYYY-MM strings between monthFrom and monthTo
    function monthsBetween(from, to) {
      const months = []
      const [fy, fm] = from.split('-').map(Number)
      const [ty, tm] = to.split('-').map(Number)
      let y = fy, m = fm
      while (y < ty || (y === ty && m <= tm)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`)
        m++; if (m > 12) { m = 1; y++ }
      }
      return months
    }

    const targetMonths = monthsBetween(monthFrom, monthTo)
    const errors = []

    for (const item of selectedItems) {
      for (const ym of targetMonths) {
        try {
          await createForecastRow(buCode, {
            ForecastTypeCode: Number(ftCode),
            SalesChannelCode: channelCode,
            CustomerCode:     customerCode,
            ItemNo:           item.ItemNo,
            ForecastDate:     ym + '-01',
            PriceTypeCode:    Number(modalPriceType),
            Price:            0,
            Quantity:         0,
            Notes:            null,
          })
        } catch (e) {
          // Skip duplicates (409) silently — row may already exist
          if (!e.message.includes('already exists')) {
            errors.push(`${item.ItemNo} ${ym}: ${e.message}`)
          }
        }
      }
    }

    await qc.invalidateQueries({ queryKey: ['forecast'] })
    setSaving(false)
    setShowAddItems(false)

    if (errors.length) {
      setGridError(`Added with ${errors.length} error(s): ${errors.slice(0, 3).join('; ')}`)
    }
  }

  // ── Modal save (price / notes update) ─────────────────────────────────────
  async function handleModalSave({ quantity, price, notes, priceTypeCode: modalPriceType }) {
    setSaving(true)
    setGridError('')
    try {
      if (modalCell.entryNo) {
        // Simple update — price and price type are no longer part of the unique key
        await updateForecastRow(buCode, modalCell.entryNo, {
          Quantity:      quantity,
          Price:         price ?? 0,
          PriceTypeCode: modalPriceType ? Number(modalPriceType) : null,
          Notes:         notes || null,
        })
      } else {
        await createForecastRow(buCode, {
          ForecastTypeCode: Number(ftCode),
          SalesChannelCode: channelCode,
          CustomerCode:     customerCode,
          ItemNo:           modalCell.itemNo,
          ForecastDate:     firstOfMonth(modalCell.ym),
          PriceTypeCode:    modalPriceType ? Number(modalPriceType) : null,
          Price:            price ?? 0,
          Quantity:         quantity,
          Notes:            notes || null,
        })
      }
      qc.invalidateQueries({ queryKey: ['forecast'] })
      setModalCell(null)
    } catch (e) {
      setGridError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Modal delete ───────────────────────────────────────────────────────────
  async function handleModalDelete(entryNo) {
    if (!window.confirm('Delete this forecast row?')) return
    setSaving(true)
    setGridError('')
    try {
      await deleteForecastRow(buCode, entryNo)
      qc.invalidateQueries({ queryKey: ['forecast'] })
      setModalCell(null)
    } catch (e) {
      setGridError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="card">
        <div className="card-title">Forecast Entry</div>

        {/* ── Row 1: Required filters + date range ── */}
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <div className="field-group">
            <label>Forecast Type *</label>
            <select value={ftCode} onChange={e => updateFtCode(e.target.value)}>
              <option value="">— Select —</option>
              {fts.map(f => <option key={f.Code} value={f.Code}>{f.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Responsibility *</label>
            <select value={buCode} onChange={e => { updateBuCode(e.target.value); setCustomerCode('') }}>
              <option value="">— Select —</option>
              {permittedBUs.map(b => <option key={b.Code} value={b.Code}>{b.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Sales Channel *</label>
            <select value={channelCode} onChange={e => updateChannelCode(e.target.value)}>
              <option value="">— Select —</option>
              {chns.map(c => <option key={c.Code} value={c.Code}>{c.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>Customer *</label>
            <select value={customerCode} onChange={e => updateCustomerCode(e.target.value)} disabled={!buCode}>
              <option value="">— Select —</option>
              {customers.map(c => <option key={c.Code} value={c.Code}>{c.Name}</option>)}
            </select>
          </div>

          <div className="field-group">
            <label>From (month)</label>
            <MonthPicker value={dateFrom} onChange={updateDateFrom} />
          </div>

          <div className="field-group">
            <label>To (month)</label>
            <MonthPicker value={dateTo} onChange={updateDateTo} />
          </div>
        </div>

        {/* ── Row 2: Brand filter + action buttons ── */}
        <div className="toolbar" style={{ marginBottom: 16 }}>
          <div className="field-group">
            <label>Brand (optional)</label>
            <MultiSelect
              placeholder="All brands"
              options={brands.map(b => ({ value: b.Name, label: b.Name }))}
              selected={selectedBrands}
              onChange={updateSelectedBrands}
            />
          </div>

          {/* Left-side action buttons: Actuals toggle + Add Items */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <button
              className="btn btn-ghost"
              onClick={() => setShowActuals(v => !v)}
              style={{
                borderColor: showActuals ? 'var(--c-success)' : 'var(--c-border)',
                color:       showActuals ? 'var(--c-success)' : 'var(--c-muted)',
                fontWeight:  showActuals ? 700 : 400,
              }}
            >
              {showActuals ? '✓ Actuals' : 'Actuals'}
            </button>

            <button
              className="btn btn-ghost"
              onClick={() => setShowLE(v => !v)}
              style={{
                borderColor: showLE ? '#7D3C98' : 'var(--c-border)',
                color:       showLE ? '#7D3C98' : 'var(--c-muted)',
                fontWeight:  showLE ? 700 : 400,
              }}
            >
              {showLE ? '✓ LE' : 'LE'}
            </button>

            <button
              className="btn btn-ghost"
              onClick={() => setShowEmpty(v => !v)}
              style={{
                borderColor: showEmpty ? 'var(--c-accent)' : 'var(--c-border)',
                color:       showEmpty ? 'var(--c-accent)' : 'var(--c-muted)',
                fontWeight:  showEmpty ? 700 : 400,
                fontSize:    12,
              }}
              title="Show items with no forecast data in the visible range"
            >
              {showEmpty ? '✓ Show empty' : 'Show empty'}
            </button>

            {(me?.role?.CanManageRefData || me?.role?.CanManageUsers) &&
              !fts.find(f => String(f.Code) === ftCode)?.Name?.toLowerCase().includes('gm') && (
              <button
                className="btn btn-ghost"
                onClick={() => setShowGmCopy(true)}
                disabled={!buCode}
                style={{ borderColor: 'var(--c-accent)', color: 'var(--c-accent)' }}
              >
                Copy → GM
              </button>
            )}

            <button
              className="btn btn-primary"
              onClick={() => setShowAddItems(true)}
              disabled={!canLoad}
            >
              + Add Items
            </button>
          </div>

          {/* Spacer pushes Export/Import to the right */}
          <div style={{ flex: 1 }} />

          {/* Right-side action buttons: Export + Import */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={handleExport}
              disabled={!rowDataWithTotals.filter(r => r.rowType === 'F').length}>
              ↓ Export
            </button>

            <button
              className="btn btn-ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing || !canLoad}
            >
              {importing ? 'Importing…' : '↑ Import'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>
        </div>

        <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Click a cell to edit quantity inline. Double-click to set price and notes.
        </p>

        {!canLoad && (
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>
            Select Responsibility, Forecast Type, Sales Channel and Customer to load the grid.
          </p>
        )}
        {gridError  && <div className="error-banner">{gridError}</div>}
        {fetchError && <div className="error-banner">{fetchError.message}</div>}
        {importResult && (
          <div style={{
            background: importResult.errors.length ? '#fdf0ee' : '#eafaf1',
            border: `1px solid ${importResult.errors.length ? '#f1948a' : '#a9dfbf'}`,
            borderRadius: 'var(--radius)', padding: '8px 14px',
            fontSize: 13, marginBottom: 10,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>
              Import complete — <strong>{importResult.updated}</strong> updated,{' '}
              <strong>{importResult.created}</strong> created,{' '}
              <strong>{importResult.skipped}</strong> skipped
              {importResult.errors.length > 0 && (
                <span style={{ color: 'var(--c-danger)', marginLeft: 8 }}>
                  · {importResult.errors.length} error(s): {importResult.errors[0]}
                </span>
              )}
            </span>
            <button
              onClick={() => setImportResult(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--c-muted)' }}
            >×</button>
          </div>
        )}

        {canLoad && (
          <div className="ag-theme-alpine" style={{ height: 520, width: '100%' }}>
            {isLoading ? (
              <div className="loading">Loading forecast data…</div>
            ) : (
              <AgGridReact
                ref={gridRef}
                rowData={rowDataWithTotals}
                context={{ rowData: rowDataWithTotals }}
                columnDefs={colDefs}
                pinnedTopRowData={pinnedBottomRow}
                suppressRowClickSelection
                onCellValueChanged={onCellValueChanged}
                onCellDoubleClicked={onCellDoubleClicked}
                preventDefaultOnContextMenu={true}
                tabToNextCell={tabToNextCell}
                stopEditingWhenCellsLoseFocus
                enterNavigatesVertically={false}
                onCellFocused={params => {
                  // Only auto-start editing when focus arrived via keyboard (tab/arrow),
                  // not on mouse click — avoids the flicker loop caused by repeated
                  // startEditingCell calls when focus shifts during edit.
                  if (!params.column || !params.fromTab) return
                  const colId = params.column.getColId?.() ?? params.column
                  if (/^months\.\d{4}-\d{2}\.quantity$/.test(colId)) {
                    params.api?.startEditingCell({
                      rowIndex: params.rowIndex,
                      colKey:   colId,
                    })
                  }
                }}
                tooltipShowDelay={600}
                defaultColDef={{ resizable: true, sortable: true, filter: false, floatingFilter: false }}
                rowHeight={28}
                headerHeight={34}
                getRowStyle={params => {
                  if (params.node.rowPinned) return { background: '#eaf0fb', fontWeight: 700, borderBottom: '2px solid #2e86c1' }
                  if (params.data?.isLastInBrand) {
                    const isF = params.data?.rowType === 'F'
                    return { background: isF ? 'transparent' : '#f7fdf9', borderBottom: '3px solid #a9cce3' }
                  }
                  if (params.data?.rowType === 'A')  return { background: '#f7fdf9', borderBottom: '1px solid #d5e8d4' }
                  if (params.data?.rowType === 'LE') return { background: '#fdf5ff', borderBottom: '1px solid #d7bde2' }
                }}
              />
            )}
          </div>
        )}

        {canLoad && !isLoading && rowData.length === 0 && (
          <p className="text-muted mt-8" style={{ fontSize: 13 }}>
            No forecast rows found for the selected filters. Click any future month cell to add one.
          </p>
        )}
      </div>

      {/* ── Context menu ── */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999,
          }}
          onClick={() => setContextMenu(null)}
          onContextMenu={e => { e.preventDefault(); setContextMenu(null) }}
        >
          <div
            style={{
              position: 'fixed',
              top: contextMenu.y, left: contextMenu.x,
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              zIndex: 1000, minWidth: 200, overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div
              style={{
                padding: '10px 16px', fontSize: 12,
                color: 'var(--c-muted)', borderBottom: '1px solid var(--c-border)',
                fontWeight: 600,
              }}
            >
              {contextMenu.row.itemNo}
            </div>
            <div
              style={{
                padding: '10px 16px', fontSize: 13, cursor: 'pointer',
                color: 'var(--c-text)',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--c-bg)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => {
                // Find the current price for this item from first available cell
                const fRow = rowDataWithTotals.find(r => r.itemNo === contextMenu.row.itemNo && r.rowType === 'F')
                const firstCell = months.map(ym => fRow?.months?.[ym]).find(c => c?.price != null)
                const currentPt = firstCell?.priceTypeCode
                  ? String(firstCell.priceTypeCode)
                  : String(pts[0]?.Code ?? '')
                setBulkPrice({
                  row:          contextMenu.row,
                  fromYM:       dateFrom,
                  toYM:         dateTo,
                  price:        firstCell?.price != null ? String(firstCell.price) : '',
                  priceTypeCode: currentPt,
                  saving:       false,
                  error:        '',
                })
                setContextMenu(null)
              }}
            >
              📋 Update price for all months…
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk price modal ── */}
      {bulkPrice && (
        <div className="modal-overlay" onClick={() => !bulkPrice.saving && setBulkPrice(null)}>
          <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 4 }}>Update Price</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 16 }}>
              <strong>{bulkPrice.row.itemNo}</strong> — {bulkPrice.row.description}
            </p>

            {bulkPrice.error && <div className="error-banner" style={{ marginBottom: 12 }}>{bulkPrice.error}</div>}

            <div className="modal-row">
              <label>Price Type</label>
              <select
                value={bulkPrice.priceTypeCode}
                onChange={e => setBulkPrice(bp => ({ ...bp, priceTypeCode: e.target.value }))}
                style={{ width: '100%', height: 34 }}
                disabled={bulkPrice.saving}
              >
                <option value="">— Select —</option>
                {pts.map(pt => <option key={pt.Code} value={pt.Code}>{pt.Name}</option>)}
              </select>
            </div>

            <div className="modal-row">
              <label>New Price ({channelCode === 'FOB' ? 'USD' : (selectedBU?.CurrencyCode || '')})</label>
              <input
                type="number" min="0" step="0.0001"
                value={bulkPrice.price}
                onChange={e => setBulkPrice(bp => ({ ...bp, price: e.target.value }))}
                autoFocus
                disabled={bulkPrice.saving}
                style={{ width: '100%' }}
              />
            </div>

            <div className="modal-row">
              <label>From month</label>
              <MonthPicker
                value={bulkPrice.fromYM}
                onChange={v => setBulkPrice(bp => ({ ...bp, fromYM: v }))}
              />
            </div>

            <div className="modal-row">
              <label>To month</label>
              <MonthPicker
                value={bulkPrice.toYM}
                onChange={v => setBulkPrice(bp => ({ ...bp, toYM: v }))}
              />
            </div>

            <p style={{ fontSize: 11, color: 'var(--c-muted)', marginTop: 8, marginBottom: 16 }}>
              All forecast rows for this item between the selected months will be updated to the new price.
              Locked periods are skipped.
            </p>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setBulkPrice(null)} disabled={bulkPrice.saving}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleBulkPriceUpdate} disabled={bulkPrice.saving}>
                {bulkPrice.saving ? 'Updating…' : 'Update Price'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Import progress modal ── */}
      {importProgress && (
        <div className="modal-overlay">
          <div className="modal" style={{ width: 460 }}>
            <h3 style={{ marginBottom: 6 }}>Importing Forecast Data</h3>
            <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 18 }}>
              Please wait — do not close this window.
            </p>

            {/* Progress bar */}
            <div style={{
              background: 'var(--c-border)', borderRadius: 4,
              height: 8, marginBottom: 10, overflow: 'hidden',
            }}>
              <div style={{
                width: `${Math.round((importProgress.current / importProgress.total) * 100)}%`,
                height: '100%',
                background: 'var(--c-accent)',
                borderRadius: 4,
                transition: 'width 0.15s ease',
              }} />
            </div>

            {/* Item counter */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--c-muted)', marginBottom: 14 }}>
              <span>Item {importProgress.current} of {importProgress.total}</span>
              <span>{Math.round((importProgress.current / importProgress.total) * 100)}%</span>
            </div>

            {/* Current item */}
            <div style={{
              background: 'var(--c-bg)', borderRadius: 'var(--radius)',
              padding: '8px 12px', fontSize: 12, marginBottom: 14,
              color: 'var(--c-text)', fontFamily: 'monospace',
            }}>
              {importProgress.currentItem}
            </div>

            {/* Running totals */}
            <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
              <span style={{ color: 'var(--c-success)' }}>
                <strong>{importProgress.updated}</strong> updated
              </span>
              <span style={{ color: 'var(--c-accent)' }}>
                <strong>{importProgress.created}</strong> created
              </span>
              <span style={{ color: 'var(--c-muted)' }}>
                <strong>{importProgress.skipped}</strong> skipped
              </span>
            </div>
          </div>
        </div>
      )}

      {showGmCopy && (
        <GmCopyModal
          buCode={buCode}
          forecastTypes={fts}
          onCopy={payload => copyForecastToGM(buCode, payload)}
          onClose={() => { setShowGmCopy(false); qc.invalidateQueries({ queryKey: ['forecast'] }) }}
        />
      )}

      {showAddItems && (
        <AddItemsModal
          items={allItems}
          brands={brands}
          priceTypes={pts}
          months={months}
          existingItemNos={existingItemNos}
          selectedBrands={selectedBrands}
          onAdd={handleBulkAdd}
          onClose={() => setShowAddItems(false)}
          saving={saving}
        />
      )}

      {canLoad && (
        <ForecastSummaryPanel
          buCode={buCode}
          ftCode={ftCode}
          channelCode={channelCode}
          customerCode={customerCode}
          dateFrom={dateFrom}
          dateTo={dateTo}
          months={months}
          currencySymbol={currencySymbol}
          customerName={customers.find(c => c.Code === customerCode)?.Name || customerCode}
          selectedBrands={selectedBrands}
        />
      )}

      {modalCell && (
        <EditModal
          cell={modalCell}
          onSave={handleModalSave}
          onDelete={handleModalDelete}
          onClose={() => setModalCell(null)}
          saving={saving}
          priceTypes={pts}
        />
      )}
    </div>
  )
}
