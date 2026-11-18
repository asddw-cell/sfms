"""
services/item_migration.py

Business logic for migrating forecast quantities from one item variant to another.
Sibling items are defined as items sharing the same BrandCode that are active
for the BU's region.
"""
from datetime import date, datetime
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import ForecastData, Item, User, UserCustomer, ForecastType
from app.services.editability import check_editable

_REGION_COLUMN_MAP = {
    "UK": Item.IsActive_UK,
    "EU": Item.IsActive_EU,
    "US": Item.IsActive_US,
    "AU": Item.IsActive_AU,
    "MX": Item.IsActive_MX,
}


def _region_active_column(bu_code: str):
    return _REGION_COLUMN_MAP.get(bu_code[:2].upper())


def _get_sales_type_code(db: Session):
    ft = db.query(ForecastType).filter(
        ForecastType.Name == "Sales",
        ForecastType.IsActive == True,
    ).first()
    return ft.Code if ft else None


def get_migration_targets(
    bu_code: str,
    source_item_no: str,
    user: User,
    db: Session,
) -> list:
    """Returns items in the same brand as source_item_no, active for the BU's region."""
    source_item = db.query(Item).filter(Item.ItemNo == source_item_no).first()
    if not source_item:
        raise HTTPException(404, detail="Source item not found.")

    q = db.query(Item).filter(
        Item.BrandCode == source_item.BrandCode,
        Item.ItemNo != source_item_no,
    )
    region_col = _region_active_column(bu_code)
    if region_col is not None:
        q = q.filter(region_col == True)

    return q.order_by(Item.Description).all()


def get_type_counts(
    bu_code: str,
    source_item_no: str,
    date_from: date,
    date_to: date,
    db: Session,
) -> list[dict]:
    """Returns forecast types with row counts for the source item in the date range."""
    rows = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode == bu_code,
        ForecastData.ItemNo           == source_item_no,
        ForecastData.ForecastDate     >= date_from.replace(day=1),
        ForecastData.ForecastDate     <= date_to.replace(day=1),
    ).all()

    from collections import Counter
    type_counts = Counter(r.ForecastTypeCode for r in rows)
    if not type_counts:
        return []

    types = db.query(ForecastType).filter(ForecastType.Code.in_(list(type_counts))).all()
    type_name_map = {t.Code: t.Name for t in types}

    return [
        {
            "forecast_type_code": code,
            "name": type_name_map.get(code, str(code)),
            "row_count": count,
        }
        for code, count in sorted(type_counts.items())
    ]


def get_migration_preview(
    bu_code: str,
    source_item_no: str,
    target_item_no: str,
    date_from: date,
    date_to: date,
    forecast_type_codes: list[int],
    all_customers: bool,
    user: User,
    db: Session,
) -> list[dict]:
    """Returns a preview of rows that would be moved, flagging conflicts."""
    customer_filter = _resolve_customer_filter(bu_code, all_customers, user, db)

    source_rows = _fetch_source_rows(
        bu_code, source_item_no, date_from, date_to, forecast_type_codes, customer_filter, db
    )

    target_keys = {
        (r.ForecastTypeCode, r.SalesChannelCode, r.CustomerCode, r.ForecastDate)
        for r in db.query(ForecastData).filter(
            ForecastData.BusinessUnitCode    == bu_code,
            ForecastData.ItemNo              == target_item_no,
            ForecastData.ForecastDate        >= date_from.replace(day=1),
            ForecastData.ForecastDate        <= date_to.replace(day=1),
            ForecastData.ForecastTypeCode.in_(forecast_type_codes),
        ).all()
    }

    types = db.query(ForecastType).filter(ForecastType.Code.in_(forecast_type_codes)).all()
    type_name_map = {t.Code: t.Name for t in types}

    return [
        {
            "entry_no":           row.EntryNo,
            "forecast_type_code": row.ForecastTypeCode,
            "forecast_type_name": type_name_map.get(row.ForecastTypeCode, str(row.ForecastTypeCode)),
            "sales_channel_code": row.SalesChannelCode,
            "customer_code":      row.CustomerCode,
            "forecast_date":      row.ForecastDate,
            "quantity":           row.Quantity,
            "has_conflict": (
                row.ForecastTypeCode,
                row.SalesChannelCode,
                row.CustomerCode,
                row.ForecastDate,
            ) in target_keys,
        }
        for row in source_rows
    ]


