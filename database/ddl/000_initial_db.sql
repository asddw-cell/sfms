USE [master]
GO

/****** Object:  Database [SalesForecast]    Script Date: 06/02/2026 14:37:04 ******/

-- Drop and recreate the 'SalesForecast' database

IF EXISTS (SELECT 1 FROM sys.databases WHERE name = 'SalesForecast')
BEGIN
	ALTER DATABASE SalesForecast SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
	DROP DATABASE SalesForecast;
END;
GO

-- Create the 'SalesForecast' database
CREATE DATABASE [SalesForecast];
GO