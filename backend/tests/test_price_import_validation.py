"""
tests/test_price_import_validation.py

Unit tests for the price import validation pipeline:
  - _detect_in_file_overlaps (pure function, no DB needed)
  - validate_import_rows (warnings, overlaps, row count, param chunking)
  - _commit_rows safety-net duplicate check
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.services.pricing import _detect_in_file_overlaps, validate_import_rows


# ── Constants ─────────────────────────────────────────────────────────────────

BU   = "UK_UK"
CUST = "CUST1"
CHAN = "CH1"
BASE = "BASE01"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _entry(
    start_month: tuple[int, int],
    end_month:   tuple[int, int],
    *,
    excel_row: int = 2,
    price: str     = "10.00",
    customer: str  = CUST,
    channel:  str  = CHAN,
    base:     str  = BASE,
    suffix:   str  = "",
) -> dict:
    """Build a file_entry dict as produced by validate_import_rows Phase 1."""
    return {
        "excel_row":   excel_row,
        "bu":          BU,
        "customer":    customer,
        "channel":     channel,
        "base":        base,
        "suffix":      suffix,
        "start_month": date(start_month[0], start_month[1], 1),
        "end_month":   date(end_month[0],   end_month[1],   1),
        "price":       Decimal(price),
    }


def _row(
    *,
    customer: str = CUST,
    channel:  str = CHAN,
    base:     str = BASE,
    suffix:   str = "",
    start:    str = "2026-01-01",
    end:      str = "2026-03-31",
    price:    str = "10.00",
    excel_row: int = 2,
) -> dict:
    """Build a validate_import_rows input row dict."""
    return {
        "CustomerCode":     customer,
        "SalesChannelCode": channel,
        "BaseItemNo":       base,
        "VariantSuffix":    suffix,
        "StartDate":        start,
        "EndDate":          end,
        "Price":            price,
        "_excel_row":       excel_row,
    }


def _make_db(base_items: list[str] | None = None, price_rows: list | None = None):
    """
    Mock DB session for validate_import_rows.

    Item queries return SimpleNamespace objects covering all base_items so every
    row passes item-existence validation. Price queries return price_rows (default
    empty — no existing conflicts).
    """
    from app.models import Item, Price

    item_objs  = [SimpleNamespace(ItemNo=b) for b in (base_items or [BASE])]
    price_objs = price_rows or []

    def _query(model):
        mock = MagicMock()
        if model is Item:
            mock.filter.return_value.all.return_value    = item_objs
            mock.filter.return_value.first.return_value  = item_objs[0] if item_objs else None
            mock.filter.return_value.filter.return_value = mock.filter.return_value
        elif model is Price:
            mock.filter.return_value.all.return_value    = price_objs
            mock.filter.return_value.first.return_value  = price_objs[0] if price_objs else None
            mock.filter.return_value.filter.return_value = mock.filter.return_value
        else:
            mock.filter.return_value.all.return_value    = []
            mock.filter.return_value.first.return_value  = None
            mock.filter.return_value.filter.return_value = mock.filter.return_value
        return mock

    db = MagicMock()
    db.query.side_effect = _query
    return db


# ── _detect_in_file_overlaps ──────────────────────────────────────────────────

class TestDetectInFileOverlaps:

    def test_partial_overlap(self):
        """Row A Jan–Mar, Row B Mar–May → single-month overlap in Mar."""
        entries = [
            _entry((2026, 1), (2026, 3), excel_row=2),
            _entry((2026, 3), (2026, 5), excel_row=3),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["overlap_start"] == "2026-03-01"
        assert errors[0]["overlap_end"]   == "2026-03-01"
        assert errors[0]["row_a"] == 2
        assert errors[0]["row_b"] == 3

    def test_nested_range(self):
        """Row A Jan–Dec contains Row B Apr–Jun → overlap is Apr–Jun."""
        entries = [
            _entry((2026, 1), (2026, 12), excel_row=2),
            _entry((2026, 4), (2026, 6),  excel_row=3),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["overlap_start"] == "2026-04-01"
        assert errors[0]["overlap_end"]   == "2026-06-01"

    def test_exact_duplicate(self):
        """Two rows with identical date ranges for the same key are an overlap."""
        entries = [
            _entry((2026, 1), (2026, 3), excel_row=2),
            _entry((2026, 1), (2026, 3), excel_row=3),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["overlap_start"] == "2026-01-01"
        assert errors[0]["overlap_end"]   == "2026-03-01"

    def test_same_price_is_still_error(self):
        """Overlapping rows with the same price are still a blocking error."""
        entries = [
            _entry((2026, 1), (2026, 3), excel_row=2, price="10.00"),
            _entry((2026, 2), (2026, 4), excel_row=3, price="10.00"),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["prices_differ"] is False
        assert "(same price)" in errors[0]["message"]

    def test_touching_ranges_are_not_overlap(self):
        """Row A Jan–Mar, Row B Apr–Jun → contiguous months, not an overlap."""
        entries = [
            _entry((2026, 1), (2026, 3), excel_row=2),
            _entry((2026, 4), (2026, 6), excel_row=3),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert errors == []

    def test_year_boundary_not_overlap(self):
        """Dec 2025 and Jan 2026 are touching months, not an overlap."""
        entries = [
            _entry((2025, 12), (2025, 12), excel_row=2),
            _entry((2026,  1), (2026,  1), excel_row=3),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert errors == []

    def test_different_customer_no_overlap(self):
        """Same dates and item but different customer codes → no overlap."""
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=2, customer="CUST1"),
            _entry((2026, 1), (2026, 6), excel_row=3, customer="CUST2"),
        ]
        assert _detect_in_file_overlaps(entries) == []

    def test_different_channel_no_overlap(self):
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=2, channel="CH1"),
            _entry((2026, 1), (2026, 6), excel_row=3, channel="CH2"),
        ]
        assert _detect_in_file_overlaps(entries) == []

    def test_different_base_no_overlap(self):
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=2, base="ITEM01"),
            _entry((2026, 1), (2026, 6), excel_row=3, base="ITEM02"),
        ]
        assert _detect_in_file_overlaps(entries) == []

    def test_different_suffix_no_overlap(self):
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=2, suffix=".006"),
            _entry((2026, 1), (2026, 6), excel_row=3, suffix=".012"),
        ]
        assert _detect_in_file_overlaps(entries) == []

    def test_excel_row_numbers_in_error(self):
        """Error dict carries correct Excel row numbers and they appear in the message."""
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=5),
            _entry((2026, 3), (2026, 9), excel_row=12),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["row_a"] == 5
        assert errors[0]["row_b"] == 12
        assert "5"  in errors[0]["message"]
        assert "12" in errors[0]["message"]

    def test_prices_differ_flag_and_message(self):
        """prices_differ is True and the message says so when prices are different."""
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=2, price="10.00"),
            _entry((2026, 3), (2026, 9), excel_row=3, price="12.50"),
        ]
        errors = _detect_in_file_overlaps(entries)
        assert len(errors) == 1
        assert errors[0]["prices_differ"] is True
        assert "prices differ" in errors[0]["message"]

    def test_direct_count_of_all_pairs(self):
        """11 entries all covering the same date range → C(11,2) = 55 pairs total."""
        entries = [
            _entry((2026, 1), (2026, 6), excel_row=r + 2)
            for r in range(11)
        ]
        all_errors = _detect_in_file_overlaps(entries)
        assert len(all_errors) == 55

    def test_validate_caps_at_50_with_total_count(self):
        """
        validate_import_rows caps returned overlap_errors at 50 but overlap_count
        reports the true total.  11 mutually-overlapping rows → 55 pairs.
        """
        rows = [
            _row(start="2026-01-01", end="2026-06-30", excel_row=r + 2)
            for r in range(11)
        ]
        result = validate_import_rows(rows, BU, _make_db())
        assert result["overlap_count"]        == 55
        assert len(result["overlap_errors"])   == 50

    def test_no_overlap_empty_list(self):
        """No entries → no errors."""
        assert _detect_in_file_overlaps([]) == []

    def test_single_entry_no_error(self):
        """One entry can't overlap with anything."""
        entries = [_entry((2026, 1), (2026, 6))]
        assert _detect_in_file_overlaps(entries) == []


