/**
 * PriceMaintenance.jsx
 *
 * Price management screen: view, add, delete and import pricing data per customer.
 * Prices are stored as monthly rows in tblPrice; the API returns them collapsed into
 * contiguous date ranges with the same price.
 *
 * Route: /prices
 * Min role: CanManageRefData
 */
import { useState, useMemo, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'

import {
  fetchBusinessUnits, fetchCustomers, fetchSalesChannels, fetchItems, fetchMe,
  fetchPrices, upsertPrice, deletePrice, downloadPriceTemplate,
  importPriceFile, confirmPriceImport, updatePriceRange,
} from '../../api/sfms'
import { useTheme } from '../../ThemeContext'

// ── Helpers ────────────────────────────────────────────────────────────────────
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function ymToApiDate(ym) {
  // Convert YYYY-MM picker value to YYYY-MM-DD (ISO 8601) for the API
  return `${ym}-01`
}

function formatMonthDisplay(isoDate) {
  if (!isoDate) return ''
  const [y, m] = isoDate.split('-')
  return `${MONTH_ABBR[Number(m) - 1]} ${y}`
}

function MonthPicker({ value, onChange, label }) {
  return (
    <div className="field-group">
      {label && <label>{label}</label>}
      <input
        type="month"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: 130 }}
      />
    </div>
  )
}

