"""
services/pricing.py

Single source of truth for effective-price resolution and import helpers.
All endpoints that need a price call one of the functions here — never
re-implement the logic inline.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.models import Item, Price

_log = logging.getLogger(__name__)


# ── Item split / join helpers ─────────────────────────────────────────────────

def split_item_no(item_no: str) -> tuple[str, str]:
    """
    Split a full item number into (BaseItemNo, VariantSuffix).

    Rule: if the string has more than 4 characters and the 4th character
    from the end is '.', split there.
      '123456.006' → ('123456', '.006')
      '123456'     → ('123456', '')
      '1234'       → ('1234',   '')   ← exactly 4 chars, no split
    """
    if len(item_no) > 4 and item_no[-4] == '.':
        return (item_no[:-4], item_no[-4:])
    return (item_no, '')


# ── Token store ───────────────────────────────────────────────────────────────
# Keys are UUID strings; values are {"rows": [...], "expires": datetime}
_import_tokens: dict[str, dict] = {}
_TOKEN_TTL_MINUTES = 10
_MAX_IMPORT_ROWS   = 10_000  # Maximum input rows (before date expansion)


# ── SQLAlchemy helpers ────────────────────────────────────────────────────────

def _chunked_or_query(db: Session, model, conditions: list, params_per_condition: int = 1):
    """
    Execute a query using OR-of-AND conditions in chunks to stay under
    SQL Server's 2,100 bound-parameter limit.

    params_per_condition: bound parameters each individual condition uses
    (e.g. 6 for a Price keyed on BU+cust+chan+base+suffix+month).

    Returns a flat list of all matched rows across all chunks.
    """
    if not conditions:
        return []
    chunk_size = (2100 - 100) // params_per_condition
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

    Lookup order:
      1. IsPriceOverride → OverridePrice
      2. Exact variant row (BaseItemNo, VariantSuffix)
      3. Base row (BaseItemNo, VariantSuffix='')
      4. 0 (is_missing_price=True)

    Returns (effective_price, is_missing_price).
    """
    if row.IsPriceOverride:
        return (row.OverridePrice or Decimal("0"), False)

    lookup_customer, lookup_bu = _resolve_price_customer(
        row.CustomerCode, row.BusinessUnitCode, db
    )

    base_item, variant_suffix = split_item_no(row.ItemNo)
    price_month = row.ForecastDate.replace(day=1)

    # Single query fetching at most two candidates (exact variant + base)
    candidates = db.query(Price).filter(
        Price.BusinessUnitCode == lookup_bu,
        Price.CustomerCode     == lookup_customer,
        Price.SalesChannelCode == row.SalesChannelCode,
        Price.BaseItemNo       == base_item,
        Price.VariantSuffix.in_([variant_suffix, '']),
        Price.PriceMonth       == price_month,
    ).all()

    # Prefer exact variant over base
    exact = next((p for p in candidates if p.VariantSuffix == variant_suffix and variant_suffix != ''), None)
    base  = next((p for p in candidates if p.VariantSuffix == ''), None)

    # For items with no suffix, the base candidate IS the match
    if not variant_suffix:
        p = base
    else:
        p = exact or base

    if p:
        return (p.Price, False)
    return (Decimal("0"), True)


