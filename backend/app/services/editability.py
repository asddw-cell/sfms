"""
services/editability.py

Editability window: current month up to current month + HorizonMonthsForward.

HorizonMonthsForward is stored in tblRole.HorizonMonthsBack (column name retained
for backwards compatibility — semantics changed to forward-looking).
HorizonOverrideMonthsBack on tblUserBusinessUnit likewise now means
HorizonMonthsForward for a specific user/BU.

Examples with HorizonMonthsForward = 3:
  Today = March 2026 → editable: Mar, Apr, May, Jun 2026
  July 2026 and beyond → locked (too far ahead)
  February 2026 and before → locked (past)

Set HorizonMonthsForward = 0 to allow only the current month.
Set to a large number (e.g. 999) to allow unlimited future editing.
"""
from datetime import date
from dateutil.relativedelta import relativedelta
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.models import UserBusinessUnit, User


def _first_day_of_current_month() -> date:
    return date.today().replace(day=1)


def _table_exists(table_name: str, db: Session) -> bool:
    result = db.execute(text(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES "
        "WHERE TABLE_NAME = :t"
    ), {"t": table_name}).scalar()
    return result > 0


def _invoiced_actuals_exist(bu_code: str, forecast_date: date, db: Session) -> bool:
    """Returns False gracefully if tblActuals doesn't exist yet."""
    try:
        if not _table_exists("tblActuals", db):
            return False
        from app.models import Actuals
        month_start = forecast_date.replace(day=1)
        return db.query(Actuals).filter(
            Actuals.BusinessUnitCode == bu_code,
            Actuals.ActualsType      == "Invoiced",
            Actuals.ActualsDate      == month_start,
        ).first() is not None
    except Exception:
        return False


def _get_bu_assignment(user_id: int, bu_code: str, db: Session):
    """Returns None gracefully if tblUserBusinessUnit doesn't exist yet."""
    try:
        if not _table_exists("tblUserBusinessUnit", db):
            return None
        return db.query(UserBusinessUnit).filter(
            UserBusinessUnit.UserID           == user_id,
            UserBusinessUnit.BusinessUnitCode == bu_code,
        ).first()
    except Exception:
        return None


def check_editable(bu_code: str, forecast_date: date, user: User, db: Session) -> None:
    """
    Raises HTTP 403 if the forecast row is not editable.

    Editable window = current month  →  current month + HorizonMonthsForward

      1. Past month lock — always locked regardless of horizon
      2. Invoiced actuals lock
      3. BU assignment check
      4. Forward horizon check — locks periods beyond current month + N
    """
    current_month_start  = _first_day_of_current_month()
    forecast_month_start = forecast_date.replace(day=1)

    # 1 — Past month lock (absolute — no horizon can override this)
    if forecast_month_start < current_month_start:
        raise HTTPException(403, detail="Period is before the current month and cannot be edited.")

    # 2 — Invoiced actuals lock
    if _invoiced_actuals_exist(bu_code, forecast_month_start, db):
        raise HTTPException(403, detail="Invoiced actuals exist for this period — it is locked.")

    # 3 — BU assignment
    assignment = _get_bu_assignment(user.UserID, bu_code, db)
    if not assignment and not user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")

    # 4 — Minimum future distance check
    # HorizonMonthsBack = minimum number of months ahead of today a user can edit.
    # e.g. horizon=2 → earliest editable = current month + 2 (May if today is March)
    # e.g. horizon=0 → current month and beyond (original behaviour)
    horizon = (
        assignment.HorizonOverrideMonthsBack
        if assignment and assignment.HorizonOverrideMonthsBack is not None
        else user.role.HorizonMonthsBack
    )

    earliest_editable = current_month_start + relativedelta(months=horizon)
    if forecast_month_start < earliest_editable:
        raise HTTPException(
            403,
            detail=f"Period is within your editing horizon lock "
                   f"(earliest editable month is {earliest_editable.strftime('%B %Y')})."
        )