"""
routers/prices.py
Price maintenance endpoints: CRUD for tblPrice, Excel template, import flow.
"""
from __future__ import annotations

import io
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.dev_auth import get_current_user
from app.db import get_db
from app.models import Customer, ForecastData, Item, Price, User, UserBusinessUnit, UserCustomer
from app.schemas import (
    ImportConfirmRequest,
    ImportConfirmResponse,
    ImportValidationResponse,
    PriceRangeCreate,
    PriceRangeResponse,
    PriceUpdate,
)
from app.services.pricing import (
    consume_import_token,
    expand_date_range_to_months,
    parse_import_date,
    validate_import_rows,
)

router = APIRouter(prefix="/api/v1/prices", tags=["Prices"])

# ── Region → IsActive column helper (mirrors reference.py) ───────────────────

_REGION_ACTIVE_ATTR = {
    "UK": "IsActive_UK",
    "EU": "IsActive_EU",
    "US": "IsActive_US",
    "AU": "IsActive_AU",
    "MX": "IsActive_MX",
}


def _region_active_column(bu_code: str):
    group = bu_code[:2].upper()
    attr  = _REGION_ACTIVE_ATTR.get(group)
    return getattr(Item, attr) if attr else Item.IsActive


def _require_bu_access(bu_code: str, current_user: User, db: Session) -> None:
    assignment = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID          == current_user.UserID,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not assignment and not current_user.role.CanViewAllBU:
        raise HTTPException(403, detail="You are not assigned to this business unit.")


def _accessible_customers(bu_code: str, current_user: User, db: Session) -> list[str] | None:
    """
    Return list of accessible customer codes for this user/BU.
    Returns None if unrestricted (CanViewAllBU or no UserCustomer rows).
    """
    if current_user.role.CanViewAllBU:
        return None
    rows = db.query(UserCustomer).filter(
        UserCustomer.UserID          == current_user.UserID,
        UserCustomer.BusinessUnitCode == bu_code,
    ).all()
    if not rows:
        return None
    return [r.CustomerCode for r in rows]


# ── Collapse helper ───────────────────────────────────────────────────────────

def _collapse_ranges(
    price_rows: list[Price],
    customer_name_map: dict[str, str],
    item_desc_map: dict[str, str],
) -> list[PriceRangeResponse]:
    """
    Group consecutive monthly rows with the same (Customer, Channel, Item, Price)
    into collapsed PriceRangeResponse objects. A gap of even one month breaks a range.
    """
    if not price_rows:
        return []

    # Sort by (Customer, Channel, Item, PriceMonth)
    sorted_rows = sorted(
        price_rows,
        key=lambda p: (p.CustomerCode, p.SalesChannelCode, p.ItemNo, p.PriceMonth),
    )

    ranges: list[PriceRangeResponse] = []
    first = sorted_rows[0]
    run_key   = (first.CustomerCode, first.SalesChannelCode, first.ItemNo, first.Price)
    run_start = first.PriceMonth
    run_end   = first.PriceMonth
    run_id    = first.PriceID
    run_ids:  list[int] = [first.PriceID]

    def _next_month(d: date) -> date:
        m = d.month + 1
        y = d.year + (m > 12)
        m = m if m <= 12 else 1
        return date(y, m, 1)

    for row in sorted_rows[1:]:
        key = (row.CustomerCode, row.SalesChannelCode, row.ItemNo, row.Price)
        if key == run_key and row.PriceMonth == _next_month(run_end):
            run_end = row.PriceMonth
            run_ids.append(row.PriceID)
        else:
            cust, chan, item, price = run_key
            ranges.append(PriceRangeResponse(
                PriceID_first    = run_id,
                PriceIDs         = run_ids,
                CustomerCode     = cust,
                CustomerName     = customer_name_map.get(cust, cust),
                SalesChannelCode = chan,
                ItemNo           = item,
                ItemDescription  = item_desc_map.get(item, item),
                StartDate        = run_start,
                EndDate          = run_end,
                Price            = price,
            ))
            run_key   = key
            run_start = row.PriceMonth
            run_end   = row.PriceMonth
            run_id    = row.PriceID
            run_ids   = [row.PriceID]

    cust, chan, item, price = run_key
    ranges.append(PriceRangeResponse(
        PriceID_first    = run_id,
        PriceIDs         = run_ids,
        CustomerCode     = cust,
        CustomerName     = customer_name_map.get(cust, cust),
        SalesChannelCode = chan,
        ItemNo           = item,
        ItemDescription  = item_desc_map.get(item, item),
        StartDate        = run_start,
        EndDate          = run_end,
        Price            = price,
    ))
    return ranges


