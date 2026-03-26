# Goliath SFMS — Sales Forecast Management System

A web-based sales forecasting application replacing the existing ERP-based process.

## Tech Stack
- **Database:** Microsoft SQL Server / Azure SQL
- **Backend:** Python — FastAPI
- **Frontend:** React — AG Grid
- **Auth:** Azure Entra ID (OIDC)

## Repository Structure
| Folder | Contents |
|---|---|
| `docs/` | Project documents — brief, data model, architecture |
| `database/ddl/` | Schema creation scripts |
| `database/seeds/` | Reference data seed scripts |
| `database/migrations/` | Numbered schema change scripts |
| `backend/` | FastAPI application |
| `frontend/` | React application |
| `etl/` | SQL Agent job scripts for actuals loading |

## Project Status
- [x] Project Brief
- [x] Data Model Design
- [ ] DDL Script
- [ ] Application Architecture
- [ ] Phase 1 — Foundation
- [ ] Phase 2 — Forecast Entry
- [ ] Phase 3 — Audit & History
- [ ] Phase 4 — Actuals & Comparison
- [ ] Phase 5 — Integration & Hardening