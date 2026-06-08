"""
routers/admin.py
User management endpoints — Admin only except /users GET which is
available to all authenticated users (used by DevUserSwitcher in dev).
"""
import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.auth.dev_auth import get_current_user
from app.models import User, Role, UserBusinessUnit, UserCustomer, Customer, SupplyHorizon
from app.schemas import (
    UserOut, UserAdminOut, UserCreateRequest, UserUpdateRequest,
    BUAssignRequest, CustomerAssignRequest, BUAssignmentOut,
    CustomerAssignmentOut, SupplyHorizonOut, SupplyHorizonCreate, SupplyHorizonUpdate,
)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _require_admin(current_user: User):
    if not current_user.role.CanManageUsers:
        raise HTTPException(403, "Admin role required")


def _build_user_admin_out(user: User, db: Session) -> UserAdminOut:
    """Build a fully populated UserAdminOut including BU and customer assignments."""
    bu_assignments = []
    for uba in user.bu_assignments:
        customer_rows = db.query(UserCustomer).filter(
            UserCustomer.UserID == user.UserID,
            UserCustomer.BusinessUnitCode == uba.BusinessUnitCode,
        ).all()
        bu_assignments.append(BUAssignmentOut(
            BusinessUnitCode=uba.BusinessUnitCode,
            HorizonOverrideMonthsBack=uba.HorizonOverrideMonthsBack,
            customer_assignments=[
                CustomerAssignmentOut(
                    CustomerCode=uc.CustomerCode,
                    BusinessUnitCode=uc.BusinessUnitCode,
                )
                for uc in customer_rows
            ],
        ))

    return UserAdminOut(
        UserID=user.UserID,
        Username=user.Username,
        DisplayName=user.DisplayName,
        Email=user.Email,
        RoleCode=user.RoleCode,
        RoleName=user.role.Name if user.role else None,
        IsActive=user.IsActive,
        CreatedDate=user.CreatedDate,
        ModifiedDate=user.ModifiedDate,
        bu_assignments=bu_assignments,
    )


# -- User list -----------------------------------------------------------------

@router.get("/users", response_model=list[UserOut])
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all active users with role name. Open to all authenticated users
    so DevUserSwitcher can populate without requiring Admin role."""
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


@router.get("/users/all", response_model=list[UserAdminOut])
def list_all_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full user list including inactive users with all assignments. Admin only."""
    _require_admin(current_user)
    users = db.query(User).order_by(User.DisplayName).all()
    return [_build_user_admin_out(u, db) for u in users]