def execute_migration(
    bu_code: str,
    source_item_no: str,
    target_item_no: str,
    date_from: date,
    date_to: date,
    forecast_type_codes: list[int],
    all_customers: bool,
    on_conflict: str,
    user: User,
    db: Session,
) -> dict:
    """Moves forecast rows from source item to target item. Returns move/skip/overwrite counts."""
    from app.services.supply_sync import sync_supply_row, delete_supply_row

    customer_filter = _resolve_customer_filter(bu_code, all_customers, user, db)
    source_rows = _fetch_source_rows(
        bu_code, source_item_no, date_from, date_to, forecast_type_codes, customer_filter, db
    )

    if not source_rows:
        return {"moved": 0, "skipped": 0, "overwritten": 0, "not_editable": 0}

    # Check editability per unique (month, type) combination up front
    unique_month_types = {(r.ForecastDate, r.ForecastTypeCode) for r in source_rows}
    non_editable: set[tuple] = set()
    for fd, ftc in unique_month_types:
        try:
            check_editable(bu_code, fd, ftc, user, db)
        except HTTPException:
            non_editable.add((fd, ftc))

    # Fetch existing target rows for conflict detection
    target_map: dict[tuple, ForecastData] = {
        (r.ForecastTypeCode, r.SalesChannelCode, r.CustomerCode, r.ForecastDate): r
        for r in db.query(ForecastData).filter(
            ForecastData.BusinessUnitCode    == bu_code,
            ForecastData.ItemNo              == target_item_no,
            ForecastData.ForecastDate        >= date_from.replace(day=1),
            ForecastData.ForecastDate        <= date_to.replace(day=1),
            ForecastData.ForecastTypeCode.in_(forecast_type_codes),
        ).all()
    }

    sales_type = _get_sales_type_code(db)
    now = datetime.utcnow()
    moved = skipped = overwritten = not_editable_count = 0

    for row in source_rows:
        if (row.ForecastDate, row.ForecastTypeCode) in non_editable:
            not_editable_count += 1
            continue

        key = (row.ForecastTypeCode, row.SalesChannelCode, row.CustomerCode, row.ForecastDate)
        existing_target = target_map.get(key)

        if existing_target:
            if on_conflict == 'skip':
                skipped += 1
                continue
            # overwrite — replace target quantity with source quantity
            existing_target.Quantity    = row.Quantity
            existing_target.Notes       = row.Notes
            existing_target.ModifiedBy  = user.UserID
            existing_target.ModifiedDate = now
            try:
                if sales_type and existing_target.ForecastTypeCode == sales_type:
                    sync_supply_row(existing_target, db)
            except Exception:
                pass
            overwritten += 1
        else:
            new_row = ForecastData(
                BusinessUnitCode = bu_code,
                ForecastTypeCode = row.ForecastTypeCode,
                SalesChannelCode = row.SalesChannelCode,
                CustomerCode     = row.CustomerCode,
                ItemNo           = target_item_no,
                ForecastDate     = row.ForecastDate,
                IsPriceOverride  = False,
                OverridePrice    = None,
                Quantity         = row.Quantity,
                Notes            = row.Notes,
                CreatedBy        = user.UserID,
                CreatedDate      = now,
                ModifiedBy       = user.UserID,
                ModifiedDate     = now,
            )
            db.add(new_row)
            db.flush()
            try:
                if sales_type and new_row.ForecastTypeCode == sales_type:
                    sync_supply_row(new_row, db)
            except Exception:
                pass
            moved += 1

        # Delete source row (always, whether we moved or overwrote)
        try:
            if sales_type and row.ForecastTypeCode == sales_type:
                delete_supply_row(
                    bu_code=bu_code,
                    channel_code=row.SalesChannelCode,
                    customer_code=row.CustomerCode,
                    item_no=source_item_no,
                    forecast_date=row.ForecastDate,
                    db=db,
                )
        except Exception:
            pass
        db.delete(row)

    db.commit()
    return {
        "moved":       moved,
        "skipped":     skipped,
        "overwritten": overwritten,
        "not_editable": not_editable_count,
    }


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_customer_filter(
    bu_code: str,
    all_customers: bool,
    user: User,
    db: Session,
) -> list[str] | None:
    """Returns None (no filter) or a list of allowed customer codes."""
    if all_customers:
        return None
    restrictions = db.query(UserCustomer).filter(
        UserCustomer.UserID           == user.UserID,
        UserCustomer.BusinessUnitCode == bu_code,
    ).all()
    return [r.CustomerCode for r in restrictions] if restrictions else None


def _fetch_source_rows(
    bu_code: str,
    source_item_no: str,
    date_from: date,
    date_to: date,
    forecast_type_codes: list[int],
    customer_filter: list[str] | None,
    db: Session,
) -> list:
    q = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode    == bu_code,
        ForecastData.ItemNo              == source_item_no,
        ForecastData.ForecastDate        >= date_from.replace(day=1),
        ForecastData.ForecastDate        <= date_to.replace(day=1),
        ForecastData.ForecastTypeCode.in_(forecast_type_codes),
    )
    if customer_filter is not None:
        q = q.filter(ForecastData.CustomerCode.in_(customer_filter))
    return q.order_by(ForecastData.ForecastTypeCode, ForecastData.ForecastDate, ForecastData.CustomerCode).all()
