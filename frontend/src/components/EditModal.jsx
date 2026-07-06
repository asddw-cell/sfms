/**
 * EditModal.jsx
 * Shown when a user double-clicks an editable forecast cell.
 * Handles quantity, price override, and notes.
 */
import { useState } from 'react'

export default function EditModal({ cell, onSave, onDelete, onClose, saving }) {
  const isNew = !cell.entryNo

  const [quantity, setQuantity] = useState(
    cell.quantity != null ? String(cell.quantity) : ''
  )

  // Pre-populate with the currently active price:
  // override price if one is set, otherwise the standard tblPrice lookup value
  const initialPrice = cell.isPriceOverride
    ? (cell.overridePrice != null ? String(cell.overridePrice) : '')
    : (cell.effectivePrice != null ? String(cell.effectivePrice) : '')
  const [price, setPrice] = useState(initialPrice)

  const [notes, setNotes] = useState(cell.notes || '')
  const [error, setError] = useState('')

  function handleSave() {
    const qty = parseFloat(quantity)
    if (isNaN(qty) || qty < 0) { setError('Quantity must be a non-negative number.'); return }
    const prc = parseFloat(price)
    if (isNaN(prc) || prc < 0) { setError('Price must be a non-negative number.'); return }
    setError('')
    onSave({ quantity: qty, notes, overridePrice: prc })
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
