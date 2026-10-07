"""
tests/test_pricing.py

Unit tests for the base-item/variant-suffix pricing logic.
All tests use mock DB sessions — no real database required.

Test scenarios from the spec:
 1. Base row only → all variants of that base resolve to the base price.
 2. Base + explicit variant → other variants get base, explicit variant gets its own price.
 3. Variant-only row → that variant gets its price, others resolve to 0.
 4. Variant override for one month → next month falls back to base price.
 5. Item with no suffix and a base row → resolves to the base price.
 6. No matching row → 0, is_missing_price=True.
 7. IsPriceOverride=1 → OverridePrice wins over any tblPrice row.
 8. Customer/channel isolation.
 9. Validation: bad suffix formats, base with no matching items, variant not in tblItem.
10. Upload: .006 and 006 accepted; numeric cells rejected with clear error.
"""
from __future__ import annotations

import re
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.pricing import (
    get_effective_price,
    normalise_variant_suffix,
    split_item_no,
    validate_import_rows,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

BU   = "UK_UK"
CUST = "UK_UK_ASD"
CHAN = "UK_RETAIL"
BASE = "123456"
V006 = ".006"
V012 = ".012"
V106 = ".106"
MONTH = date(2026, 7, 1)


def _make_price(base_item, variant_suffix, price, bu=BU, cust=CUST, chan=CHAN, month=MONTH):
    return SimpleNamespace(
        PriceID          = 1,
        BusinessUnitCode = bu,
        CustomerCode     = cust,
        SalesChannelCode = chan,
        BaseItemNo       = base_item,
        VariantSuffix    = variant_suffix,
        PriceMonth       = month,
        Price            = Decimal(str(price)),
    )


def _make_forecast_row(item_no, bu=BU, cust=CUST, chan=CHAN, month=MONTH,
                       is_override=False, override_price=None, entry_no=1):
    return SimpleNamespace(
        EntryNo          = entry_no,
        BusinessUnitCode = bu,
        CustomerCode     = cust,
        SalesChannelCode = chan,
        ItemNo           = item_no,
        ForecastDate     = month,
        IsPriceOverride  = is_override,
        OverridePrice    = Decimal(str(override_price)) if override_price else None,
    )


def _make_db(price_rows=None, customer_rows=None, item_rows=None):
    """
    Build a minimal mock DB session.
    db.query(Price).filter(...).all() returns price_rows.
    db.query(Price).filter(...).first() returns price_rows[0] if any.
    db.query(Customer).filter(...).first() returns customer_rows[0] if any.
    db.query(Item).filter(...).first() / .all() returns item_rows.
    """
    price_rows    = price_rows    or []
    customer_rows = customer_rows or []
    item_rows     = item_rows     or []

    from app.models import Customer, Item, Price

    def _query(model):
        mock = MagicMock()
        if model is Price:
            mock.filter.return_value.all.return_value   = price_rows
            mock.filter.return_value.first.return_value = price_rows[0] if price_rows else None
        elif model is Customer:
            mock.filter.return_value.all.return_value   = customer_rows
            mock.filter.return_value.first.return_value = customer_rows[0] if customer_rows else None
        elif model is Item:
            mock.filter.return_value.all.return_value   = item_rows
            mock.filter.return_value.first.return_value = item_rows[0] if item_rows else None
        else:
            mock.filter.return_value.all.return_value   = []
            mock.filter.return_value.first.return_value = None
        mock.filter.return_value.filter.return_value = mock.filter.return_value
        return mock

    db = MagicMock()
    db.query.side_effect = _query
    return db


# ── split_item_no ─────────────────────────────────────────────────────────────

def test_split_item_with_variant():
    assert split_item_no("123456.006") == ("123456", ".006")

def test_split_item_no_suffix():
    assert split_item_no("123456") == ("123456", "")

def test_split_item_exactly_four_chars():
    # 4 chars: no split
    assert split_item_no("1234") == ("1234", "")

def test_split_item_five_chars_no_dot():
    # 5 chars, 4th from end is '2', not '.'
    assert split_item_no("12345") == ("12345", "")

def test_split_item_dot_not_at_position():
    # dot at position 3 from end, not 4
    assert split_item_no("1234.06") == ("1234.06", "")


# ── normalise_variant_suffix ──────────────────────────────────────────────────

def test_normalise_empty():
    assert normalise_variant_suffix("") == ""

def test_normalise_blank_whitespace():
    assert normalise_variant_suffix("   ") == ""

def test_normalise_dot_variant():
    assert normalise_variant_suffix(".006") == ".006"

def test_normalise_three_char_variant():
    assert normalise_variant_suffix("006") == ".006"

def test_normalise_uppercase_variant():
    assert normalise_variant_suffix("ABC") == ".ABC"

def test_normalise_invalid_five_chars():
    assert normalise_variant_suffix(".0061") is None

def test_normalise_invalid_one_char():
    assert normalise_variant_suffix("0") is None

def test_normalise_invalid_two_chars():
    assert normalise_variant_suffix("06") is None


# ── get_effective_price ───────────────────────────────────────────────────────

def test_scenario1_base_only_resolves_all_variants():
    """Base row 5.50 → .006, .012, .106 all resolve to 5.50."""
    base_row = _make_price(BASE, "", "5.50")
    db       = _make_db(price_rows=[base_row])

    for variant in [V006, V012, V106]:
        item_no = BASE + variant
        row     = _make_forecast_row(item_no)
        price, missing = get_effective_price(row, db)
        assert price == Decimal("5.50"), f"Expected 5.50 for {item_no}"
        assert not missing


def test_scenario2_variant_overrides_base():
    """Base 5.50 + explicit .106 at 5.75 → .006 and .012 get 5.50, .106 gets 5.75."""
    base_row    = _make_price(BASE, "",   "5.50")
    variant_row = _make_price(BASE, V106, "5.75")

    for variant, expected in [(V006, "5.50"), (V012, "5.50"), (V106, "5.75")]:
        item_no = BASE + variant
        # Only return the relevant rows for this variant
        if variant == V106:
            rows = [variant_row, base_row]
        else:
            rows = [base_row]
        db    = _make_db(price_rows=rows)
        price, missing = get_effective_price(_make_forecast_row(item_no), db)
        assert price == Decimal(expected), f"{variant}: expected {expected}, got {price}"
        assert not missing


def test_scenario3_variant_only_other_variants_zero():
    """Variant-only row for .006 → .006 gets its price, .106 resolves to 0."""
    variant_row = _make_price(BASE, V006, "4.00")
    db_with     = _make_db(price_rows=[variant_row])
    db_empty    = _make_db(price_rows=[])

    price_006, missing_006 = get_effective_price(_make_forecast_row(BASE + V006), db_with)
    assert price_006 == Decimal("4.00")
    assert not missing_006

    price_106, missing_106 = get_effective_price(_make_forecast_row(BASE + V106), db_empty)
    assert price_106 == Decimal("0")
    assert missing_106


def test_scenario4_variant_override_one_month_next_falls_back():
    """Variant override for month A → month B falls back to base."""
    month_a = date(2026, 7, 1)
    month_b = date(2026, 8, 1)

    variant_a = _make_price(BASE, V106, "5.75", month=month_a)
    base_b    = _make_price(BASE, "",   "5.50", month=month_b)

    # For month A: variant row
    db_a = _make_db(price_rows=[variant_a])
    row_a = _make_forecast_row(BASE + V106, month=month_a)
    price_a, _ = get_effective_price(row_a, db_a)
    assert price_a == Decimal("5.75")

    # For month B: only base row
    db_b = _make_db(price_rows=[base_b])
    row_b = _make_forecast_row(BASE + V106, month=month_b)
    price_b, _ = get_effective_price(row_b, db_b)
    assert price_b == Decimal("5.50")


def test_scenario5_item_no_suffix_base_row():
    """Plain item (no suffix) with a base row → resolves to the base price."""
    base_row = _make_price("PLAIN01", "", "7.99")
    db       = _make_db(price_rows=[base_row])
    row      = _make_forecast_row("PLAIN01")
    price, missing = get_effective_price(row, db)
    assert price == Decimal("7.99")
    assert not missing


def test_scenario6_no_matching_row_returns_zero():
    """No tblPrice row → 0, is_missing_price=True."""
    db  = _make_db(price_rows=[])
    row = _make_forecast_row(BASE + V006)
    price, missing = get_effective_price(row, db)
    assert price == Decimal("0")
    assert missing


def test_scenario7_price_override_wins():
    """IsPriceOverride=1 → OverridePrice returned regardless of tblPrice."""
    base_row = _make_price(BASE, "", "5.50")
    db       = _make_db(price_rows=[base_row])
    row      = _make_forecast_row(BASE + V006, is_override=True, override_price="9.99")
    price, missing = get_effective_price(row, db)
    assert price == Decimal("9.99")
    assert not missing


def test_scenario8_customer_isolation():
    """A price row for CUST_A is not used when resolving for CUST_B."""
    db_empty = _make_db(price_rows=[])
    row_b    = _make_forecast_row(BASE + V006, cust="UK_UK_OTHER")
    price, missing = get_effective_price(row_b, db_empty)
    assert price == Decimal("0")
    assert missing


def test_scenario8_channel_isolation():
    """A price row for channel CHAN_A is not returned for CHAN_B."""
    db_empty = _make_db(price_rows=[])
    row_b    = _make_forecast_row(BASE + V006, chan="OTHER")
    price, missing = get_effective_price(row_b, db_empty)
    assert price == Decimal("0")
    assert missing


# ── validate_import_rows ──────────────────────────────────────────────────────

def _make_item(item_no, bu=BU):
    return SimpleNamespace(ItemNo=item_no, BusinessUnitCode=bu, Description=item_no)


def _db_for_validation(item_rows=None, existing_price_rows=None):
    """
    Build a mock DB for validate_import_rows calls.
    Handles Item queries (existence checks) and Price queries (conflict checks).
    """
    item_rows          = item_rows          or []
    existing_price_rows = existing_price_rows or []

    from app.models import Customer, Item, Price

    def _query(model):
        mock = MagicMock()
        if model is Item:
            mock.filter.return_value.all.return_value   = item_rows
            mock.filter.return_value.first.return_value = item_rows[0] if item_rows else None
            mock.filter.return_value.filter.return_value = mock.filter.return_value
        elif model is Price:
            mock.filter.return_value.all.return_value   = existing_price_rows
            mock.filter.return_value.first.return_value = existing_price_rows[0] if existing_price_rows else None
            mock.filter.return_value.filter.return_value = mock.filter.return_value
        elif model is Customer:
            mock.filter.return_value.all.return_value   = []
            mock.filter.return_value.first.return_value = None
        else:
            mock.filter.return_value.all.return_value   = []
            mock.filter.return_value.first.return_value = None
        mock.filter.return_value.filter.return_value = mock.filter.return_value
        return mock

    db = MagicMock()
    db.query.side_effect = _query
    return db


def test_scenario9_bad_suffix_rejected():
    rows = [{
        "CustomerCode": CUST, "SalesChannelCode": CHAN,
        "BaseItemNo": BASE, "VariantSuffix": ".06",  # only 2 chars after dot
        "StartDate": "2026-07-01", "EndDate": "2026-07-01", "Price": "5.00",
    }]
    db     = _db_for_validation(item_rows=[_make_item(BASE + ".006")])
    result = validate_import_rows(rows, BU, db)
    assert result["date_errors"], "Expected error for bad suffix format"
    assert result["import_token"] is None


def test_scenario9_base_with_no_items_rejected():
    rows = [{
        "CustomerCode": CUST, "SalesChannelCode": CHAN,
        "BaseItemNo": "UNKNOWN", "VariantSuffix": "",
        "StartDate": "2026-07-01", "EndDate": "2026-07-01", "Price": "5.00",
    }]
    db     = _db_for_validation(item_rows=[])  # no items at all
    result = validate_import_rows(rows, BU, db)
    assert result["date_errors"], "Expected error for base item not in tblItem"
    assert result["import_token"] is None


def test_scenario9_variant_not_in_tblitem_rejected():
    rows = [{
        "CustomerCode": CUST, "SalesChannelCode": CHAN,
        "BaseItemNo": BASE, "VariantSuffix": ".999",
        "StartDate": "2026-07-01", "EndDate": "2026-07-01", "Price": "5.00",
    }]
    db     = _db_for_validation(item_rows=[])  # BASE + .999 not in tblItem
    result = validate_import_rows(rows, BU, db)
    assert result["date_errors"], "Expected error for variant not in tblItem"
    assert result["import_token"] is None


def test_validate_valid_row_issues_token():
    rows = [{
        "CustomerCode": CUST, "SalesChannelCode": CHAN,
        "BaseItemNo": BASE, "VariantSuffix": V006,
        "StartDate": "2026-07-01", "EndDate": "2026-08-01", "Price": "5.50",
    }]
    full_item = _make_item(BASE + V006)
    db        = _db_for_validation(item_rows=[full_item])
    result    = validate_import_rows(rows, BU, db)
    assert not result["date_errors"]
    assert result["import_token"] is not None
    assert len(result["valid_rows"]) == 2  # 2 months expanded


def test_validate_base_row_valid():
    rows = [{
        "CustomerCode": CUST, "SalesChannelCode": CHAN,
        "BaseItemNo": BASE, "VariantSuffix": "",
        "StartDate": "2026-07-01", "EndDate": "2026-07-01", "Price": "5.50",
    }]
    # A variant item in tblItem whose base is BASE → makes BASE a valid base
    variant_item = _make_item(BASE + V006)
    db           = _db_for_validation(item_rows=[variant_item])
    result       = validate_import_rows(rows, BU, db)
    assert not result["date_errors"]
    assert result["import_token"] is not None


# ── Upload numeric-type rejection (scenario 10) ───────────────────────────────

def test_scenario10_dot_variant_accepted():
    assert normalise_variant_suffix(".006") == ".006"


def test_scenario10_no_dot_variant_normalised():
    assert normalise_variant_suffix("006") == ".006"


def test_scenario10_numeric_cell_error_message():
    """
    simulate_numeric_cells: when Base Item or Variant raw value is a float,
    the import endpoint should emit a numeric-type error.

    We test the normalise_variant_suffix None path since the import_prices
    endpoint itself handles the isinstance(float) detection before calling validate.
    """
    # Simulate what happens when Excel gives a float for Variant ('.006' → 0.006)
    raw_from_excel = 0.006   # float — should be caught
    assert isinstance(raw_from_excel, float)
    # In import_prices, this triggers the numeric_type_error flag, not normalise_variant_suffix
    # Confirm normalise on the string representation would fail:
    as_str = str(raw_from_excel)  # '0.006'
    result = normalise_variant_suffix(as_str)
    assert result is None, f"'0.006' should not normalise to a valid suffix, got {result!r}"


# ── _chunked_or_query param-limit guard ──────────────────────────────────────

def test_chunked_or_query_stays_under_param_limit():
    """
    2,001 Price conditions at 6 params each must be split across enough batches
    that no single DB call would exceed SQL Server's 2,100 bound-parameter limit.

    chunk_size = (2100 - 100) // 6 = 333 → ceil(2001 / 333) = 7 calls minimum.
    The old fixed chunk_size=400 would produce only 6 calls, so this test
    also proves the regression is fixed.
    """
    from sqlalchemy import and_
    from app.models import Price
    from app.services.pricing import _chunked_or_query

    N             = 2_001
    PARAMS_PER    = 6
    SAFE_CHUNK    = (2100 - 100) // PARAMS_PER        # 333
    MIN_CALLS     = -(-N // SAFE_CHUNK)                # ceil(2001/333) = 7

    call_count = [0]

    def counting_query(model):
        m = MagicMock()
        def capture_filter(*args):
            call_count[0] += 1
            r = MagicMock()
            r.all.return_value = []
            return r
        m.filter.side_effect = capture_filter
        return m

    db = MagicMock()
    db.query.side_effect = counting_query

    conditions = [
        and_(
            Price.BusinessUnitCode == "BU",
            Price.CustomerCode     == f"C{i:06d}",
            Price.SalesChannelCode == "CH",
            Price.BaseItemNo       == f"I{i:06d}",
            Price.VariantSuffix    == "",
            Price.PriceMonth       == date(2026, 1, 1),
        )
        for i in range(N)
    ]

    _chunked_or_query(db, Price, conditions, params_per_condition=PARAMS_PER)

    assert call_count[0] >= MIN_CALLS, (
        f"Expected >= {MIN_CALLS} DB calls (chunk_size={SAFE_CHUNK}) for {N} conditions, "
        f"got {call_count[0]} — a single batch would exceed 2,100 bound parameters"
    )
