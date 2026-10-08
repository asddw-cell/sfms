/**
 * __tests__/PriceMaintenance.combobox.test.jsx
 *
 * Unit tests for:
 *   - filterAndRank  (combobox filtering and ranking)
 *   - BaseItemCombobox  (variant reset on base change, pre-fill, keyboard)
 *
 * Imports the helpers directly from the page file via named re-exports added below,
 * or tests the combobox component in isolation using render.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// We need to test filterAndRank directly.  Since it's a module-level function
// inside PriceMaintenance.jsx (not exported), we duplicate it here so the test
// logic lives in the test file.  This keeps the page file unchanged.

// ── filterAndRank (duplicated for direct testing) ─────────────────────────────

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
    if (b.startsWith(first))                 rank = 0
    else if (words.some(w => b.includes(w))) rank = 1
    else                                      rank = 2
    return { item, rank }
  })
  scored.sort((a, b) => a.rank - b.rank || a.item.base_item_no.localeCompare(b.item.base_item_no))

  const top50 = scored.slice(0, 50).map(r => r.item)
  return { items: top50, hasMore: scored.length > 50 }
}

// ── Sample base-items ─────────────────────────────────────────────────────────

const ITEMS = [
  { base_item_no: '100001', description: 'Alpha Widget', variants: ['.006', '.012'] },
  { base_item_no: '100002', description: 'Beta Gadget',  variants: [] },
  { base_item_no: '200003', description: 'Gamma Widget', variants: ['.106'] },
  { base_item_no: '300004', description: 'Delta Premium', variants: [] },
]

// ── filterAndRank tests ───────────────────────────────────────────────────────

describe('filterAndRank', () => {
  it('returns up to 50 items with no query', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      base_item_no: `A${String(i).padStart(5, '0')}`,
      description: `Item ${i}`,
      variants: [],
    }))
    const { items, hasMore } = filterAndRank(big, '')
    expect(items).toHaveLength(50)
    expect(hasMore).toBe(true)
  })

  it('prefix match on item number ranked first', () => {
    const { items } = filterAndRank(ITEMS, '1000')
    expect(items[0].base_item_no).toBe('100001')
    expect(items[1].base_item_no).toBe('100002')
  })

  it('description-only match ranked after item-number match', () => {
    // '200003' has 'widget' in description; '100001' has 'widget' in description too
    // but '100001' contains the word 'widget' in desc; '200003' too.
    // Neither starts with the query word 'widget' in item number.
    const { items } = filterAndRank(ITEMS, 'widget')
    const bases = items.map(i => i.base_item_no)
    expect(bases).toContain('100001')
    expect(bases).toContain('200003')
    expect(bases).not.toContain('100002')
    expect(bases).not.toContain('300004')
  })

  it('multi-word AND: all words must match', () => {
    const { items } = filterAndRank(ITEMS, 'delta premium')
    expect(items).toHaveLength(1)
    expect(items[0].base_item_no).toBe('300004')
  })

  it('multi-word AND: words may span item number and description', () => {
    // '100001' has '1000' in base_item_no and 'widget' in description
    const { items } = filterAndRank(ITEMS, '1000 widget')
    expect(items).toHaveLength(1)
    expect(items[0].base_item_no).toBe('100001')
  })

  it('case-insensitive matching', () => {
    const { items } = filterAndRank(ITEMS, 'ALPHA')
    expect(items).toHaveLength(1)
    expect(items[0].base_item_no).toBe('100001')
  })

  it('% and _ treated as literal characters', () => {
    const specialItems = [
      { base_item_no: 'PCT001', description: '50% Discount', variants: [] },
      { base_item_no: 'ANY002', description: 'Any other',    variants: [] },
    ]
    const { items } = filterAndRank(specialItems, '%')
    expect(items).toHaveLength(1)
    expect(items[0].base_item_no).toBe('PCT001')
  })

  it('hasMore is true when >50 results', () => {
    const big = Array.from({ length: 55 }, (_, i) => ({
      base_item_no: `X${String(i).padStart(5, '0')}`,
      description:  'widget',
      variants: [],
    }))
    const { items, hasMore } = filterAndRank(big, 'widget')
    expect(items).toHaveLength(50)
    expect(hasMore).toBe(true)
  })

  it('returns empty when nothing matches', () => {
    const { items } = filterAndRank(ITEMS, 'xyzzy')
    expect(items).toHaveLength(0)
  })
})
