-- =============================================================================
-- GOLIATH SFMS — Sales Forecast Management System
-- DDL Script: 001_initial_schema.sql
-- Description: Creates all tables, constraints, and indexes
-- Version: 1.0
-- Date: 2026-03-01
-- Run this script BEFORE 001_reference_data.sql
-- =============================================================================
-- Prerequisites:
--   - SQL Server 2016+ or Azure SQL Database
--   - Run as a user with db_owner or equivalent rights
--   - A database must already exist and be selected (USE YourDatabase)
-- =============================================================================

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

PRINT '=== SFMS Schema Creation Starting ===';
PRINT '';

-- =============================================================================
-- 1. REFERENCE DATA TABLES
-- =============================================================================

PRINT '--- Creating reference data tables ---';

-- -----------------------------------------------------------------------------
-- tblCurrency
-- ISO 4217 currency reference
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblCurrency', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCurrency (
        Code        nvarchar(3)     NOT NULL,
        Name        nvarchar(50)    NOT NULL,
        Symbol      nvarchar(5)     NOT NULL,
        IsActive    bit             NOT NULL CONSTRAINT DF_tblCurrency_IsActive DEFAULT (1),

        CONSTRAINT PK_tblCurrency PRIMARY KEY CLUSTERED (Code ASC)
    );
    PRINT '  Created: tblCurrency';
END
ELSE
    PRINT '  Skipped: tblCurrency already exists';
GO

-- -----------------------------------------------------------------------------
-- tblBusinessUnit
-- Each distinct business unit in the global organisation
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblBusinessUnit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblBusinessUnit (
        Code            nvarchar(10)    NOT NULL,
        Name            nvarchar(100)   NOT NULL,
        CurrencyCode    nvarchar(3)     NOT NULL,
        IsActive        bit             NOT NULL CONSTRAINT DF_tblBusinessUnit_IsActive DEFAULT (1),
        CreatedDate     datetime2       NOT NULL CONSTRAINT DF_tblBusinessUnit_CreatedDate DEFAULT (GETUTCDATE()),
        ModifiedDate    datetime2       NOT NULL CONSTRAINT DF_tblBusinessUnit_ModifiedDate DEFAULT (GETUTCDATE()),

        CONSTRAINT PK_tblBusinessUnit PRIMARY KEY CLUSTERED (Code ASC),
        CONSTRAINT FK_tblBusinessUnit_Currency FOREIGN KEY (CurrencyCode)
            REFERENCES dbo.tblCurrency (Code)
    );
    PRINT '  Created: tblBusinessUnit';
END
ELSE
    PRINT '  Skipped: tblBusinessUnit already exists';
GO

-- -----------------------------------------------------------------------------
-- tblForecastType
-- Types of forecast (e.g. Sales, GM)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblForecastType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblForecastType (
        Code            int             NOT NULL IDENTITY(1,1),
        Name            nvarchar(100)   NOT NULL,
        Description     nvarchar(500)   NULL,
        IsActive        bit             NOT NULL CONSTRAINT DF_tblForecastType_IsActive DEFAULT (1),

        CONSTRAINT PK_tblForecastType PRIMARY KEY CLUSTERED (Code ASC)
    );
    PRINT '  Created: tblForecastType';
END
ELSE
    PRINT '  Skipped: tblForecastType already exists';
GO

-- -----------------------------------------------------------------------------
-- tblSalesChannel
-- Sales channels (e.g. Domestic, FOB, DDP)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblSalesChannel', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblSalesChannel (
        Code        nvarchar(15)    NOT NULL,
        Name        nvarchar(100)   NOT NULL,
        IsActive    bit             NOT NULL CONSTRAINT DF_tblSalesChannel_IsActive DEFAULT (1),

        CONSTRAINT PK_tblSalesChannel PRIMARY KEY CLUSTERED (Code ASC)
    );
    PRINT '  Created: tblSalesChannel';
END
ELSE
    PRINT '  Skipped: tblSalesChannel already exists';
GO

