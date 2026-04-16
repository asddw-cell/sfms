/**
 * MultiSelect.jsx
 * A lightweight multi-select dropdown with text search, matching toolbar styling.
 * Shows a summary of selected items in the trigger button.
 * Closes when clicking outside.
 */
import { useState, useRef, useEffect } from 'react'

export default function MultiSelect({ label, options, selected, onChange, placeholder = 'All' }) {
  const [open,   setOpen]   = useState(false)
  const [search, setSearch] = useState('')
  const ref      = useRef()
  const searchRef = useRef()

  // Close when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus()
    }
  }, [open])

  const filtered = search.trim()
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options

  function toggle(value) {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  function clearAll()   { onChange([]) }
  function selectAll()  { onChange(options.map(o => o.value)) }
  function selectFiltered() { 
    const newVals = filtered.map(o => o.value)
    const merged  = [...new Set([...selected, ...newVals])]
    onChange(merged)
  }

  const summary = selected.length === 0
    ? placeholder
    : selected.length === options.length
      ? 'All'
      : selected.length === 1
        ? options.find(o => o.value === selected[0])?.label || selected[0]
        : `${selected.length} selected`

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setSearch('') }}
        style={{
          height: 34,
          padding: '0 10px',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--radius)',
          fontSize: 13,
          background: 'var(--c-surface)',
          color: selected.length ? 'var(--c-text)' : 'var(--c-muted)',
          minWidth: 160,
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          zIndex: 500,
          background: 'var(--c-surface)',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 4px 12px rgba(0,0,0,.15)',
          minWidth: 220,
          marginTop: 2,
        }}>
          {/* Search input */}
          <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--c-border)' }}>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              style={{
                width: '100%',
                height: 28,
                padding: '0 8px',
                border: '1px solid var(--c-border)',
                borderRadius: 'var(--radius)',
                fontSize: 12,
                background: 'var(--c-bg)',
                color: 'var(--c-text)',
                boxSizing: 'border-box',
                outline: 'none',
              }}
              onClick={e => e.stopPropagation()}
            />
          </div>

          {/* Select all / clear controls */}
          <div style={{
            display: 'flex',
            gap: 8,
            padding: '5px 10px',
            borderBottom: '1px solid var(--c-border)',
            background: 'var(--c-bg)',
          }}>
            <button
              type="button"
              onClick={search.trim() ? selectFiltered : selectAll}
              style={{ fontSize: 11, color: 'var(--c-accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {search.trim() ? 'Select matching' : 'All'}
            </button>
            <span style={{ color: 'var(--c-border)' }}>|</span>
            <button
              type="button"
              onClick={clearAll}
              style={{ fontSize: 11, color: 'var(--c-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Clear
            </button>
            {search.trim() && (
              <>
                <span style={{ color: 'var(--c-border)' }}>|</span>
                <span style={{ fontSize: 11, color: 'var(--c-muted)' }}>
                  {filtered.length} of {options.length}
                </span>
              </>
            )}
          </div>

          {/* Options */}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(opt => (
              <label
                key={opt.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 12px',
                  cursor: 'pointer',
                  fontSize: 13,
                  background: selected.includes(opt.value) ? '#eaf4fb' : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = selected.includes(opt.value) ? '#daedf7' : 'var(--c-bg)'}
                onMouseLeave={e => e.currentTarget.style.background = selected.includes(opt.value) ? '#eaf4fb' : 'transparent'}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  style={{ accentColor: 'var(--c-accent)', width: 14, height: 14, flexShrink: 0 }}
                />
                {opt.label}
              </label>
            ))}

            {filtered.length === 0 && (
              <div style={{ padding: '10px 12px', color: 'var(--c-muted)', fontSize: 12 }}>
                No brands match "{search}"
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
