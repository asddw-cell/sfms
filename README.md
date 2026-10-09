# Sales Forecast Management System (SFMS)

A purpose-built web application for managing sales forecasts across a global organisation. Replaces ERP-based forecasting with a dedicated system supporting multi-dimensional entry, full audit trail, actuals comparison, and GM budget planning.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Database | Microsoft SQL Server / Azure SQL |
| Backend API | Python 3.12 · FastAPI · SQLAlchemy |
| Frontend | React 18 · Vite · AG Grid Community |
| Authentication | Azure Entra ID (OIDC/OAuth2) — dev stub in use during PoC |
| Deployment | IIS (on-premise) · Uvicorn · NSSM |

---

## Project Structure

```
sfms/
├── backend/
│   ├── app/
│   │   ├── auth/
│   │   │   ├── dev_auth.py        # DEV ONLY — remove before production
│   │   │   └── entra.py           # Production Entra ID token validation
│   │   ├── routers/
│   │   │   ├── forecast.py        # Forecast CRUD
│   │   │   ├── actuals.py         # Actuals + comparison endpoint
│   │   │   ├── reference.py       # BU, customers, items, brands etc.
│   │   │   ├── admin.py           # User list (dev user switcher)
│   │   │   ├── gm_copy.py         # Copy Sales → GM forecast
│   │   │   └── changes.py         # Change history
│   │   ├── services/
│   │   │   └── editability.py     # Horizon + actuals lock rules
│   │   ├── main.py
│   │   ├── models.py              # SQLAlchemy ORM models
│   │   ├── schemas.py             # Pydantic request/response schemas
│   │   ├── db.py                  # Database connection
│   │   └── config.py              # Settings from .env
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   │   ├── client.js          # Axios instance + dev auth header
│   │   │   ├── sfms.js            # One function per API endpoint
│   │   │   └── devUser.js         # Dev user localStorage helpers
│   │   ├── components/
│   │   │   ├── ForecastSummaryPanel.jsx
│   │   │   ├── GmCopyModal.jsx
│   │   │   ├── DevUserSwitcher.jsx  # DEV ONLY
│   │   │   ├── AddItemsModal.jsx
│   │   │   ├── EditModal.jsx
│   │   │   ├── MonthPicker.jsx
│   │   │   └── MultiSelect.jsx
│   │   ├── pages/
│   │   │   ├── Admin/
│   │   │   │   └── UserAdmin.jsx  # User management (Admin only)
│   │   │   ├── ForecastGrid/      # Main forecast entry screen
│   │   │   └── Changes/           # Audit trail screen
│   │   └── App.jsx
│   ├── package.json
│   └── .env.example
├── database/
│   ├── ddl/                       # Schema creation scripts
│   ├── seeds/                     # Reference data seed scripts
│   └── migrations/                # Numbered schema change scripts
│       └── 05_user_customer_assignments.sql
└── etl/                           # SQL Agent actuals load scripts
```

---

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 20 LTS
- Microsoft SQL Server (existing instance)
- ODBC Driver 17 for SQL Server

### 1. Clone the repo

```powershell
git clone https://github.com/asddw-cell/sfms.git
cd sfms
git checkout develop
```

