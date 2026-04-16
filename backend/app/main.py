"""
main.py - FastAPI application entry point.
"""
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.auth.dev_auth import get_current_user
from app.models import User
from app.schemas import MeOut
from app.routers import reference, forecast, actuals, changes, gm_copy, admin


app = FastAPI(
    title="SFMS API",
    description="Sales Forecast Management System — PoC build (dev auth stub)",
    version="0.1.0",
)

# CORS — allow the React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(reference.router)
app.include_router(forecast.router)
app.include_router(actuals.router)
app.include_router(changes.router)
app.include_router(gm_copy.router)
app.include_router(admin.router)

@app.get("/api/v1/me", response_model=MeOut, tags=["Auth"])
def get_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns the currently authenticated user's profile, role, and BU assignments."""
    # Eagerly load relationships needed by MeOut
    db.refresh(current_user)
    return current_user


@app.get("/api/v1/health", tags=["Health"])
def health():
    return {"status": "ok", "environment": settings.environment}