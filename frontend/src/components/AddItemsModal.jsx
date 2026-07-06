/**
 * AddItemsModal.jsx
 * Lets the user pick one or more items from the full BU item catalogue,
 * select a month range, then bulk-inserts forecast rows (Qty=0) for every
 * selected item × every month in the range.
 */
import { useState, useMemo } from 'react'
import MonthPicker from './MonthPicker'

export default function AddItemsModal({
  items,           // full item list for the BU
  brands,          // full brands list — used to resolve brand name → code
  months,          // currently visible months (YYYY-MM strings) — used as defaults
  existingItemNos, // Set of ItemNo already in the grid (excluded from picker)
  selectedBrands,  // array of brand names currently filtered in the grid
  onAdd,           // fn({ selectedItems, monthFrom, monthTo }) → Promise
  onClose,
  saving,
}) {
  const defaultFrom = months[0] ?? ''
  const defaultTo   = months[months.length - 1] ?? ''

  const [search,    setSearch]    = useState('')
  const [selected,  setSelected]  = useState([])
  const [monthFrom, setMonthFrom] = useState(defaultFrom)
  const [monthTo,   setMonthTo]   = useState(defaultTo)
  const [error,     setError]     = useState('')

  // Resolve selected brand names → brand codes for comparison with item.BrandCode
  const selectedBrandCodes = useMemo(() => {
    if (!selectedBrands?.length) return null
    const nameToCode = new Map(brands.map(b => [b.Name, b.Code]))
    return new Set(selectedBrands.map(name => nameToCode.get(name)).filter(Boolean))
  }, [selectedBrands, brands])

  // Filter items by brand code, search text, and exclude already-in-grid items
  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return items.filter(item => {
      if (existingItemNos.has(item.ItemNo)) return false
      if (selectedBrandCodes && !selectedBrandCodes.has(item.BrandCode)) return false
      if (!q) return true
      return (
        item.ItemNo.toLowerCase().includes(q) ||
        item.Description.toLowerCase().includes(q) ||
        (item.BrandCode || '').toLowerCase().includes(q)
      )
    }).sort((a, b) => a.ItemNo.localeCompare(b.ItemNo))
  }, [items, search, existingItemNos, selectedBrandCodes])

  function toggle(itemNo) {
    setSelected(prev =>
      prev.includes(itemNo) ? prev.filter(n => n !== itemNo) : [...prev, itemNo]
    )
  }
  function selectAll() { setSelected(filtered.map(i => i.ItemNo)) }
  function clearAll()  { setSelected([]) }

  const selectedItems = items.filter(i => selected.includes(i.ItemNo))

  // Compute how many months are in the selected range
  function monthsBetween(from, to) {
    if (!from || !to) return 0
    const [fy, fm] = from.split('-').map(Number)
    const [ty, tm] = to.split('-').map(Number)
    return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1)
  }
  const monthCount    = monthsBetween(monthFrom, monthTo)
  const rowsToInsert  = selected.length * monthCount

  async function handleAdd() {
    setError('')
    if (!selected.length)    { setError('Please select at least one item.'); return }
    if (!monthFrom || !monthTo) { setError('Please select a month range.'); return }
    if (monthFrom > monthTo) { setError('"From" month must be before "To" month.'); return }
    if (rowsToInsert > 500)  { setError(`This would insert ${rowsToInsert} rows. Please narrow the range or select fewer items.`); return }
    await onAdd({ selectedItems, monthFrom, monthTo })
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal" style={{
        width: 560, maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', gap: 0,
      }}>
        <h3 style={{ marginBottom: 4 }}>Add Items to Forecast</h3>
        <p style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 16 }}>
          Selected items will be added with 0 quantity for each month in the chosen range.
        </p>

        {/* ── Month range ── */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
          <div className="field-group" style={{ flex: 1 }}>
            <label>From month</label>
            <MonthPicker value={monthFrom} onChange={setMonthFrom} />
          </div>
          <div className="field-group" style={{ flex: 1 }}>
            <label>To month</label>
            <MonthPicker value={monthTo} onChange={setMonthTo} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <span style={{ fontSize: 12, color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>
              {monthCount > 0 ? `${monthCount} month${monthCount !== 1 ? 's' : ''}` : '—'}
            </span>
          </div>
        </div>

        {/* ── Search ── */}
        <input
          type="text"
          placeholder="Search by item number or description…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', marginBottom: 8 }}
          autoFocus
        />

        {/* ── Select all / clear ── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 6, fontSize: 12,
        }}>
          <span style={{ color: 'var(--c-muted)' }}>
            {filtered.length} item{filtered.length !== 1 ? 's' : ''} available
            {selectedBrands?.length > 0 && ` · filtered by ${selectedBrands.length} brand${selectedBrands.length !== 1 ? 's' : ''}`}
            {search && ` matching "${search}"`}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button" onClick={selectAll}
              style={{ fontSize: 12, color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Select all
            </button>
            <span style={{ color: 'var(--c-border)' }}>|</span>
            <button
              type="button" onClick={clearAll}
              style={{ fontSize: 12, color: 'var(--c-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Clear
            </button>
          </div>
        </div>

        {/* ── Item list ── */}
        <div style={{
          flex: 1, overflowY: 'auto', border: '1px solid var(--c-border)',
          borderRadius: 'var(--radius)', minHeight: 200, maxHeight: 320,
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--c-muted)', fontSize: 13, textAlign: 'center' }}>
              {items.length === 0 ? 'No items found for this responsibility.' : 'No items match your search.'}
            </div>
          ) : (
            filtered.map(item => (
              <label
                key={item.ItemNo}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                  borderBottom: '1px solid var(--c-border)',
                  background: selected.includes(item.ItemNo) ? 'var(--c-cell-edited-bg)' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (!selected.includes(item.ItemNo))
                    e.currentTarget.style.background = 'var(--c-bg)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = selected.includes(item.ItemNo) ? 'var(--c-cell-edited-bg)' : 'transparent'
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(item.ItemNo)}
                  onChange={() => toggle(item.ItemNo)}
                  style={{ accentColor: 'var(--c-accent)', width: 15, height: 15, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--c-primary)' }}>{item.ItemNo}</div>
                  <div style={{ color: 'var(--c-muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.Description}
                    {item.BrandCode && (
                      <span style={{ marginLeft: 6, opacity: 0.7 }}>
                        · {brands.find(b => b.Code === item.BrandCode)?.Name || item.BrandCode}
                      </span>
                    )}
                  </div>
                </div>
              </label>
            ))
          )}
        </div>

        {/* ── Summary ── */}
        {selected.length > 0 && (
          <div style={{
            marginTop: 10, padding: '8px 12px', background: 'var(--c-bg)',
            borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--c-text)',
          }}>
            <strong>{selected.length}</strong> item{selected.length !== 1 ? 's' : ''} ×{' '}
            <strong>{monthCount}</strong> month{monthCount !== 1 ? 's' : ''} ={' '}
            <strong>{rowsToInsert}</strong> row{rowsToInsert !== 1 ? 's' : ''} to insert
          </div>
        )}

        {error && <div className="error-banner" style={{ marginTop: 10 }}>{error}</div>}

        {/* ── Actions ── */}
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleAdd}
            disabled={saving || selected.length === 0 || monthCount === 0}
          >
            {saving ? 'Adding…' : `Add ${rowsToInsert > 0 ? rowsToInsert + ' row' + (rowsToInsert !== 1 ? 's' : '') : 'items'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