-- -----------------------------------------------------------------------------
-- tblPriceType
-- Pricing tiers (e.g. List, Special)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblPriceType', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblPriceType (
        Code        int             NOT NULL IDENTITY(1,1),
        Name        nvarchar(100)   NOT NULL,
        IsActive    bit             NOT NULL CONSTRAINT DF_tblPriceType_IsActive DEFAULT (1),

        CONSTRAINT PK_tblPriceType PRIMARY KEY CLUSTERED (Code ASC)
    );
    PRINT '  Created: tblPriceType';
END
ELSE
    PRINT '  Skipped: tblPriceType already exists';
GO

-- -----------------------------------------------------------------------------
-- tblBrand
-- Product brand master — shared across business units
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblBrand', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblBrand (
        Code        nvarchar(25)    NOT NULL,
        Name        nvarchar(100)   NOT NULL,
        IsActive    bit             NOT NULL CONSTRAINT DF_tblBrand_IsActive DEFAULT (1),

        CONSTRAINT PK_tblBrand PRIMARY KEY CLUSTERED (Code ASC)
    );
    PRINT '  Created: tblBrand';
END
ELSE
    PRINT '  Skipped: tblBrand already exists';
GO

-- -----------------------------------------------------------------------------
-- tblCustomer
-- Forecast-level customer master — scoped to business unit
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblCustomer', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblCustomer (
        Code                nvarchar(20)    NOT NULL,
        BusinessUnitCode    nvarchar(10)    NOT NULL,
        Name                nvarchar(200)   NOT NULL,
        CustomerGroup       nvarchar(100)   NULL,
        IsActive            bit             NOT NULL CONSTRAINT DF_tblCustomer_IsActive DEFAULT (1),

        CONSTRAINT PK_tblCustomer PRIMARY KEY CLUSTERED (Code ASC, BusinessUnitCode ASC),
        CONSTRAINT FK_tblCustomer_BusinessUnit FOREIGN KEY (BusinessUnitCode)
            REFERENCES dbo.tblBusinessUnit (Code)
    );
    PRINT '  Created: tblCustomer';
END
ELSE
    PRINT '  Skipped: tblCustomer already exists';
GO

-- -----------------------------------------------------------------------------
-- tblItem
-- Product / SKU master — scoped to business unit
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblItem', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblItem (
        ItemNo              nvarchar(20)    NOT NULL,
        BusinessUnitCode    nvarchar(10)    NOT NULL,
        BrandCode           nvarchar(25)    NOT NULL,
        Description         nvarchar(300)   NOT NULL,
        UnitOfMeasure       nvarchar(20)    NULL,
        IsActive            bit             NOT NULL CONSTRAINT DF_tblItem_IsActive DEFAULT (1),

        CONSTRAINT PK_tblItem PRIMARY KEY CLUSTERED (ItemNo ASC, BusinessUnitCode ASC),
        CONSTRAINT FK_tblItem_BusinessUnit FOREIGN KEY (BusinessUnitCode)
            REFERENCES dbo.tblBusinessUnit (Code),
        CONSTRAINT FK_tblItem_Brand FOREIGN KEY (BrandCode)
            REFERENCES dbo.tblBrand (Code)
    );

    CREATE NONCLUSTERED INDEX IX_tblItem_Brand
        ON dbo.tblItem (BrandCode ASC)
        INCLUDE (ItemNo, BusinessUnitCode, Description);

    PRINT '  Created: tblItem';
END
ELSE
    PRINT '  Skipped: tblItem already exists';
GO

-- =============================================================================
-- 2. SECURITY & ACCESS TABLES
-- =============================================================================

PRINT '';
PRINT '--- Creating security and access tables ---';

