"""
services/pricing.py

Single source of truth for effective-price resolution and import helpers.
All endpoints that need a price call one of the functions here — never
re-implement the logic inline.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models import Item, Price

# ── ItemNo helpers ───────────────────────────────────────────────────────────

def _try_pad_item_no(item_no: str) -> str | None:
    """
    If item_no is a decimal number with 1 or 2 decimal places, return a
    zero-padded version to 3 decimal places; otherwise return None.

    Used to recover trailing zeros stripped by Excel (e.g. 869257.010 → 869257.01).
    None means no padding is applicable or needed.
    """
    if not item_no:
        return None
    m = re.match(r'^(\d+)\.(\d{1,2})$', item_no.strip())
    if m:
        return f"{m.group(1)}.{m.group(2).ljust(3, '0')}"
    return None


# ── Token store ───────────────────────────────────────────────────────────────
# Keys are UUID strings; values are {"rows": [...], "expires": datetime}
_import_tokens: dict[str, dict] = {}
_TOKEN_TTL_MINUTES = 10
_MAX_IMPORT_ROWS   = 10_000  # Maximum input rows (before date expansion)


# ── SQLAlchemy helpers ────────────────────────────────────────────────────────

def _chunked_or_query(db: Session, model, conditions: list, chunk_size: int = 400):
    """
    Execute a query using OR-of-AND conditions in chunks to stay under
    SQL Server's 2,100 bound-parameter limit.

    Each price condition uses 5 parameters; chunk_size=400 gives 2,000
    parameters per batch — safely under the limit.

    Returns a flat list of all matched rows across all chunks.
    """
    if not conditions:
        return []
    results = []
    for i in range(0, len(conditions), chunk_size):
        chunk = conditions[i : i + chunk_size]
        if len(chunk) == 1:
            results.extend(db.query(model).filter(chunk[0]).all())
        else:
            results.extend(db.query(model).filter(or_(*chunk)).all())
    return results


# ── Alias resolution ─────────────────────────────────────────────────────────

def _resolve_price_customer(
    customer_code: str,
    bu_code: str,
    db: Session,
) -> tuple[str, str]:
    """
    Return the (CustomerCode, BusinessUnitCode) to use for tblPrice lookup.

    If the customer has a PriceAliasCode set, return the alias target.
    Otherwise return the original customer unchanged.

    The alias is followed at most one level — no recursive chaining.
    """
    from app.models import Customer
    customer = db.query(Customer).filter(
        Customer.Code             == customer_code,
        Customer.BusinessUnitCode == bu_code,
    ).first()

    if customer and customer.PriceAliasCode and customer.PriceAliasBUCode:
        return (customer.PriceAliasCode, customer.PriceAliasBUCode)

    return (customer_code, bu_code)


# ── Core price resolution ─────────────────────────────────────────────────────

def get_effective_price(row, db: Session) -> tuple[Decimal, bool]:
    """
    Resolve the effective price for a single forecast row.

    Returns (effective_price, is_missing_price).
    is_missing_price is True only when IsPriceOverride=0 and no tblPrice row
    was found — the cell should be shown in amber in the grid.
    """
    if row.IsPriceOverride:
        return (row.OverridePrice or Decimal("0"), False)

    # Resolve alias: EU_xx_AMAZ → EU_EU_AMA etc.
    lookup_customer, lookup_bu = _resolve_price_customer(
        row.CustomerCode, row.BusinessUnitCode, db
    )

    price_month = row.ForecastDate.replace(day=1)
    p = db.query(Price).filter(
        Price.BusinessUnitCode == lookup_bu,
        Price.CustomerCode     == lookup_customer,
        Price.SalesChannelCode == row.SalesChannelCode,
        Price.ItemNo           == row.ItemNo,
        Price.PriceMonth       == price_month,
    ).first()

    if p:
        return (p.Price, False)
    return (Decimal("0"), True)


def get_effective_prices_bulk(rows, db: Session) -> dict[int, tuple[Decimal, bool]]:
    """
    Batch price resolution for the forecast GET endpoint.

    Fetches all required tblPrice rows in a single query.
    Returns a dict keyed by EntryNo -> (effective_price, is_missing_price).
    """
    result: dict[int, tuple[Decimal, bool]] = {}

    # Rows that already have an override don't need a DB lookup
    override_rows   = [r for r in rows if r.IsPriceOverride]
    lookup_rows     = [r for r in rows if not r.IsPriceOverride]

    for r in override_rows:
        result[r.EntryNo] = (r.OverridePrice or Decimal("0"), False)

    if not lookup_rows:
        return result

    # Resolve aliases in a single batch customer query
    unique_customers = {(r.CustomerCode, r.BusinessUnitCode) for r in lookup_rows}

    from app.models import Customer
    customer_conditions = [
        and_(
            Customer.Code             == cust,
            Customer.BusinessUnitCode == bu,
        )
        for cust, bu in unique_customers
    ]
    customers = _chunked_or_query(db, Customer, customer_conditions)

    alias_map: dict[tuple, tuple] = {}
    for c in customers:
        key = (c.Code, c.BusinessUnitCode)
        if c.PriceAliasCode and c.PriceAliasBUCode:
            alias_map[key] = (c.PriceAliasCode, c.PriceAliasBUCode)
        else:
            alias_map[key] = key

    # Build lookup keys using resolved (customer, bu) pairs
    keys = {
        alias_map.get(
            (r.CustomerCode, r.BusinessUnitCode),
            (r.CustomerCode, r.BusinessUnitCode),
        ) + (r.SalesChannelCode, r.ItemNo, r.ForecastDate.replace(day=1))
        for r in lookup_rows
    }

    # Single query — pull all matching tblPrice rows at once
    # SQL Server supports tuple IN via OR-of-ANDs for composite keys
    conditions = [
        and_(
            Price.BusinessUnitCode == bu,
            Price.CustomerCode     == cust,
            Price.SalesChannelCode == chan,
            Price.ItemNo           == item,
            Price.PriceMonth       == month,
        )
        for bu, cust, chan, item, month in keys
    ]

    price_rows = _chunked_or_query(db, Price, conditions)

    price_map: dict[tuple, Decimal] = {
        (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode, p.ItemNo, p.PriceMonth): p.Price
        for p in price_rows
    }

    for r in lookup_rows:
        lookup_key = alias_map.get(
            (r.CustomerCode, r.BusinessUnitCode),
            (r.CustomerCode, r.BusinessUnitCode),
        )
        price_key = lookup_key + (r.SalesChannelCode, r.ItemNo, r.ForecastDate.replace(day=1))
        if price_key in price_map:
            result[r.EntryNo] = (price_map[price_key], False)
        else:
            result[r.EntryNo] = (Decimal("0"), True)

    return result


# ── Date helpers ──────────────────────────────────────────────────────────────

def expand_date_range_to_months(start_date: date, end_date: date) -> list[date]:
    """
    Return first-of-month dates for every calendar month from start_date to
    end_date inclusive.

    Example:
        expand_date_range_to_months(date(2026,1,15), date(2026,3,20))
        → [date(2026,1,1), date(2026,2,1), date(2026,3,1)]
    """
    months = []
    y, m = start_date.year, start_date.month
    ey, em = end_date.year, end_date.month
    while (y, m) <= (ey, em):
        months.append(date(y, m, 1))
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return months


def parse_import_date(value: str, row_number: int) -> date:
    """
    Parse a date string in YYYY-MM-DD format (e.g. 2026-07-06).
    Returns a date set to the first of the parsed month (day is ignored).
    Raises ValueError with a user-friendly message on failure.
    """
    try:
        parsed = datetime.strptime(value.strip(), "%Y-%m-%d")
        return parsed.replace(day=1).date()
    except ValueError:
        raise ValueError(
            f"Date '{value}' in row {row_number} could not be parsed. "
            f"Use the format YYYY-MM-DD, e.g. 2026-07-06."
        )


# ── Import validation ─────────────────────────────────────────────────────────

def validate_import_rows(
    rows: list[dict],
    bu_code: str,
    db: Session,
) -> dict:
    """
    Validate and expand a list of import dicts.

    Each dict should have keys:
        CustomerCode, SalesChannelCode, ItemNo, StartDate (str), EndDate (str), Price (str/Decimal)

    Returns:
        {
            "valid_rows": [...],    # expanded monthly rows ready for insert/update
            "date_errors": [...],   # list of {row, value, message}
            "conflict_rows": [...], # existing tblPrice rows that clash
            "import_token": str | None
        }
    """
    if len(rows) > _MAX_IMPORT_ROWS:
        return {
            "valid_rows":    [],
            "date_errors":   [{
                "row":     0,
                "value":   str(len(rows)),
                "message": (
                    f"Import file contains {len(rows):,} rows, which exceeds the "
                    f"maximum of {_MAX_IMPORT_ROWS:,} input rows per import. "
                    f"Split the file into smaller batches and import each separately."
                ),
            }],
            "conflict_rows": [],
            "import_token":  None,
        }

    valid_rows: list[dict] = []
    date_errors: list[dict] = []

    for i, row in enumerate(rows, start=1):
        customer_code    = (row.get("CustomerCode")    or "").strip()
        channel_code     = (row.get("SalesChannelCode") or "").strip()
        item_no          = (row.get("ItemNo")           or "").strip()
        start_raw        = (row.get("StartDate")        or "").strip()
        end_raw          = (row.get("EndDate")          or "").strip()
        price_val        = row.get("Price")

        # Skip completely blank rows (unfilled template rows that slipped through)
        if not any([customer_code, channel_code, item_no, start_raw, end_raw]):
            continue

        # Require all key dimension fields
        missing_fields = [
            name for name, val in [
                ("CustomerCode",     customer_code),
                ("SalesChannelCode", channel_code),
                ("ItemNo",           item_no),
            ] if not val
        ]
        if missing_fields:
            date_errors.append({
                "row":     i,
                "value":   "",
                "message": f"Row {i}: Missing required fields: {', '.join(missing_fields)}.",
            })
            continue

        # Normalise ItemNo — recover trailing zeros dropped by Excel
        if _try_pad_item_no(item_no) is not None:
            exact = db.query(Item).filter(Item.ItemNo == item_no).first()
            if not exact:
                padded = _try_pad_item_no(item_no)
                padded_item = db.query(Item).filter(Item.ItemNo == padded).first()
                if padded_item:
                    item_no = padded

        start_date = end_date = None

        try:
            start_date = parse_import_date(str(start_raw), i)
        except ValueError as exc:
            date_errors.append({"row": i, "value": str(start_raw), "message": str(exc)})

        try:
            end_date = parse_import_date(str(end_raw), i)
        except ValueError as exc:
            date_errors.append({"row": i, "value": str(end_raw), "message": str(exc)})

        if start_date and end_date:
            if end_date < start_date:
                date_errors.append({
                    "row": i,
                    "value": f"{start_raw} – {end_raw}",
                    "message": f"Row {i}: EndDate must be on or after StartDate.",
                })
            else:
                try:
                    price_decimal = Decimal(str(price_val))
                except Exception:
                    date_errors.append({
                        "row": i, "value": str(price_val),
                        "message": f"Row {i}: Price '{price_val}' is not a valid number.",
                    })
                    continue

                for month in expand_date_range_to_months(start_date, end_date):
                    valid_rows.append({
                        "BusinessUnitCode": bu_code,
                        "CustomerCode":     customer_code,
                        "SalesChannelCode": channel_code,
                        "ItemNo":           item_no,
                        "PriceMonth":       month,
                        "Price":            price_decimal,
                    })

    # If there are date errors, stop here — no token
    if date_errors:
        return {
            "valid_rows":    valid_rows,
            "date_errors":   date_errors,
            "conflict_rows": [],
            "import_token":  None,
        }

    # Check for conflicts: existing tblPrice rows with matching keys
    conflict_rows: list[dict] = []
    if valid_rows:
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
        existing = _chunked_or_query(db, Price, conditions)

        existing_keys = {
            (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode, p.ItemNo, p.PriceMonth): p
            for p in existing
        }

        for r in valid_rows:
            key = (r["BusinessUnitCode"], r["CustomerCode"], r["SalesChannelCode"], r["ItemNo"], r["PriceMonth"])
            if key in existing_keys:
                p = existing_keys[key]
                conflict_rows.append({
                    "PriceID":         p.PriceID,
                    "CustomerCode":    p.CustomerCode,
                    "SalesChannelCode": p.SalesChannelCode,
                    "ItemNo":          p.ItemNo,
                    "PriceMonth":      p.PriceMonth.isoformat(),
                    "ExistingPrice":   str(p.Price),
                    "NewPrice":        str(r["Price"]),
                })

    # No valid rows to import — return without issuing a token
    if not valid_rows:
        return {
            "valid_rows":    [],
            "date_errors":   [],
            "conflict_rows": [],
            "import_token":  None,
        }

    # Issue token (valid for 10 minutes)
    token = str(uuid.uuid4())
    _import_tokens[token] = {
        "valid_rows": valid_rows,
        "bu_code":    bu_code,
        "expires":    datetime.utcnow(),
    }
    _purge_expired_tokens()

    return {
        "valid_rows":    valid_rows,
        "date_errors":   [],
        "conflict_rows": conflict_rows,
        "import_token":  token,
    }


def get_import_token(token: str) -> dict | None:
    """Return the token payload if it exists and has not expired, else None."""
    _purge_expired_tokens()
    entry = _import_tokens.get(token)
    if not entry:
        return None
    age = (datetime.utcnow() - entry["expires"]).total_seconds() / 60
    if age > _TOKEN_TTL_MINUTES:
        del _import_tokens[token]
        return None
    return entry


def consume_import_token(token: str) -> dict | None:
    """Return and delete the token payload; returns None if missing/expired."""
    payload = get_import_token(token)
    if payload:
        _import_tokens.pop(token, None)
    return payload


def _purge_expired_tokens() -> None:
    now = datetime.utcnow()
    expired = [
        k for k, v in _import_tokens.items()
        if (now - v["expires"]).total_seconds() / 60 > _TOKEN_TTL_MINUTES
    ]
    for k in expired:
        del _import_tokens[k]
