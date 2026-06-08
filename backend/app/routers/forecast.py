"""
routers/forecast.py
Forecast CRUD endpoints. GET enriches rows with ItemDescription from tblItem.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from datetime import date, datetime
from app.db import get_db
from app.models import ForecastData, Item, User, UserBusinessUnit
from app.schemas import ForecastRowOut, ForecastRowCreate, ForecastRowUpdate
from app.auth.dev_auth import get_current_user
from app.services.editability import check_editable
from app.services.supply_sync import sync_supply_row, delete_supply_row, _get_supply_type_code

router = APIRouter(prefix="/api/v1/forecast", tags=["Forecast"])

_SALES_TYPE_CODE_CACHE: int | None = None


def _get_sales_type_code(db) -> int:
    global _SALES_TYPE_CODE_CACHE
    if _SALES_TYPE_CODE_CACHE is not None:
        return _SALES_TYPE_CODE_CACHE
    from app.models import ForecastType
    ft = db.query(ForecastType).filter(
        ForecastType.Name == "Sales",
        ForecastType.IsActive == True,
    ).first()
    if ft:
        _SALES_TYPE_CODE_CACHE = ft.Code
    return _SALES_TYPE_CODE_CACHE


@router.get("/{bu_code}", response_model=list[ForecastRowOut])
def get_forecast(
    bu_code: str,
    forecast_type_code: int | None = Query(default=None),
    sales_channel_code: str | None = Query(default=None),
    customer_code:      str | None = Query(default=None),
    date_from:          date | None = Query(default=None),
    date_to:            date | None = Query(default=None),
    limit:  int = Query(default=5000, le=10000),
    offset: int = Query(default=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Access check
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == current_user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not current_user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")

    q = db.query(ForecastData).filter(ForecastData.BusinessUnitCode == bu_code)

    if forecast_type_code:
        q = q.filter(ForecastData.ForecastTypeCode == forecast_type_code)
    if sales_channel_code:
        q = q.filter(ForecastData.SalesChannelCode == sales_channel_code)
    if customer_code:
        q = q.filter(ForecastData.CustomerCode == customer_code)
    if date_from:
        q = q.filter(ForecastData.ForecastDate >= date_from)
    if date_to:
        q = q.filter(ForecastData.ForecastDate <= date_to)

    rows = q.order_by(
        ForecastData.ItemNo,
        ForecastData.ForecastDate,
    ).offset(offset).limit(limit).all()

    # Enrich rows with item descriptions and brand names via a single bulk lookup
    item_nos = list({r.ItemNo for r in rows})
    item_desc_map  = {}
    item_brand_map = {}
    if item_nos:
        items = db.query(Item).filter(
            Item.ItemNo.in_(item_nos),
        ).all()
        item_desc_map  = {i.ItemNo: i.Description for i in items}
        # Fetch brand names for all unique brand codes found on those items
        brand_codes = list({i.BrandCode for i in items})
        from app.models import Brand
        brands = db.query(Brand).filter(Brand.Code.in_(brand_codes)).all()
        brand_name_map = {b.Code: b.Name for b in brands}
        item_brand_map = {i.ItemNo: brand_name_map.get(i.BrandCode, i.BrandCode) for i in items}

    for row in rows:
        row.ItemDescription = item_desc_map.get(row.ItemNo, row.ItemNo)
        row.BrandName       = item_brand_map.get(row.ItemNo, '')

    return rows


@router.post("/{bu_code}", response_model=ForecastRowOut, status_code=201)
def create_forecast_row(
    bu_code: str,
    body: ForecastRowCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    check_editable(bu_code, body.ForecastDate, body.ForecastTypeCode, current_user, db)

    existing = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode == bu_code,
        ForecastData.ForecastTypeCode == body.ForecastTypeCode,
        ForecastData.SalesChannelCode == body.SalesChannelCode,
        ForecastData.CustomerCode     == body.CustomerCode,
        ForecastData.ItemNo           == body.ItemNo,
        ForecastData.ForecastDate     == body.ForecastDate.replace(day=1),
        ForecastData.PriceTypeCode    == body.PriceTypeCode if body.PriceTypeCode else ForecastData.PriceTypeCode.is_(None),
    ).first()
    if existing:
        raise HTTPException(409, detail="A forecast row with this combination already exists.")

    row = ForecastData(
        BusinessUnitCode = bu_code,
        ForecastTypeCode = body.ForecastTypeCode,
        SalesChannelCode = body.SalesChannelCode,
        CustomerCode     = body.CustomerCode,
        ItemNo           = body.ItemNo,
        ForecastDate     = body.ForecastDate.replace(day=1),
        PriceTypeCode    = body.PriceTypeCode,
        Price            = body.Price,
        Quantity         = body.Quantity,
        Notes            = body.Notes,
        CreatedBy        = current_user.UserID,
        CreatedDate      = datetime.utcnow(),
        ModifiedBy       = current_user.UserID,
        ModifiedDate     = datetime.utcnow(),
    )
    db.add(row)

    # Sync Supply row if this is a Sales forecast row
    try:
        sales_type_code = _get_sales_type_code(db)
        if sales_type_code and row.ForecastTypeCode == sales_type_code:
            sync_supply_row(row, db)
    except Exception:
        pass  # Supply type not yet configured — skip sync gracefully

    db.commit()
    db.refresh(row)

    # Enrich the newly created row with its description and brand name
    item = db.query(Item).filter(
        Item.ItemNo == row.ItemNo,
    ).first()
    from app.models import Brand
    brand = db.query(Brand).filter(Brand.Code == item.BrandCode).first() if item else None
    row.ItemDescription = item.Description if item else row.ItemNo
    row.BrandName       = brand.Name if brand else ''

    return row


@router.put("/{bu_code}/{entry_no}", response_model=ForecastRowOut)
def update_forecast_row(
    bu_code: str,
    entry_no: int,
    body: ForecastRowUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = db.query(ForecastData).filter(
        ForecastData.EntryNo == entry_no,
        ForecastData.BusinessUnitCode == bu_code,
    ).first()
    if not row:
        raise HTTPException(404, detail="Forecast row not found.")

    check_editable(bu_code, row.ForecastDate, row.ForecastTypeCode, current_user, db)

    row.Quantity     = body.Quantity
    if body.Price is not None:
        row.Price    = body.Price
    if body.PriceTypeCode is not None:
        row.PriceTypeCode = body.PriceTypeCode
    if body.Notes is not None:
        row.Notes    = body.Notes
    row.ModifiedBy   = current_user.UserID
    row.ModifiedDate = datetime.utcnow()

    # Sync Supply row if this is a Sales forecast row
    try:
        sales_type_code = _get_sales_type_code(db)
        if sales_type_code and row.ForecastTypeCode == sales_type_code:
            sync_supply_row(row, db)
    except Exception:
        pass

    db.commit()
    db.refresh(row)

    # Enrich with description and brand name
    item = db.query(Item).filter(
        Item.ItemNo == row.ItemNo,
    ).first()
    from app.models import Brand
    brand = db.query(Brand).filter(Brand.Code == item.BrandCode).first() if item else None
    row.ItemDescription = item.Description if item else row.ItemNo
    row.BrandName       = brand.Name if brand else ''

    return row


@router.delete("/{bu_code}/{entry_no}", status_code=204)
def delete_forecast_row(
    bu_code: str,
    entry_no: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = db.query(ForecastData).filter(
        ForecastData.EntryNo == entry_no,
        ForecastData.BusinessUnitCode == bu_code,
    ).first()
    if not row:
        raise HTTPException(404, detail="Forecast row not found.")

    check_editable(bu_code, row.ForecastDate, row.ForecastTypeCode, current_user, db)

    # Delete the matching Supply row if this is a Sales forecast row and
    # the period is outside the horizon (price-change flow)
    try:
        sales_type_code = _get_sales_type_code(db)
        if sales_type_code and row.ForecastTypeCode == sales_type_code:
            delete_supply_row(
                bu_code=bu_code,
                channel_code=row.SalesChannelCode,
                customer_code=row.CustomerCode,
                item_no=row.ItemNo,
                forecast_date=row.ForecastDate,
                price_type_code=row.PriceTypeCode,
                old_price=float(row.Price),
                db=db,
            )
    except Exception:
        pass

    db.delete(row)
    db.commit()
