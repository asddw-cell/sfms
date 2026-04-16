/**
 * MonthPicker.jsx
 * A clean month-only date picker using react-datepicker.
 * Accepts and returns values as "YYYY-MM" strings to match
 * the rest of the application's date format.
 */
import DatePicker from 'react-datepicker'
import 'react-datepicker/dist/react-datepicker.css'

// Parse "YYYY-MM" string → Date object (first of month)
function ymToDate(ym) {
  if (!ym) return null
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1)
}

// Date object → "YYYY-MM" string
function dateToYM(date) {
  if (!date) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export default function MonthPicker({ value, onChange, minDate, maxDate }) {
  return (
    <DatePicker
      selected={ymToDate(value)}
      onChange={date => onChange(dateToYM(date))}
      dateFormat="MMM yyyy"
      showMonthYearPicker
      showFullMonthYearPicker
      minDate={minDate ? ymToDate(minDate) : undefined}
      maxDate={maxDate ? ymToDate(maxDate) : undefined}
      customInput={
        <input
          readOnly
          style={{
            height: 34,
            padding: '0 10px',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--radius)',
            fontSize: 13,
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            minWidth: 120,
            cursor: 'pointer',
          }}
        />
      }
    />
  )
}