# ── validate_import_rows — warnings ───────────────────────────────────────────

class TestWarnings:

    def test_mid_month_start_warning(self):
        """Start day ≠ 1 → warning referencing the original start date."""
        rows   = [_row(start="2026-06-15", end="2026-08-31")]
        result = validate_import_rows(rows, BU, _make_db())
        msgs   = [w["message"] for w in result["warnings"]]
        assert any("2026-06-15" in m for m in msgs)

    def test_non_month_end_date_warning(self):
        """End day ≠ last day of that month → warning referencing the original end date."""
        rows   = [_row(start="2026-06-01", end="2026-08-15")]
        result = validate_import_rows(rows, BU, _make_db())
        msgs   = [w["message"] for w in result["warnings"]]
        assert any("2026-08-15" in m for m in msgs)

    def test_zero_price_warning(self):
        """price == 0 → zero-price warning."""
        rows   = [_row(start="2026-01-01", end="2026-03-31", price="0")]
        result = validate_import_rows(rows, BU, _make_db())
        msgs   = [w["message"] for w in result["warnings"]]
        assert any("price is 0" in m for m in msgs)

    def test_month_end_date_no_warning(self):
        """End date that IS the last day of its month → no end-date warning."""
        rows   = [_row(start="2026-06-01", end="2026-06-30")]   # Jun 30 = last day
        result = validate_import_rows(rows, BU, _make_db())
        msgs   = [w["message"] for w in result["warnings"]]
        assert not any("2026-06-30" in m for m in msgs)

    def test_first_of_month_start_no_warning(self):
        """Start date on the 1st → no start warning."""
        rows   = [_row(start="2026-06-01", end="2026-06-30")]
        result = validate_import_rows(rows, BU, _make_db())
        msgs   = [w["message"] for w in result["warnings"]]
        assert not any("2026-06-01" in m for m in msgs)

    def test_warnings_do_not_block_import(self):
        """A warning alone must not prevent issuing an import token."""
        rows   = [_row(start="2026-06-15", end="2026-08-31")]
        result = validate_import_rows(rows, BU, _make_db())
        assert result["import_token"]   is not None
        assert result["date_errors"]    == []
        assert result["overlap_errors"] == []
        assert result["warnings_count"] >= 1


