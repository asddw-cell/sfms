# SFMS PoC — Local Setup Guide

**Server:** `NLREPORTING-DTA` | **Database:** `SalesForecast` | **OS:** Windows 11

---

## Prerequisites

### 1 — Python (already installed)
Confirm your version is 3.12+ in PowerShell:
```powershell
python --version
```

### 2 — ODBC Driver 17 for SQL Server
Check if already installed via **Control Panel → ODBC Data Sources (64-bit) → Drivers tab**.
If "ODBC Driver 17 for SQL Server" is listed, skip this step.

If not: download and install from Microsoft:
```
https://aka.ms/odbc17
```
Accept all defaults. No restart needed.

### 3 — Node.js 20 LTS
Download the Windows installer from:
```
https://nodejs.org/en/download
```
- Choose **LTS** (not Current)
- Accept all defaults — this installs both `node` and `npm`

Verify after install (open a **new** PowerShell window):
```powershell
node --version   # should show v20.x.x
npm --version    # should show 10.x.x
```

---

## Step 1 — Get the project files

Copy the `sfms/` folder (provided alongside this guide) to a location of your choice.
This guide assumes:
```
C:\Projects\sfms\
```

Adjust the paths below if you put it elsewhere.

---

## Step 2 — Configure the backend

```powershell
cd C:\Projects\sfms\backend

# Create the virtual environment
python -m venv venv

# Activate it
.\venv\Scripts\Activate.ps1
```

> **If you see an execution policy error**, run this first, then retry:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

```powershell
# Install dependencies
pip install -r requirements.txt
pip install python-dateutil   # needed by editability service
```

**Create the .env file:**
```powershell
copy .env.example .env
```

Open `.env` in Notepad and confirm these values match your environment:
```
DB_SERVER=NLREPORTING-DTA
DB_NAME=SalesForecast
DB_DRIVER=ODBC Driver 17 for SQL Server
ENVIRONMENT=dev
ALLOWED_ORIGINS=http://localhost:3000
DEV_USER=admin
```

> **DEV_USER** must match a `Username` value in `tblUser` in your database.
> Update it to match a real user in your seed data.

---

## Step 3 — Configure the frontend

```powershell
cd C:\Projects\sfms\frontend

# Install Node dependencies (takes ~60 seconds first time)
npm install

# Create the .env file
copy .env.example .env
```

Open `frontend\.env` and set `VITE_DEV_USER` to match the same username
you set in the backend `.env`:
```
VITE_DEV_USER=admin
```

---

## Step 4 — Run the application

You need **two PowerShell terminals** open simultaneously.

### Terminal 1 — Backend API
```powershell
cd C:\Projects\sfms\backend
.\venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

You should see:
```
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
INFO:     Started reloader process
```

Verify it's working — open in your browser:
```
http://localhost:8000/api/v1/health
```
Expected response: `{"status":"ok","environment":"dev"}`

Interactive API docs (all endpoints, try them live):
```
http://localhost:8000/docs
```

### Terminal 2 — React frontend
```powershell
cd C:\Projects\sfms\frontend
npm run dev
```

You should see:
```
  VITE v6.x.x  ready in xxx ms
  ➜  Local:   http://localhost:3000/
```

Open the app:
```
http://localhost:3000
```

---

## Step 5 — Verify end-to-end

1. The nav bar should show your user's display name and role (top right)
2. Go to **Forecast Entry** — select a Business Unit, Forecast Type, Cycle, Sales Channel, and Customer
3. The grid loads — past months appear greyed, future months are clickable
4. Click a future month cell → the edit modal opens → enter Quantity and Price → Save
5. The grid refreshes and shows the new value

---

## How the dev auth stub works

There is **no login screen** in the PoC. Instead:
- Every API request includes an `X-Dev-User` header set to the value of `VITE_DEV_USER`
- The FastAPI backend looks up that username in `tblUser` and treats it as the logged-in user
- That user's role and BU assignments control what data they can see and edit

**To switch users** without restarting anything, open your browser's DevTools,
go to the Network tab, and you'll see `X-Dev-User` on every request.
To test a different user, change `VITE_DEV_USER` in `frontend\.env` and run `npm run dev` again.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ODBC Driver not found` | Driver not installed | Install from `https://aka.ms/odbc17` |
| `Login failed for user` | Windows Auth issue | Ensure your Windows account has access to `SalesForecast` on `NLREPORTING-DTA` |
| `401 Dev auth: user 'admin' not found` | DEV_USER doesn't match tblUser | Update `DEV_USER` in `backend\.env` to a real Username in your database |
| `CORS error` in browser | Backend not running | Start `uvicorn` in Terminal 1 first |
| `npm: command not found` | Node.js not installed / new session | Install Node.js, open a new PowerShell window |
| Grid loads but empty | No matching forecast data | Correct — use the toolbar to set filters, then click a cell to add rows |
| PowerShell script error on `Activate.ps1` | Execution policy | Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |

---

## Project structure reference

```
sfms/
├── backend/
│   ├── app/
│   │   ├── main.py              ← FastAPI entry point
│   │   ├── config.py            ← Settings (reads .env)
│   │   ├── db.py                ← SQL Server connection
│   │   ├── models.py            ← SQLAlchemy ORM (all tables)
│   │   ├── schemas.py           ← Pydantic request/response shapes
│   │   ├── auth/
│   │   │   └── dev_auth.py      ← Dev auth stub (replace with Entra ID later)
│   │   ├── routers/
│   │   │   ├── forecast.py      ← Forecast CRUD
│   │   │   ├── actuals.py       ← Actuals + comparison view
│   │   │   └── reference.py     ← Reference data (BUs, items, customers…)
│   │   └── services/
│   │       └── editability.py   ← 5-step edit lock logic
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.jsx              ← Routing + nav shell
    │   ├── api/
    │   │   ├── client.js        ← Axios instance (injects X-Dev-User)
    │   │   └── sfms.js          ← One function per API endpoint
    │   ├── components/
    │   │   └── EditModal.jsx    ← Forecast cell edit/create/delete modal
    │   └── pages/
    │       ├── ForecastGrid/    ← Main AG Grid forecast entry screen
    │       └── ActualsComparison/ ← Forecast vs actuals table
    ├── package.json
    ├── vite.config.js           ← Dev server + /api proxy to :8000
    └── .env.example
```
