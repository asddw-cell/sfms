"""
services/supply_sync.py

Supply forecast auto-sync service.

When a Sales forecast row is created or updated, this service is called within
the same database transaction. It determines whether the corresponding Supply
row should be upserted based on the supply horizon for the BU+channel.

Rules:
  - FOB channel (HorizonMonths=0): always sync — no lock window.
  - Other channels: sync only if ForecastDate >= first_day_of(current month + HorizonMonths).
  - Inside the lock window: do nothing — the Supply row is frozen.
  - The SYSTEM account (UserID from config) is used as CreatedBy/ModifiedBy on
    all auto-synced rows so they are clearly distinguishable in the audit trail.
"""
from datetime import date, datetime
from dateutil.relativedelta import relativedelta
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ForecastData, SupplyHorizon

# ForecastTypeCode value for Supply — read from the database at runtime.
# Cached after first lookup to avoid repeated queries.
_SUPPLY_TYPE_CODE_CACHE: int | None = None


def _get_supply_type_code(db: Session) -> int:
    global _SUPPLY_TYPE_CODE_CACHE
    if _SUPPLY_TYPE_CODE_CACHE is not None:
        return _SUPPLY_TYPE_CODE_CACHE
    from app.models import ForecastType
    ft = db.query(ForecastType).filter(
        ForecastType.Name == "Supply",
        ForecastType.IsActive == True,
    ).first()
    if not ft:
        raise RuntimeError(
            "Supply ForecastType not found in tblForecastType. "
            "Ensure the database migration has been applied."
        )
    _SUPPLY_TYPE_CODE_CACHE = ft.Code
    return ft.Code


def _first_day_of_current_month() -> date:
    return date.today().replace(day=1)


def resolve_horizon(bu_code: str, channel_code: str, db: Session) -> int:
    """
    Return the HorizonMonths value for a given BU+channel combination.
    Falls back to the application default (SUPPLY_HORIZON_DEFAULT_MONTHS)
    if no active row exists in tblSupplyHorizon.
    """
    rule = db.query(SupplyHorizon).filter(
        SupplyHorizon.BusinessUnitCode == bu_code,
        SupplyHorizon.SalesChannelCode == channel_code,
        SupplyHorizon.IsActive == True,
    ).first()
    return rule.HorizonMonths if rule else settings.supply_horizon_default_months


def _horizon_boundary(horizon_months: int) -> date:
    """First day of (current calendar month + horizon_months)."""
    return _first_day_of_current_month() + relativedelta(months=horizon_months)


def _is_outside_horizon(forecast_date: date, horizon_months: int) -> bool:
    """
    Returns True if the forecast_date is outside (at or after) the lock window.
    When horizon_months=0 (FOB), always returns True — no lock window.
    """
    return forecast_date >= _horizon_boundary(horizon_months)


def sync_supply_row(sales_row: ForecastData, db: Session) -> None:
    """
    Upsert the matching Supply forecast row if the sales_row's ForecastDate
    is outside the supply horizon for its BU+channel.

    Must be called within the same SQLAlchemy session/transaction as the
    Sales row write. The caller is responsible for the commit.

    Does nothing if the period is inside the lock window.
    """
    horizon = resolve_horizon(
        sales_row.BusinessUnitCode,
        sales_row.SalesChannelCode,
        db,
    )

    if not _is_outside_horizon(sales_row.ForecastDate, horizon):
        return  # Inside lock window — do not touch Supply row

    supply_type_code = _get_supply_type_code(db)
    system_user_id   = settings.system_user_id
    now              = datetime.utcnow()

    existing = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode == sales_row.BusinessUnitCode,
        ForecastData.ForecastTypeCode == supply_type_code,
        ForecastData.SalesChannelCode == sales_row.SalesChannelCode,
        ForecastData.CustomerCode     == sales_row.CustomerCode,
        ForecastData.ItemNo           == sales_row.ItemNo,
        ForecastData.ForecastDate     == sales_row.ForecastDate,
        ForecastData.PriceTypeCode    == sales_row.PriceTypeCode,
    ).first()

    if existing:
        existing.Quantity     = sales_row.Quantity
        existing.Price        = sales_row.Price
        existing.ModifiedBy   = system_user_id
        existing.ModifiedDate = now
        existing.Notes        = "Auto-synced from Sales forecast"
    else:
        supply_row = ForecastData(
            BusinessUnitCode = sales_row.BusinessUnitCode,
            ForecastTypeCode = supply_type_code,
            SalesChannelCode = sales_row.SalesChannelCode,
            CustomerCode     = sales_row.CustomerCode,
            ItemNo           = sales_row.ItemNo,
            ForecastDate     = sales_row.ForecastDate,
            PriceTypeCode    = sales_row.PriceTypeCode,
            Price            = sales_row.Price,
            Quantity         = sales_row.Quantity,
            Notes            = "Auto-synced from Sales forecast",
            CreatedBy        = system_user_id,
            CreatedDate      = now,
            ModifiedBy       = system_user_id,
            ModifiedDate     = now,
        )
        db.add(supply_row)


def delete_supply_row(
    bu_code:         str,
    channel_code:    str,
    customer_code:   str,
    item_no:         str,
    forecast_date:   date,
    price_type_code: int | None,
    old_price:       float,
    db:              Session,
) -> None:
    """
    Delete the Supply row at old_price for the given dimension key.
    Called during the price-change delete+insert flow, before the Sales row
    is deleted, within the same transaction.

    Does nothing if the period is inside the lock window.
    """
    horizon = resolve_horizon(bu_code, channel_code, db)
    if not _is_outside_horizon(forecast_date, horizon):
        return  # Inside lock window — do not touch Supply row

    supply_type_code = _get_supply_type_code(db)

    q = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode == bu_code,
        ForecastData.ForecastTypeCode == supply_type_code,
        ForecastData.SalesChannelCode == channel_code,
        ForecastData.CustomerCode     == customer_code,
        ForecastData.ItemNo           == item_no,
        ForecastData.ForecastDate     == forecast_date,
        ForecastData.Price            == old_price,
    )
    if price_type_code is not None:
        q = q.filter(ForecastData.PriceTypeCode == price_type_code)

    q.delete(synchronize_session=False)