// ── Add Price Modal ────────────────────────────────────────────────────────────
function AddPriceModal({ buCode, customers, channels, items, onSave, onClose, saving }) {
  const [customerCode,     setCustomerCode]     = useState('')
  const [salesChannelCode, setSalesChannelCode] = useState('')
  const [itemNo,           setItemNo]           = useState('')
  const [startMonth,       setStartMonth]       = useState('')
  const [endMonth,         setEndMonth]         = useState('')
  const [price,            setPrice]            = useState('')
  const [error,            setError]            = useState('')

  async function handleSave() {
    setError('')
    if (!customerCode)     { setError('Customer is required.'); return }
    if (!salesChannelCode) { setError('Sales Channel is required.'); return }
    if (!itemNo)           { setError('Item is required.'); return }
    if (!startMonth)       { setError('Start month is required.'); return }
    if (!endMonth)         { setError('End month is required.'); return }
    if (startMonth > endMonth) { setError('"Start" must be before or equal to "End".'); return }
    const p = parseFloat(price)
    if (isNaN(p) || p < 0) { setError('Price must be a non-negative number.'); return }

    await onSave({
      CustomerCode:     customerCode,
      SalesChannelCode: salesChannelCode,
      ItemNo:           itemNo,
      StartDate:        ymToApiDate(startMonth),
      EndDate:          ymToApiDate(endMonth),
      Price:            p,
    })
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{ width: 440 }}>
        <h3>Add Price Range</h3>

        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        <div className="modal-row">
          <label>Customer</label>
          <select value={customerCode} onChange={e => setCustomerCode(e.target.value)} autoFocus>
            <option value="">— select —</option>
            {customers.map(c => (
              <option key={c.Code} value={c.Code}>{c.Name} ({c.Code})</option>
            ))}
          </select>
        </div>

        <div className="modal-row">
          <label>Sales Channel</label>
          <select value={salesChannelCode} onChange={e => setSalesChannelCode(e.target.value)}>
            <option value="">— select —</option>
            {channels.map(ch => (
              <option key={ch.Code} value={ch.Code}>{ch.Name ?? ch.Code}</option>
            ))}
          </select>
        </div>

        <div className="modal-row">
          <label>Item</label>
          <select value={itemNo} onChange={e => setItemNo(e.target.value)}>
            <option value="">— select —</option>
            {items.map(i => (
              <option key={i.ItemNo} value={i.ItemNo}>{i.ItemNo} — {i.Description}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <MonthPicker label="Start month" value={startMonth} onChange={setStartMonth} />
          <MonthPicker label="End month"   value={endMonth}   onChange={setEndMonth}   />
        </div>

        <div className="modal-row" style={{ marginTop: 12 }}>
          <label>Price</label>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={price}
            onChange={e => setPrice(e.target.value)}
            placeholder="0.00"
            style={{ width: 120 }}
          />
        </div>

        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Conflict / Confirm modal ───────────────────────────────────────────────────
function ConflictModal({ summary, onConfirm, onCancel, saving }) {
  const [resolution, setResolution] = useState('overwrite')

  const conflictCount = summary?.conflict_rows?.length ?? 0

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 520 }}>
        <h3>Price Conflicts</h3>
        <p style={{ fontSize: 13, color: 'var(--c-muted)', marginBottom: 12 }}>
          {conflictCount > 0
            ? `${conflictCount} row${conflictCount !== 1 ? 's' : ''} conflict with existing prices. Choose how to handle them:`
            : 'No conflicts — ready to import.'}
        </p>

        {conflictCount > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="radio" value="overwrite" checked={resolution === 'overwrite'} onChange={() => setResolution('overwrite')} />
                <span><strong>Overwrite</strong> — replace existing prices</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, marginTop: 6 }}>
                <input type="radio" value="skip" checked={resolution === 'skip'} onChange={() => setResolution('skip')} />
                <span><strong>Skip</strong> — keep existing prices, only insert new months</span>
              </label>
            </div>

            <div style={{
              maxHeight: 200, overflowY: 'auto', border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius)', fontSize: 12, padding: 8, marginBottom: 12,
            }}>
              {summary.conflict_rows.map((r, i) => (
                <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--c-border)', color: 'var(--c-muted)' }}>
                  {r.CustomerCode} · {r.SalesChannelCode} · {r.ItemNo} · {r.PriceMonth} →
                  existing {r.ExistingPrice} / new {r.NewPrice}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(resolution)} disabled={saving}>
            {saving ? 'Saving…' : `Confirm (${resolution})`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Import modal ───────────────────────────────────────────────────────────────
function ImportModal({ buCode, onClose, onDone }) {
  const [step,       setStep]       = useState('pick')   // 'pick' | 'confirm'
  const [validation, setValidation] = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')
  const fileRef = useRef()

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setLoading(true)
    try {
      const result = await importPriceFile(buCode, file)
      setValidation(result)
      setStep('confirm')
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(resolution) {
    setSaving(true)
    setError('')
    try {
      const result = await confirmPriceImport(buCode, validation.import_token, resolution)
      onDone(result)
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
      setSaving(false)
    }
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget && !loading && !saving) onClose()
  }

  if (step === 'confirm' && validation) {
    return (
      <ConflictModal
        summary={validation}
        onConfirm={handleConfirm}
        onCancel={onClose}
        saving={saving}
      />
    )
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{ width: 420 }}>
        <h3>Import Prices</h3>
        <p style={{ fontSize: 13, color: 'var(--c-muted)', marginBottom: 16 }}>
          Upload an Excel file (.xlsx) with columns: CustomerCode, ItemNo, SalesChannelCode, StartDate, EndDate, Price.
          Download the template first to get the correct format.
        </p>

        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => fileRef.current?.click()}
            disabled={loading}
          >
            {loading ? 'Validating…' : 'Choose file…'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function PriceMaintenance() {
  const qc = useQueryClient()
  const gridRef = useRef()
  const { theme } = useTheme()

  const [selectedBU,       setSelectedBU]       = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState('')
  const [filterChannel,    setFilterChannel]    = useState('')
  const [filterItem,       setFilterItem]       = useState('')

  const [showAdd,    setShowAdd]    = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [conflict,   setConflict]  = useState(null)   // { summary, body } for deferred confirm
  const [saving,     setSaving]    = useState(false)
  const [error,      setError]     = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // ── Reference data ────────────────────────────────────────────────────────
  const { data: me }         = useQuery({ queryKey: ['me'],  queryFn: fetchMe })
  const { data: bus   = [] } = useQuery({ queryKey: ['bus'], queryFn: fetchBusinessUnits })
  const { data: channels = [] } = useQuery({ queryKey: ['chns'], queryFn: fetchSalesChannels })

  const myBUs = useMemo(() => {
    if (!me || !bus.length) return []
    if (me.role?.CanViewAllBU) return bus
    return bus.filter(b => me.businessUnits?.some(ub => ub.BusinessUnitCode === b.Code))
  }, [me, bus])

  // Set default BU
  const activeBU = selectedBU || myBUs[0]?.Code || ''

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', activeBU],
    queryFn:  () => fetchCustomers(activeBU),
    enabled:  !!activeBU,
  })

  const { data: items = [] } = useQuery({
    queryKey: ['items', activeBU],
    queryFn:  () => fetchItems(activeBU),
    enabled:  !!activeBU,
  })

  // ── Price data ────────────────────────────────────────────────────────────
  const priceQueryKey = ['prices', activeBU, selectedCustomer, filterChannel, filterItem]

  const { data: priceRanges = [], isLoading: pricesLoading } = useQuery({
    queryKey: priceQueryKey,
    queryFn:  () => fetchPrices(activeBU, {
      customer_code:      selectedCustomer,
      sales_channel_code: filterChannel  || undefined,
      item_no:            filterItem     || undefined,
    }),
    enabled: !!(activeBU && selectedCustomer),
  })

  const canManage = me?.role?.CanManageRefData

  // ── Inline price edit ─────────────────────────────────────────────────────
  const handlePriceCellChanged = useCallback(async (params) => {
    if (params.column.getColId() !== 'Price') return
    const newPrice = params.newValue
    if (newPrice == null || newPrice === params.oldValue) return

    const row = params.data
    try {
      const result = await updatePriceRange(activeBU, row.PriceID_first, {
        new_price: newPrice,
        price_ids: row.PriceIDs ?? [row.PriceID_first],
      })
      params.node.setData(result)
    } catch (ex) {
      params.node.setData({ ...params.data, Price: params.oldValue })
      setError(ex.response?.data?.detail || 'Failed to update price.')
    }
  }, [activeBU])

  // ── Delete range ──────────────────────────────────────────────────────────
  const handleDeleteRange = useCallback(async (row) => {
    const monthCount = row.PriceIDs?.length ?? 1
    const label = monthCount === 1
      ? `Delete 1 price row for ${row.ItemNo} (${formatMonthDisplay(row.StartDate)})?`
      : `Delete ${monthCount} months of pricing for ${row.ItemNo} (${formatMonthDisplay(row.StartDate)} – ${formatMonthDisplay(row.EndDate)})?`

    if (!window.confirm(label)) return

    setError('')
    try {
      await Promise.all((row.PriceIDs ?? [row.PriceID_first]).map(id => deletePrice(activeBU, id)))
      qc.invalidateQueries({ queryKey: priceQueryKey })
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
    }
  }, [activeBU, priceQueryKey, qc])

  // ── Grid column definitions ───────────────────────────────────────────────
  const colDefs = useMemo(() => [
    {
      headerName:  'Sales Channel',
      field:       'SalesChannelCode',
      width:       100,
      pinned:      'left',
      cellStyle:   { fontSize: 11 },
    },
    {
      headerName:  'Item No',
      field:       'ItemNo',
      width:       120,
      cellStyle:   { fontSize: 11, fontFamily: 'monospace' },
    },
    {
      headerName:  'Description',
      field:       'ItemDescription',
      flex:        2,
      minWidth:    160,
      cellStyle:   { fontSize: 11 },
    },
    {
      headerName:    'Start',
      field:         'StartDate',
      width:         100,
      cellStyle:     { fontSize: 11 },
      valueFormatter: p => formatMonthDisplay(p.value),
    },
    {
      headerName:    'End',
      field:         'EndDate',
      width:         100,
      cellStyle:     { fontSize: 11 },
      valueFormatter: p => formatMonthDisplay(p.value),
    },
    {
      headerName:    'Months',
      field:         'PriceIDs',
      width:         80,
      type:          'numericColumn',
      cellStyle:     { fontSize: 11, color: 'var(--c-muted)' },
      valueGetter:   p => p.data?.PriceIDs?.length ?? 1,
    },
    {
      headerName:    'Price',
      field:         'Price',
      width:         110,
      type:          'numericColumn',
      editable:      !!canManage,
      cellClass:     canManage ? 'editable-cell' : undefined,
      cellStyle:     { fontSize: 11, fontWeight: 600, textAlign: 'right' },
      valueGetter:   p => p.data?.Price != null
        ? parseFloat(parseFloat(p.data.Price).toFixed(2))
        : null,
      valueFormatter: p => p.value != null
        ? new Intl.NumberFormat('en-GB', {
            style: 'decimal',
            minimumFractionDigits: 2, maximumFractionDigits: 2,
          }).format(p.value)
        : '',
      valueSetter: params => {
        const parsed = parseFloat(params.newValue)
        if (isNaN(parsed) || parsed < 0) return false
        params.data.Price = parsed
        return true
      },
      cellEditorParams: {
        inputType: 'number',
        style: { textAlign: 'right' },
      },
    },
    {
      headerName: '',
      field:      'PriceID_first',
      width:      70,
      sortable:   false,
      pinned:     'right',
      cellRenderer: params => (
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', justifyContent: 'center' }}>
          <button
            onClick={() => handleDeleteRange(params.data)}
            title="Delete this price range"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--c-danger, #dc3545)', fontSize: 13, padding: '0 4px',
            }}
          >✕</button>
        </div>
      ),
    },
  ], [canManage, handleDeleteRange, handlePriceCellChanged])

  // ── Add Price ─────────────────────────────────────────────────────────────
  async function handleAddSave(body) {
    setSaving(true)
    setError('')
    try {
      const result = await upsertPrice(activeBU, body)
      if (result.import_token) {
        // Conflicts — show confirmation dialog
        setConflict({ summary: result, body })
        setShowAdd(false)
      } else {
        setShowAdd(false)
        qc.invalidateQueries({ queryKey: priceQueryKey })
        setSuccessMsg(`${result.inserted ?? 1} month${(result.inserted ?? 1) !== 1 ? 's' : ''} saved.`)
        setTimeout(() => setSuccessMsg(''), 3000)
      }
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleConflictConfirm(resolution) {
    setSaving(true)
    setError('')
    try {
      const result = await confirmPriceImport(activeBU, conflict.summary.import_token, resolution)
      setConflict(null)
      qc.invalidateQueries({ queryKey: priceQueryKey })
      setSuccessMsg(`Done — ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped.`)
      setTimeout(() => setSuccessMsg(''), 4000)
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Template download ─────────────────────────────────────────────────────
  async function handleTemplateDownload() {
    setError('')
    try {
      const params = {}
      if (selectedCustomer) params.customer_code      = selectedCustomer
      if (filterChannel)    params.sales_channel_code = filterChannel
      const blob = await downloadPriceTemplate(activeBU, params)
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `price_template_${activeBU}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (ex) {
      setError(ex.response?.data?.detail || ex.message)
    }
  }

  // ── Import done callback ──────────────────────────────────────────────────
  function handleImportDone(result) {
    setShowImport(false)
    qc.invalidateQueries({ queryKey: priceQueryKey })
    setSuccessMsg(`Import done — ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped.`)
    setTimeout(() => setSuccessMsg(''), 4000)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '16px 24px' }}>
      <h2 style={{ marginBottom: 16, fontSize: 18 }}>Price Maintenance</h2>

      {!canManage && (
        <div className="error-banner">You do not have permission to manage price data.</div>
      )}

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="field-group">
          <label>Responsibility</label>
          <select value={activeBU} onChange={e => { setSelectedBU(e.target.value); setSelectedCustomer('') }} style={{ minWidth: 140 }}>
            {myBUs.map(b => <option key={b.Code} value={b.Code}>{b.Name ?? b.Code}</option>)}
          </select>
        </div>

        <div className="field-group">
          <label>Customer</label>
          <select value={selectedCustomer} onChange={e => setSelectedCustomer(e.target.value)} style={{ minWidth: 200 }}>
            <option value="">— select a customer —</option>
            {customers.map(c => <option key={c.Code} value={c.Code}>{c.Name} ({c.Code})</option>)}
          </select>
        </div>

        <div className="field-group">
          <label>Sales Channel</label>
          <select value={filterChannel} onChange={e => setFilterChannel(e.target.value)} style={{ minWidth: 120 }}>
            <option value="">All channels</option>
            {channels.map(ch => <option key={ch.Code} value={ch.Code}>{ch.Name ?? ch.Code}</option>)}
          </select>
        </div>

        <div className="field-group">
          <label>Item No</label>
          <input
            type="text"
            value={filterItem}
            onChange={e => setFilterItem(e.target.value)}
            placeholder="Filter by item…"
            style={{ width: 140 }}
          />
        </div>

        <span style={{ flex: 1 }} />

        <button
          className="btn btn-ghost"
          onClick={handleTemplateDownload}
          disabled={!activeBU}
          title="Download Excel template"
        >
          Template ↓
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setShowImport(true)}
          disabled={!activeBU || !canManage}
        >
          Import
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setShowAdd(true)}
          disabled={!activeBU || !canManage}
        >
          + Add Range
        </button>
      </div>

      {error      && <div className="error-banner"   style={{ marginBottom: 10 }}>{error}</div>}
      {successMsg && <div className="success-banner" style={{ marginBottom: 10 }}>{successMsg}</div>}

      {/* ── Grid ── */}
      {!selectedCustomer ? (
        <div className="text-muted" style={{ fontSize: 13, marginTop: 24, textAlign: 'center' }}>
          Select a customer above to view their price data.
        </div>
      ) : (
        <div
          className={`ag-theme-alpine${theme === 'dark' ? '-dark' : ''}`}
          style={{ height: 'calc(100vh - 290px)', minHeight: 300, width: '100%' }}
        >
          <AgGridReact
            ref={gridRef}
            rowData={priceRanges}
            columnDefs={colDefs}
            loading={pricesLoading}
            getRowId={p => String(p.data.PriceID_first)}
            defaultColDef={{ resizable: true, sortable: true, filter: false }}
            rowHeight={28}
            headerHeight={34}
            suppressRowClickSelection
            stopEditingWhenCellsLoseFocus
            onGridReady={p => p.api.sizeColumnsToFit()}
            onGridSizeChanged={() => gridRef.current?.api?.sizeColumnsToFit()}
            onCellValueChanged={handlePriceCellChanged}
          />
        </div>
      )}

      {/* ── Modals ── */}
      {showAdd && (
        <AddPriceModal
          buCode={activeBU}
          customers={customers}
          channels={channels}
          items={items}
          onSave={handleAddSave}
          onClose={() => setShowAdd(false)}
          saving={saving}
        />
      )}

      {showImport && (
        <ImportModal
          buCode={activeBU}
          onClose={() => setShowImport(false)}
          onDone={handleImportDone}
        />
      )}

      {conflict && (
        <ConflictModal
          summary={conflict.summary}
          onConfirm={handleConflictConfirm}
          onCancel={() => setConflict(null)}
          saving={saving}
        />
      )}
    </div>
  )
}
