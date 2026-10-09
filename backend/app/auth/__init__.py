"""
auth/__init__.py

Exports a single get_current_user dependency. The active implementation is
selected once at import time based on ENVIRONMENT, so routers can write:

    from app.auth import get_current_user

and work correctly in every environment without knowing which backend is active.
"""
from app.config import settings

if settings.environment == "dev":
    from app.auth.dev_auth import get_current_user
else:
    from app.auth.entra import get_current_user

__all__ = ["get_current_user"]
