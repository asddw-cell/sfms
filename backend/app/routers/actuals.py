"""
routers/actuals.py
Actuals and comparison view.
Actuals are stored at invoice-date level and aggregated to month at query time.
Multiple rows per item/month (e.g. multiple invoices, credit notes) are summed.
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from datetime import date
from decimal import Decimal
from app.db import get_db
from app.models import Actuals, ForecastData, Item, Customer, UserBusinessUnit, User
from app.schemas import ActualsRowOut, ComparisonRow, LYActualsRow
from app.auth import get_current_user

router = APIRouter(tags=["Actuals & Comparison"])


def _check_bu_access(bu_code: str, user: User, db: Session) -> None:
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")


@router.get("/api/v1/actuals/{bu_code}", response_model=list[ActualsRowOut])
def get_actuals(
    bu_code: str,
    actuals_type:  str | None  = Query(default=None),
    date_from:     date | None = Query(default=None),
    date_to:       date | None = Query(default=None),
    customer_code: str | None  = Query(default=None),
    limit:  int = Query(default=500, le=2000),
    offset: int = Query(default=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _check_bu_access(bu_code, current_user, db)

    q = db.query(Actuals).filter(Actuals.BusinessUnitCode == bu_code)
    if actuals_type:
        q = q.filter(Actuals.ActualsType == actuals_type)
    if date_from:
        q = q.filter(Actuals.ActualsDate >= date_from)
    if date_to:
        q = q.filter(Actuals.ActualsDate <= date_to)
    if customer_code:
        q = q.filter(Actuals.CustomerCode == customer_code)

    return q.order_by(Actuals.ActualsDate, Actuals.ItemNo).offset(offset).limit(limit).all()


@router.get("/api/v1/comparison/{bu_code}", response_model=list[ComparisonRow])
def get_comparison(
    bu_code:            str,
    customer_code:      str        = Query(...),
    date_from:          date | None = Query(default=None),
    date_to:            date | None = Query(default=None),
    forecast_type_code: int | None  = Query(default=None),
    sales_channel_code: str | None  = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Returns side-by-side forecast vs actuals rows with variance.
    Actuals are aggregated to month (truncated from invoice date) and summed,
    so multiple invoices and credit notes within a month net off correctly.
    """
    _check_bu_access(bu_code, current_user, db)

    # ── Forecast rows ──────────────────────────────────────────────────────────
    fq = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode == bu_code,
        ForecastData.CustomerCode     == customer_code,
    )
    if forecast_type_code:
        fq = fq.filter(ForecastData.ForecastTypeCode == forecast_type_code)
    if sales_channel_code:
        fq = fq.filter(ForecastData.SalesChannelCode == sales_channel_code)
    if date_from:
        fq = fq.filter(ForecastData.ForecastDate >= date_from)
    if date_to:
        fq = fq.filter(ForecastData.ForecastDate <= date_to)
    forecast_rows = fq.all()

    # ── Actuals aggregated to month via raw SQL ───────────────────────────────
    # Using raw SQL avoids SQLAlchemy re-parameterising DATEFROMPARTS differently
    # in SELECT vs GROUP BY, which causes an "invalid in select list" error.
    # Quantities are summed so multiple invoices and credit notes net off correctly.
    from sqlalchemy import text as sa_text

    params: dict = {"bu": bu_code, "cust": customer_code}
    date_filters = ""
    if date_from:
        date_filters += " AND ActualsDate >= :date_from"
        params["date_from"] = date_from
    if date_to:
        date_filters += " AND ActualsDate <= :date_to"
        params["date_to"] = date_to
    channel_filter = ""
    if sales_channel_code:
        channel_filter = " AND SalesChannelCode = :channel"
        params["channel"] = sales_channel_code

    sql = sa_text(f"""
        SELECT
            ItemNo,
            ActualsType,
            SalesChannelCode,
            DATEFROMPARTS(YEAR(ActualsDate), MONTH(ActualsDate), 1) AS ActualsMonth,
            SUM(Quantity)           AS TotalQty,
            AVG(Price)              AS AvgPrice,
            SUM(Quantity * Price)   AS TotalValue
        FROM tblActuals
        WHERE BusinessUnitCode = :bu
          AND CustomerCode     = :cust
          {date_filters}
          {channel_filter}
        GROUP BY
            ItemNo,
            ActualsType,
            SalesChannelCode,
            DATEFROMPARTS(YEAR(ActualsDate), MONTH(ActualsDate), 1)
    """)

    actuals_agg = db.execute(sql, params).fetchall()

    # ── Build lookup dicts ─────────────────────────────────────────────────────
    # Forecast keyed by (ItemNo, ForecastDate) — ForecastDate already first-of-month
    forecast_map: dict[tuple, ForecastData] = {}
    for f in forecast_rows:
        key = (f.ItemNo, f.ForecastDate)
        forecast_map[key] = f

    # Actuals keyed by (ItemNo, ActualsMonth) — aggregated
    # Raw SQL rows support attribute-style access by column name
    actuals_map: dict[tuple, dict] = {}
    for a in actuals_agg:
        key = (a.ItemNo, a.ActualsMonth)
        actuals_map[key] = {
            "qty":         Decimal(str(a.TotalQty)),
            "price":       Decimal(str(a.AvgPrice)),
            "total_value": Decimal(str(a.TotalValue)),
            "type":        a.ActualsType,
            "channelCode": a.SalesChannelCode,
        }

    # ── Merge keys ─────────────────────────────────────────────────────────────
    all_keys = set(forecast_map.keys()) | set(actuals_map.keys())

    # Bulk load all items and customer needed for this result set — one query each,
    # no per-row fallback. BrandCode join done in the same pass.
    from app.models import Brand
    all_item_nos = list({k[0] for k in all_keys})

    items_bulk = db.query(Item).filter(Item.ItemNo.in_(all_item_nos)).all()
    item_cache: dict[str, Item] = {i.ItemNo: i for i in items_bulk}

    brand_codes = list({i.BrandCode for i in items_bulk if i.BrandCode})
    brands_list = db.query(Brand).filter(Brand.Code.in_(brand_codes)).all()
    brand_name_map = {b.Code: b.Name for b in brands_list}

    customer_obj = db.query(Customer).filter(
        Customer.Code == customer_code,
        Customer.BusinessUnitCode == bu_code,
    ).first()
    customer_cache: dict[str, Customer] = {customer_code: customer_obj}

    results: list[ComparisonRow] = []
    for item_no, period_date in sorted(all_keys):
        f = forecast_map.get((item_no, period_date))
        a = actuals_map.get((item_no, period_date))

        item     = item_cache.get(item_no)
        customer = customer_cache.get(customer_code)

        fqty     = Decimal(str(f.Quantity)) if f else None
        aqty     = a["qty"] if a else None
        variance = (aqty - fqty) if (fqty is not None and aqty is not None) else None
        variance_pct = (
            (variance / aqty * 100).quantize(Decimal("0.01"))
            if (variance is not None and aqty and aqty != 0)
            else None
        )

        results.append(ComparisonRow(
            ItemNo           = item_no,
            Description      = item.Description if item else item_no,
            BrandName        = brand_name_map.get(item.BrandCode) if item else None,
            CustomerCode     = customer_code,
            CustomerName     = customer.Name if customer else customer_code,
            SalesChannelCode = f.SalesChannelCode if f else (a["channelCode"] if a else ""),
            ForecastDate     = period_date,
            ForecastQty      = fqty,
            ForecastPrice    = Decimal(str(f.Price)) if f else None,
            ActualsQty       = aqty,
            ActualsPrice     = a["price"]       if a else None,
            ActualsTotalValue = a["total_value"] if a else None,
            ActualsType      = a["type"] if a else None,
            QtyVariance      = variance,
            QtyVariancePct   = variance_pct,
        ))

    return results