def get_effective_prices_bulk(rows, db: Session) -> dict[int, tuple[Decimal, bool]]:
    """
    Batch price resolution for the forecast GET endpoint.

    Replaces two large OR-of-AND batch queries with a single tblPrice fetch
    using IN lists on (BusinessUnitCode, CustomerCode, SalesChannelCode) and
    a BETWEEN on PriceMonth.  Resolution to (effective_price, is_missing_price)
    is done in Python with the same lookup order as get_effective_price:
      override → exact variant → base (VariantSuffix='') → 0.

    Returns a dict keyed by EntryNo -> (effective_price, is_missing_price).
    """
    _t0 = time.perf_counter()
    result: dict[int, tuple[Decimal, bool]] = {}

    override_rows = [r for r in rows if r.IsPriceOverride]
    lookup_rows   = [r for r in rows if not r.IsPriceOverride]

    for r in override_rows:
        result[r.EntryNo] = (r.OverridePrice or Decimal("0"), False)

    if not lookup_rows:
        return result

    # ── Alias resolution ──────────────────────────────────────────────────────
    unique_customers = {(r.CustomerCode, r.BusinessUnitCode) for r in lookup_rows}

    from app.models import Customer
    customer_conditions = [
        and_(Customer.Code == cust, Customer.BusinessUnitCode == bu)
        for cust, bu in unique_customers
    ]
    _ta = time.perf_counter()
    customers = _chunked_or_query(db, Customer, customer_conditions, params_per_condition=2)
    _log.debug("price_bulk alias %.3fs (%d cond)", time.perf_counter() - _ta, len(customer_conditions))

    # alias_map: (orig_cust, orig_bu) → (price_cust, price_bu)
    alias_map: dict[tuple, tuple] = {}
    for c in customers:
        orig_key = (c.Code, c.BusinessUnitCode)
        if c.PriceAliasCode and c.PriceAliasBUCode:
            alias_map[orig_key] = (c.PriceAliasCode, c.PriceAliasBUCode)
        else:
            alias_map[orig_key] = orig_key

    # ── Build IN-list members and PriceMonth range ────────────────────────────
    lookup_bus:   set[str]  = set()
    lookup_custs: set[str]  = set()
    lookup_chans: set[str]  = set()
    min_month:    date | None = None
    max_month:    date | None = None

    # Per-row resolved keys for the Python resolution pass
    row_keys: list[tuple] = []  # (entry_no, price_bu, price_cust, chan, base, suffix, month)

    for r in lookup_rows:
        orig_key = (r.CustomerCode, r.BusinessUnitCode)
        price_cust, price_bu = alias_map.get(orig_key, orig_key)
        base_item, variant_suffix = split_item_no(r.ItemNo)
        month = r.ForecastDate.replace(day=1)

        lookup_bus.add(price_bu)
        lookup_custs.add(price_cust)
        lookup_chans.add(r.SalesChannelCode)

        if min_month is None or month < min_month:
            min_month = month
        if max_month is None or month > max_month:
            max_month = month

        row_keys.append(
            (r.EntryNo, price_bu, price_cust, r.SalesChannelCode, base_item, variant_suffix, month)
        )

    # ── Single bulk price fetch ───────────────────────────────────────────────
    # Parameters: len(bus) + len(custs) + len(chans) + 2 (BETWEEN bounds).
    # If distinct customers somehow exceed the safe budget, chunk by customers.
    _MARGIN     = 100
    _fixed_params  = len(lookup_bus) + len(lookup_chans) + 2
    _max_custs_per_chunk = max(1, 2100 - _MARGIN - _fixed_params)

    _tp = time.perf_counter()
    price_map: dict[tuple, Decimal] = {}
    cust_list  = list(lookup_custs)
    _n_chunks  = 0

    for _cs in range(0, len(cust_list), _max_custs_per_chunk):
        cust_chunk = cust_list[_cs : _cs + _max_custs_per_chunk]
        _n_chunks += 1
        fetched = (
            db.query(
                Price.BusinessUnitCode,
                Price.CustomerCode,
                Price.SalesChannelCode,
                Price.BaseItemNo,
                Price.VariantSuffix,
                Price.PriceMonth,
                Price.Price,
            )
            .filter(
                Price.BusinessUnitCode.in_(list(lookup_bus)),
                Price.CustomerCode.in_(cust_chunk),
                Price.SalesChannelCode.in_(list(lookup_chans)),
                Price.PriceMonth >= min_month,
                Price.PriceMonth <= max_month,
            )
            .all()
        )
        for p in fetched:
            price_map[
                (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode,
                 p.BaseItemNo, p.VariantSuffix, p.PriceMonth)
            ] = p.Price

    _log.debug(
        "price_bulk fetch %.3fs (%d price rows, %d bus, %d custs, %d chans, %s–%s, %d chunk(s))",
        time.perf_counter() - _tp, len(price_map),
        len(lookup_bus), len(lookup_custs), len(lookup_chans),
        min_month, max_month, _n_chunks,
    )

    # ── Python resolution — same lookup order as get_effective_price ──────────
    for entry_no, price_bu, price_cust, chan, base_item, variant_suffix, month in row_keys:
        if variant_suffix:
            v_key = (price_bu, price_cust, chan, base_item, variant_suffix, month)
            if v_key in price_map:
                result[entry_no] = (price_map[v_key], False)
                continue

        b_key = (price_bu, price_cust, chan, base_item, '', month)
        if b_key in price_map:
            result[entry_no] = (price_map[b_key], False)
        else:
            result[entry_no] = (Decimal("0"), True)

    _log.debug(
        "price_bulk TOTAL %.3fs (%d rows, %d overrides, %d lookups, %d prices in map)",
        time.perf_counter() - _t0, len(rows), len(override_rows), len(lookup_rows), len(price_map),
    )
    return result


