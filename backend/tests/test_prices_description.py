"""
tests/test_prices_description.py

Unit tests for _build_item_desc_map and the grid list endpoint's ItemDescription
field, focusing on base-level rows where BaseItemNo has no direct tblItem entry.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.routers.prices import _build_item_desc_map, _item_desc


# ── Helpers ───────────────────────────────────────────────────────────────────

def _price_row(base: str, suffix: str) -> SimpleNamespace:
    return SimpleNamespace(BaseItemNo=base, VariantSuffix=suffix)


def _item_row(item_no: str, description: str) -> SimpleNamespace:
    return SimpleNamespace(ItemNo=item_no, Description=description)


def _make_db(item_rows: list) -> MagicMock:
    """
    Mock DB session that returns item_rows for any .query(Item).filter(...).all()
    and for the LIKE-based variant fallback query.
    """
    db    = MagicMock()
    chain = MagicMock()
    chain.filter.return_value   = chain
    chain.order_by.return_value = chain
    chain.all.return_value      = item_rows
    db.query.return_value       = chain
    return db


# ── _build_item_desc_map ──────────────────────────────────────────────────────

def test_variant_row_gets_exact_description():
    """Variant-level row: description from the matching tblItem entry."""
    rows   = [_price_row("123456", ".006")]
    db     = _make_db([_item_row("123456.006", "Widget .006")])
    result = _build_item_desc_map(rows, db)
    assert result.get("123456.006") == "Widget .006"


def test_base_row_direct_entry():
    """Base-level row where the base exists directly in tblItem."""
    rows   = [_price_row("123456", "")]
    db     = _make_db([_item_row("123456", "Widget Base")])
    result = _build_item_desc_map(rows, db)
    assert result.get("123456") == "Widget Base"


def test_base_row_fallback_to_variant():
    """
    Base-level row where the base has no direct tblItem entry.
    The description of the lowest-sorted variant must be used.
    """
    rows = [_price_row("104330", "")]
    # First query (full_items IN): returns nothing for "104330" (only variants exist)
    # Second query (LIKE fallback): returns variants sorted by ItemNo
    variant_items = [
        _item_row("104330.006", "Brown Sugar 006"),
        _item_row("104330.012", "Brown Sugar 012"),
    ]

    # Simulate two query calls: first returns [], second returns variant_items
    call_count = [0]

    def _query(model):
        m = MagicMock()
        call_count[0] += 1
        if call_count[0] == 1:
            # First call: full_items IN lookup — "104330" not found
            m.filter.return_value.all.return_value     = []
            m.filter.return_value.filter.return_value  = m.filter.return_value
            m.filter.return_value.order_by.return_value = m.filter.return_value
        else:
            # Second call: LIKE fallback
            m.filter.return_value.order_by.return_value.all.return_value = variant_items
            m.filter.return_value.filter.return_value  = m.filter.return_value
        return m

    db           = MagicMock()
    db.query.side_effect = _query

    result = _build_item_desc_map(rows, db)
    assert result.get("104330") == "Brown Sugar 006"


def test_base_row_no_item_at_all():
    """
    Base-level row with no tblItem entry at all (neither base nor variants).
    Fallback: base string itself (unchanged from before).
    """
    rows = [_price_row("UNKNOWN", "")]

    call_count = [0]

    def _query(model):
        m = MagicMock()
        call_count[0] += 1
        if call_count[0] == 1:
            m.filter.return_value.all.return_value = []
            m.filter.return_value.filter.return_value = m.filter.return_value
            m.filter.return_value.order_by.return_value = m.filter.return_value
        else:
            m.filter.return_value.order_by.return_value.all.return_value = []
            m.filter.return_value.filter.return_value = m.filter.return_value
        return m

    db           = MagicMock()
    db.query.side_effect = _query

    result = _build_item_desc_map(rows, db)
    # desc_map has no "UNKNOWN" → _item_desc falls back to the base string
    desc = _item_desc("UNKNOWN", "", result)
    assert desc == "UNKNOWN"


# ── _item_desc ────────────────────────────────────────────────────────────────

def test_item_desc_variant_found():
    desc_map = {"123456.006": "Variant Desc", "123456": "Base Desc"}
    assert _item_desc("123456", ".006", desc_map) == "Variant Desc"


def test_item_desc_variant_missing_falls_to_base():
    desc_map = {"123456": "Base Desc"}
    assert _item_desc("123456", ".006", desc_map) == "Base Desc"


def test_item_desc_nothing_found_returns_base_string():
    assert _item_desc("999999", "", {}) == "999999"
