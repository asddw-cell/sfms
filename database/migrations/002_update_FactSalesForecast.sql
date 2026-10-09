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
        ELSE COALESCE(P.[Price], 0)
    END                                             AS [Forecast Sales NSP],
    'N'                                             AS [Intercompany],
    CASE
        WHEN F.[SalesChannelCode] = 'FOB' THEN 'USD'
        ELSE BU.[CurrencyCode]
    END                                             AS [LCY]
FROM [SalesForecast].[dbo].[tblForecastData] F
INNER JOIN [SalesForecast].[dbo].[tblBusinessUnit] BU
    ON F.[BusinessUnitCode] = BU.[Code]
LEFT JOIN [SalesForecast].[dbo].[tblPrice] P
    ON  P.[BusinessUnitCode]  = F.[BusinessUnitCode]
    AND P.[CustomerCode]      = F.[CustomerCode]
    AND P.[SalesChannelCode]  = F.[SalesChannelCode]
    AND P.[ItemNo]            = F.[ItemNo]
    AND P.[PriceMonth]        = F.[ForecastDate]
WHERE F.[ForecastTypeCode] = 1;
GO