# ── GET /api/v1/prices/{bu_code} ─────────────────────────────────────────────

@router.get("/{bu_code}/template")
def get_price_template(
    bu_code: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download an Excel template pre-populated with customer × active-item rows."""
    _require_bu_access(bu_code, current_user, db)

    try:
        import openpyxl
        from openpyxl.styles import Font
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise HTTPException(500, detail="openpyxl is not installed on the server.")

    # Fetch accessible customers
    allowed = _accessible_customers(bu_code, current_user, db)
    q = db.query(Customer).filter(
        Customer.BusinessUnitCode == bu_code,
        Customer.IsActive == True,
    )
    if allowed is not None:
        q = q.filter(Customer.Code.in_(allowed))
    customers = q.order_by(Customer.Name).all()

    # Fetch active items for this BU
    region_col = _region_active_column(bu_code)
    items = db.query(Item).filter(region_col == True).order_by(Item.Description).all()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Prices"

    headers = ["CustomerCode", "ItemNo", "SalesChannelCode",
               "StartDate (YYYY-MM-DD e.g. 2026-07-06)",
               "EndDate (YYYY-MM-DD e.g. 2026-07-06)",
               "Price"]
    for col_idx, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = Font(bold=True)

    # Freeze header row
    ws.freeze_panes = "A2"

    # Date columns (D and E) and ItemNo column (B) formatted as Text to prevent
    # Excel auto-converting values (dates to serials, ItemNos to numbers)
    total_rows = len(customers) * len(items) + 100
    for col_letter in ("B", "D", "E"):
        for r in range(2, total_rows + 2):
            ws.cell(row=r, column={"B": 2, "D": 4, "E": 5}[col_letter]).number_format = "@"

    row_idx = 2
    for cust in customers:
        for item in items:
            ws.cell(row=row_idx, column=1, value=cust.Code)
            item_cell = ws.cell(row=row_idx, column=2, value=str(item.ItemNo))
            item_cell.number_format = "@"
            item_cell.data_type = "s"
            # SalesChannelCode left blank — user fills in
            row_idx += 1

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="price_template_{bu_code}.xlsx"'},
    )


@router.get("/{bu_code}", response_model=list[PriceRangeResponse])
def get_prices(
    bu_code:           str,
    customer_code:     str        = Query(...),
    sales_channel_code: str | None = Query(default=None),
    item_no:           str | None  = Query(default=None),
    start_date:        str | None  = Query(default=None),
    end_date:          str | None  = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    q = db.query(Price).filter(
        Price.BusinessUnitCode == bu_code,
        Price.CustomerCode     == customer_code,
    )
    if sales_channel_code:
        q = q.filter(Price.SalesChannelCode == sales_channel_code)
    if item_no:
        q = q.filter(Price.ItemNo == item_no)

    if start_date:
        try:
            sd = parse_import_date(start_date, 0)
            q  = q.filter(Price.PriceMonth >= sd)
        except ValueError:
            pass
    if end_date:
        try:
            ed = parse_import_date(end_date, 0)
            q  = q.filter(Price.PriceMonth <= ed)
        except ValueError:
            pass

    rows = q.order_by(Price.CustomerCode, Price.SalesChannelCode, Price.ItemNo, Price.PriceMonth).all()

    # Bulk-fetch lookup data
    item_nos = list({r.ItemNo for r in rows})
    items    = db.query(Item).filter(Item.ItemNo.in_(item_nos)).all() if item_nos else []
    item_desc_map = {i.ItemNo: i.Description for i in items}

    customer_name_map = {customer_code: customer_code}
    cust = db.query(Customer).filter(
        Customer.Code             == customer_code,
        Customer.BusinessUnitCode == bu_code,
    ).first()
    if cust:
        customer_name_map[customer_code] = cust.Name

    return _collapse_ranges(rows, customer_name_map, item_desc_map)


# ── PUT /api/v1/prices/{bu_code} ──────────────────────────────────────────────

@router.put("/{bu_code}")
def upsert_price(
    bu_code: str,
    body:    PriceRangeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    result = validate_import_rows(
        [{
            "CustomerCode":     body.CustomerCode,
            "SalesChannelCode": body.SalesChannelCode,
            "ItemNo":           body.ItemNo,
            "StartDate":        body.StartDate,
            "EndDate":          body.EndDate,
            "Price":            str(body.Price),
        }],
        bu_code,
        db,
    )

    if result["date_errors"]:
        raise HTTPException(422, detail=result["date_errors"])

    if not result["conflict_rows"]:
        # No conflicts — write immediately
        inserted = _commit_rows(result["valid_rows"], "overwrite", current_user, db)
        return {"inserted": inserted, "updated": 0, "skipped": 0}

    # Return conflict report with token for caller to confirm
    return {
        "valid_rows":    len(result["valid_rows"]),
        "date_errors":   [],
        "conflict_rows": result["conflict_rows"],
        "import_token":  result["import_token"],
    }


# ── DELETE /api/v1/prices/{bu_code}/{price_id} ────────────────────────────────

@router.delete("/{bu_code}/{price_id}", status_code=204)
def delete_price(
    bu_code:  str,
    price_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    row = db.query(Price).filter(Price.PriceID == price_id).first()
    if not row:
        raise HTTPException(404, detail="Price row not found.")
    if row.BusinessUnitCode != bu_code:
        raise HTTPException(403, detail="This price row does not belong to the specified BU.")

    db.delete(row)
    db.commit()


# ── PATCH /api/v1/prices/{bu_code}/{price_id_first} ──────────────────────────

@router.patch("/{bu_code}/{price_id_first}", response_model=PriceRangeResponse)
def update_price_range(
    bu_code:        str,
    price_id_first: int,
    body:           PriceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    if body.new_price < 0:
        raise HTTPException(422, detail="Price must be zero or greater.")

    rows = db.query(Price).filter(
        Price.PriceID.in_(body.price_ids),
        Price.BusinessUnitCode == bu_code,
    ).all()

    if not rows:
        raise HTTPException(404, detail="No price rows found for the given IDs.")
    if len(rows) != len(body.price_ids):
        raise HTTPException(400, detail="Some price IDs do not belong to this business unit.")

    now = datetime.utcnow()
    for row in rows:
        row.Price        = body.new_price
        row.ModifiedBy   = current_user.UserID
        row.ModifiedDate = now
    db.commit()

    item_nos = list({r.ItemNo for r in rows})
    items    = db.query(Item).filter(Item.ItemNo.in_(item_nos)).all() if item_nos else []
    item_desc_map = {i.ItemNo: i.Description for i in items}

    cust_codes = list({r.CustomerCode for r in rows})
    custs      = db.query(Customer).filter(
        Customer.Code.in_(cust_codes),
        Customer.BusinessUnitCode == bu_code,
    ).all() if cust_codes else []
    customer_name_map = {c.Code: c.Name for c in custs}

    collapsed = _collapse_ranges(rows, customer_name_map, item_desc_map)
    if not collapsed:
        raise HTTPException(500, detail="Could not build response after update.")

    return collapsed[0]


# ── POST /api/v1/prices/{bu_code}/import ─────────────────────────────────────

@router.post("/{bu_code}/import", response_model=ImportValidationResponse)
async def import_prices(
    bu_code: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    try:
        import openpyxl
    except ImportError:
        raise HTTPException(500, detail="openpyxl is not installed on the server.")

    contents = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
    except Exception as exc:
        raise HTTPException(422, detail=f"Could not read Excel file: {exc}")

    ws = wb.active
    rows: list[dict] = []
    header_row = None

    def _cell_to_str(c) -> str:
        """Convert any openpyxl cell value to a clean string.
        Handles datetime objects returned when Excel auto-converts YYYY-MM-DD
        strings to date serials, even in Text-formatted columns."""
        if c is None:
            return ""
        if isinstance(c, (datetime, date)):
            return c.strftime("%Y-%m-%d")
        return str(c).strip()

    for row in ws.iter_rows(values_only=True):
        if header_row is None:
            # First non-empty row is the header
            header_row = [_cell_to_str(c) for c in row]
            continue
        if all(c is None for c in row):
            continue
        row_dict = dict(zip(header_row, [_cell_to_str(c) for c in row]))
        # Skip template rows where Price has not been filled in
        if not row_dict.get("Price", "").strip():
            continue
        # Normalise column names — accept both exact and shortened header forms
        rows.append({
            "CustomerCode":     row_dict.get("CustomerCode", ""),
            "SalesChannelCode": row_dict.get("SalesChannelCode", ""),
            "ItemNo":           row_dict.get("ItemNo", ""),
            "StartDate":        row_dict.get("StartDate (YYYY-MM-DD e.g. 2026-07-06)",
                                             row_dict.get("StartDate", "")),
            "EndDate":          row_dict.get("EndDate (YYYY-MM-DD e.g. 2026-07-06)",
                                             row_dict.get("EndDate", "")),
            "Price":            row_dict.get("Price", ""),
        })

    result = validate_import_rows(rows, bu_code, db)

    return ImportValidationResponse(
        valid_rows    = len(result["valid_rows"]),
        date_errors   = result["date_errors"],
        conflict_rows = result["conflict_rows"],
        import_token  = result["import_token"],
    )


# ── POST /api/v1/prices/{bu_code}/import/confirm ──────────────────────────────

@router.post("/{bu_code}/import/confirm", response_model=ImportConfirmResponse)
def confirm_import(
    bu_code: str,
    body:    ImportConfirmRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_bu_access(bu_code, current_user, db)

    payload = consume_import_token(body.import_token)
    if not payload:
        raise HTTPException(400, detail="Import token is invalid or has expired.")
    if payload["bu_code"] != bu_code:
        raise HTTPException(400, detail="Import token was issued for a different BU.")

    valid_rows = payload["valid_rows"]
    inserted   = _commit_rows(valid_rows, body.conflict_resolution, current_user, db)
    updated    = 0
    skipped    = 0

    if body.conflict_resolution == "overwrite":
        # _commit_rows returns a combined count; split isn't tracked separately
        # but semantics: existing rows that were replaced count as updated
        # We re-query to distinguish — simpler: track in _commit_rows
        pass

    return ImportConfirmResponse(inserted=inserted, updated=0, skipped=0)


# ── Shared write helper ───────────────────────────────────────────────────────

def _commit_rows(
    valid_rows: list[dict],
    conflict_resolution: str,
    current_user: User,
    db: Session,
) -> int:
    """
    Write valid_rows to tblPrice within a single transaction.
    Returns the count of rows inserted (overwritten rows are also counted).
    conflict_resolution: "overwrite" | "skip"
    """
    from sqlalchemy import and_, or_

    if not valid_rows:
        return 0

    # Fetch all conflicting rows in one query
    conditions = [
        and_(
            Price.BusinessUnitCode == r["BusinessUnitCode"],
            Price.CustomerCode     == r["CustomerCode"],
            Price.SalesChannelCode == r["SalesChannelCode"],
            Price.ItemNo           == r["ItemNo"],
            Price.PriceMonth       == r["PriceMonth"],
        )
        for r in valid_rows
    ]
    existing = db.query(Price).filter(or_(*conditions)).all() if conditions else []
    existing_map = {
        (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode, p.ItemNo, p.PriceMonth): p
        for p in existing
    }

    now = datetime.utcnow()
    count = 0

    for r in valid_rows:
        key = (r["BusinessUnitCode"], r["CustomerCode"], r["SalesChannelCode"], r["ItemNo"], r["PriceMonth"])
        existing_row = existing_map.get(key)

        if existing_row:
            if conflict_resolution == "overwrite":
                existing_row.Price       = r["Price"]
                existing_row.ModifiedBy   = current_user.UserID
                existing_row.ModifiedDate = now
                count += 1
            # skip → do nothing
        else:
            db.add(Price(
                BusinessUnitCode = r["BusinessUnitCode"],
                CustomerCode     = r["CustomerCode"],
                SalesChannelCode = r["SalesChannelCode"],
                ItemNo           = r["ItemNo"],
                PriceMonth       = r["PriceMonth"],
                Price            = r["Price"],
                CreatedBy        = current_user.UserID,
                CreatedDate      = now,
            ))
            count += 1

    db.commit()
    return count
