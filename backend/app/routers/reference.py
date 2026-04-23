"""
routers/reference.py
Read-only reference data endpoints consumed by the forecast grid dropdowns.
tblForecastCycle removed from schema - cycles endpoint removed.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from app.db import get_db
from app.models import (
    BusinessUnit, ForecastType, SalesChannel, Customer,
    Brand, Item, PriceType, Currency, UserCustomer, UserBusinessUnit, Role
)
from app.schemas import (
    BusinessUnitOut, ForecastTypeOut, SalesChannelOut, CustomerOut,
    BrandOut, ItemOut, PriceTypeOut, CurrencyOut, RoleOut
)
from app.auth.dev_auth import get_current_user
from app.models import User

router = APIRouter(prefix="/api/v1/reference", tags=["Reference Data"])


@router.get("/business-units", response_model=list[BusinessUnitOut])
def list_business_units(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(BusinessUnit).filter(BusinessUnit.IsActive == True).all()


@router.get("/currencies", response_model=list[CurrencyOut])
def list_currencies(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(Currency).filter(Currency.IsActive == True).all()


@router.get("/forecast-types", response_model=list[ForecastTypeOut])
def list_forecast_types(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(ForecastType).filter(ForecastType.IsActive == True).all()


@router.get("/sales-channels", response_model=list[SalesChannelOut])
def list_sales_channels(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(SalesChannel).filter(SalesChannel.IsActive == True).all()


@router.get("/customers/{bu_code}", response_model=list[CustomerOut])
def list_customers(
    bu_code: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Check if this user has specific customer restrictions for this BU
    restrictions = db.query(UserCustomer).filter(
        UserCustomer.UserID == current_user.UserID,
        UserCustomer.BusinessUnitCode == bu_code,
    ).all()

    q = db.query(Customer).filter(
        Customer.BusinessUnitCode == bu_code,
        Customer.IsActive == True,
    )

    if restrictions:
        # User has restrictions — only return assigned customers
        allowed_codes = [r.CustomerCode for r in restrictions]
        q = q.filter(Customer.Code.in_(allowed_codes))

    return q.order_by(Customer.Name).all()


@router.get("/brands", response_model=list[BrandOut])
def list_brands(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(Brand).filter(Brand.IsActive == True).order_by(Brand.Name).all()


# Map the first 2 characters of a BU code to the corresponding IsActive column
_REGION_COLUMN_MAP = {
    "UK": Item.IsActive_UK,
    "EU": Item.IsActive_EU,
    "US": Item.IsActive_US,
    "AU": Item.IsActive_AU,
    "MX": Item.IsActive_MX,
}

def _region_active_column(bu_code: str):
    group = bu_code[:2].upper()
    return _REGION_COLUMN_MAP.get(group)


@router.get("/items/{bu_code}", response_model=list[ItemOut])
def list_items(
    bu_code: str,
    brand_code: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    region_col = _region_active_column(bu_code)

    # Filter by regional availability only — IsActive is deprecated
    if region_col is not None:
        q = db.query(Item).filter(region_col == True)
    else:
        q = db.query(Item)

    if brand_code:
        q = q.filter(Item.BrandCode == brand_code)

    return q.order_by(Item.Description).all()


@router.get("/price-types", response_model=list[PriceTypeOut])
def list_price_types(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(PriceType).filter(PriceType.IsActive == True).all()

@router.get("/roles", response_model=list[RoleOut])
def list_roles(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(Role).order_by(Role.Name).all()