"""
tests/test_editability.py

Unit tests for check_editable() in services/editability.py.
All tests patch the database helpers and supply-type lookup — no real DB required.
"""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.editability import check_editable

# ── Constants ─────────────────────────────────────────────────────────────────

BU             = "UK_UK"
SALES_FT_CODE  = 1
SUPPLY_FT_CODE = 3


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_role(
    *,
    CanViewAllBU=True,
    HorizonMonthsBack=0,
    CanEditSupplyForecast=False,
):
    return SimpleNamespace(
        CanViewAllBU          = CanViewAllBU,
        HorizonMonthsBack     = HorizonMonthsBack,
        CanEditSupplyForecast = CanEditSupplyForecast,
    )


def _make_user(role=None, user_id=1):
    return SimpleNamespace(UserID=user_id, role=role or _make_role())


def _make_assignment(horizon_override=None):
    return SimpleNamespace(HorizonOverrideMonthsBack=horizon_override)


def _today_first():
    """First day of the current calendar month."""
    return date.today().replace(day=1)


def _month_offset(months: int) -> date:
    """First day of current month + `months` months."""
    from dateutil.relativedelta import relativedelta
    return _today_first() + relativedelta(months=months)


# ── Patch targets ─────────────────────────────────────────────────────────────

PATCH_INVOICED  = "app.services.editability._invoiced_actuals_exist"
PATCH_BU_ASSIGN = "app.services.editability._get_bu_assignment"
PATCH_SUPPLY    = "app.services.supply_sync._SUPPLY_TYPE_CODE_CACHE"


def _run(
    forecast_date,
    *,
    invoiced=False,
    assignment=None,
    user=None,
    ft_code=SALES_FT_CODE,
    supply_type_code=SUPPLY_FT_CODE,
):
    """
    Run check_editable with the given parameters, patching all DB helpers.
    Returns None on success, raises HTTPException on lock.
    """
    db = MagicMock()
    if user is None:
        user = _make_user()
    if assignment is None:
        assignment = _make_assignment()

    with patch(PATCH_INVOICED, return_value=invoiced), \
         patch(PATCH_BU_ASSIGN, return_value=assignment), \
         patch("app.services.supply_sync._SUPPLY_TYPE_CODE_CACHE", supply_type_code):
        return check_editable(BU, forecast_date, ft_code, user, db)


# ── Tests — past month ────────────────────────────────────────────────────────

def test_past_month_no_actuals_is_locked():
    """Rule 1: any past month is locked regardless of actuals."""
    past = _month_offset(-1)
    with pytest.raises(HTTPException) as exc:
        _run(past, invoiced=False)
    assert exc.value.status_code == 403
    assert "before the current month" in exc.value.detail


def test_past_month_with_invoiced_actuals_is_locked():
    """Rules 1 + 2: past month with invoiced actuals remains locked.
    Step 1 fires first; step 2 is a safety-net for the same outcome."""
    past = _month_offset(-1)
    with pytest.raises(HTTPException) as exc:
        _run(past, invoiced=True)
    assert exc.value.status_code == 403
    # Step 1 fires — message is the past-month lock, not the actuals lock
    assert "before the current month" in exc.value.detail


def test_past_month_with_horizon_override_is_locked():
    """Even a user with HorizonOverrideMonthsBack=1 cannot edit a past month —
    step 1 is unconditional."""
    past = _month_offset(-1)
    user = _make_user(role=_make_role(HorizonMonthsBack=0))
    assignment = _make_assignment(horizon_override=1)
    with pytest.raises(HTTPException) as exc:
        _run(past, invoiced=True, user=user, assignment=assignment)
    assert exc.value.status_code == 403
    assert "before the current month" in exc.value.detail


# ── Tests — current month ─────────────────────────────────────────────────────

def test_current_month_no_actuals_is_editable():
    """Current month without invoiced actuals is always editable."""
    _run(_today_first(), invoiced=False)  # must not raise


def test_current_month_with_invoiced_actuals_is_editable():
    """Rule: current month must stay editable even when invoiced actuals exist.
    This is the core regression test for the ETL-loads-current-month bug."""
    _run(_today_first(), invoiced=True)  # must not raise


# ── Tests — future month ──────────────────────────────────────────────────────

def test_future_month_with_invoiced_actuals_is_editable():
    """A future month with invoiced actuals (unusual but possible) must not be locked."""
    future = _month_offset(1)
    _run(future, invoiced=True)  # must not raise


# ── Tests — Supply type ───────────────────────────────────────────────────────

def test_current_month_supply_with_invoiced_actuals_authorized():
    """Supply type + current month + invoiced actuals: step 2 must not fire.
    Result depends only on CanEditSupplyForecast (authorized → editable)."""
    user = _make_user(role=_make_role(CanEditSupplyForecast=True))
    _run(_today_first(), invoiced=True, ft_code=SUPPLY_FT_CODE, user=user)  # must not raise


def test_current_month_supply_with_invoiced_actuals_unauthorized():
    """Supply type + current month + invoiced actuals: step 2 must not fire.
    A Sales User is blocked by step 4 (CanEditSupplyForecast), not step 2."""
    user = _make_user(role=_make_role(CanEditSupplyForecast=False))
    with pytest.raises(HTTPException) as exc:
        _run(_today_first(), invoiced=True, ft_code=SUPPLY_FT_CODE, user=user)
    assert exc.value.status_code == 403
    assert "Supply forecast" in exc.value.detail