@router.get("/users/{user_id}", response_model=UserAdminOut)
def get_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single user with full BU and customer assignments. Admin only."""
    _require_admin(current_user)
    user = db.query(User).filter(User.UserID == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")
    return _build_user_admin_out(user, db)


# -- Create / update user ------------------------------------------------------

@router.post("/users", response_model=UserAdminOut, status_code=201)
def create_user(
    payload: UserCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new user account. Admin only."""
    _require_admin(current_user)

    if db.query(User).filter(User.Username == payload.Username).first():
        raise HTTPException(400, f"Username '{payload.Username}' already exists")

    role = db.query(Role).filter(Role.Code == payload.RoleCode).first()
    if not role:
        raise HTTPException(400, "Role not found")

    now = datetime.datetime.utcnow()
    user = User(
        Username=payload.Username,
        DisplayName=payload.DisplayName,
        Email=payload.Email,
        ExternalIdentityID=payload.ExternalIdentityID or payload.Username,
        RoleCode=payload.RoleCode,
        IsActive=payload.IsActive,
        CreatedDate=now,
        ModifiedDate=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _build_user_admin_out(user, db)


@router.put("/users/{user_id}", response_model=UserAdminOut)
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update user fields. Admin only."""
    _require_admin(current_user)

    user = db.query(User).filter(User.UserID == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    if payload.DisplayName is not None:
        user.DisplayName = payload.DisplayName
    if payload.Email is not None:
        user.Email = payload.Email
    if payload.RoleCode is not None:
        role = db.query(Role).filter(Role.Code == payload.RoleCode).first()
        if not role:
            raise HTTPException(400, "Role not found")
        user.RoleCode = payload.RoleCode
    if payload.IsActive is not None:
        user.IsActive = payload.IsActive

    user.ModifiedDate = datetime.datetime.utcnow()
    db.commit()
    db.refresh(user)
    return _build_user_admin_out(user, db)


# -- BU assignments ------------------------------------------------------------

@router.post("/users/{user_id}/bus", response_model=UserAdminOut)
def assign_bu(
    user_id: int,
    payload: BUAssignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assign a user to a BU. Defaults horizon to role default if not specified."""
    _require_admin(current_user)

    user = db.query(User).filter(User.UserID == user_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    existing = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == user_id,
        UserBusinessUnit.BusinessUnitCode == payload.BusinessUnitCode,
    ).first()
    if existing:
        raise HTTPException(400, f"User already assigned to {payload.BusinessUnitCode}")

    horizon = payload.HorizonOverrideMonthsBack
    if horizon is None:
        horizon = user.role.HorizonMonthsBack if user.role else 0

    now = datetime.datetime.utcnow()
    uba = UserBusinessUnit(
        UserID=user_id,
        BusinessUnitCode=payload.BusinessUnitCode,
        HorizonOverrideMonthsBack=horizon,
        AssignedDate=now,
        AssignedBy=current_user.UserID,
        ModifiedDate=now,
        ModifiedBy=current_user.UserID,
    )
    db.add(uba)
    db.commit()
    db.refresh(user)
    return _build_user_admin_out(user, db)


@router.put("/users/{user_id}/bus/{bu_code}", response_model=UserAdminOut)
def update_bu_assignment(
    user_id: int,
    bu_code: str,
    payload: BUAssignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update horizon override for an existing BU assignment."""
    _require_admin(current_user)

    uba = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == user_id,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not uba:
        raise HTTPException(404, "BU assignment not found")

    uba.HorizonOverrideMonthsBack = payload.HorizonOverrideMonthsBack
    uba.ModifiedDate = datetime.datetime.utcnow()
    uba.ModifiedBy = current_user.UserID
    db.commit()

    user = db.query(User).filter(User.UserID == user_id).first()
    return _build_user_admin_out(user, db)


@router.delete("/users/{user_id}/bus/{bu_code}", response_model=UserAdminOut)
def remove_bu(
    user_id: int,
    bu_code: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a BU assignment. Also removes any customer restrictions for that BU."""
    _require_admin(current_user)

    uba = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == user_id,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not uba:
        raise HTTPException(404, "BU assignment not found")

    db.query(UserCustomer).filter(
        UserCustomer.UserID == user_id,
        UserCustomer.BusinessUnitCode == bu_code,
    ).delete(synchronize_session=False)

    db.delete(uba)
    db.commit()

    user = db.query(User).filter(User.UserID == user_id).first()
    return _build_user_admin_out(user, db)


# -- Customer assignments -------------------------------------------------------

@router.put("/users/{user_id}/bus/{bu_code}/customers", response_model=UserAdminOut)
def set_customer_assignments(
    user_id: int,
    bu_code: str,
    payload: CustomerAssignRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace the full set of customer restrictions for a user in a BU.
    Empty CustomerCodes list = unrestricted (sees all customers in that BU)."""
    _require_admin(current_user)

    uba = db.query(UserBusinessUnit).filter(
        UserBusinessUnit.UserID == user_id,
        UserBusinessUnit.BusinessUnitCode == bu_code,
    ).first()
    if not uba:
        raise HTTPException(404, "User is not assigned to this BU")

    if payload.CustomerCodes:
        valid = db.query(Customer).filter(
            Customer.BusinessUnitCode == bu_code,
            Customer.Code.in_(payload.CustomerCodes),
        ).all()
        valid_codes = {c.Code for c in valid}
        invalid = set(payload.CustomerCodes) - valid_codes
        if invalid:
            raise HTTPException(400, f"Customers not found in {bu_code}: {', '.join(invalid)}")

    db.query(UserCustomer).filter(
        UserCustomer.UserID == user_id,
        UserCustomer.BusinessUnitCode == bu_code,
    ).delete(synchronize_session=False)

    now = datetime.datetime.utcnow()
    for code in payload.CustomerCodes:
        db.add(UserCustomer(
            UserID=user_id,
            BusinessUnitCode=bu_code,
            CustomerCode=code,
            AssignedDate=now,
            AssignedBy=current_user.UserID,
        ))

    uba.ModifiedDate = now
    uba.ModifiedBy = current_user.UserID
    db.commit()

    user = db.query(User).filter(User.UserID == user_id).first()
    return _build_user_admin_out(user, db)


# ── Supply Horizon configuration ───────────────────────────────────────────────

@router.get("/supply-horizon", response_model=list[SupplyHorizonOut])
def list_supply_horizons(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all supply horizon rules. Admin only."""
    _require_admin(current_user)
    return db.query(SupplyHorizon).order_by(
        SupplyHorizon.BusinessUnitCode,
        SupplyHorizon.SalesChannelCode,
    ).all()


@router.post("/supply-horizon", response_model=SupplyHorizonOut, status_code=201)
def create_supply_horizon(
    payload: SupplyHorizonCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new supply horizon rule for a BU+channel combination. Admin only."""
    _require_admin(current_user)

    existing = db.query(SupplyHorizon).filter(
        SupplyHorizon.BusinessUnitCode == payload.BusinessUnitCode,
        SupplyHorizon.SalesChannelCode == payload.SalesChannelCode,
        SupplyHorizon.IsActive == True,
    ).first()
    if existing:
        raise HTTPException(
            400,
            f"An active horizon rule already exists for "
            f"{payload.BusinessUnitCode} / {payload.SalesChannelCode}. "
            f"Update or deactivate it first.",
        )

    now = datetime.datetime.utcnow()
    rule = SupplyHorizon(
        BusinessUnitCode = payload.BusinessUnitCode,
        SalesChannelCode = payload.SalesChannelCode,
        HorizonMonths    = payload.HorizonMonths,
        IsActive         = True,
        CreatedBy        = current_user.UserID,
        CreatedDate      = now,
        ModifiedDate     = now,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/supply-horizon/{horizon_id}", response_model=SupplyHorizonOut)
def update_supply_horizon(
    horizon_id: int,
    payload: SupplyHorizonUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update an existing supply horizon rule. Admin only."""
    _require_admin(current_user)

    rule = db.query(SupplyHorizon).filter(SupplyHorizon.HorizonID == horizon_id).first()
    if not rule:
        raise HTTPException(404, "Supply horizon rule not found.")

    if payload.HorizonMonths is not None:
        rule.HorizonMonths = payload.HorizonMonths
    if payload.IsActive is not None:
        rule.IsActive = payload.IsActive

    rule.ModifiedDate = datetime.datetime.utcnow()
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/supply-horizon/{horizon_id}", response_model=SupplyHorizonOut)
def deactivate_supply_horizon(
    horizon_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete (deactivate) a supply horizon rule. Admin only."""
    _require_admin(current_user)

    rule = db.query(SupplyHorizon).filter(SupplyHorizon.HorizonID == horizon_id).first()
    if not rule:
        raise HTTPException(404, "Supply horizon rule not found.")

    rule.IsActive     = False
    rule.ModifiedDate = datetime.datetime.utcnow()
    db.commit()
    db.refresh(rule)
    return rule