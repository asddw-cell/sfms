/* =====================================================================
   FactSalesForecast view: update tblPrice join for BaseItemNo/VariantSuffix
   ---------------------------------------------------------------------
   Run AFTER 20261006_tblPrice_base_item_variant_suffix.sql has been applied
   to this database. Replaces the single tblPrice join (on ItemNo) with two
   LEFT JOINs — one for the exact variant price and one for the base price —
   and COALESCE to implement the variant → base → 0 fallback.
   ===================================================================== */

USE sfms;
GO

ALTER VIEW [dbo].[FactSalesForecast]
AS
SELECT
    CASE
        WHEN F.[SalesChannelCode] = 'FOB'  THEN 'HK'
        WHEN F.[BusinessUnitCode] = 'MX_MX' THEN 'EU'
        ELSE LEFT(F.[BusinessUnitCode], 2)
    END                                             AS [Source],
    2                                               AS [Line Type],
    F.[ItemNo],
    F.[Quantity],
    F.[BusinessUnitCode]                            AS [Responsibility],
    F.[CustomerCode]                                AS [ForecastingEntity],
    F.[ForecastDate],
    CASE F.[SalesChannelCode]
        WHEN 'FOB' THEN 'FOB/DTR'
        ELSE F.[SalesChannelCode]
    END                                             AS [Domestic_FOB],
    CASE
        WHEN F.[SalesChannelCode] = 'FOB'  THEN 'HK'
        WHEN F.[BusinessUnitCode] = 'MX_MX' THEN 'EU'
        ELSE LEFT(F.[BusinessUnitCode], 2)
    END                                             AS [Source_Co],
    F.[Quantity] * CASE
        WHEN F.[IsPriceOverride] = 1 THEN F.[OverridePrice]
        ELSE COALESCE(PV.[Price], PB.[Price], 0)
    END                                             AS [Forecast Sales NSP],
    'N'                                             AS [Intercompany],
    CASE
        WHEN F.[SalesChannelCode] = 'FOB' THEN 'USD'
        ELSE BU.[CurrencyCode]
    END                                             AS [LCY]
FROM [SalesForecast].[dbo].[tblForecastData] F
INNER JOIN [SalesForecast].[dbo].[tblBusinessUnit] BU
    ON F.[BusinessUnitCode] = BU.[Code]
-- Exact variant price (VariantSuffix matches the suffix split from ItemNo)
LEFT JOIN [SalesForecast].[dbo].[tblPrice] PV
    ON  PV.[BusinessUnitCode]  = F.[BusinessUnitCode]
    AND PV.[CustomerCode]      = F.[CustomerCode]
    AND PV.[SalesChannelCode]  = F.[SalesChannelCode]
    AND PV.[PriceMonth]        = F.[ForecastDate]
    AND PV.[BaseItemNo]        = CASE
                                     WHEN LEN(F.[ItemNo]) > 4
                                          AND SUBSTRING(F.[ItemNo], LEN(F.[ItemNo]) - 3, 1) = '.'
                                     THEN LEFT(F.[ItemNo], LEN(F.[ItemNo]) - 4)
                                     ELSE F.[ItemNo]
                                 END
    AND PV.[VariantSuffix]     = CASE
                                     WHEN LEN(F.[ItemNo]) > 4
                                          AND SUBSTRING(F.[ItemNo], LEN(F.[ItemNo]) - 3, 1) = '.'
                                     THEN RIGHT(F.[ItemNo], 4)
                                     ELSE N''
                                 END
-- Base price fallback (VariantSuffix = '')
LEFT JOIN [SalesForecast].[dbo].[tblPrice] PB
    ON  PB.[BusinessUnitCode]  = F.[BusinessUnitCode]
    AND PB.[CustomerCode]      = F.[CustomerCode]
    AND PB.[SalesChannelCode]  = F.[SalesChannelCode]
    AND PB.[PriceMonth]        = F.[ForecastDate]
    AND PB.[BaseItemNo]        = CASE
                                     WHEN LEN(F.[ItemNo]) > 4
                                          AND SUBSTRING(F.[ItemNo], LEN(F.[ItemNo]) - 3, 1) = '.'
                                     THEN LEFT(F.[ItemNo], LEN(F.[ItemNo]) - 4)
                                     ELSE F.[ItemNo]
                                 END
    AND PB.[VariantSuffix]     = N''
WHERE F.[ForecastTypeCode] = 1;
GO
