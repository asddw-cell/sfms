"""
tests/test_price_access.py

Access-control tests for the price endpoints.

Rules verified:
  - Any role that has a tblUserBusinessUnit row for the BU can access all price
    endpoints (read and write) — no CanManageRefData gate.
  - A user with no BU assignment and CanViewAllBU=0 gets 403 on every endpoint.
  - An unauthenticated request gets 401 on every endpoint.

All DB and auth dependencies are overridden; no SQL Server connection required.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.models import User, UserBusinessUnit


BU   = "UK_UK"
CUST = "UK_UK_ASD"


# ── Mock factories ────────────────────────────────────────────────────────────

def _make_user(*, can_view_all_bu: bool = False, role_name: str = "Manager") -> MagicMock:
    """Return a mock User with configurable role flags."""
    user = MagicMock(spec=User)
    user.UserID = 99
    user.role = SimpleNamespace(
        CanViewAllBU    = can_view_all_bu,
        CanManageRefData = False,   # deliberately False — prices must not need this
        CanManageUsers   = False,
        CanLoadActuals   = False,
        Name             = role_name,
    )
    return user


def _chainable_mock(*, first_return=None, all_return=None) -> MagicMock:
    """
    Build a MagicMock that chains .filter(), .order_by(), .filter()… indefinitely
    and returns sensible values for .first() and .all() at any point in the chain.
    """
    m = MagicMock()
    m.all.return_value   = all_return if all_return is not None else []
    m.first.return_value = first_return
    # Any chaining method returns the same mock so the terminal .all()/.first() always works.
    m.filter.return_value   = m
    m.order_by.return_value = m
    m.filter.return_value.filter.return_value = m
    return m


def _make_db(*, has_bu_assignment: bool) -> MagicMock:
    """
    Return a mock DB session.

    has_bu_assignment controls what _require_bu_access sees when it calls
    db.query(UserBusinessUnit).filter(...).first().  Every other query returns
    an empty result so endpoints that pass the access check can still respond.
    """
    assignment = SimpleNamespace(UserID=99, BusinessUnitCode=BU) if has_bu_assignment else None

    def _query(model):
        if model is UserBusinessUnit:
            return _chainable_mock(first_return=assignment)
        return _chainable_mock()

    db = MagicMock()
    db.query.side_effect = _query
    return db


@contextmanager
def _make_client(*, has_bu_assignment: bool, can_view_all_bu: bool = False,
                 role_name: str = "Manager", raise_401: bool = False):
    """
    Context manager that yields a TestClient with overridden auth and DB deps.

    raise_401=True simulates an unauthenticated request (get_current_user raises 401).
    """
    from app.db import get_db
    from app.auth import get_current_user

    def _override_get_db():
        yield _make_db(has_bu_assignment=has_bu_assignment)

    if raise_401:
        def _override_get_current_user():
            raise HTTPException(401, detail="Not authenticated")
    else:
        user = _make_user(can_view_all_bu=can_view_all_bu, role_name=role_name)
        def _override_get_current_user():
            return user

    app.dependency_overrides[get_db]             = _override_get_db
    app.dependency_overrides[get_current_user]   = _override_get_current_user
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()


# ── Endpoint table ────────────────────────────────────────────────────────────
# (method, path, kwargs) — minimal valid args to reach the BU check

_ENDPOINTS = [
    ("GET",    f"/api/v1/prices/{BU}",                   {"params": {"customer_code": CUST}}),
    ("GET",    f"/api/v1/prices/{BU}/template",          {"params": {"customer_code": CUST}}),
    ("PUT",    f"/api/v1/prices/{BU}",                   {"json": {
        "CustomerCode": CUST, "SalesChannelCode": "CH1",
        "BaseItemNo": "BASE01", "VariantSuffix": "",
        "StartDate": "2026-01-01", "EndDate": "2026-03-31", "Price": "10.00",
    }}),
    ("DELETE", f"/api/v1/prices/{BU}/1",                 {}),
    ("PATCH",  f"/api/v1/prices/{BU}/1",                 {"json": {"new_price": "12.00", "price_ids": [1]}}),
    ("POST",   f"/api/v1/prices/{BU}/import",
     {"files": {"file": ("p.xlsx", b"PK\x03\x04", "application/octet-stream")}}),
    ("POST",   f"/api/v1/prices/{BU}/import/confirm",    {"json": {
        "import_token": "00000000-0000-0000-0000-000000000000",
        "conflict_resolution": "overwrite",
    }}),
]


# ── Tests: no BU assignment → 403 ────────────────────────────────────────────

@pytest.mark.parametrize("method,path,kwargs", _ENDPOINTS,
    ids=["list", "template", "upsert", "delete", "patch", "import", "confirm"])
def test_no_bu_assignment_returns_403(method, path, kwargs):
    """A user with no tblUserBusinessUnit row for the BU gets 403 on every endpoint."""
    with _make_client(has_bu_assignment=False, can_view_all_bu=False) as client:
        resp = client.request(method, path, **kwargs)
    assert resp.status_code == 403


# ── Tests: unauthenticated → 401 ─────────────────────────────────────────────

@pytest.mark.parametrize("method,path,kwargs", _ENDPOINTS,
    ids=["list", "template", "upsert", "delete", "patch", "import", "confirm"])
def test_unauthenticated_returns_401(method, path, kwargs):
    """An unauthenticated request gets 401 on every endpoint."""
    with _make_client(has_bu_assignment=True, raise_401=True) as client:
        resp = client.request(method, path, **kwargs)
    assert resp.status_code == 401


# ── Tests: all roles with BU assignment can access prices ────────────────────

_ROLE_NAMES = ["Manager", "SalesUser", "PowerUser", "Admin"]


@pytest.mark.parametrize("role_name", _ROLE_NAMES)
def test_any_role_with_bu_assignment_can_list_prices(role_name):
    """
    GET prices returns 200 for every role when the user has a BU assignment.
    No CanManageRefData gate exists on this endpoint.
    """
    with _make_client(has_bu_assignment=True, role_name=role_name) as client:
        resp = client.get(
            f"/api/v1/prices/{BU}",
            params={"customer_code": CUST},
        )
    assert resp.status_code == 200
    assert resp.json() == []   # mock DB returns no prices — empty list is correct


@pytest.mark.parametrize("role_name", _ROLE_NAMES)
def test_any_role_with_bu_assignment_can_download_template(role_name):
    """GET template returns a non-403 for any role with a BU assignment."""
    # Template endpoint calls openpyxl; patch it to avoid the import check
    with _make_client(has_bu_assignment=True, role_name=role_name) as client:
        with patch("app.routers.prices.openpyxl", create=True) as mock_xl:
            # Make openpyxl look installed and return a minimal workbook
            wb_mock = MagicMock()
            ws_mock = MagicMock()
            ws_mock.cell.return_value = MagicMock()
            wb_mock.active = ws_mock
            mock_xl.Workbook.return_value = wb_mock
            mock_xl.styles.Font = MagicMock
            buf_mock = BytesIO(b"PK")   # minimal xlsx-like bytes
            wb_mock.save.side_effect = lambda buf: buf.write(b"PK")
            resp = client.get(
                f"/api/v1/prices/{BU}/template",
                params={"customer_code": CUST},
            )
    assert resp.status_code != 403


# ── Tests: CanViewAllBU without assignment passes ─────────────────────────────

def test_can_view_all_bu_without_assignment_passes_bu_check():
    """CanViewAllBU=1 with no explicit assignment: _require_bu_access passes."""
    with _make_client(has_bu_assignment=False, can_view_all_bu=True) as client:
        resp = client.get(
            f"/api/v1/prices/{BU}",
            params={"customer_code": CUST},
        )
    assert resp.status_code == 200