### 2. Backend setup

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# Edit .env with your SQL Server connection details
```

Start the API:

```powershell
uvicorn app.main:app --reload --port 8000
```

API docs available at: http://localhost:8000/docs

### 3. Frontend setup

```powershell
cd frontend
npm install
copy .env.example .env
# Edit .env — set VITE_API_BASE_URL=http://localhost:8000
```

Start the dev server:

```powershell
npm run dev
```

App available at: http://localhost:3000

### 4. Database setup

Run scripts in this order against your SQL Server instance:

```
database/ddl/01_create_schema.sql
database/seeds/001_reference_data.sql
database/migrations/02_tblItem_region_refactor.sql
database/migrations/03_tblItem_add_IsActive_MX.sql
database/migrations/04_tblForecastData_remove_price_from_key.sql
```

---

## Environment Variables

### Backend (`backend/.env`)

```env
DB_SERVER=YOUR_SQL_SERVER_NAME
DB_NAME=SalesForecast
DB_DRIVER=ODBC Driver 17 for SQL Server
ENVIRONMENT=dev
ALLOWED_ORIGINS=http://localhost:3000
ENTRA_TENANT_ID=your-tenant-id
ENTRA_CLIENT_ID=your-api-client-id
ENTRA_AUTHORITY=https://login.microsoftonline.com/your-tenant-id
```

### Frontend (`frontend/.env`)

```env
VITE_API_BASE_URL=http://localhost:8000
VITE_DEV_USER=your.username
VITE_ENTRA_CLIENT_ID=your-frontend-client-id
VITE_ENTRA_AUTHORITY=https://login.microsoftonline.com/your-tenant-id
VITE_API_SCOPE=api://sfms-api/forecast.readwrite
```

---

## Dev Auth (PoC only)

During development, authentication is handled by a stub that reads the `X-Dev-User` header. The `DevUserSwitcher` dropdown in the nav bar lets you switch between users without modifying code — it writes to `localStorage` and reloads the page.

**Before production deployment:**
- Remove `DevUserSwitcher` from `App.jsx`
- Remove the `X-Dev-User` block from `frontend/src/api/client.js`
- Replace `from app.auth.dev_auth import get_current_user` with `from app.auth.entra import get_current_user` in all routers
- Set up Azure Entra ID app registrations (see App Architecture document)

---

## Key Features

- **Forecast Entry** — AG Grid with inline editing, month columns, copy/paste from Excel, import/export
- **Row Types** — F (forecast), A (actuals overlay), LE (latest estimate), brand subtotals
- **Actuals Comparison** — side-by-side forecast vs actuals with variance colouring
- **Forecast Summary Panel** — chart + monthly table showing forecast vs LY vs actuals
- **GM Copy** — copy Sales forecast to GM budget in one operation (PowerUser/Admin)
- **Change History** — full audit trail of all edits with before/after values
- **Multi-Responsibility** — data scoped by business unit with per-user BU assignments
- **Multi-Currency** — prices stored in each BU's home currency
- **User Management** — Admin UI for creating users, assigning responsibilities, 
  setting edit horizon, and restricting access to specific customers per responsibility
- **Customer Permissions** — Users default to seeing all customers in an assigned 
  responsibility; optionally restrict to specific customers per responsibility

---

## User Roles

| Role | Key Permissions |
|---|---|
| Admin | Full access, manage users and reference data |
| PowerUser | View all BUs, manage ref data, GM copy, load actuals |
| Manager | Standard entry within assigned BUs |
| SalesUser | Standard entry within assigned BUs |

---

## Branching Strategy

| Branch | Purpose |
|---|---|
| `main` | Production only — never commit directly, merge via PR |
| `develop` | Integration branch — all active development |
| `feature/*` | Individual features branched off develop |
| `fix/*` | Bug fixes branched off develop |
| `hotfix/*` | Critical production fixes branched off main |

```powershell
# Start new work
git checkout develop
git pull origin develop
git checkout -b feature/my-feature

# When done
git checkout develop
git merge feature/my-feature
git push origin develop
git branch -d feature/my-feature
```

---

## Documentation

Full project documentation is in the `docs/` folder:

- `SFMS_Project_Brief_v1.0.docx` — scope, objectives, requirements
- `SFMS_DataModel_v1.5.docx` — database schema, all tables and columns
- `SFMS_AppArchitecture_v1.2.docx` — tech stack, API endpoints, component structure
- `SFMS_Implementation_Guide_v2.docx` — production deployment instructions
- `SFMS_User_Guide_v2.docx` — end user guide

---

## Production Checklist

Before going live, see the Implementation Guide. Key steps:

- [ ] Replace dev auth stub with Entra ID middleware
- [ ] Remove DevUserSwitcher from nav bar
- [ ] Replace `xlsx` library with `ExcelJS` (known vulnerability)
- [ ] Configure Azure Entra ID app registrations
- [ ] Run all database migration scripts
- [ ] Configure SQL Server Agent actuals ETL job
- [ ] Set up database backups
- [ ] Configure IIS with ARR + URL Rewrite
- [ ] Install Uvicorn as Windows Service via NSSM
- [ ] Restrict `.env` file permissions on server
