"""
tests/test_comparison.py

Unit tests for GET /api/v1/comparison/{bu_code}.

All DB and auth dependencies are mocked; no SQL Server connection is required.
Tests focus on the ForecastPrice resolution logic that was previously broken
(AttributeError: 'ForecastData' object has no attribute 'Price').
"""
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import ForecastData, User


# ── Shared helpers ────────────────────────────────────────────────────────────

BU   = "UK_UK"
CUST = "UK_UK_ASD"
ITEM = "934022.006"
PERIOD = date(2026, 4, 1)


def _make_forecast_row(
    *,
    item_no: str = ITEM,
    forecast_date: date = PERIOD,
    quantity: int = 100,
    is_price_override: bool = False,
    override_price: Decimal | None = None,
    sales_channel_code: str = "Domestic",
) -> MagicMock:
    row = MagicMock(spec=ForecastData)
    row.ItemNo             = item_no
    row.ForecastDate       = forecast_date
    row.Quantity           = quantity
    row.IsPriceOverride    = is_price_override
    row.OverridePrice      = override_price
    row.SalesChannelCode   = sales_channel_code
    row.BusinessUnitCode   = BU
    row.CustomerCode       = CUST
    row.ForecastTypeCode   = 1
    return row


def _mock_user() -> MagicMock:
    user = MagicMock(spec=User)
    user.UserID = 1
    user.role = MagicMock()
    user.role.CanViewAllBU = True
    return user


@contextmanager
def _make_client(
    forecast_rows: list,
    actuals_agg_rows: list,
    effective_price_return: tuple[Decimal, bool] = (Decimal("4.77"), False),
) -> TestClient:
    """
    Build a TestClient with all external dependencies overridden.

    forecast_rows       — list returned by ForecastData ORM query
    actuals_agg_rows    — list of MagicMock rows (with .ItemNo, .TotalQty etc.)
      passed as the raw SQL actuals aggregate result
    effective_price_return — (price, is_missing) returned by get_effective_price
    """
    def _override_get_db():
        db = MagicMock()
        # ForecastData query chain: .filter().filter()...all()
        fq_mock = MagicMock()
        fq_mock.all.return_value = forecast_rows
        fq_mock.filter.return_value = fq_mock
        # Actuals raw SQL
        db.execute.return_value.fetchall.return_value = actuals_agg_rows
        # Item/Brand/Customer/UserBusinessUnit queries (used for metadata lookups)
        db.query.return_value.filter.return_value.all.return_value = []
        db.query.return_value.filter.return_value.first.return_value = None
        # ForecastData-specific overrides
        db.query.side_effect = lambda model: fq_mock if model is ForecastData else db.query.return_value
        yield db

    def _override_get_current_user():
        return _mock_user()

    from app.db import get_db
    from app.auth import get_current_user

    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_current_user] = _override_get_current_user

    with patch(
        "app.routers.actuals.get_effective_price",
        return_value=effective_price_return,
    ):
        client = TestClient(app, raise_server_exceptions=True)
        yield client

    app.dependency_overrides.clear()


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestComparisonForecastPrice:
    def test_tblprice_lookup_returns_price(self):
        """
        When IsPriceOverride=False and a tblPrice entry exists, ForecastPrice
        should be the resolved price (is_missing=False).
        """
        frow = _make_forecast_row(quantity=312)

        with _make_client(
            forecast_rows=[frow],
            actuals_agg_rows=[],
            effective_price_return=(Decimal("4.77"), False),
        ) as client:
            resp = client.get(
                f"/api/v1/comparison/{BU}",
                params={"customer_code": CUST},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert float(data[0]["ForecastPrice"]) == pytest.approx(4.77, abs=0.001)

    def test_missing_tblprice_returns_none(self):
        """
        When IsPriceOverride=False and no tblPrice entry exists (is_missing=True),
        ForecastPrice should be None — not Decimal('0') or a 500.
        """
        frow = _make_forecast_row(quantity=50)

        with _make_client(
            forecast_rows=[frow],
            actuals_agg_rows=[],
            effective_price_return=(Decimal("0"), True),
        ) as client:
            resp = client.get(
                f"/api/v1/comparison/{BU}",
                params={"customer_code": CUST},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["ForecastPrice"] is None

    def test_price_override_returns_override_price(self):
        """
        When IsPriceOverride=True with an OverridePrice set, ForecastPrice
        should be the override value.
        """
        frow = _make_forecast_row(
            is_price_override=True,
            override_price=Decimal("9.99"),
        )

        with _make_client(
            forecast_rows=[frow],
            actuals_agg_rows=[],
            effective_price_return=(Decimal("9.99"), False),
        ) as client:
            resp = client.get(
                f"/api/v1/comparison/{BU}",
                params={"customer_code": CUST},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert float(data[0]["ForecastPrice"]) == pytest.approx(9.99, abs=0.001)

    def test_no_forecast_row_gives_none_price(self):
        """
        Rows that only have actuals (no matching forecast) must return
        ForecastPrice=None without calling get_effective_price.
        """
        actuals_row = MagicMock()
        actuals_row.ItemNo          = ITEM
        actuals_row.ActualsMonth    = PERIOD
        actuals_row.TotalQty        = Decimal("312")
        actuals_row.AvgPrice        = Decimal("4.77")
        actuals_row.TotalValue      = Decimal("1488.24")
        actuals_row.ActualsType     = "Invoiced"
        actuals_row.SalesChannelCode = "Domestic"

        with _make_client(
            forecast_rows=[],
            actuals_agg_rows=[actuals_row],
        ) as client:
            resp = client.get(
                f"/api/v1/comparison/{BU}",
                params={"customer_code": CUST},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data[0]["ForecastPrice"] is None
        assert float(data[0]["ActualsQty"]) == pytest.approx(312)

    def test_endpoint_returns_200_not_500(self):
        """Regression guard: the endpoint must not raise AttributeError on f.Price."""
        frow = _make_forecast_row()

        with _make_client(
            forecast_rows=[frow],
            actuals_agg_rows=[],
        ) as client:
            resp = client.get(
                f"/api/v1/comparison/{BU}",
                params={"customer_code": CUST},
            )

        assert resp.status_code == 200