-- -----------------------------------------------------------------------------
-- tblRole
-- Application roles with permission flags and horizon defaults
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblRole', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblRole (
        Code                    int             NOT NULL IDENTITY(1,1),
        Name                    nvarchar(50)    NOT NULL,
        HorizonMonthsBack       int             NOT NULL CONSTRAINT DF_tblRole_HorizonMonthsBack DEFAULT (0),
        CanViewAllBU            bit             NOT NULL CONSTRAINT DF_tblRole_CanViewAllBU DEFAULT (0),
        CanManageUsers          bit             NOT NULL CONSTRAINT DF_tblRole_CanManageUsers DEFAULT (0),
        CanManageRefData        bit             NOT NULL CONSTRAINT DF_tblRole_CanManageRefData DEFAULT (0),
        CanManageCycles         bit             NOT NULL CONSTRAINT DF_tblRole_CanManageCycles DEFAULT (0),
        CanLoadActuals          bit             NOT NULL CONSTRAINT DF_tblRole_CanLoadActuals DEFAULT (0),

        CONSTRAINT PK_tblRole PRIMARY KEY CLUSTERED (Code ASC),
        CONSTRAINT CK_tblRole_HorizonMonthsBack CHECK (HorizonMonthsBack >= 0)
    );
    PRINT '  Created: tblRole';
END
ELSE
    PRINT '  Skipped: tblRole already exists';
GO

-- -----------------------------------------------------------------------------
-- tblUser
-- Application user accounts — identity managed by Azure Entra ID
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblUser', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblUser (
        UserID              int             NOT NULL IDENTITY(1,1),
        Username            nvarchar(100)   NOT NULL,
        DisplayName         nvarchar(200)   NOT NULL,
        Email               nvarchar(200)   NOT NULL,
        ExternalIdentityID  nvarchar(100)   NOT NULL,
        RoleCode            int             NOT NULL,
        IsActive            bit             NOT NULL CONSTRAINT DF_tblUser_IsActive DEFAULT (1),
        CreatedDate         datetime2       NOT NULL CONSTRAINT DF_tblUser_CreatedDate DEFAULT (GETUTCDATE()),
        ModifiedDate        datetime2       NOT NULL CONSTRAINT DF_tblUser_ModifiedDate DEFAULT (GETUTCDATE()),

        CONSTRAINT PK_tblUser PRIMARY KEY CLUSTERED (UserID ASC),
        CONSTRAINT UQ_tblUser_Username UNIQUE (Username),
        CONSTRAINT UQ_tblUser_ExternalIdentityID UNIQUE (ExternalIdentityID),
        CONSTRAINT FK_tblUser_Role FOREIGN KEY (RoleCode)
            REFERENCES dbo.tblRole (Code)
    );
    PRINT '  Created: tblUser';
END
ELSE
    PRINT '  Skipped: tblUser already exists';
GO

-- -----------------------------------------------------------------------------
-- tblUserBusinessUnit
-- Assigns users to business units with optional horizon override
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblUserBusinessUnit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblUserBusinessUnit (
        UserID                      int             NOT NULL,
        BusinessUnitCode            nvarchar(10)    NOT NULL,
        HorizonOverrideMonthsBack   int             NULL,
        AssignedDate                datetime2       NOT NULL CONSTRAINT DF_tblUserBU_AssignedDate DEFAULT (GETUTCDATE()),
        AssignedBy                  int             NOT NULL,

        CONSTRAINT PK_tblUserBusinessUnit PRIMARY KEY CLUSTERED (UserID ASC, BusinessUnitCode ASC),
        CONSTRAINT FK_tblUserBU_User FOREIGN KEY (UserID)
            REFERENCES dbo.tblUser (UserID),
        CONSTRAINT FK_tblUserBU_BusinessUnit FOREIGN KEY (BusinessUnitCode)
            REFERENCES dbo.tblBusinessUnit (Code),
        CONSTRAINT FK_tblUserBU_AssignedBy FOREIGN KEY (AssignedBy)
            REFERENCES dbo.tblUser (UserID),
        CONSTRAINT CK_tblUserBU_HorizonOverride CHECK (
            HorizonOverrideMonthsBack IS NULL OR HorizonOverrideMonthsBack >= 0
        )
    );
    PRINT '  Created: tblUserBusinessUnit';
END
ELSE
    PRINT '  Skipped: tblUserBusinessUnit already exists';
GO

-- =============================================================================
-- 3. FORECAST CYCLE TABLE
-- =============================================================================

