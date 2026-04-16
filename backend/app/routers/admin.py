"""
routers/admin.py
Admin endpoints — user management and BU assignments.
Requires CanManageUsers permission.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db import get_db
from app.auth.dev_auth import get_current_user
from app.models import User
from app.schemas import UserOut

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


@router.get("/users", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return all users with their role name. Available to any authenticated
    user in dev mode so DevUserSwitcher can populate its list without requiring
    Admin role. Restrict to CanManageUsers in production if desired."""
    users = (
        db.query(User)
        .filter(User.IsActive == True)
        .order_by(User.DisplayName)
        .all()
    )
    result = []
    for user in users:
        out = UserOut.model_validate(user)
        out.RoleName = user.role.Name if user.role else None
        result.append(out)
    return result


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.role.CanManageUsers:
        raise HTTPException(403, "Requires CanManageUsers permission")
    row = (
        db.query(User, Role.Name)
        .join(Role, User.RoleCode == Role.Code)
        .filter(User.UserID == user_id)
        .first()
    )
    if not row:
        raise HTTPException(404, "User not found")
    user, role_name = row
    out = UserOut.model_validate(user)
    out.RoleName = role_name
    return out
