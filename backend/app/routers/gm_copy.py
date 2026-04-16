"""
routers/gm_copy.py
Copy Sales forecast to GM forecast for an entire business unit.

Logic:
  1. Validate user has CanManageRefData (PowerUser+) permission
  2. Delete all existing GM rows for the BU within the date range
  3. Copy all rows from the source forecast type into GM, preserving all
     dimension values (customer, channel, item, price type, price, quantity)
  4. Return a summary of rows deleted and inserted
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import date
from pydantic import BaseModel
from typing import Optional
from app.db import get_db
from app.models import ForecastData, ForecastType, User, UserBusinessUnit
from app.auth.dev_auth import get_current_user
import datetime

router = APIRouter(prefix="/api/v1/gm-copy", tags=["GM Copy"])


class GmCopyRequest(BaseModel):
    source_forecast_type_code: int   # e.g. Sales type code
    target_forecast_type_code: int   # GM type code
    date_from: date
    date_to:   date


class GmCopyResult(BaseModel):
    deleted: int
    inserted: int
    bu_code:  str


@router.post("/{bu_code}", response_model=GmCopyResult)
def copy_sales_to_gm(
    bu_code:  str,
    payload:  GmCopyRequest,
    db:       Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Permission check — PowerUser or Admin only
    if not (current_user.role.CanManageRefData or current_user.role.CanManageUsers):
        raise HTTPException(403, detail="You do not have permission to copy forecast data.")

    # BU access check
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == current_user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not current_user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")

    # Validate forecast types exist
    source_ft = db.query(ForecastType).filter(ForecastType.Code == payload.source_forecast_type_code).first()
    target_ft = db.query(ForecastType).filter(ForecastType.Code == payload.target_forecast_type_code).first()
    if not source_ft:
        raise HTTPException(400, detail="Source forecast type not found.")
    if not target_ft:
        raise HTTPException(400, detail="Target forecast type not found.")
    if payload.source_forecast_type_code == payload.target_forecast_type_code:
        raise HTTPException(400, detail="Source and target forecast types must be different.")

    date_from = payload.date_from.replace(day=1)
    date_to   = payload.date_to.replace(day=1)

    # Step 1 — Delete existing target (GM) rows in the date range for this BU
    deleted = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode  == bu_code,
        ForecastData.ForecastTypeCode  == payload.target_forecast_type_code,
        ForecastData.ForecastDate      >= date_from,
        ForecastData.ForecastDate      <= date_to,
    ).delete(synchronize_session=False)

    # Step 2 — Fetch all source rows in the date range
    source_rows = db.query(ForecastData).filter(
        ForecastData.BusinessUnitCode  == bu_code,
        ForecastData.ForecastTypeCode  == payload.source_forecast_type_code,
        ForecastData.ForecastDate      >= date_from,
        ForecastData.ForecastDate      <= date_to,
    ).all()

    # Step 3 — Insert copies as target forecast type
    now = datetime.datetime.utcnow()
    inserted = 0
    for src in source_rows:
        new_row = ForecastData(
            BusinessUnitCode = src.BusinessUnitCode,
            ForecastTypeCode = payload.target_forecast_type_code,
            SalesChannelCode = src.SalesChannelCode,
            CustomerCode     = src.CustomerCode,
            ItemNo           = src.ItemNo,
            ForecastDate     = src.ForecastDate,
            PriceTypeCode    = src.PriceTypeCode,
            Price            = src.Price,
            Quantity         = src.Quantity,
            Notes            = src.Notes,
            CreatedBy        = current_user.UserID,
            CreatedDate      = now,
            ModifiedBy       = None,
            ModifiedDate     = None,
        )
        db.add(new_row)
        inserted += 1

    db.commit()

    return GmCopyResult(deleted=deleted, inserted=inserted, bu_code=bu_code)