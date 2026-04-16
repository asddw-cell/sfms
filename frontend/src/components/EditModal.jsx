/**
 * EditModal.jsx
 * Shown when a user clicks an editable forecast cell.
 * Handles both create (no existing row) and update (existing EntryNo).
 */
import { useState } from 'react'

export default function EditModal({ cell, onSave, onDelete, onClose, saving, priceTypes = [] }) {
  const isNew = !cell.entryNo

  const [quantity, setQuantity] = useState(
    cell.quantity != null ? String(cell.quantity) : ''
  )
  const [price, setPrice]       = useState(
    cell.price != null ? String(cell.price) : ''
  )
  const [notes,         setNotes]         = useState(cell.notes || '')
  const [priceTypeCode, setPriceTypeCode] = useState(
    cell.priceTypeCode != null ? String(cell.priceTypeCode) : String(priceTypes[0]?.Code ?? '')
  )
  const [error, setError] = useState('')

  function handleSave() {
    const qty = parseFloat(quantity)
    const prc = parseFloat(price)
    if (isNaN(qty) || qty < 0) { setError('Quantity must be a non-negative number.'); return }
    if (isNaN(prc) || prc < 0) { setError('Price must be a non-negative number.'); return }
    setError('')
    onSave({ quantity: qty, price: prc, notes, priceTypeCode: priceTypeCode ? Number(priceTypeCode) : null })
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleBackdrop}>
      <div className="modal">
        <h3>{isNew ? 'Add Forecast' : 'Edit Forecast'}</h3>

        <div className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
          <strong>{cell.itemNo}</strong> — {cell.description}<br />
          Customer: {cell.customerName} &nbsp;|&nbsp; Period: {cell.period}<br />
          Channel: {cell.channelCode}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="modal-row">
          <label>Price Type</label>
          <select
            value={priceTypeCode}
            onChange={e => setPriceTypeCode(e.target.value)}
            style={{ width: '100%', height: 34 }}
          >
            <option value="">— Select —</option>
            {priceTypes.map(pt => (
              <option key={pt.Code} value={pt.Code}>{pt.Name}</option>
            ))}
          </select>
        </div>

        <div className="modal-row">
          <label>Quantity</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            autoFocus
          />
        </div>

        <div className="modal-row">
          <label>Price ({cell.currencySymbol})</label>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={price}
            onChange={e => setPrice(e.target.value)}
          />
        </div>

        <div className="modal-row">
          <label>Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Reason for change…"
          />
        </div>

        <div className="modal-actions">
          {!isNew && (
            <button
              className="btn btn-danger"
              onClick={() => onDelete(cell.entryNo)}
              disabled={saving}
            >
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
