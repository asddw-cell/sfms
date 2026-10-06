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

from app.auth import get_current_user
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
    normalise_variant_suffix,
    parse_import_date,
    split_item_no,
    validate_import_rows,
)

router = APIRouter(prefix="/api/v1/prices", tags=["Prices"])

# ── Region → IsActive column helper ──────────────────────────────────────────

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
    if current_user.role.CanViewAllBU:
        return None
    rows = db.query(UserCustomer).filter(
        UserCustomer.UserID          == current_user.UserID,
        UserCustomer.BusinessUnitCode == bu_code,
    ).all()
    if not rows:
        return None
    return [r.CustomerCode for r in rows]


# ── Item description helper ───────────────────────────────────────────────────

def _build_item_desc_map(rows: list[Price], db: Session) -> dict[str, str]:
    """
    Build a {full_item_no: description} map for the given price rows.
    For variant rows the full item is BaseItemNo + VariantSuffix.
    For base rows (VariantSuffix='') the full item equals BaseItemNo.
    Falls back to the BaseItemNo string when no tblItem row is found.
    """
    full_items = {r.BaseItemNo + r.VariantSuffix for r in rows}
    items      = db.query(Item).filter(Item.ItemNo.in_(full_items)).all() if full_items else []
    return {i.ItemNo: i.Description for i in items}


def _item_desc(base: str, suffix: str, desc_map: dict[str, str]) -> str:
    full = base + suffix
    return desc_map.get(full, desc_map.get(base, base))


# ── Collapse helper ───────────────────────────────────────────────────────────

def _collapse_ranges(
    price_rows: list[Price],
    customer_name_map: dict[str, str],
    item_desc_map: dict[str, str],
) -> list[PriceRangeResponse]:
    """
    Group consecutive monthly rows with the same (Customer, Channel, BaseItemNo, VariantSuffix, Price)
    into collapsed PriceRangeResponse objects. A gap of even one month breaks a range.
    """
    if not price_rows:
        return []

    sorted_rows = sorted(
        price_rows,
        key=lambda p: (p.CustomerCode, p.SalesChannelCode, p.BaseItemNo, p.VariantSuffix, p.PriceMonth),
    )

    ranges: list[PriceRangeResponse] = []
    first = sorted_rows[0]
    run_key   = (first.CustomerCode, first.SalesChannelCode, first.BaseItemNo, first.VariantSuffix, first.Price)
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
        key = (row.CustomerCode, row.SalesChannelCode, row.BaseItemNo, row.VariantSuffix, row.Price)
        if key == run_key and row.PriceMonth == _next_month(run_end):
            run_end = row.PriceMonth
            run_ids.append(row.PriceID)
        else:
            cust, chan, base, suffix, price = run_key
            ranges.append(PriceRangeResponse(
                PriceID_first    = run_id,
                PriceIDs         = run_ids,
                CustomerCode     = cust,
                CustomerName     = customer_name_map.get(cust, cust),
                SalesChannelCode = chan,
                BaseItemNo       = base,
                VariantSuffix    = suffix,
                ItemDescription  = _item_desc(base, suffix, item_desc_map),
                StartDate        = run_start,
                EndDate          = run_end,
                Price            = price,
            ))
            run_key   = key
            run_start = row.PriceMonth
            run_end   = row.PriceMonth
            run_id    = row.PriceID
            run_ids   = [row.PriceID]

    cust, chan, base, suffix, price = run_key
    ranges.append(PriceRangeResponse(
        PriceID_first    = run_id,
        PriceIDs         = run_ids,
        CustomerCode     = cust,
        CustomerName     = customer_name_map.get(cust, cust),
        SalesChannelCode = chan,
        BaseItemNo       = base,
        VariantSuffix    = suffix,
        ItemDescription  = _item_desc(base, suffix, item_desc_map),
        StartDate        = run_start,
        EndDate          = run_end,
        Price            = price,
    ))
    return ranges


# ── GET /api/v1/prices/{bu_code}/template ────────────────────────────────────

