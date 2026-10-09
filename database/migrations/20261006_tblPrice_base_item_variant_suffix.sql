/* =====================================================================
   tblPrice: replace ItemNo with BaseItemNo + VariantSuffix
   ---------------------------------------------------------------------
   ALREADY APPLIED on dev. Run ONCE per database (Test, then Production)
   BEFORE deploying the matching application code. Run against the target
   database (no USE statement; select the database in SSMS first).
   Not idempotent: do not re-run on a database where it has been applied.
   Rollback: the backup table dbo.tblPrice_PreMigration_Backup holds the
   pre-migration rows.
   ===================================================================== */

-- 0. Safety copy
IF OBJECT_ID('dbo.tblPrice_PreMigration_Backup') IS NULL
    SELECT * INTO dbo.tblPrice_PreMigration_Backup FROM dbo.tblPrice;
GO

-- 1. Add the new columns (BaseItemNo nullable until backfilled)
ALTER TABLE dbo.tblPrice ADD BaseItemNo    nvarchar(20) NULL;
ALTER TABLE dbo.tblPrice ADD VariantSuffix nvarchar(4)  NOT NULL
    CONSTRAINT DF_tblPrice_VariantSuffix DEFAULT (N'');
GO

-- 2. Backfill from ItemNo: split off a trailing '.' + 3 characters
UPDATE dbo.tblPrice
SET    BaseItemNo = CASE WHEN LEN(ItemNo) > 4 AND SUBSTRING(ItemNo, LEN(ItemNo) - 3, 1) = '.'
                         THEN LEFT(ItemNo, LEN(ItemNo) - 4) ELSE ItemNo END,
       VariantSuffix = CASE WHEN LEN(ItemNo) > 4 AND SUBSTRING(ItemNo, LEN(ItemNo) - 3, 1) = '.'
                            THEN RIGHT(ItemNo, 4) ELSE N'' END;
GO

-- 3. Make BaseItemNo mandatory
ALTER TABLE dbo.tblPrice ALTER COLUMN BaseItemNo nvarchar(20) NOT NULL;
GO

-- 4. Drop objects that depend on ItemNo
ALTER TABLE dbo.tblPrice DROP CONSTRAINT FK_tblPrice_Item;
ALTER TABLE dbo.tblPrice DROP CONSTRAINT UQ_tblPrice_BusinessKey;
DROP INDEX IX_tblPrice_BU_Month ON dbo.tblPrice;
DROP INDEX IX_tblPrice_Item_BU  ON dbo.tblPrice;
GO

-- 5. Drop the old column
ALTER TABLE dbo.tblPrice DROP COLUMN ItemNo;
GO

-- 6. Recreate indexes on the new columns
CREATE NONCLUSTERED INDEX IX_tblPrice_BU_Month
    ON dbo.tblPrice (BusinessUnitCode, PriceMonth)
    INCLUDE (CustomerCode, SalesChannelCode, BaseItemNo, VariantSuffix, Price);

CREATE NONCLUSTERED INDEX IX_tblPrice_Item_BU
    ON dbo.tblPrice (BaseItemNo, VariantSuffix, BusinessUnitCode);
GO

-- 7. Recreate the business key on the new columns
ALTER TABLE dbo.tblPrice ADD CONSTRAINT UQ_tblPrice_BusinessKey UNIQUE NONCLUSTERED
(
    BusinessUnitCode ASC,
    CustomerCode     ASC,
    SalesChannelCode ASC,
    BaseItemNo       ASC,
    VariantSuffix    ASC,
    PriceMonth       ASC
);

-- 8. VariantSuffix must be blank (all variants) or a dot plus 3 characters
ALTER TABLE dbo.tblPrice WITH CHECK ADD CONSTRAINT CHK_tblPrice_VariantSuffix_Format
    CHECK (VariantSuffix = N'' OR (LEN(VariantSuffix) = 4 AND LEFT(VariantSuffix, 1) = N'.'));
GO

-- 9. Verify
SELECT RowsNow    = (SELECT COUNT(*) FROM dbo.tblPrice),
       RowsBefore = (SELECT COUNT(*) FROM dbo.tblPrice_PreMigration_Backup);
GO