# ── Variant suffix normalisation ──────────────────────────────────────────────

def normalise_variant_suffix(raw: str) -> str | None:
    """
    Normalise a raw variant suffix string from user input or a spreadsheet cell.

    Accepts:
      ''      → ''       (base-level price)
      '.006'  → '.006'   (dot + 3 chars)
      '006'   → '.006'   (add leading dot)

    Returns None for any other value (caller should report an error).
    """
    raw = raw.strip()
    if raw == '':
        return ''
    if re.match(r'^\.[A-Za-z0-9]{3}$', raw):
        return raw
    if re.match(r'^[A-Za-z0-9]{3}$', raw):
        return '.' + raw
    return None


# ── Item existence validation ─────────────────────────────────────────────────

def _item_exists_for_base(base_item: str, db: Session) -> bool:
    """
    True if tblItem has either:
      - an exact row ItemNo = base_item, OR
      - at least one variant row whose split gives base_item
        (checked with LEFT/SUBSTRING, not LIKE, so % and _ in item numbers are safe).

    tblItem is globally scoped (no BusinessUnitCode column); region availability
    is tracked via per-BU IsActive_XX flags rather than row-level partitioning.
    """
    n = len(base_item)
    return db.query(Item).filter(
        or_(
            Item.ItemNo == base_item,
            and_(
                func.len(Item.ItemNo) == n + 4,
                func.left(Item.ItemNo, n) == base_item,
                func.substring(Item.ItemNo, n + 1, 1) == '.',
            ),
        ),
    ).first() is not None


# ── Date helpers ──────────────────────────────────────────────────────────────

