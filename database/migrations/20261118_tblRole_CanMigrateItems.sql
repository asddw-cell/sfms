-- Migration: add CanMigrateItems permission flag to tblRole
-- Grant to Manager (2), PowerUser (3), Admin (4); SalesUser (1) stays 0

ALTER TABLE tblRole
    ADD CanMigrateItems BIT NOT NULL DEFAULT 0;

UPDATE tblRole SET CanMigrateItems = 1 WHERE Code IN (2, 3, 4);
