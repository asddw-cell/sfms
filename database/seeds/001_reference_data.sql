-- =============================================================================
-- GOLIATH SFMS — Sales Forecast Management System
-- Seed Script: 001_reference_data.sql
-- Description: Seeds all reference data tables with confirmed initial values
-- Version: 1.1
-- Date: 2026-03-26
-- Changes from v1.0:
--   - Removed CanManageCycles from tblRole seed (column removed from schema)
-- Run AFTER 001_initial_schema.sql
-- =============================================================================
-- Safe to re-run — all inserts use MERGE (upsert) statements.
-- =============================================================================

SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

PRINT '=== SFMS Reference Data Seeding Starting (v1.1) ===';
PRINT '';

-- =============================================================================
-- 1. CURRENCIES
-- =============================================================================

PRINT '--- Seeding tblCurrency ---';

MERGE dbo.tblCurrency AS target
USING (VALUES
    ('USD', 'US Dollar',         '$' ),
    ('GBP', 'Pound Sterling',    '£' ),
    ('EUR', 'Euro',              '€' ),
    ('AUD', 'Australian Dollar', 'A$')
) AS source (Code, Name, Symbol)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET Name = source.Name, Symbol = source.Symbol, IsActive = 1
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, Symbol, IsActive)
    VALUES (source.Code, source.Name, source.Symbol, 1);

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- 2. BUSINESS UNITS
-- =============================================================================

PRINT '--- Seeding tblBusinessUnit ---';

MERGE dbo.tblBusinessUnit AS target
USING (VALUES
    ('Goliath_EU', 'Goliath Europe',    'EUR'),
    ('Goliath_UK', 'Goliath UK',        'GBP'),
    ('Goliath_US', 'Goliath US',        'USD'),
    ('Goliath_AU', 'Goliath Australia', 'AUD')
) AS source (Code, Name, CurrencyCode)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET
        Name         = source.Name,
        CurrencyCode = source.CurrencyCode,
        IsActive     = 1,
        ModifiedDate = GETUTCDATE()
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, CurrencyCode, IsActive, CreatedDate, ModifiedDate)
    VALUES (source.Code, source.Name, source.CurrencyCode, 1, GETUTCDATE(), GETUTCDATE());

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- 3. FORECAST TYPES
-- =============================================================================

PRINT '--- Seeding tblForecastType ---';

SET IDENTITY_INSERT dbo.tblForecastType ON;

MERGE dbo.tblForecastType AS target
USING (VALUES
    (1, 'Sales', 'Sales forecast — used for purchasing and inventory planning'),
    (2, 'GM',    'General Manager forecast — used for financial budgeting. Seeded from Sales and adjusted.')
) AS source (Code, Name, Description)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET Name = source.Name, Description = source.Description, IsActive = 1
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, Description, IsActive)
    VALUES (source.Code, source.Name, source.Description, 1);

SET IDENTITY_INSERT dbo.tblForecastType OFF;

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- 4. SALES CHANNELS
-- =============================================================================

PRINT '--- Seeding tblSalesChannel ---';

MERGE dbo.tblSalesChannel AS target
USING (VALUES
    ('Domestic', 'Domestic'),
    ('FOB',      'Free On Board (FOB)'),
    ('DDP',      'Delivered Duty Paid (DDP)')
) AS source (Code, Name)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET Name = source.Name, IsActive = 1
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, IsActive)
    VALUES (source.Code, source.Name, 1);

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- 5. PRICE TYPES
-- =============================================================================

PRINT '--- Seeding tblPriceType ---';

SET IDENTITY_INSERT dbo.tblPriceType ON;

MERGE dbo.tblPriceType AS target
USING (VALUES
    (1, 'List'),
    (2, 'Special')
) AS source (Code, Name)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET Name = source.Name, IsActive = 1
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, IsActive)
    VALUES (source.Code, source.Name, 1);

SET IDENTITY_INSERT dbo.tblPriceType OFF;

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- 6. ROLES
-- =============================================================================
-- Permission matrix:
--
--  Role        HorizonBack  ViewAllBU  ManageUsers  ManageRef  LoadActuals
--  SalesUser       0            0           0           0           0
--  Manager         0            0           0           0           0
--  PowerUser       0            1           0           0           1
--  Admin           0            1           1           1           1
--
-- HorizonMonthsBack = 0 for all roles initially (current month + future only).
-- Can be increased per-role or overridden per-user in tblUserBusinessUnit.
-- =============================================================================

PRINT '--- Seeding tblRole ---';

SET IDENTITY_INSERT dbo.tblRole ON;

MERGE dbo.tblRole AS target
USING (VALUES
--  Code  Name          HorizonBack  ViewAllBU  ManageUsers  ManageRef  LoadActuals
    (1,  'SalesUser',   0,           0,         0,           0,         0),
    (2,  'Manager',     0,           0,         0,           0,         0),
    (3,  'PowerUser',   0,           1,         0,           0,         1),
    (4,  'Admin',       0,           1,         1,           1,         1)
) AS source (Code, Name, HorizonMonthsBack, CanViewAllBU, CanManageUsers, CanManageRefData, CanLoadActuals)
ON target.Code = source.Code
WHEN MATCHED THEN
    UPDATE SET
        Name              = source.Name,
        HorizonMonthsBack = source.HorizonMonthsBack,
        CanViewAllBU      = source.CanViewAllBU,
        CanManageUsers    = source.CanManageUsers,
        CanManageRefData  = source.CanManageRefData,
        CanLoadActuals    = source.CanLoadActuals
WHEN NOT MATCHED BY TARGET THEN
    INSERT (Code, Name, HorizonMonthsBack, CanViewAllBU, CanManageUsers, CanManageRefData, CanLoadActuals)
    VALUES (source.Code, source.Name, source.HorizonMonthsBack, source.CanViewAllBU,
            source.CanManageUsers, source.CanManageRefData, source.CanLoadActuals);

SET IDENTITY_INSERT dbo.tblRole OFF;

PRINT '  Merged: ' + CAST(@@ROWCOUNT AS nvarchar) + ' row(s)';
GO

-- =============================================================================
-- SUMMARY
-- =============================================================================

PRINT '';
PRINT '=== Reference Data Seeding Complete (v1.1) ===';
PRINT '';
PRINT 'Row counts:';
PRINT '  tblCurrency       : ' + CAST((SELECT COUNT(*) FROM dbo.tblCurrency)     AS nvarchar) + ' rows';
PRINT '  tblBusinessUnit   : ' + CAST((SELECT COUNT(*) FROM dbo.tblBusinessUnit) AS nvarchar) + ' rows';
PRINT '  tblForecastType   : ' + CAST((SELECT COUNT(*) FROM dbo.tblForecastType) AS nvarchar) + ' rows';
PRINT '  tblSalesChannel   : ' + CAST((SELECT COUNT(*) FROM dbo.tblSalesChannel) AS nvarchar) + ' rows';
PRINT '  tblPriceType      : ' + CAST((SELECT COUNT(*) FROM dbo.tblPriceType)    AS nvarchar) + ' rows';
PRINT '  tblRole           : ' + CAST((SELECT COUNT(*) FROM dbo.tblRole)         AS nvarchar) + ' rows';
PRINT '';
PRINT 'Not seeded here — populated separately:';
PRINT '  tblBrand, tblCustomer, tblItem  — via ERP migration script';
PRINT '  tblUser                          — via Azure Entra ID on first login';
GO