PRINT '';
PRINT '--- Creating forecast cycle table ---';

-- -----------------------------------------------------------------------------
-- tblForecastCycle
-- Named forecast rounds with open/close submission windows
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblForecastCycle', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblForecastCycle (
        CycleID             int             NOT NULL IDENTITY(1,1),
        Name                nvarchar(150)   NOT NULL,
        ForecastTypeCode    int             NOT NULL,
        PeriodStart         date            NOT NULL,
        PeriodEnd           date            NOT NULL,
        OpenDate            datetime2       NOT NULL,
        CloseDate           datetime2       NULL,
        IsActive            bit             NOT NULL CONSTRAINT DF_tblForecastCycle_IsActive DEFAULT (1),
        CreatedBy           int             NOT NULL,
        CreatedDate         datetime2       NOT NULL CONSTRAINT DF_tblForecastCycle_CreatedDate DEFAULT (GETUTCDATE()),

        CONSTRAINT PK_tblForecastCycle PRIMARY KEY CLUSTERED (CycleID ASC),
        CONSTRAINT FK_tblForecastCycle_ForecastType FOREIGN KEY (ForecastTypeCode)
            REFERENCES dbo.tblForecastType (Code),
        CONSTRAINT FK_tblForecastCycle_CreatedBy FOREIGN KEY (CreatedBy)
            REFERENCES dbo.tblUser (UserID),
        CONSTRAINT CK_tblForecastCycle_Period CHECK (PeriodEnd >= PeriodStart),
        CONSTRAINT CK_tblForecastCycle_CloseDate CHECK (
            CloseDate IS NULL OR CloseDate > OpenDate
        ),
        -- Periods must always be stored as the 1st of the month
        CONSTRAINT CK_tblForecastCycle_PeriodStartDay CHECK (DAY(PeriodStart) = 1),
        CONSTRAINT CK_tblForecastCycle_PeriodEndDay CHECK (DAY(PeriodEnd) = 1)
    );

    CREATE NONCLUSTERED INDEX IX_tblForecastCycle_TypeActive
        ON dbo.tblForecastCycle (ForecastTypeCode ASC, IsActive ASC)
        INCLUDE (Name, PeriodStart, PeriodEnd, OpenDate, CloseDate);

    PRINT '  Created: tblForecastCycle';
END
ELSE
    PRINT '  Skipped: tblForecastCycle already exists';
GO

-- =============================================================================
-- 4. FORECAST DATA TABLE (TEMPORAL / SYSTEM-VERSIONED)
-- =============================================================================

PRINT '';
PRINT '--- Creating forecast data table (temporal) ---';

