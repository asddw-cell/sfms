"""
routers/item_migration.py

Endpoints for migrating forecast quantities between item variants.
Requires the CanMigrateItems role flag (Manager, PowerUser, Admin).

Registered before the forecast router in main.py so the
/api/v1/forecast/migrate-item/* paths are matched before
/api/v1/forecast/{bu_code}.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from datetime import date
from decimal import Decimal
from pydantic import BaseModel
from typing import Literal, Optional

from app.db import get_db
from app.models import User, UserBusinessUnit
from app.auth import get_current_user
from app.schemas import ItemOut
import app.services.item_migration as svc

router = APIRouter(prefix="/api/v1/forecast/migrate-item", tags=["Migrate Item"])


def _require_can_migrate(current_user: User) -> None:
    if not getattr(current_user.role, "CanMigrateItems", False):
        raise HTTPException(403, detail="Your role does not have permission to migrate items.")


def _validate_scope(all_customers: bool, customer_code) -> None:
    if not all_customers and not customer_code:
        raise HTTPException(400, detail="customer_code is required when all_customers is false.")


def _require_bu_access(bu_code: str, current_user: User, db: Session) -> None:
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID           == current_user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not current_user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")


# ── Request / Response models ──────────────────────────────────────────────────

class TypeCountRow(BaseModel):
    forecast_type_code: int
    name: str
    row_count: int
    customer_count: int


class TypeCountsRequest(BaseModel):
    bu_code: str
    source_item_no: str
    date_from: date
    date_to: date
    customer_code: Optional[str] = None
    all_customers: bool = False


class PreviewRow(BaseModel):
    entry_no: int
    forecast_type_code: int
    forecast_type_name: str
    sales_channel_code: str
    customer_code: str
    forecast_date: date
    quantity: Optional[Decimal] = None
    has_conflict: bool


class MigratePreviewRequest(BaseModel):
    bu_code: str
    source_item_no: str
    target_item_no: str
    date_from: date
    date_to: date
    forecast_type_codes: list[int]
    customer_code: Optional[str] = None
    all_customers: bool = False


class MigrateExecuteRequest(BaseModel):
    bu_code: str
    source_item_no: str
    target_item_no: str
    date_from: date
    date_to: date
    forecast_type_codes: list[int]
    customer_code: Optional[str] = None
    all_customers: bool = False
    on_conflict: Literal["skip", "overwrite"]


class MigrateResult(BaseModel):
    moved: int
    skipped: int
    overwritten: int
    not_editable: int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/targets", response_model=list[ItemOut])
def get_targets(
    bu_code:        str = Query(...),
    source_item_no: str = Query(...),
    db:             Session = Depends(get_db),
    current_user:   User    = Depends(get_current_user),
):
    """Returns items in the same brand as source_item_no that are valid migration targets."""
    _require_can_migrate(current_user)
    _require_bu_access(bu_code, current_user, db)
    return svc.get_migration_targets(bu_code, source_item_no, current_user, db)


@router.post("/type-counts", response_model=list[TypeCountRow])
def type_counts(
    body:         TypeCountsRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Returns forecast types and row counts for the source item in the given date range."""
    _require_can_migrate(current_user)
    _require_bu_access(body.bu_code, current_user, db)
    _validate_scope(body.all_customers, body.customer_code)
    return svc.get_type_counts(
        body.bu_code, body.source_item_no, body.date_from, body.date_to,
        body.customer_code, body.all_customers, db,
    )


@router.post("/preview", response_model=list[PreviewRow])
def preview_migration(
    body:         MigratePreviewRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Returns a preview of rows that would be migrated, flagging conflicts on the target item."""
    _require_can_migrate(current_user)
    _require_bu_access(body.bu_code, current_user, db)
    _validate_scope(body.all_customers, body.customer_code)
    return svc.get_migration_preview(
        body.bu_code, body.source_item_no, body.target_item_no,
        body.date_from, body.date_to, body.forecast_type_codes,
        body.customer_code, body.all_customers, current_user, db,
    )


@router.post("/execute", response_model=MigrateResult)
def execute_migration(
    body:         MigrateExecuteRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Moves forecast rows from source item to target item. Atomic — all rows committed together."""
    _require_can_migrate(current_user)
    _require_bu_access(body.bu_code, current_user, db)
    _validate_scope(body.all_customers, body.customer_code)
    return svc.execute_migration(
        body.bu_code, body.source_item_no, body.target_item_no,
        body.date_from, body.date_to, body.forecast_type_codes,
        body.customer_code, body.all_customers, body.on_conflict, current_user, db,
    )
