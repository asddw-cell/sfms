"""
tests/test_entra_auth.py

Unit tests for the Entra ID token-validation dependency (app/auth/entra.py).

All tests mock httpx and python-jose so no real Entra tenant is required.
The test module imports entra directly (not via app.auth.__init__) so the
ENVIRONMENT check in __init__.py doesn't interfere.
"""
import time
from unittest.mock import MagicMock, patch, call

import pytest
from fastapi import HTTPException
from jose import ExpiredSignatureError, JWTError
from jose.exceptions import JWTClaimsError

from app.auth import entra
from app.models import User


# ── Helpers ───────────────────────────────────────────────────────────────────

FAKE_KID = "test-key-id"

FAKE_JWK = {
    "kty": "RSA",
    "use": "sig",
    "kid": FAKE_KID,
    "n": "somerandombase64",
    "e": "AQAB",
}

FAKE_JWKS_RESPONSE = {"keys": [FAKE_JWK]}

VALID_PAYLOAD = {
    "oid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "sub": "some-sub",
    "aud": "test-client-id",
    "iss": "https://login.microsoftonline.com/test-tenant/v2.0",
    "exp": int(time.time()) + 3600,
}


def _mock_jwks_response():
    """Return a mock httpx.Response that yields FAKE_JWKS_RESPONSE."""
    resp = MagicMock()
    resp.json.return_value = FAKE_JWKS_RESPONSE
    resp.raise_for_status.return_value = None
    return resp


def _mock_user(oid: str = VALID_PAYLOAD["oid"]) -> User:
    user = MagicMock(spec=User)
    user.ExternalIdentityID = oid
    user.IsActive = True
    return user


def _db_returning(user):
    """Build a mock Session whose .query(...).filter(...).first() returns user."""
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = user
    return db


@pytest.fixture(autouse=True)
def reset_jwks_cache():
    """Ensure the JWKS cache is empty before every test."""
    entra._jwks_cache["keys"] = []
    entra._jwks_cache["expires_at"] = 0.0
    yield
    entra._jwks_cache["keys"] = []
    entra._jwks_cache["expires_at"] = 0.0


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestValidToken:
    def test_returns_user_on_valid_token(self):
        """A well-formed token with a matching oid returns the tblUser row."""
        mock_user = _mock_user()
        db = _db_returning(mock_user)

        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", return_value=VALID_PAYLOAD):

            result = entra.get_current_user(db=db, authorization="Bearer fake.token.here")

        assert result is mock_user


class TestMissingOrMalformedHeader:
    def test_no_authorization_header_raises_401(self):
        db = _db_returning(None)
        with pytest.raises(HTTPException) as exc_info:
            entra.get_current_user(db=db, authorization=None)
        assert exc_info.value.status_code == 401

    def test_non_bearer_scheme_raises_401(self):
        db = _db_returning(None)
        with pytest.raises(HTTPException) as exc_info:
            entra.get_current_user(db=db, authorization="Basic dXNlcjpwYXNz")
        assert exc_info.value.status_code == 401

    def test_malformed_token_header_raises_401(self):
        db = _db_returning(None)
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", side_effect=JWTError("bad header")):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer not.a.real.token")
        assert exc_info.value.status_code == 401
        assert "Malformed token header" in exc_info.value.detail


class TestExpiredToken:
    def test_expired_token_raises_401_with_helpful_message(self):
        db = _db_returning(None)
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", side_effect=ExpiredSignatureError("expired")):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer expired.token")
        assert exc_info.value.status_code == 401
        assert "expired" in exc_info.value.detail.lower()


class TestWrongAudienceOrIssuer:
    def test_wrong_audience_raises_401(self):
        db = _db_returning(None)
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", side_effect=JWTClaimsError("audience mismatch")):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer wrong.aud.token")
        assert exc_info.value.status_code == 401
        assert "claims" in exc_info.value.detail.lower()

    def test_invalid_signature_raises_401(self):
        db = _db_returning(None)
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", side_effect=JWTError("signature verification failed")):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer bad.sig.token")
        assert exc_info.value.status_code == 401
        assert "validation failed" in exc_info.value.detail.lower()


class TestUnknownOid:
    def test_oid_not_in_db_raises_401(self):
        """A valid token whose oid has no matching active tblUser raises 401."""
        db = _db_returning(None)  # no user found
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", return_value=VALID_PAYLOAD):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer valid.but.unknown.token")
        assert exc_info.value.status_code == 401
        assert VALID_PAYLOAD["oid"] in exc_info.value.detail

    def test_missing_oid_claim_raises_401(self):
        """A token that passes signature checks but lacks the oid claim raises 401."""
        payload_no_oid = {k: v for k, v in VALID_PAYLOAD.items() if k != "oid"}
        db = _db_returning(None)
        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()), \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", return_value=payload_no_oid):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer no.oid.token")
        assert exc_info.value.status_code == 401
        assert "oid" in exc_info.value.detail


class TestJwksCache:
    def test_jwks_fetched_only_once_across_two_calls(self):
        """The JWKS endpoint should be hit once; the second call uses the cache."""
        mock_user = _mock_user()
        db = _db_returning(mock_user)

        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()) as mock_get, \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", return_value=VALID_PAYLOAD):

            entra.get_current_user(db=db, authorization="Bearer token.one")
            entra.get_current_user(db=db, authorization="Bearer token.two")

        assert mock_get.call_count == 1, (
            f"Expected httpx.get to be called once (JWKS cached), but it was called {mock_get.call_count} times"
        )

    def test_stale_cache_triggers_refetch(self):
        """An expired cache entry causes a fresh JWKS fetch on the next call."""
        mock_user = _mock_user()
        db = _db_returning(mock_user)

        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()) as mock_get, \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": FAKE_KID}), \
             patch("app.auth.entra.jwt.decode", return_value=VALID_PAYLOAD):

            entra.get_current_user(db=db, authorization="Bearer token.one")

            # Expire the cache manually
            entra._jwks_cache["expires_at"] = 0.0

            entra.get_current_user(db=db, authorization="Bearer token.two")

        assert mock_get.call_count == 2

    def test_unknown_kid_forces_cache_refresh(self):
        """If the token's kid isn't in the cache, a refresh is attempted before failing."""
        db = _db_returning(None)

        with patch("app.auth.entra.httpx.get", return_value=_mock_jwks_response()) as mock_get, \
             patch("app.auth.entra.jwt.get_unverified_header", return_value={"kid": "unknown-kid"}):
            with pytest.raises(HTTPException) as exc_info:
                entra.get_current_user(db=db, authorization="Bearer unknown.kid.token")

        assert exc_info.value.status_code == 401
        assert "not found" in exc_info.value.detail.lower()
        # First fetch (cache miss) + one forced refresh = 2 calls
        assert mock_get.call_count == 2
