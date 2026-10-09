"""
services/channel_norm.py

Normalizes SalesChannelCode values to their canonical casing from tblSalesChannel.

Why this exists: tblForecastData and tblActuals can contain inconsistently-cased
SalesChannelCode values (e.g. 'DOMESTIC' vs 'Domestic' on different rows of the
same item). The frontend's client-side channel filter is case-sensitive, so
un-normalized responses cause valid rows to be silently filtered out in the UI.
"""
from sqlalchemy.orm import Session


def build_channel_map(db: Session) -> dict[str, str]:
    """Returns {UPPERCASE_CODE: canonical_code} from tblSalesChannel."""
    from app.models import SalesChannel
    rows = db.query(SalesChannel.Code).all()
    return {r.Code.upper(): r.Code for r in rows}


def normalize_channel(code: str | None, channel_map: dict[str, str]) -> str | None:
    """Maps a possibly-mis-cased channel code to its canonical form.
    Falls back to the original value unchanged if not found in tblSalesChannel,
    rather than silently dropping/blanking unrecognised codes."""
    if code is None:
        return None
    return channel_map.get(code.upper(), code)
