"""
auth/dev_auth.py - Development auth stub.

In ENVIRONMENT=dev, every request is treated as the user named in DEV_USER (.env).
This completely bypasses Entra ID / token validation.

Replace this module with real Entra ID token validation before going to production.
"""
from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session
from app.db import get_db
from app.models import User
from app.config import settings
from typing import Optional


def get_current_user(
    db: Session = Depends(get_db),
    x_dev_user: Optional[str] = Header(default=None),
) -> User:
    """
    Dev auth dependency injected into every route.

    In dev mode:
    - If X-Dev-User header is present, use that username (lets you switch users in the UI).
    - Otherwise fall back to DEV_USER from .env.

    Raises 401 if the resolved username is not found in tblUser.
    """
    username = x_dev_user or settings.dev_user

    user = db.query(User).filter(
        User.Username == username,
        User.IsActive == True,
    ).first()

    if not user:
        raise HTTPException(
            status_code=401,
            detail=f"Dev auth: user '{username}' not found in tblUser or is inactive. "
                   f"Check DEV_USER in .env or seed tblUser with a matching record."
        )

    return user
