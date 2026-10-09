"""
tests/test_reference_base_items.py

Unit tests for GET /api/v1/reference/base-items/{bu_code}.

Covers: item-number prefix match, description-word match, multi-word AND,
case insensitivity, wildcard characters in q, BU scoping, variant listing,
description resolution (base item vs variant fallback).
"""
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from app.main import app
from app.models import Item, User


# ── Helpers ───────────────────────────────────────────────────────────────────

def _item(item_no: str, description: str, is_active_uk: bool = True) -> SimpleNamespace:
    """Minimal tblItem row."""
    return SimpleNamespace(ItemNo=item_no, Description=description, IsActive_UK=is_active_uk)


def _mock_user() -> MagicMock:
    user = MagicMock(spec=User)
    user.UserID = 1
    user.role   = MagicMock()
    user.role.CanViewAllBU = True
    return user


@contextmanager
def _make_client(item_rows: list):
    """Build a TestClient with DB and auth overrides."""

    def _override_db():
        db = MagicMock()
        # The endpoint calls db.query(Item.ItemNo, Item.Description).filter().order_by().all()
        # All query chains return item_rows.
        chain = MagicMock()
        chain.filter.return_value    = chain
        chain.order_by.return_value  = chain
        chain.all.return_value       = item_rows
        db.query.return_value        = chain
        yield db

    def _override_user():
        return _mock_user()

    from app.auth import get_current_user
    from app.db   import get_db

    app.dependency_overrides[get_db]              = _override_db
    app.dependency_overrides[get_current_user]    = _override_user

    try:
        yield TestClient(app, raise_server_exceptions=True)
    finally:
        app.dependency_overrides.clear()


# ── Tests ─────────────────────────────────────────────────────────────────────

BU = "UK_UK"


def test_returns_distinct_base_items():
    """Items with the same base are collapsed into one entry."""
    items = [
        _item("123456.006", "Widget A"),
        _item("123456.012", "Widget A"),
        _item("999000",     "Gadget Z"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    assert r.status_code == 200
    data = r.json()
    bases = [d["base_item_no"] for d in data]
    assert bases.count("123456") == 1
    assert "999000" in bases


def test_variants_sorted_and_listed():
    """Variant suffixes are listed in sorted order, '' is excluded."""
    items = [
        _item("123456.012", "Widget A"),
        _item("123456.006", "Widget A"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    data = r.json()
    entry = next(d for d in data if d["base_item_no"] == "123456")
    assert entry["variants"] == [".006", ".012"]


def test_description_uses_base_item_when_present():
    """When the exact base ItemNo exists in tblItem, use its description."""
    items = [
        _item("123456",     "Base Description"),
        _item("123456.006", "Variant Description"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    data = {d["base_item_no"]: d for d in r.json()}
    assert data["123456"]["description"] == "Base Description"


def test_description_fallback_to_lowest_variant():
    """When only variants exist, description comes from the lowest-sorted variant."""
    items = [
        _item("123456.106", "Variant 106 Desc"),
        _item("123456.006", "Variant 006 Desc"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    data = {d["base_item_no"]: d for d in r.json()}
    # .006 < .106 alphabetically; .006 description should be used
    assert data["123456"]["description"] == "Variant 006 Desc"


def test_no_variants_for_plain_item():
    """A plain item (no suffix) has an empty variants list."""
    items = [_item("999000", "Gadget Z")]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    data = {d["base_item_no"]: d for d in r.json()}
    assert data["999000"]["variants"] == []


def test_q_prefix_match_on_item_number():
    """q filters to items whose base_item_no contains the query."""
    items = [
        _item("123456.006", "Widget A"),
        _item("999000",     "Gadget Z"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "123"})
    data = r.json()
    bases = [d["base_item_no"] for d in data]
    assert "123456" in bases
    assert "999000" not in bases


def test_q_match_on_description_word():
    """q matches on description as well as item number."""
    items = [
        _item("123456.006", "Blue Widget"),
        _item("999000",     "Red Gadget"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "gadget"})
    data = r.json()
    bases = [d["base_item_no"] for d in data]
    assert "999000" in bases
    assert "123456" not in bases


def test_q_multi_word_and_matching():
    """All words in q must match (AND logic)."""
    items = [
        _item("AA0001", "Blue Widget Premium"),
        _item("AA0002", "Blue Widget Standard"),
        _item("AA0003", "Red Widget Premium"),
    ]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "blue premium"})
    data = r.json()
    bases = [d["base_item_no"] for d in data]
    assert bases == ["AA0001"]


def test_q_case_insensitive():
    """q matching is case-insensitive."""
    items = [_item("ABC001", "SUPER Widget")]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "super widget"})
    assert len(r.json()) == 1
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "SUPER WIDGET"})
    assert len(r.json()) == 1


def test_q_wildcard_chars_are_literal():
    """% and _ in q are treated as literal characters, not SQL wildcards."""
    items = [
        _item("PCT001", "50% Discount item"),
        _item("ANY002", "Any other item"),
    ]
    with _make_client(items) as client:
        # '%' should only match items containing literal '%' in name/number
        r = client.get(f"/api/v1/reference/base-items/{BU}", params={"q": "%"})
    data = r.json()
    bases = [d["base_item_no"] for d in data]
    assert "PCT001" in bases
    assert "ANY002" not in bases  # "Any other item" doesn't contain '%'


def test_no_q_returns_all():
    """Without q, all base items are returned."""
    items = [_item("A00001", "Alpha"), _item("B00001", "Beta")]
    with _make_client(items) as client:
        r = client.get(f"/api/v1/reference/base-items/{BU}")
    assert len(r.json()) == 2
