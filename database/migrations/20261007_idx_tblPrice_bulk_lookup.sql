-- Migration: composite index to support the bulk price lookup introduced in
-- perf/price-lookup-bulk.
--
-- WHEN TO APPLY
-- Apply this before or immediately after deploying the new get_effective_prices_bulk
-- function to production.  On a quiet system the build is online (non-blocking
-- READ_COMMITTED traffic can proceed), but schedule it outside peak hours on a
-- large tblPrice table.  Estimate roughly 1-2 minutes per million rows on typical
-- SQL Server hardware.
--
-- WHAT IT COVERS
-- The new bulk fetch issues:
--
--   SELECT BusinessUnitCode, CustomerCode, SalesChannelCode,
--          BaseItemNo, VariantSuffix, PriceMonth, Price
--   FROM   tblPrice
--   WHERE  BusinessUnitCode IN (...)
--     AND  CustomerCode     IN (...)
--     AND  SalesChannelCode IN (...)
--     AND  PriceMonth BETWEEN @min AND @max
--
-- The leading columns (BU, Customer, Channel) narrow the seek to the relevant
-- customer set; PriceMonth prunes the date range; the remaining columns are
-- included so the index covers the SELECT list completely (no key lookups).
--
-- DO NOT RUN THIS SCRIPT FROM CLAUDE CODE. Apply by hand after review.

USE SalesForecast;
GO

IF NOT EXISTS (
    SELECT 1
    FROM   sys.indexes
    WHERE  object_id = OBJECT_ID('dbo.tblPrice')
      AND  name      = 'IX_tblPrice_BulkLookup'
)
BEGIN
    CREATE NONCLUSTERED INDEX IX_tblPrice_BulkLookup
        ON dbo.tblPrice (BusinessUnitCode, CustomerCode, SalesChannelCode, PriceMonth)
        INCLUDE (BaseItemNo, VariantSuffix, Price);

    PRINT 'Index IX_tblPrice_BulkLookup created.';
END
ELSE
BEGIN
    PRINT 'Index IX_tblPrice_BulkLookup already exists — skipped.';
END
GO
