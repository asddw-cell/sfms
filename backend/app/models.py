"""
models.py - SQLAlchemy ORM models matching the SFMS SQL Server schema.
"""
from sqlalchemy import (
    Column, Integer, String, Numeric, Date, DateTime, Boolean,
    ForeignKey, CheckConstraint, ForeignKeyConstraint
)
from sqlalchemy.orm import relationship
from app.db import Base


class Currency(Base):
    __tablename__ = "tblCurrency"
    Code     = Column(String(3),  primary_key=True)
    Name     = Column(String(50), nullable=False)
    Symbol   = Column(String(5),  nullable=False)
    IsActive = Column(Boolean,    nullable=False, default=True)


class BusinessUnit(Base):
    __tablename__ = "tblBusinessUnit"
    Code         = Column(String(10),  primary_key=True)
    Name         = Column(String(100), nullable=False)
    CurrencyCode = Column(String(3),   ForeignKey("tblCurrency.Code"), nullable=False)
    IsActive     = Column(Boolean,     nullable=False, default=True)
    CreatedDate  = Column(DateTime,    nullable=False)
    ModifiedDate = Column(DateTime,    nullable=False)

    currency  = relationship("Currency")
    customers = relationship("Customer", back_populates="business_unit")


class ForecastType(Base):
    __tablename__ = "tblForecastType"
    Code        = Column(Integer,     primary_key=True, autoincrement=True)
    Name        = Column(String(100), nullable=False)
    Description = Column(String(500), nullable=True)
    IsActive    = Column(Boolean,     nullable=False, default=True)


class SalesChannel(Base):
    __tablename__ = "tblSalesChannel"
    Code     = Column(String(15),  primary_key=True)
    Name     = Column(String(100), nullable=False)
    IsActive = Column(Boolean,     nullable=False, default=True)


class Customer(Base):
    __tablename__ = "tblCustomer"
    Code             = Column(String(20),  primary_key=True, nullable=False)
    BusinessUnitCode = Column(String(10),  ForeignKey("tblBusinessUnit.Code"), primary_key=True, nullable=False)
    Name             = Column(String(200), nullable=False)
    CustomerGroup    = Column(String(100), nullable=True)
    IsActive         = Column(Boolean,     nullable=False, default=True)

    business_unit = relationship("BusinessUnit", back_populates="customers")


class Brand(Base):
    __tablename__ = "tblBrand"
    Code     = Column(String(25),  primary_key=True)
    Name     = Column(String(100), nullable=False)
    IsActive = Column(Boolean,     nullable=False, default=True)

    items = relationship("Item", back_populates="brand")


class Item(Base):
    __tablename__ = "tblItem"
    ItemNo        = Column(String(20),  primary_key=True, nullable=False)
    BrandCode     = Column(String(25),  ForeignKey("tblBrand.Code"), nullable=False)
    Description   = Column(String(300), nullable=False)
    UnitOfMeasure = Column(String(20),  nullable=True)
    IsActive      = Column(Boolean,     nullable=False, default=True)
    # Per-region availability flags — group derived from first 2 chars of BU code
    IsActive_UK   = Column(Boolean,     nullable=False, default=False)
    IsActive_EU   = Column(Boolean,     nullable=False, default=False)
    IsActive_US   = Column(Boolean,     nullable=False, default=False)
    IsActive_AU   = Column(Boolean,     nullable=False, default=False)
    IsActive_MX   = Column(Boolean,     nullable=False, default=False)

    brand = relationship("Brand", back_populates="items")


class PriceType(Base):
    __tablename__ = "tblPriceType"
    Code     = Column(Integer,     primary_key=True, autoincrement=True)
    Name     = Column(String(100), nullable=False)
    IsActive = Column(Boolean,     nullable=False, default=True)


class Role(Base):
    __tablename__ = "tblRole"
    Code              = Column(Integer,    primary_key=True, autoincrement=True)
    Name              = Column(String(50), nullable=False)
    HorizonMonthsBack = Column(Integer,    nullable=False, default=0)
    CanViewAllBU      = Column(Boolean,    nullable=False, default=False)
    CanManageUsers    = Column(Boolean,    nullable=False, default=False)
    CanManageRefData  = Column(Boolean,    nullable=False, default=False)
    CanLoadActuals    = Column(Boolean,    nullable=False, default=False)

    users = relationship("User", back_populates="role")


class User(Base):
    __tablename__ = "tblUser"
    UserID             = Column(Integer,     primary_key=True, autoincrement=True)
    Username           = Column(String(100), nullable=False, unique=True)
    DisplayName        = Column(String(200), nullable=False)
    Email              = Column(String(200), nullable=False)
    ExternalIdentityID = Column(String(100), nullable=False)
    RoleCode           = Column(Integer,     ForeignKey("tblRole.Code"), nullable=False)
    IsActive           = Column(Boolean,     nullable=False, default=True)
    CreatedDate        = Column(DateTime,    nullable=False)
    ModifiedDate       = Column(DateTime,    nullable=False)

    role           = relationship("Role",             back_populates="users")
    bu_assignments = relationship("UserBusinessUnit", back_populates="user",
                                  foreign_keys="UserBusinessUnit.UserID")


