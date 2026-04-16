"""
db.py - SQL Server database connection using SQLAlchemy
Uses Windows Authentication (trusted_connection=yes) - no username/password needed.
"""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.config import settings
import urllib

# Build the ODBC connection string for SQL Server with Windows Auth
params = urllib.parse.quote_plus(
    f"DRIVER={{{settings.db_driver}}};"
    f"SERVER={settings.db_server};"
    f"DATABASE={settings.db_name};"
    "Trusted_Connection=yes;"
)

engine = create_engine(
    f"mssql+pyodbc:///?odbc_connect={params}",
    echo=settings.environment == "dev",   # Log SQL in dev mode
    pool_pre_ping=True,                   # Verify connections before use
    pool_size=5,
    max_overflow=10,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI dependency - yields a database session and closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
