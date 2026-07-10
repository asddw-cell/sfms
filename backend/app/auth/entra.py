"""
auth/entra.py - Azure Entra ID (OIDC) token validation.

Used when ENVIRONMENT != "dev". Validates Bearer tokens from the Authorization
header against the tenant's JWKS endpoint using RS256 public-key cryptography.

No client secret is required — this is token validation only (JWKS-based),
not any app-only Graph API calls.
"""
import logging
import time
from typing import Optional

import httpx
from fastapi import Depends, Header, HTTPException
from jose import ExpiredSignatureError, JWTError, jwt
from jose.exceptions import JWTClaimsError
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import User

logger = logging.getLogger(__name__)

# ── JWKS cache ────────────────────────────────────────────────────────────────
# Module-level cache so the JWKS endpoint is hit at most once per TTL window,
# not on every request.
_JWKS_TTL_SECONDS = 86_400  # 24 hours
_jwks_cache: dict = {"keys": [], "expires_at": 0.0}


def _get_jwks() -> list[dict]:
    """Return cached JWKS keys, refreshing from Entra if the cache is stale."""
    now = time.time()
    if _jwks_cache["keys"] and now < _jwks_cache["expires_at"]:
        return _jwks_cache["keys"]

    url = f"{settings.entra_authority}/discovery/v2.0/keys"
    try:
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.error("Failed to fetch Entra JWKS from %s: %s", url, exc)
        raise HTTPException(
            status_code=503,
            detail="Could not reach the identity provider to validate your token. Try again shortly.",
        )

    keys = resp.json().get("keys", [])
    _jwks_cache["keys"] = keys
    _jwks_cache["expires_at"] = now + _JWKS_TTL_SECONDS
    return keys


def _signing_key_for_token(token: str) -> dict:
    """
    Extract the kid from the token header and return the matching JWK dict.
    If the kid is not in the cached JWKS, the cache is invalidated and
    re-fetched once before raising 401 (handles key rotation gracefully).
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Malformed token header: {exc}")

    kid = header.get("kid")

    def _find(keys: list[dict]) -> dict | None:
        return next((k for k in keys if k.get("kid") == kid), None)

    key = _find(_get_jwks())
    if key is None:
        # kid not in cache — force a refresh once to handle key rotation
        _jwks_cache["expires_at"] = 0.0
        key = _find(_get_jwks())
    if key is None:
        raise HTTPException(
            status_code=401,
            detail=f"Token signing key (kid='{kid}') not found in Entra JWKS.",
        )
    return key


def get_current_user(
    db: Session = Depends(get_db),
    authorization: Optional[str] = Header(default=None),
) -> User:
    """
    Entra ID token-validation dependency — drop-in replacement for
    dev_auth.get_current_user in non-dev environments.

    Validates the Bearer token's signature, issuer, audience, and expiry,
    then looks up the active tblUser row by the 'oid' claim
    (stored as ExternalIdentityID).

    Raises HTTP 401 for any authentication failure.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail="Authorization header is missing or is not a Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.removeprefix("Bearer ").strip()
    signing_key = _signing_key_for_token(token)

    issuer = f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0"

    try:
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=settings.entra_client_id,
            issuer=issuer,
        )
    except ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired. Please sign in again.")
    except JWTClaimsError as exc:
        raise HTTPException(status_code=401, detail=f"Token claims are invalid: {exc}")
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Token validation failed: {exc}")

    oid = payload.get("oid")
    if not oid:
        raise HTTPException(status_code=401, detail="Token is missing the required 'oid' claim.")

    # ── User lookup ───────────────────────────────────────────────────────────
    # DECISION POINT: Users must be pre-provisioned in tblUser by an administrator.
    # Auto-provisioning (JIT) is intentionally NOT implemented here.
    # To add JIT provisioning, create the User record from the token claims
    # (name / preferred_username / email) before the 401 raise below.
    user = db.query(User).filter(
        User.ExternalIdentityID == oid,
        User.IsActive == True,
    ).first()

    if not user:
        raise HTTPException(
            status_code=401,
            detail=(
                f"User '{oid}' is not recognized or is inactive. "
                "Contact an administrator to provision this account."
            ),
        )

    return user
