"""
routers/changes.py
Change management screen — queries the SQL Server temporal history table
(tblForecastData_History) to surface both quantity and price changes.

Change types:
  - Quantity edit:  same EntryNo, quantity changed (LAG within EntryNo partition)
  - Price change:   new EntryNo for same business key, old row deleted (appears
                    in history with SysEndTime < current), new row in current table
  - New row:        first version of an EntryNo (QtyBefore IS NULL) — shown as
                    an insert with QtyBefore=0, PriceBefore=0
"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from datetime import date, datetime
from decimal import Decimal
from pydantic import BaseModel, ConfigDict
from typing import Optional
from app.db import get_db
from app.models import User, UserBusinessUnit
from app.auth import get_current_user

router = APIRouter(prefix="/api/v1/changes", tags=["Change Management"])


class ChangeRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    EntryNo:          int
    BusinessUnitCode: str
    SalesChannelCode: str
    CustomerCode:     str
    CustomerName:     Optional[str]
    ItemNo:           str
    ItemDescription:  Optional[str]
    ForecastDate:     date
    ChangedBy:        str
    ChangedAt:        datetime
    ChangeType:       str            # 'Quantity', 'Price', 'Override', 'New', 'Deleted'
    QtyBefore:        Optional[Decimal]
    QtyAfter:         Optional[Decimal]
    QtyDelta:         Optional[Decimal]
    PriceBefore:      Optional[Decimal]     # OverridePrice before change
    PriceAfter:       Optional[Decimal]     # OverridePrice after change
    IsPriceOverrideBefore: Optional[bool]
    IsPriceOverrideAfter:  Optional[bool]


@router.get("/{bu_code}", response_model=list[ChangeRow])
def get_changes(
    bu_code:            str,
    changed_from:       Optional[date] = Query(default=None),
    changed_to:         Optional[date] = Query(default=None),
    customer_code:      Optional[str]  = Query(default=None),
    item_no:            Optional[str]  = Query(default=None),
    forecast_type_code: Optional[int]  = Query(default=None),
    hide_system:        bool           = Query(default=True),
    limit: int = Query(default=200, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Check BU access
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == current_user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not current_user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")

    params: dict = {"bu": bu_code, "limit": limit}

    where_clauses      = ["f.BusinessUnitCode = :bu"]
    where_clauses_hist = ["h.BusinessUnitCode = :bu"]

    if changed_from:
        where_clauses.append("f.SysStartTime >= :changed_from")
        where_clauses_hist.append("h.SysStartTime >= :changed_from")
        params["changed_from"] = changed_from
    if changed_to:
        # Add 1 day so "to" date is inclusive of the full day
        where_clauses.append("f.SysStartTime < DATEADD(day, 1, :changed_to)")
        where_clauses_hist.append("h.SysStartTime < DATEADD(day, 1, :changed_to)")
        params["changed_to"] = changed_to
    if customer_code:
        where_clauses.append("f.CustomerCode = :customer_code")
        where_clauses_hist.append("h.CustomerCode = :customer_code")
        params["customer_code"] = customer_code
    if item_no:
        where_clauses.append("f.ItemNo LIKE :item_no")
        where_clauses_hist.append("h.ItemNo LIKE :item_no")
        params["item_no"] = f"%{item_no}%"

    if forecast_type_code is not None:
        where_clauses.append("f.ForecastTypeCode = :forecast_type_code")
        where_clauses_hist.append("h.ForecastTypeCode = :forecast_type_code")
        params["forecast_type_code"] = forecast_type_code

    if hide_system:
        system_user = db.query(User).filter(User.Username == 'system').first()
        if system_user:
            where_clauses.append("f.ModifiedBy != :system_user_id")
            where_clauses_hist.append("h.ModifiedBy != :system_user_id")
            params["system_user_id"] = system_user.UserID

    where_sql      = " AND ".join(where_clauses)
    where_sql_hist = " AND ".join(where_clauses_hist)

    sql = text(f"""
        WITH AllVersions AS (
            -- Current live rows
            SELECT
                f.EntryNo,
                f.BusinessUnitCode,
                f.ForecastTypeCode,
                f.SalesChannelCode,
                f.CustomerCode,
                f.ItemNo,
                f.ForecastDate,
                f.Quantity,
                f.OverridePrice,
                f.IsPriceOverride,
                f.Notes,
                f.CreatedBy,
                f.CreatedDate,
                f.ModifiedBy,
                f.SysStartTime,
                f.SysEndTime,
                0 AS IsHistory
            FROM tblForecastData f
            WHERE {where_sql}

            UNION ALL

            -- All historical versions
            SELECT
                h.EntryNo,
                h.BusinessUnitCode,
                h.ForecastTypeCode,
                h.SalesChannelCode,
                h.CustomerCode,
                h.ItemNo,
                h.ForecastDate,
                h.Quantity,
                h.OverridePrice,
                h.IsPriceOverride,
                h.Notes,
                h.CreatedBy,
                h.CreatedDate,
                h.ModifiedBy,
                h.SysStartTime,
                h.SysEndTime,
                1 AS IsHistory
            FROM tblForecastData_History h
            WHERE {where_sql_hist}
        ),

        -- Detect quantity/price edits: same EntryNo, value changed from previous version
        QtyPriceEdits AS (
            SELECT
                av.EntryNo,
                av.BusinessUnitCode,
                av.SalesChannelCode,
                av.CustomerCode,
                av.ItemNo,
                av.ForecastDate,
                av.Quantity                                                            AS QtyAfter,
                LAG(av.Quantity)        OVER (PARTITION BY av.EntryNo ORDER BY av.SysStartTime) AS QtyBefore,
                av.OverridePrice                                                       AS PriceAfter,
                LAG(av.OverridePrice)   OVER (PARTITION BY av.EntryNo ORDER BY av.SysStartTime) AS PriceBefore,
                av.IsPriceOverride                                                     AS IsPriceOverrideAfter,
                LAG(av.IsPriceOverride) OVER (PARTITION BY av.EntryNo ORDER BY av.SysStartTime) AS IsPriceOverrideBefore,
                av.ModifiedBy,
                av.SysStartTime                                                        AS ChangedAt
            FROM AllVersions av
        ),

        -- Classify changes
        AllChanges AS (
            SELECT
                EntryNo, BusinessUnitCode, SalesChannelCode, CustomerCode,
                ItemNo, ForecastDate, ModifiedBy, ChangedAt,
                CASE
                    WHEN QtyBefore IS NULL                                                THEN 'New'
                    WHEN PriceAfter <> PriceBefore AND QtyAfter  = QtyBefore              THEN 'Price'
                    WHEN PriceAfter <> PriceBefore AND QtyAfter <> QtyBefore              THEN 'Price + Qty'
                    WHEN IsPriceOverrideAfter <> IsPriceOverrideBefore                    THEN 'Override'
                    ELSE 'Quantity'
                END AS ChangeType,
                ISNULL(QtyBefore,    0) AS QtyBefore,
                QtyAfter,
                QtyAfter - ISNULL(QtyBefore, 0) AS QtyDelta,
                PriceBefore,
                PriceAfter,
                IsPriceOverrideBefore,
                IsPriceOverrideAfter
            FROM QtyPriceEdits
            WHERE QtyBefore IS NULL                                  -- new row inserts
               OR QtyAfter             <> QtyBefore                  -- qty changed
               OR ISNULL(PriceAfter,0) <> ISNULL(PriceBefore,0)     -- override price changed
               OR IsPriceOverrideAfter <> IsPriceOverrideBefore      -- override flag toggled
        )

        SELECT TOP (:limit)
            ac.EntryNo,
            ac.BusinessUnitCode,
            ac.SalesChannelCode,
            ac.CustomerCode,
            c.Name                          AS CustomerName,
            ac.ItemNo,
            i.Description                   AS ItemDescription,
            ac.ForecastDate,
            ISNULL(u.DisplayName, CAST(ac.ModifiedBy AS NVARCHAR)) AS ChangedBy,
            ac.ChangedAt,
            ac.ChangeType,
            ac.QtyBefore,
            ac.QtyAfter,
            ac.QtyDelta,
            ac.PriceBefore,
            ac.PriceAfter,
            ac.IsPriceOverrideBefore,
            ac.IsPriceOverrideAfter
        FROM AllChanges ac
        LEFT JOIN tblUser     u ON u.UserID           = ac.ModifiedBy
        LEFT JOIN tblCustomer c ON c.Code             = ac.CustomerCode
                                AND c.BusinessUnitCode = ac.BusinessUnitCode
        LEFT JOIN tblItem     i ON i.ItemNo            = ac.ItemNo
        ORDER BY ac.ChangedAt DESC
    """)

    rows = db.execute(sql, params).fetchall()

    return [
        ChangeRow(
            EntryNo                = r.EntryNo,
            BusinessUnitCode       = r.BusinessUnitCode,
            SalesChannelCode       = r.SalesChannelCode,
            CustomerCode           = r.CustomerCode,
            CustomerName           = r.CustomerName,
            ItemNo                 = r.ItemNo,
            ItemDescription        = r.ItemDescription,
            ForecastDate           = r.ForecastDate,
            ChangedBy              = r.ChangedBy,
            ChangedAt              = r.ChangedAt,
            ChangeType             = r.ChangeType,
            QtyBefore              = Decimal(str(r.QtyBefore))   if r.QtyBefore   is not None else None,
            QtyAfter               = Decimal(str(r.QtyAfter))    if r.QtyAfter    is not None else None,
            QtyDelta               = Decimal(str(r.QtyDelta))    if r.QtyDelta    is not None else None,
            PriceBefore            = Decimal(str(r.PriceBefore)) if r.PriceBefore is not None else None,
            PriceAfter             = Decimal(str(r.PriceAfter))  if r.PriceAfter  is not None else None,
            IsPriceOverrideBefore  = bool(r.IsPriceOverrideBefore) if r.IsPriceOverrideBefore is not None else None,
            IsPriceOverrideAfter   = bool(r.IsPriceOverrideAfter)  if r.IsPriceOverrideAfter  is not None else None,
        )
        for r in rows
    ]