@router.get("/{bu_code}/template")
def get_price_template(
    bu_code:            str,
    customer_code:      str | None = Query(default=None),
    sales_channel_code: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Download an Excel template pre-populated with customer × active-item rows.
    Each tblItem row is split into Base Item and Variant columns.
    """
    _require_bu_access(bu_code, current_user, db)

    try:
        import openpyxl
        from openpyxl.styles import Font
    except ImportError:
        raise HTTPException(500, detail="openpyxl is not installed on the server.")

    allowed = _accessible_customers(bu_code, current_user, db)
    q = db.query(Customer).filter(
        Customer.BusinessUnitCode == bu_code,
        Customer.IsActive == True,
    )
    if allowed is not None:
        q = q.filter(Customer.Code.in_(allowed))
    if customer_code:
        q = q.filter(Customer.Code == customer_code)
    customers = q.order_by(Customer.Name).all()

    region_col = _region_active_column(bu_code)
    items = db.query(Item).filter(region_col == True).order_by(Item.Description).all()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Prices"

    headers = [
        "CustomerCode",
        "CustomerName",
        "Base Item",
        "Variant",
        "SalesChannelCode",
        "StartDate (YYYY-MM-DD e.g. 2026-07-06)",
        "EndDate (YYYY-MM-DD e.g. 2026-07-06)",
        "Price",
    ]
    for col_idx, h in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = Font(bold=True)

    ws.freeze_panes = "A2"

    # Text-format columns that Excel might auto-convert:
    #   C (3) = Base Item  — prevent numeric conversion of item codes
    #   D (4) = Variant    — prevent .006 → 0.006 conversion
    #   F (6) = StartDate  — prevent date-serial conversion
    #   G (7) = EndDate    — prevent date-serial conversion
    total_rows = len(customers) * len(items) + 100
    for col_num in (3, 4, 6, 7):
        for r in range(2, total_rows + 2):
            ws.cell(row=r, column=col_num).number_format = "@"

    row_idx = 2
    for cust in customers:
        for item in items:
            base_item, variant_suffix = split_item_no(item.ItemNo)
            ws.cell(row=row_idx, column=1, value=cust.Code)
            ws.cell(row=row_idx, column=2, value=cust.Name)

            base_cell = ws.cell(row=row_idx, column=3, value=str(base_item))
            base_cell.number_format = "@"
            base_cell.data_type = "s"

            variant_cell = ws.cell(row=row_idx, column=4, value=str(variant_suffix))
            variant_cell.number_format = "@"
            variant_cell.data_type = "s"

            if sales_channel_code:
                ws.cell(row=row_idx, column=5, value=sales_channel_code)
            row_idx += 1

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="price_template_{bu_code}.xlsx"'},
    )


# ── GET /api/v1/prices/{bu_code} ─────────────────────────────────────────────

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

    # item_no filter: split the supplied value to match against BaseItemNo/VariantSuffix
    if item_no:
        base_filter, suffix_filter = split_item_no(item_no)
        if suffix_filter:
            q = q.filter(Price.BaseItemNo == base_filter, Price.VariantSuffix == suffix_filter)
        else:
            q = q.filter(Price.BaseItemNo == base_filter)

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

    rows = q.order_by(
        Price.CustomerCode, Price.SalesChannelCode,
        Price.BaseItemNo, Price.VariantSuffix, Price.PriceMonth,
    ).all()

    item_desc_map = _build_item_desc_map(rows, db)

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
            "BaseItemNo":       body.BaseItemNo,
            "VariantSuffix":    body.VariantSuffix,
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
        inserted = _commit_rows(result["valid_rows"], "overwrite", current_user, db)
        return {"inserted": inserted, "updated": 0, "skipped": 0}

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

    item_desc_map = _build_item_desc_map(rows, db)

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
        """Convert any openpyxl cell value to a clean string."""
        if c is None:
            return ""
        if isinstance(c, (datetime, date)):
            return c.strftime("%Y-%m-%d")
        return str(c).strip()

    for row in ws.iter_rows(values_only=True):
        if header_row is None:
            header_row = [_cell_to_str(c) for c in row]
            continue
        if all(c is None for c in row):
            continue

        # Keep raw values for numeric-type detection on Base Item and Variant
        raw_values = list(row)
        row_dict   = dict(zip(header_row, [_cell_to_str(c) for c in raw_values]))

        if not row_dict.get("Price", "").strip():
            continue

        # Locate the Base Item and Variant column indices
        try:
            base_col_idx    = header_row.index("Base Item")
            variant_col_idx = header_row.index("Variant")
        except ValueError:
            base_col_idx    = None
            variant_col_idx = None

        # Reject rows where Base Item or Variant arrived as a numeric type
        numeric_type_error = False
        if base_col_idx is not None and isinstance(raw_values[base_col_idx], (int, float)):
            numeric_type_error = True
        if variant_col_idx is not None and isinstance(raw_values[variant_col_idx], (int, float)):
            numeric_type_error = True

        rows.append({
            "CustomerCode":     row_dict.get("CustomerCode", ""),
            "SalesChannelCode": row_dict.get("SalesChannelCode", ""),
            "BaseItemNo":       row_dict.get("Base Item", ""),
            "VariantSuffix":    row_dict.get("Variant", ""),
            "StartDate":        row_dict.get("StartDate (YYYY-MM-DD e.g. 2026-07-06)",
                                             row_dict.get("StartDate", "")),
            "EndDate":          row_dict.get("EndDate (YYYY-MM-DD e.g. 2026-07-06)",
                                             row_dict.get("EndDate", "")),
            "Price":            row_dict.get("Price", ""),
            "_numeric_type_error": numeric_type_error,
        })

    # Convert numeric-type errors into date_errors before passing to validate_import_rows
    clean_rows:  list[dict] = []
    early_errors: list[dict] = []
    for i, r in enumerate(rows, start=2):  # row 1 is header → data starts at 2
        if r.pop("_numeric_type_error", False):
            early_errors.append({
                "row":     i,
                "value":   "",
                "message": (
                    f"Row {i}: Base Item and Variant must be formatted as Text in Excel. "
                    f"Excel has converted one of those cells to a number. "
                    f"Re-format the columns as Text and re-enter the values."
                ),
            })
        else:
            clean_rows.append(r)

    if early_errors:
        return ImportValidationResponse(
            valid_rows    = 0,
            date_errors   = early_errors,
            conflict_rows = [],
            import_token  = None,
        )

    result = validate_import_rows(clean_rows, bu_code, db)

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
    Returns the count of rows inserted or overwritten.
    """
    from sqlalchemy import and_, or_

    if not valid_rows:
        return 0

    conditions = [
        and_(
            Price.BusinessUnitCode == r["BusinessUnitCode"],
            Price.CustomerCode     == r["CustomerCode"],
            Price.SalesChannelCode == r["SalesChannelCode"],
            Price.BaseItemNo       == r["BaseItemNo"],
            Price.VariantSuffix    == r["VariantSuffix"],
            Price.PriceMonth       == r["PriceMonth"],
        )
        for r in valid_rows
    ]
    existing = db.query(Price).filter(or_(*conditions)).all() if conditions else []
    existing_map = {
        (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode, p.BaseItemNo, p.VariantSuffix, p.PriceMonth): p
        for p in existing
    }

    now   = datetime.utcnow()
    count = 0

    for r in valid_rows:
        key = (
            r["BusinessUnitCode"], r["CustomerCode"], r["SalesChannelCode"],
            r["BaseItemNo"], r["VariantSuffix"], r["PriceMonth"],
        )
        existing_row = existing_map.get(key)

        if existing_row:
            if conflict_resolution == "overwrite":
                existing_row.Price       = r["Price"]
                existing_row.ModifiedBy   = current_user.UserID
                existing_row.ModifiedDate = now
                count += 1
        else:
            db.add(Price(
                BusinessUnitCode = r["BusinessUnitCode"],
                CustomerCode     = r["CustomerCode"],
                SalesChannelCode = r["SalesChannelCode"],
                BaseItemNo       = r["BaseItemNo"],
                VariantSuffix    = r["VariantSuffix"],
                PriceMonth       = r["PriceMonth"],
                Price            = r["Price"],
                CreatedBy        = current_user.UserID,
                CreatedDate      = now,
            ))
            count += 1

    db.commit()
    return count
