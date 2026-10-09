# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```powershell
cd backend
.\venv\Scripts\pip.exe install -r requirements.txt          # first time
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload  # dev server → http://localhost:8000
.\venv\Scripts\pytest.exe                                   # run all tests
.\venv\Scripts\pytest.exe tests/test_forecast.py            # run a single test file
```
> **Windows note:** All commands must be run via the **PowerShell tool**, not Bash — the Bash tool mangles Windows paths. `uvicorn` is not on the system PATH; always invoke via the venv Python (`.\venv\Scripts\python.exe -m uvicorn`). The system Python (3.14) does not have the project packages installed.

### Frontend
```powershell
cd frontend
npm install                              # first time
npm run dev                              # dev server → http://localhost:3000
npm run build                            # production build
```

### Environment setup
Backend requires `backend/.env`:
```
DB_SERVER=<SQL Server host>
DB_NAME=SalesForecast
DB_DRIVER=ODBC Driver 17 for SQL Server
ENVIRONMENT=dev
ALLOWED_ORIGINS=http://localhost:3000
DEV_USER=admin
```
The database uses Windows Authentication (`trusted_connection=yes`). ODBC Driver 17 must be installed. No frontend `.env` is required for local dev — Vite proxies `/api` to the backend via `vite.config.js`.

## Architecture

Full-stack PoC: **React 18 (Vite) + FastAPI + SQL Server**.

```
frontend/src/
  api/          — axios client + one function per API endpoint (sfms.js)
  pages/
    ForecastGrid/   — main forecast entry screen (~1600 lines, AG Grid)
    Changes/        — audit trail view
    Admin/          — user management (admin-only)
  components/   — modals, pickers, multi-select
backend/app/
  routers/      — one file per resource: forecast, reference, actuals, changes, gm_copy, admin
  models.py     — SQLAlchemy ORM (all 14+ tables)
  schemas.py    — Pydantic v2 request/response schemas (ORMBase uses from_attributes=True)
  services/
    editability.py  — editability window enforcement (past-lock, actuals-lock, horizon)
  auth/
    dev_auth.py     — PoC auth stub (X-Dev-User header → tblUser lookup)
    entra.py        — production Entra ID stub (not yet wired in)
  config.py     — Pydantic Settings reading .env
database/
  ddl/          — schema creation scripts
  seeds/        — reference data
  migrations/   — incremental schema changes
```

### Auth
All routes use `get_current_user` from `auth/dev_auth.py`. In dev, the active user is resolved from the `X-Dev-User` request header (sent by the axios client, settable in the UI via `DevUserSwitcher`) or falls back to `DEV_USER` in `.env`. **Replace `dev_auth.py` with `entra.py` before production.**

### Editability window (`services/editability.py`)
`check_editable()` is called in every forecast write endpoint. A month is editable only if:
1. It is not before the current month (absolute past-lock).
2. No invoiced actuals exist for that BU/month.
3. The user is assigned to the BU (or has `CanViewAllBU`).
4. It falls within `current month + HorizonMonthsBack` months ahead (role default, overridable per user/BU).

> **Note:** The column `tblRole.HorizonMonthsBack` and `tblUserBusinessUnit.HorizonOverrideMonthsBack` store a *forward-looking* horizon despite their names — this is a retained backwards-compatibility artefact.

### ForecastGrid data pipeline
The grid is the most complex component. Data flows through a chain of `useMemo` calls:

```
forecastRows (TanStack Query)   actualsRows (TanStack Query)
        ↓                               ↓
  forecastItemMap             actualsItemMap
  (Map<itemNo, fRow>)         (Map<itemNo, aRow>)
        ↓                               ↓
              rowData  (F + A + LE rows per item)
              deps: [forecastItemMap, actualsItemMap, months, selectedBrands]
                              ↓
              rowDataWithTotals  (adds rowTotal, rowValue, isLastInBrand)
              deps: [rowData, months, showActuals, showLE]
                              ↓
              <AgGridReact rowData={rowDataWithTotals} getRowId=... />
```

**Row types:** `F` (forecast, editable), `A` (actuals overlay, read-only), `LE` (latest estimate = past actuals + future forecast, read-only). `rowData` always contains all three types; `rowDataWithTotals` filters them based on `showActuals`/`showLE` toggles.

**`getRowId`**: `${params.data.itemNo}-${params.data.rowType}` — required for AG Grid's delta-update ImmutableService to work correctly.

**Tooltip stability constraint**: The brand tooltip on the Item column (`tooltipValueGetter`) is registered by AG Grid when it first processes rowData. Any change to `rowData`'s reference after initial mount resets AG Grid's internal tooltip state. Therefore: **never add a dependency to the `rowData` useMemo that produces a new reference on mount**, even if logically empty (e.g., `{}` from a disabled query). New row types (e.g., LY rows) must be injected in `rowDataWithTotals`, not `rowData`.

### API conventions
- All endpoints live under `/api/v1/`.
- `api/sfms.js` is the single source of truth for API calls — components never call axios directly.
- Forecast writes use cache patching (`qc.setQueryData`) for optimistic UI; `qc.invalidateQueries` on error to revert.
- The comparison endpoint (`/comparison/{bu_code}`) returns side-by-side forecast vs actuals and is used to populate A rows in the grid.

### Role permissions (flags on `tblRole`)
| Flag | Meaning |
|---|---|
| `CanViewAllBU` | See all business units, not just assigned ones |
| `CanManageUsers` | Access User Admin page |
| `CanManageRefData` | Access reference data management + GM Copy |
| `CanLoadActuals` | Upload actuals data |
