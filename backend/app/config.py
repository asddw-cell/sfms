"""
config.py - Application settings loaded from .env file
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    db_server: str = "NLREPORTING-DTA"
    db_name: str = "SalesForecast"
    db_driver: str = "ODBC Driver 17 for SQL Server"
    environment: str = "dev"
    allowed_origins: str = "http://localhost:3000"
    dev_user: str = "admin"
    # Entra ID — required when environment != "dev"; safe to leave blank in dev.
    entra_tenant_id: str = ""
    entra_client_id: str = ""
    entra_authority: str = ""
    supply_horizon_default_months: int = 3
    system_user_id: int = 1

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