def expand_date_range_to_months(start_date: date, end_date: date) -> list[date]:
    """
    Return first-of-month dates for every calendar month from start_date to
    end_date inclusive.
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
    Parse a date string in YYYY-MM-DD format.
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
        CustomerCode, SalesChannelCode, BaseItemNo, VariantSuffix,
        StartDate (str), EndDate (str), Price (str/Decimal)

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

    # ── Pre-validate all unique (BaseItemNo, VariantSuffix) pairs in one batch ─
    # Collect unique pairs that have a non-empty BaseItemNo
    unique_pairs: set[tuple[str, str]] = set()
    for row in rows:
        base   = (row.get("BaseItemNo")    or "").strip()
        suffix = (row.get("VariantSuffix") or "").strip()
        if base:
            unique_pairs.add((base, suffix))

    # Batch check full variant items (suffix != '')
    # tblItem has no BusinessUnitCode column — items are global; region scoping
    # uses IsActive_XX flags, not row-level partitioning.
    full_item_nos   = {base + suffix for base, suffix in unique_pairs if suffix}
    valid_full_set: set[str] = set()
    if full_item_nos:
        found = db.query(Item).filter(
            Item.ItemNo.in_(full_item_nos),
        ).all()
        valid_full_set = {i.ItemNo for i in found}

    # Batch check base items (suffix == '')
    base_only_items = {base for base, suffix in unique_pairs if not suffix}
    valid_base_set: set[str] = set()
    if base_only_items:
        # Exact matches first
        exact_found = db.query(Item).filter(
            Item.ItemNo.in_(base_only_items),
        ).all()
        valid_base_set = {i.ItemNo for i in exact_found}

        # For bases not found exactly, check if any variant exists for them
        missing_bases = base_only_items - valid_base_set
        for base in missing_bases:
            if _item_exists_for_base(base, db):
                valid_base_set.add(base)

    valid_rows:  list[dict] = []
    date_errors: list[dict] = []

    for i, row in enumerate(rows, start=1):
        customer_code = (row.get("CustomerCode")    or "").strip()
        channel_code  = (row.get("SalesChannelCode") or "").strip()
        base_item     = (row.get("BaseItemNo")       or "").strip()
        variant_raw   = (row.get("VariantSuffix")    or "").strip()
        start_raw     = (row.get("StartDate")        or "").strip()
        end_raw       = (row.get("EndDate")          or "").strip()
        price_val     = row.get("Price")

        # Skip completely blank rows
        if not any([customer_code, channel_code, base_item, start_raw, end_raw]):
            continue

        # Required fields
        missing_fields = [
            name for name, val in [
                ("CustomerCode",     customer_code),
                ("SalesChannelCode", channel_code),
                ("BaseItemNo",       base_item),
            ] if not val
        ]
        if missing_fields:
            date_errors.append({
                "row":     i,
                "value":   "",
                "message": f"Row {i}: Missing required fields: {', '.join(missing_fields)}.",
            })
            continue

        # Validate VariantSuffix format
        variant_suffix = normalise_variant_suffix(variant_raw)
        if variant_suffix is None:
            date_errors.append({
                "row":     i,
                "value":   variant_raw,
                "message": (
                    f"Row {i}: Variant '{variant_raw}' is not valid. "
                    f"Use '' (blank for all variants), '.006', or '006'."
                ),
            })
            continue

        # Validate item existence
        if variant_suffix:
            full_item = base_item + variant_suffix
            if full_item not in valid_full_set:
                date_errors.append({
                    "row":     i,
                    "value":   full_item,
                    "message": (
                        f"Row {i}: Item '{full_item}' was not found in this business unit."
                    ),
                })
                continue
        else:
            if base_item not in valid_base_set:
                date_errors.append({
                    "row":     i,
                    "value":   base_item,
                    "message": (
                        f"Row {i}: Base item '{base_item}' was not found in this business unit "
                        f"(no exact or variant match)."
                    ),
                })
                continue

        # Parse dates
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
                        "BaseItemNo":       base_item,
                        "VariantSuffix":    variant_suffix,
                        "PriceMonth":       month,
                        "Price":            price_decimal,
                    })

    if date_errors:
        return {
            "valid_rows":    valid_rows,
            "date_errors":   date_errors,
            "conflict_rows": [],
            "import_token":  None,
        }

    # Check for conflicts
    conflict_rows: list[dict] = []
    if valid_rows:
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
        existing = _chunked_or_query(db, Price, conditions, params_per_condition=6)

        existing_keys = {
            (p.BusinessUnitCode, p.CustomerCode, p.SalesChannelCode, p.BaseItemNo, p.VariantSuffix, p.PriceMonth): p
            for p in existing
        }

        for r in valid_rows:
            key = (
                r["BusinessUnitCode"], r["CustomerCode"], r["SalesChannelCode"],
                r["BaseItemNo"], r["VariantSuffix"], r["PriceMonth"],
            )
            if key in existing_keys:
                p = existing_keys[key]
                conflict_rows.append({
                    "PriceID":         p.PriceID,
                    "CustomerCode":    p.CustomerCode,
                    "SalesChannelCode": p.SalesChannelCode,
                    "BaseItemNo":      p.BaseItemNo,
                    "VariantSuffix":   p.VariantSuffix,
                    "PriceMonth":      p.PriceMonth.isoformat(),
                    "ExistingPrice":   str(p.Price),
                    "NewPrice":        str(r["Price"]),
                })

    if not valid_rows:
        return {
            "valid_rows":    [],
            "date_errors":   [],
            "conflict_rows": [],
            "import_token":  None,
        }

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
