/**
 * PriceMaintenance.jsx
 *
 * Price management screen: view, add, delete and import pricing data per customer.
 * Prices are stored as monthly rows in tblPrice (keyed by BaseItemNo + VariantSuffix);
 * the API returns them collapsed into contiguous date ranges with the same price.
 *
 * Route: /prices
 * Min role: CanManageRefData
 */
import { useState, useMemo, useRef, useCallback, useEffect, useId } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'

import {
  fetchBusinessUnits, fetchCustomers, fetchSalesChannels, fetchMe,
  fetchPrices, upsertPrice, deletePrice, downloadPriceTemplate,
  importPriceFile, confirmPriceImport, updatePriceRange, fetchBaseItems,
} from '../../api/sfms'
import { useTheme } from '../../ThemeContext'

// ── Helpers ────────────────────────────────────────────────────────────────────
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function ymToApiDate(ym) {
  return `${ym}-01`
}

function formatMonthDisplay(isoDate) {
  if (!isoDate) return ''
  const [y, m] = isoDate.split('-')
  return `${MONTH_ABBR[Number(m) - 1]} ${y}`
}

/**
 * Split a full item number into [baseItemNo, variantSuffix].
 * Mirrors the Python split_item_no() rule: if the string is longer than 4 chars
 * and the 4th character from the end is '.', split there.
 */
function splitItemNo(itemNo) {
  if (itemNo && itemNo.length > 4 && itemNo[itemNo.length - 4] === '.') {
    return [itemNo.slice(0, -4), itemNo.slice(-4)]
  }
  return [itemNo || '', '']
}

/**
 * Normalise a variant suffix string for the API.
 * '' → ''  |  '.006' → '.006'  |  '006' → '.006'  |  anything else → null (invalid)
 */
function normaliseVariant(raw) {
  const s = (raw || '').trim()
  if (s === '') return ''
  if (/^\.[A-Za-z0-9]{3}$/.test(s)) return s
  if (/^[A-Za-z0-9]{3}$/.test(s)) return '.' + s
  return null
}

function MonthPicker({ value, onChange, label, fullWidth = false }) {
  return (
    <div className="field-group" style={fullWidth ? { width: '100%' } : {}}>
      {label && <label>{label}</label>}
      <input
        type="month"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
      />
    </div>
  )
}

// ── Base-item combobox filter/rank ─────────────────────────────────────────────
function filterAndRank(baseItems, query) {
  if (!query || !query.trim()) {
    return { items: baseItems.slice(0, 50), hasMore: baseItems.length > 50 }
  }
  const words = query.trim().toLowerCase().split(/\s+/)
  const first = words[0]

  const matched = baseItems.filter(item => {
    const b = item.base_item_no.toLowerCase()
    const d = item.description.toLowerCase()
    return words.every(w => b.includes(w) || d.includes(w))
  })

  const scored = matched.map(item => {
    const b = item.base_item_no.toLowerCase()
    let rank
    if (b.startsWith(first))              rank = 0
    else if (words.some(w => b.includes(w))) rank = 1
    else                                    rank = 2
    return { item, rank }
  })
  scored.sort((a, b) => a.rank - b.rank || a.item.base_item_no.localeCompare(b.item.base_item_no))

  const top50 = scored.slice(0, 50).map(r => r.item)
  return { items: top50, hasMore: scored.length > 50 }
}