-- -----------------------------------------------------------------------------
-- tblForecastData
-- Core fact table with full temporal audit trail
-- History table: tblForecastData_History (auto-maintained by SQL Server)
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblForecastData', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblForecastData (
        EntryNo             int             NOT NULL IDENTITY(1,1),
        BusinessUnitCode    nvarchar(10)    NOT NULL,
        CycleID             int             NOT NULL,
        ForecastTypeCode    int             NOT NULL,
        SalesChannelCode    nvarchar(15)    NOT NULL,
        CustomerCode        nvarchar(20)    NOT NULL,
        BrandCode           nvarchar(25)    NOT NULL,
        ItemNo              nvarchar(20)    NOT NULL,
        ForecastDate        date            NOT NULL,
        PriceTypeCode       int             NOT NULL,
        Price               decimal(18,4)   NOT NULL,
        Quantity            decimal(18,4)   NOT NULL,
        Notes               nvarchar(500)   NULL,
        CreatedBy           int             NOT NULL,
        CreatedDate         datetime2       NOT NULL CONSTRAINT DF_tblForecastData_CreatedDate DEFAULT (GETUTCDATE()),
        ModifiedBy          int             NULL,
        ModifiedDate        datetime2       NULL,

        -- Temporal columns — managed by SQL Server
        SysStartTime        datetime2(7)    GENERATED ALWAYS AS ROW START HIDDEN NOT NULL,
        SysEndTime          datetime2(7)    GENERATED ALWAYS AS ROW END HIDDEN NOT NULL,

        CONSTRAINT PK_tblForecastData PRIMARY KEY CLUSTERED (EntryNo ASC),

        -- Business key — one row per unique dimension combination and price point
        CONSTRAINT UQ_tblForecastData_BusinessKey UNIQUE NONCLUSTERED (
            BusinessUnitCode,
            CycleID,
            SalesChannelCode,
            CustomerCode,
            ItemNo,
            ForecastDate,
            PriceTypeCode,
            Price
        ),

        -- Foreign keys
        CONSTRAINT FK_tblForecastData_BusinessUnit FOREIGN KEY (BusinessUnitCode)
            REFERENCES dbo.tblBusinessUnit (Code),
        CONSTRAINT FK_tblForecastData_Cycle FOREIGN KEY (CycleID)
            REFERENCES dbo.tblForecastCycle (CycleID),
        CONSTRAINT FK_tblForecastData_ForecastType FOREIGN KEY (ForecastTypeCode)
            REFERENCES dbo.tblForecastType (Code),
        CONSTRAINT FK_tblForecastData_SalesChannel FOREIGN KEY (SalesChannelCode)
            REFERENCES dbo.tblSalesChannel (Code),
        CONSTRAINT FK_tblForecastData_Customer FOREIGN KEY (CustomerCode, BusinessUnitCode)
            REFERENCES dbo.tblCustomer (Code, BusinessUnitCode),
        CONSTRAINT FK_tblForecastData_Brand FOREIGN KEY (BrandCode)
            REFERENCES dbo.tblBrand (Code),
        CONSTRAINT FK_tblForecastData_Item FOREIGN KEY (ItemNo, BusinessUnitCode)
            REFERENCES dbo.tblItem (ItemNo, BusinessUnitCode),
        CONSTRAINT FK_tblForecastData_PriceType FOREIGN KEY (PriceTypeCode)
            REFERENCES dbo.tblPriceType (Code),
        CONSTRAINT FK_tblForecastData_CreatedBy FOREIGN KEY (CreatedBy)
            REFERENCES dbo.tblUser (UserID),
        CONSTRAINT FK_tblForecastData_ModifiedBy FOREIGN KEY (ModifiedBy)
            REFERENCES dbo.tblUser (UserID),

        -- Data integrity checks
        CONSTRAINT CK_tblForecastData_Quantity CHECK (Quantity >= 0),
        CONSTRAINT CK_tblForecastData_Price CHECK (Price >= 0),
        CONSTRAINT CK_tblForecastData_ForecastDate CHECK (DAY(ForecastDate) = 1),

        PERIOD FOR SYSTEM_TIME (SysStartTime, SysEndTime)
    )
    WITH (SYSTEM_VERSIONING = ON (
        HISTORY_TABLE = dbo.tblForecastData_History,
        DATA_CONSISTENCY_CHECK = ON
    ));

    -- Supporting indexes
    CREATE NONCLUSTERED INDEX IX_tblForecastData_BUDate
        ON dbo.tblForecastData (BusinessUnitCode ASC, ForecastDate ASC)
        INCLUDE (CycleID, ForecastTypeCode, Quantity, Price);

    CREATE NONCLUSTERED INDEX IX_tblForecastData_Cycle
        ON dbo.tblForecastData (CycleID ASC)
        INCLUDE (BusinessUnitCode, ForecastDate, Quantity, Price);

    CREATE NONCLUSTERED INDEX IX_tblForecastData_Customer
        ON dbo.tblForecastData (CustomerCode ASC, BusinessUnitCode ASC)
        INCLUDE (ForecastDate, Quantity, Price);

    CREATE NONCLUSTERED INDEX IX_tblForecastData_Item
        ON dbo.tblForecastData (ItemNo ASC, BusinessUnitCode ASC)
        INCLUDE (ForecastDate, Quantity, Price);

    PRINT '  Created: tblForecastData (with temporal versioning)';
    PRINT '  Created: tblForecastData_History (auto-generated)';
