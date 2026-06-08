"""
schemas.py - Pydantic v2 request and response schemas.
"""
from pydantic import BaseModel, ConfigDict
from datetime import datetime
from typing import Optional
from datetime import date, datetime
from decimal import Decimal


class ORMBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ── Reference data ─────────────────────────────────────────────────────────────
class CurrencyOut(ORMBase):
    Code: str
    Name: str
    Symbol: str
    IsActive: bool

class BusinessUnitOut(ORMBase):
    Code: str
    Name: str
    CurrencyCode: str
    IsActive: bool

class ForecastTypeOut(ORMBase):
    Code: int
    Name: str
    Description: Optional[str]
    IsActive: bool

class SalesChannelOut(ORMBase):
    Code: str
    Name: str
    IsActive: bool

class CustomerOut(ORMBase):
    Code: str
    BusinessUnitCode: str
    Name: str
    CustomerGroup: Optional[str]
    IsActive: bool

class BrandOut(ORMBase):
    Code: str
    Name: str
    IsActive: bool

class ItemOut(ORMBase):
    ItemNo:        str
    BrandCode:     str
    Description:   str
    UnitOfMeasure: Optional[str]
    IsActive:      bool
    IsActive_UK:   bool
    IsActive_EU:   bool
    IsActive_US:   bool
    IsActive_AU:   bool
    IsActive_MX:   bool

class PriceTypeOut(ORMBase):
    Code: int
    Name: str
    IsActive: bool


# ── Roles & Users ──────────────────────────────────────────────────────────────
class RoleOut(ORMBase):
    Code: int
    Name: str
    HorizonMonthsBack: int
    CanViewAllBU: bool
    CanManageUsers: bool
    CanManageRefData: bool
    CanLoadActuals: bool
    CanEditSupplyForecast: bool

class CustomerAssignmentOut(ORMBase):
    CustomerCode: str
    BusinessUnitCode: str

class BUAssignmentOut(ORMBase):
    BusinessUnitCode: str
    HorizonOverrideMonthsBack: Optional[int] = None
    customer_assignments: list[CustomerAssignmentOut] = []

class UserOut(ORMBase):
    UserID: int
    Username: str
    DisplayName: str
    Email: str
    RoleCode: int
    RoleName: Optional[str] = None
    IsActive: bool

class MeOut(ORMBase):
    UserID: int
    Username: str
    DisplayName: str
    Email: str
    IsActive: bool
    role: RoleOut
    bu_assignments: list[BUAssignmentOut]

# ── Admin / User Management ────────────────────────────────────────────────────

class UserCreateRequest(BaseModel):
    Username: str
    DisplayName: str
    Email: str
    ExternalIdentityID: str = ""
    RoleCode: int
    IsActive: bool = True

class UserUpdateRequest(BaseModel):
    DisplayName: Optional[str] = None
    Email: Optional[str] = None
    RoleCode: Optional[int] = None
    IsActive: Optional[bool] = None

class BUAssignRequest(BaseModel):
    BusinessUnitCode: str
    HorizonOverrideMonthsBack: Optional[int] = None

class CustomerAssignRequest(BaseModel):
    CustomerCodes: list[str]  # full replacement — empty list = unrestricted (see all)

class UserAdminOut(ORMBase):
    UserID: int
    Username: str
    DisplayName: str
    Email: str
    RoleCode: int
    RoleName: Optional[str] = None
    IsActive: bool
    CreatedDate: datetime
    ModifiedDate: datetime
    bu_assignments: list[BUAssignmentOut] = []


# ── Forecast Data ──────────────────────────────────────────────────────────────
class ForecastRowOut(ORMBase):
    EntryNo:          int
    BusinessUnitCode: str
    ForecastTypeCode: int
    SalesChannelCode: str
    CustomerCode:     str
    ItemNo:           str
    ItemDescription:  Optional[str] = None   # joined from tblItem
    BrandName:        Optional[str] = None   # joined from tblItem → tblBrand
    ForecastDate:     date
    PriceTypeCode:    int
    Price:            Decimal
    Quantity:         Decimal
    Notes:            Optional[str]
    CreatedBy:        int
    CreatedDate:      datetime
    ModifiedBy:       Optional[int]
    ModifiedDate:     Optional[datetime]

class ForecastRowCreate(BaseModel):
    ForecastTypeCode: int
    SalesChannelCode: str
    CustomerCode:     str
    ItemNo:           str
    ForecastDate:     date
    PriceTypeCode:    Optional[int]     = None
    Price:            Optional[Decimal] = Decimal('0')
    Quantity:         Decimal
    Notes:            Optional[str]     = None

class ForecastRowUpdate(BaseModel):
    Quantity:      Decimal
    Price:         Optional[Decimal] = None
    PriceTypeCode: Optional[int]     = None
    Notes:         Optional[str]     = None


# ── Actuals ────────────────────────────────────────────────────────────────────
class ActualsRowOut(ORMBase):
    ActualsID:        int
    BusinessUnitCode: str
    ActualsType:      str
    SalesChannelCode: str
    CustomerCode:     str
    ItemNo:           str
    ActualsDate:      date
    Price:            Decimal
    Quantity:         Decimal
    LoadedDate:       datetime


# ── Comparison view ────────────────────────────────────────────────────────────
class ComparisonRow(BaseModel):
    ItemNo:           str
    Description:      str
    BrandName:        Optional[str] = None
    CustomerCode:     str
    CustomerName:     str
    SalesChannelCode: str
    ForecastDate:     date
    ForecastQty:      Optional[Decimal]
    ForecastPrice:    Optional[Decimal]
    ActualsQty:       Optional[Decimal]
    ActualsPrice:      Optional[Decimal]
    ActualsTotalValue: Optional[Decimal]
    ActualsType:      Optional[str]
    QtyVariance:      Optional[Decimal]
    QtyVariancePct:   Optional[Decimal]


# ── Supply Horizon ─────────────────────────────────────────────────────────────
class SupplyHorizonOut(ORMBase):
    HorizonID:        int
    BusinessUnitCode: str
    SalesChannelCode: str
    HorizonMonths:    int
    IsActive:         bool

class SupplyHorizonCreate(BaseModel):
    BusinessUnitCode: str
    SalesChannelCode: str
    HorizonMonths:    int

class SupplyHorizonUpdate(BaseModel):
    HorizonMonths: Optional[int] = None
    IsActive:      Optional[bool] = None


# ── Last Year Actuals ──────────────────────────────────────────────────────────
class LYActualsRow(BaseModel):
    ItemNo:            str
    ItemDescription:   str
    BrandName:         Optional[str] = None
    SalesChannelCode:  str
    ActualsDate:       date   # original last-year date — frontend shifts +12 months
    ActualsQty:        Decimal
    ActualsTotalValue: Decimal