# ── validate_import_rows — large import / parameter chunking ──────────────────

class TestLargeImport:

    def test_large_non_overlapping_import_succeeds(self):
        """
        50 rows × 100 months each = 5 000 expanded monthly rows (> 2 100 SQL params).
        All rows use distinct BaseItemNo values so there are no in-file overlaps.
        validate_import_rows completes without error and issues a token.
        """
        items = [f"ITEM{i:02d}" for i in range(50)]
        rows  = [
            _row(base=b, start="2026-01-01", end="2034-04-30", excel_row=i + 2)
            for i, b in enumerate(items)
        ]
        result = validate_import_rows(rows, BU, _make_db(base_items=items))
        assert result["date_errors"]    == []
        assert result["overlap_errors"] == []
        # 50 items × 100 months (Jan 2026 – Apr 2034) = 5 000 rows
        assert len(result["valid_rows"]) == 5_000
        assert result["import_token"]   is not None


# ── _commit_rows — safety-net duplicate check ─────────────────────────────────

class TestCommitRowsSafetyNet:

    def test_duplicate_keys_raise_422(self):
        """
        _commit_rows raises HTTPException(422) when valid_rows contains two entries
        with the same (BU, customer, channel, base, suffix, month) key.
        The check fires before any DB I/O.
        """
        from app.routers.prices import _commit_rows

        month   = date(2026, 7, 1)
        dup_row = {
            "BusinessUnitCode": BU,
            "CustomerCode":     CUST,
            "SalesChannelCode": CHAN,
            "BaseItemNo":       BASE,
            "VariantSuffix":    "",
            "PriceMonth":       month,
            "Price":            Decimal("10.00"),
        }

        mock_user = SimpleNamespace(UserID=1)
        db_mock   = MagicMock()

        with pytest.raises(HTTPException) as exc_info:
            _commit_rows([dup_row, {**dup_row}], "overwrite", mock_user, db_mock)

        assert exc_info.value.status_code == 422
        assert "overlapping" in exc_info.value.detail.lower()

    def test_unique_keys_do_not_raise(self):
        """
        _commit_rows does not raise for two rows with different PriceMonths.
        DB is stubbed to return no existing rows so both become INSERTs.
        """
        from app.routers.prices import _commit_rows

        base_row = {
            "BusinessUnitCode": BU,
            "CustomerCode":     CUST,
            "SalesChannelCode": CHAN,
            "BaseItemNo":       BASE,
            "VariantSuffix":    "",
            "Price":            Decimal("10.00"),
        }
        row_jan = {**base_row, "PriceMonth": date(2026, 1, 1)}
        row_feb = {**base_row, "PriceMonth": date(2026, 2, 1)}

        mock_user = SimpleNamespace(UserID=1)

        # DB returns no existing rows → both will be inserted.
        from app.models import Price
        db_mock = MagicMock()
        q_mock  = MagicMock()
        q_mock.filter.return_value.all.return_value    = []
        q_mock.filter.return_value.filter.return_value = q_mock.filter.return_value
        db_mock.query.return_value = q_mock
        db_mock.commit.return_value = None

        inserted, updated = _commit_rows([row_jan, row_feb], "overwrite", mock_user, db_mock)
        assert inserted == 2
        assert updated  == 0