END
ELSE
    PRINT '  Skipped: tblForecastData already exists';
GO

-- =============================================================================
-- 5. ACTUALS TABLE
-- =============================================================================

PRINT '';
PRINT '--- Creating actuals table ---';

-- -----------------------------------------------------------------------------
-- tblActuals
-- Invoiced actuals and open orders loaded by SQL Agent ETL job
-- Never written to directly by the application
-- -----------------------------------------------------------------------------
IF OBJECT_ID('dbo.tblActuals', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.tblActuals (
        ActualsID           int             NOT NULL IDENTITY(1,1),
        BusinessUnitCode    nvarchar(10)    NOT NULL,
        ActualsType         nvarchar(20)    NOT NULL,
        SalesChannelCode    nvarchar(15)    NOT NULL,
        CustomerCode        nvarchar(20)    NOT NULL,
        BrandCode           nvarchar(25)    NOT NULL,
        ItemNo              nvarchar(20)    NOT NULL,
        ActualsDate         date            NOT NULL,
        Price               decimal(18,4)   NOT NULL,
        Quantity            decimal(18,4)   NOT NULL,
        LoadedDate          datetime2       NOT NULL CONSTRAINT DF_tblActuals_LoadedDate DEFAULT (GETUTCDATE()),
        SourceReference     nvarchar(100)   NULL,

        CONSTRAINT PK_tblActuals PRIMARY KEY CLUSTERED (ActualsID ASC),

        -- Business key
        CONSTRAINT UQ_tblActuals_BusinessKey UNIQUE NONCLUSTERED (
            BusinessUnitCode,
            ActualsType,
            SalesChannelCode,
            CustomerCode,
            ItemNo,
            ActualsDate,
            Price
        ),

        -- Foreign keys
        CONSTRAINT FK_tblActuals_BusinessUnit FOREIGN KEY (BusinessUnitCode)
            REFERENCES dbo.tblBusinessUnit (Code),
        CONSTRAINT FK_tblActuals_SalesChannel FOREIGN KEY (SalesChannelCode)
            REFERENCES dbo.tblSalesChannel (Code),
        CONSTRAINT FK_tblActuals_Brand FOREIGN KEY (BrandCode)
            REFERENCES dbo.tblBrand (Code),
        CONSTRAINT FK_tblActuals_Item FOREIGN KEY (ItemNo, BusinessUnitCode)
            REFERENCES dbo.tblItem (ItemNo, BusinessUnitCode),

        -- Data integrity checks
        CONSTRAINT CK_tblActuals_Type CHECK (ActualsType IN ('Invoiced', 'OpenOrders')),
        CONSTRAINT CK_tblActuals_Quantity CHECK (Quantity >= 0),
        CONSTRAINT CK_tblActuals_Price CHECK (Price >= 0),
        CONSTRAINT CK_tblActuals_ActualsDate CHECK (DAY(ActualsDate) = 1)
    );

    CREATE NONCLUSTERED INDEX IX_tblActuals_BUDateType
        ON dbo.tblActuals (BusinessUnitCode ASC, ActualsDate ASC, ActualsType ASC)
        INCLUDE (CustomerCode, ItemNo, Quantity, Price);

    CREATE NONCLUSTERED INDEX IX_tblActuals_Customer
        ON dbo.tblActuals (CustomerCode ASC, BusinessUnitCode ASC)
        INCLUDE (ActualsDate, ActualsType, Quantity, Price);

    CREATE NONCLUSTERED INDEX IX_tblActuals_Item
        ON dbo.tblActuals (ItemNo ASC, BusinessUnitCode ASC)
        INCLUDE (ActualsDate, ActualsType, Quantity, Price);

    PRINT '  Created: tblActuals';
END
ELSE
    PRINT '  Skipped: tblActuals already exists';
GO

-- =============================================================================

PRINT '';
PRINT '=== SFMS Schema Creation Complete ===';
PRINT '';
PRINT 'Next step: run 001_reference_data.sql to seed reference data.';
GO