@router.get("/api/v1/actuals/{bu_code}/last-year", response_model=list[LYActualsRow])
def get_last_year_actuals(
    bu_code:            str,
    customer_code:      str        = Query(...),
    date_from:          date | None = Query(default=None),
    date_to:            date | None = Query(default=None),
    sales_channel_code: str | None  = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Returns last year's invoiced actuals aggregated by item/month.
    date_from/date_to are the current display range — the endpoint shifts them
    back 12 months internally so the frontend always passes the current range.
    ActualsDate in each response row is the original (last-year) date;
    the frontend maps it forward by 12 months to get the display month key.
    """
    _check_bu_access(bu_code, current_user, db)

    from dateutil.relativedelta import relativedelta
    from sqlalchemy import text as sa_text
    from app.models import Brand

    ly_date_from = (date_from - relativedelta(months=12)) if date_from else None
    ly_date_to   = (date_to   - relativedelta(months=12)) if date_to   else None

    params: dict = {"bu": bu_code, "cust": customer_code}
    date_filters  = ""
    channel_filter = ""
    if ly_date_from:
        date_filters += " AND ActualsDate >= :date_from"
        params["date_from"] = ly_date_from
    if ly_date_to:
        date_filters += " AND ActualsDate <= :date_to"
        params["date_to"] = ly_date_to
    if sales_channel_code:
        channel_filter = " AND SalesChannelCode = :channel"
        params["channel"] = sales_channel_code

    sql = sa_text(f"""
        SELECT
            ItemNo,
            SalesChannelCode,
            DATEFROMPARTS(YEAR(ActualsDate), MONTH(ActualsDate), 1) AS ActualsMonth,
            SUM(Quantity)           AS TotalQty,
            SUM(Quantity * Price)   AS TotalValue
        FROM tblActuals
        WHERE BusinessUnitCode = :bu
          AND CustomerCode     = :cust
          AND ActualsType      = 'Invoiced'
          {date_filters}
          {channel_filter}
        GROUP BY
            ItemNo,
            SalesChannelCode,
            DATEFROMPARTS(YEAR(ActualsDate), MONTH(ActualsDate), 1)
    """)

    actuals_agg = db.execute(sql, params).fetchall()
    if not actuals_agg:
        return []

    all_item_nos = list({row.ItemNo for row in actuals_agg})
    items_bulk   = db.query(Item).filter(Item.ItemNo.in_(all_item_nos)).all()
    item_cache   = {i.ItemNo: i for i in items_bulk}

    brand_codes    = list({i.BrandCode for i in items_bulk if i.BrandCode})
    brands_list    = db.query(Brand).filter(Brand.Code.in_(brand_codes)).all()
    brand_name_map = {b.Code: b.Name for b in brands_list}

    results: list[LYActualsRow] = []
    for row in actuals_agg:
        item = item_cache.get(row.ItemNo)
        results.append(LYActualsRow(
            ItemNo            = row.ItemNo,
            ItemDescription   = item.Description if item else row.ItemNo,
            BrandName         = brand_name_map.get(item.BrandCode) if item else None,
            SalesChannelCode  = row.SalesChannelCode,
            ActualsDate       = row.ActualsMonth,
            ActualsQty        = Decimal(str(row.TotalQty)),
            ActualsTotalValue = Decimal(str(row.TotalValue)),
        ))

    return results