class UserBusinessUnit(Base):
    __tablename__ = "tblUserBusinessUnit"
    UserID                    = Column(Integer,    ForeignKey("tblUser.UserID"), primary_key=True, nullable=False)
    BusinessUnitCode          = Column(String(10), ForeignKey("tblBusinessUnit.Code"), primary_key=True, nullable=False)
    HorizonOverrideMonthsBack = Column(Integer,    nullable=True)
    AssignedDate              = Column(DateTime,   nullable=False)
    AssignedBy                = Column(Integer,    ForeignKey("tblUser.UserID"), nullable=False)
    ModifiedDate              = Column(DateTime,   nullable=True)
    ModifiedBy                = Column(Integer,    ForeignKey("tblUser.UserID"), nullable=True)

    user          = relationship("User",         back_populates="bu_assignments", foreign_keys=[UserID])
    business_unit = relationship("BusinessUnit")



class UserCustomer(Base):
    __tablename__ = "tblUserCustomer"
    UserID           = Column(Integer,    ForeignKey("tblUser.UserID"),           primary_key=True, nullable=False)
    BusinessUnitCode = Column(String(10), ForeignKey("tblBusinessUnit.Code"),     primary_key=True, nullable=False)
    CustomerCode     = Column(String(20),                                         primary_key=True, nullable=False)
    AssignedDate     = Column(DateTime,   nullable=False)
    AssignedBy       = Column(Integer,    ForeignKey("tblUser.UserID"),           nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(
            ["CustomerCode", "BusinessUnitCode"],
            ["tblCustomer.Code", "tblCustomer.BusinessUnitCode"],
        ),
    )

    customer = relationship("Customer", foreign_keys=[CustomerCode, BusinessUnitCode])


class ForecastData(Base):
    __tablename__ = "tblForecastData"
    EntryNo          = Column(Integer,       primary_key=True, autoincrement=True)
    BusinessUnitCode = Column(String(10),    ForeignKey("tblBusinessUnit.Code"), nullable=False)
    ForecastTypeCode = Column(Integer,       ForeignKey("tblForecastType.Code"), nullable=False)
    SalesChannelCode = Column(String(15),    ForeignKey("tblSalesChannel.Code"), nullable=False)
    CustomerCode     = Column(String(20),    nullable=False)
    ItemNo           = Column(String(20),    nullable=False)
    ForecastDate     = Column(Date,          nullable=False)
    PriceTypeCode    = Column(Integer,       ForeignKey("tblPriceType.Code"), nullable=True)
    Price            = Column(Numeric(18,4), nullable=False, default=0)
    Quantity         = Column(Numeric(18,4), nullable=False)
    Notes            = Column(String(500),   nullable=True)
    CreatedBy        = Column(Integer,       ForeignKey("tblUser.UserID"), nullable=False)
    CreatedDate      = Column(DateTime,      nullable=False)
    ModifiedBy       = Column(Integer,       ForeignKey("tblUser.UserID"), nullable=True)
    ModifiedDate     = Column(DateTime,      nullable=True)

    __table_args__ = (
        ForeignKeyConstraint(
            ["CustomerCode", "BusinessUnitCode"],
            ["tblCustomer.Code", "tblCustomer.BusinessUnitCode"]
        ),
        ForeignKeyConstraint(
            ["ItemNo"],
            ["tblItem.ItemNo"]
        ),
    )

    business_unit    = relationship("BusinessUnit")
    forecast_type    = relationship("ForecastType")
    sales_channel    = relationship("SalesChannel")
    price_type       = relationship("PriceType")
    created_by_user  = relationship("User", foreign_keys=[CreatedBy])
    modified_by_user = relationship("User", foreign_keys=[ModifiedBy])


class Actuals(Base):
    __tablename__ = "tblActuals"
    ActualsID        = Column(Integer,       primary_key=True, autoincrement=True)
    BusinessUnitCode = Column(String(10),    ForeignKey("tblBusinessUnit.Code"), nullable=False)
    ActualsType      = Column(String(20),    nullable=False)
    SalesChannelCode = Column(String(15),    ForeignKey("tblSalesChannel.Code"), nullable=False)
    CustomerCode     = Column(String(20),    nullable=False)
    ItemNo           = Column(String(20),    nullable=False)
    ActualsDate      = Column(Date,          nullable=False)
    Price            = Column(Numeric(18,4), nullable=False)
    Quantity         = Column(Numeric(18,4), nullable=False)
    LoadedDate       = Column(DateTime,      nullable=False)
    SourceReference  = Column(String(100),   nullable=True)

    __table_args__ = (
        # ActualsType constraint only — ActualsDate is NOT constrained to first-of-month
        # as actuals are loaded at invoice date level and aggregated to month at query time
        CheckConstraint("ActualsType IN ('Invoiced', 'OpenOrders')", name="CK_tblActuals_Type"),
        ForeignKeyConstraint(
            ["CustomerCode", "BusinessUnitCode"],
            ["tblCustomer.Code", "tblCustomer.BusinessUnitCode"]
        ),
        ForeignKeyConstraint(
            ["ItemNo"],
            ["tblItem.ItemNo"]
        ),
    )