// ── Searchable base-item combobox ──────────────────────────────────────────────
function BaseItemCombobox({ baseItems, value, onChange, disabled }) {
  const [searchText, setSearchText] = useState('')
  const [selected,   setSelected]   = useState(null)
  const [open,       setOpen]       = useState(false)
  const [activeIdx,  setActiveIdx]  = useState(-1)
  const inputRef  = useRef()
  const listRef   = useRef()
  const listId    = useId()

  // Sync external value → selected (e.g. when parent resets)
  useEffect(() => {
    if (!value) {
      setSelected(null)
      setSearchText('')
    } else if (!selected || selected.base_item_no !== value) {
      const found = baseItems.find(b => b.base_item_no === value)
      if (found) setSelected(found)
    }
  }, [value, baseItems])

  const { items: filtered, hasMore } = useMemo(
    () => selected ? { items: baseItems.slice(0, 50), hasMore: baseItems.length > 50 }
                   : filterAndRank(baseItems, searchText),
    [selected, searchText, baseItems],
  )

  function handleSelect(item) {
    setSelected(item)
    setSearchText('')
    setOpen(false)
    setActiveIdx(-1)
    onChange(item.base_item_no, item.variants)
  }

  function handleClear() {
    setSelected(null)
    setSearchText('')
    setOpen(false)
    setActiveIdx(-1)
    onChange('', [])
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function handleInputChange(e) {
    if (selected) {
      setSelected(null)
      onChange('', [])
    }
    setSearchText(e.target.value)
    setOpen(true)
    setActiveIdx(-1)
  }

  function handleFocus() {
    if (selected) {
      requestAnimationFrame(() => inputRef.current?.select())
    }
    setOpen(true)
  }

  function handleBlur() {
    setTimeout(() => setOpen(false), 150)
  }

  function handleKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true); return
    }
    if (e.key === 'Escape') { setOpen(false); setActiveIdx(-1); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, filtered.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter' && activeIdx >= 0 && filtered[activeIdx]) {
      e.preventDefault()
      handleSelect(filtered[activeIdx])
    }
  }

  // Scroll active option into view
  useEffect(() => {
    if (activeIdx >= 0 && listRef.current) {
      const el = listRef.current.querySelector(`[data-idx="${activeIdx}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx])

  const inputValue = selected
    ? `${selected.base_item_no} – ${selected.description}`
    : searchText

  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listId}
          aria-activedescendant={activeIdx >= 0 ? `${listId}-opt-${activeIdx}` : undefined}
          value={inputValue}
          readOnly={!!selected}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder="Search by item number or description…"
          disabled={disabled}
          autoComplete="off"
          style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', paddingRight: 28,
                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        />
        {(selected || searchText) && !disabled && (
          <button
            type="button"
            aria-label="Clear selection"
            onMouseDown={e => { e.preventDefault(); handleClear() }}
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
              color: 'var(--c-muted)', fontSize: 14, lineHeight: 1,
            }}
          >×</button>
        )}
      </div>

      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
            background: 'var(--c-surface)', border: '1px solid var(--c-border)',
            borderRadius: 'var(--radius)', boxShadow: '0 4px 12px rgba(0,0,0,.15)',
            maxHeight: 220, overflowY: 'auto', margin: '2px 0', padding: 0,
            listStyle: 'none',
          }}
        >
          {filtered.length === 0 && (
            <li style={{ padding: '8px 12px', color: 'var(--c-muted)', fontSize: 12 }}>
              No items match
            </li>
          )}
          {filtered.map((item, idx) => (
            <li
              key={item.base_item_no}
              id={`${listId}-opt-${idx}`}
              data-idx={idx}
              role="option"
              aria-selected={idx === activeIdx}
              onMouseDown={e => { e.preventDefault(); handleSelect(item) }}
              style={{
                padding: '6px 12px', cursor: 'pointer', fontSize: 13,
                background: idx === activeIdx ? 'var(--c-accent)' : undefined,
                color:      idx === activeIdx ? '#fff' : undefined,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontFamily: 'monospace', marginRight: 6 }}>{item.base_item_no}</span>
              <span style={{ opacity: 0.8 }}>– {item.description}</span>
            </li>
          ))}
          {hasMore && (
            <li style={{
              padding: '6px 12px', fontSize: 11, color: 'var(--c-muted)',
              fontStyle: 'italic', borderTop: '1px solid var(--c-border)',
            }}>
              Keep typing to narrow results
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

// ── Add Price Modal ────────────────────────────────────────────────────────────
function AddPriceModal({
  buCode, customers, channels,
  initialCustomer, initialChannel,
  onSave, onClose, saving,
}) {
  const [customerCode,     setCustomerCode]     = useState(initialCustomer || '')
  const [salesChannelCode, setSalesChannelCode] = useState(initialChannel  || '')
  const [baseItemNo,       setBaseItemNo]       = useState('')
  const [variants,         setVariants]         = useState([])  // variants for chosen base
  const [variantSuffix,    setVariantSuffix]    = useState('')
  const [startMonth,       setStartMonth]       = useState('')
  const [endMonth,         setEndMonth]         = useState('')
  const [price,            setPrice]            = useState('')
  const [error,            setError]            = useState('')

  const { data: baseItems = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['base-items', buCode],
    queryFn:  () => fetchBaseItems(buCode),
    staleTime: 5 * 60 * 1000,
  })

  function handleBaseItemChange(newBase, newVariants) {
    setBaseItemNo(newBase)
    setVariants(newVariants)
    setVariantSuffix('')
  }

  async function handleSave() {
    setError('')
    if (!customerCode)     { setError('Customer is required.'); return }
    if (!salesChannelCode) { setError('Sales Channel is required.'); return }
    if (!baseItemNo)       { setError('Base Item is required.'); return }
    if (!startMonth)       { setError('Start month is required.'); return }
    if (!endMonth)         { setError('End month is required.'); return }
    if (startMonth > endMonth) { setError('"Start" must be before or equal to "End".'); return }

    const p = parseFloat(price)
    if (isNaN(p) || p < 0) { setError('Price must be a non-negative number.'); return }

    await onSave({
      CustomerCode:     customerCode,
      SalesChannelCode: salesChannelCode,
      BaseItemNo:       baseItemNo,
      VariantSuffix:    variantSuffix,
      StartDate:        ymToApiDate(startMonth),
      EndDate:          ymToApiDate(endMonth),
      Price:            p,
    }, { customerCode, salesChannelCode })
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose()
  }

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px 16px',
  }
  const fullWidth = { gridColumn: '1 / -1' }
  const fieldLabel = {
    display: 'block', fontSize: 11, fontWeight: 600,
    color: 'var(--c-muted)', textTransform: 'uppercase', marginBottom: 4, letterSpacing: '.4px',
  }
  const fieldSelect = {
    width: '100%', minWidth: 0, boxSizing: 'border-box',
    overflow: 'hidden', textOverflow: 'ellipsis',
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{ width: 480 }}>
        <h3>Add Price Range</h3>

        {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={gridStyle}>

          {/* Customer — full width */}
          <div style={fullWidth}>
            <label style={fieldLabel}>Customer</label>
            <select value={customerCode} onChange={e => setCustomerCode(e.target.value)}
                    style={fieldSelect} autoFocus>
              <option value="">— select —</option>
              {customers.map(c => (
                <option key={c.Code} value={c.Code}>{c.Name} ({c.Code})</option>
              ))}
            </select>
          </div>

          {/* Sales Channel — left column */}
          <div>
            <label style={fieldLabel}>Sales Channel</label>
            <select value={salesChannelCode} onChange={e => setSalesChannelCode(e.target.value)}
                    style={fieldSelect}>
              <option value="">— select —</option>
              {channels.map(ch => (
                <option key={ch.Code} value={ch.Code}>{ch.Name ?? ch.Code}</option>
              ))}
            </select>
          </div>

          {/* Empty right column on Sales Channel row */}
          <div />

          {/* Base Item combobox — full width */}
          <div style={fullWidth}>
            <label style={fieldLabel}>Base Item</label>
            <BaseItemCombobox
              baseItems={baseItems}
              value={baseItemNo}
              onChange={handleBaseItemChange}
              disabled={itemsLoading}
            />
          </div>

          {/* Variant dropdown — left column */}
          <div>
            <label style={fieldLabel}>Variant</label>
            <select
              value={variantSuffix}
              onChange={e => setVariantSuffix(e.target.value)}
              disabled={!baseItemNo}
              style={fieldSelect}
              title="All variants = price applies to all variants of this base item"
            >
              <option value="">All variants</option>
              {variants.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>

          {/* Empty right column on Variant row */}
          <div />

          {/* Start Month — left, End Month — right */}
          <div>
            <MonthPicker label="Start month" value={startMonth} onChange={setStartMonth} />
          </div>
          <div>
            <MonthPicker label="End month" value={endMonth} onChange={setEndMonth} />
          </div>

          {/* Price — left column */}
          <div>
            <label style={fieldLabel}>Price</label>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={price}
              onChange={e => setPrice(e.target.value)}
              placeholder="0.00"
              style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
            />
          </div>

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
      <div className="modal" style={{ width: 560 }}>
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
                  {r.CustomerCode} · {r.SalesChannelCode} · {r.BaseItemNo}{r.VariantSuffix || ''} · {r.PriceMonth} →
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
  const [step,       setStep]       = useState('pick')
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
          Upload an Excel file (.xlsx) with columns: CustomerCode, Base Item, Variant,
          SalesChannelCode, StartDate, EndDate, Price.
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
  const [conflict,   setConflict]  = useState(null)
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

  const activeBU = selectedBU || myBUs[0]?.Code || ''

  const { data: customers = [] } = useQuery({
    queryKey: ['customers', activeBU],
    queryFn:  () => fetchCustomers(activeBU),
    enabled:  !!activeBU,
  })

  // ── Alias detection ───────────────────────────────────────────────────────
  const selectedCustomerObj = customers.find(c => c.Code === selectedCustomer)
  const isAliasCustomer     = !!(selectedCustomerObj?.PriceAliasCode)
  const aliasCustomerName   = isAliasCustomer
    ? (customers.find(c => c.Code === selectedCustomerObj.PriceAliasCode)?.Name
       ?? selectedCustomerObj.PriceAliasCode)
    : null

  // ── Price data ────────────────────────────────────────────────────────────
  // item_no filter passes the combined base+variant string; the backend splits it
  const priceQueryKey = ['prices', activeBU, selectedCustomer, filterChannel, filterItem]

  const { data: priceRanges = [], isLoading: pricesLoading } = useQuery({
    queryKey: priceQueryKey,
    queryFn:  () => fetchPrices(activeBU, {
      customer_code:      selectedCustomer,
      sales_channel_code: filterChannel  || undefined,
      item_no:            filterItem     || undefined,
    }),
    enabled: !!(activeBU && selectedCustomer && !isAliasCustomer),
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
    const itemLabel  = row.BaseItemNo + (row.VariantSuffix || '')
    const label = monthCount === 1
      ? `Delete 1 price row for ${itemLabel} (${formatMonthDisplay(row.StartDate)})?`
      : `Delete ${monthCount} months of pricing for ${itemLabel} (${formatMonthDisplay(row.StartDate)} – ${formatMonthDisplay(row.EndDate)})?`

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
      headerName:  'Base Item',
      field:       'BaseItemNo',
      width:       120,
      cellStyle:   { fontSize: 11, fontFamily: 'monospace' },
    },
    {
      headerName:  'Variant',
      field:       'VariantSuffix',
      width:       100,
      cellStyle:   { fontSize: 11, fontFamily: 'monospace' },
      valueFormatter: p => p.value === '' || p.value == null ? 'All variants' : p.value,
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
  async function handleAddSave(body, { customerCode, salesChannelCode }) {
    setSaving(true)
    setError('')
    try {
      const result = await upsertPrice(activeBU, body)
      if (result.import_token) {
        setConflict({ summary: result, body })
        setShowAdd(false)
      } else {
        setShowAdd(false)
        qc.invalidateQueries({ queryKey: priceQueryKey })
        const months = result.inserted ?? 1
        const base = `${months} month${months !== 1 ? 's' : ''} saved.`
        // Warn if the saved customer/channel won't appear in the current filter view
        const savedForDifferent = (
          (selectedCustomer && customerCode !== selectedCustomer) ||
          (filterChannel    && salesChannelCode !== filterChannel)
        )
        const savedCustomerName = customers.find(c => c.Code === customerCode)?.Name ?? customerCode
        const notice = savedForDifferent
          ? ` Saved for ${savedCustomerName}. Change the filters to see these rows.`
          : ''
        setSuccessMsg(base + notice)
        setTimeout(() => setSuccessMsg(''), 5000)
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
            placeholder="Filter by base item…"
            style={{ width: 150 }}
          />
        </div>

        <span style={{ flex: 1 }} />

        <button
          className="btn btn-ghost"
          onClick={handleTemplateDownload}
          disabled={!activeBU || isAliasCustomer}
          title="Download Excel template"
        >
          Template ↓
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => setShowImport(true)}
          disabled={!activeBU || !canManage || isAliasCustomer}
        >
          Import
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setShowAdd(true)}
          disabled={!activeBU || !canManage || isAliasCustomer}
        >
          + Add Range
        </button>
      </div>

      {error      && <div className="error-banner"   style={{ marginBottom: 10 }}>{error}</div>}
      {successMsg && <div className="success-banner" style={{ marginBottom: 10 }}>{successMsg}</div>}

      {/* ── Grid / alias message ── */}
      {!selectedCustomer ? (
        <div className="text-muted" style={{ fontSize: 13, marginTop: 24, textAlign: 'center' }}>
          Select a customer above to view their price data.
        </div>
      ) : isAliasCustomer ? (
        <div style={{
          marginTop: 24, padding: '16px 20px',
          background: 'rgba(59, 130, 246, 0.08)',
          border: '1px solid rgba(59, 130, 246, 0.25)',
          borderRadius: 6,
          fontSize: 13, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            ℹ Prices for {selectedCustomerObj.Name} are managed under{' '}
            {aliasCustomerName} ({selectedCustomerObj.PriceAliasCode}).
          </div>
          <div>
            To view or edit prices for this customer, select{' '}
            {aliasCustomerName} from the Customer dropdown.
          </div>
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
          initialCustomer={selectedCustomer}
          initialChannel={filterChannel}
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
