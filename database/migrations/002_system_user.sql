-- Migration 002: Insert reserved system user
-- This user is never used for login (ExternalIdentityID = 'system' will never
-- match a real Entra ID token). It is used exclusively as CreatedBy/ModifiedBy
-- for programmatic bulk operations: GM copy, ETL actuals loads, and any future
-- automated processes, so that these changes can be hidden from the Change
-- History screen by default.

IF NOT EXISTS (SELECT 1 FROM tblUser WHERE Username = 'system')
BEGIN
    INSERT INTO tblUser (Username, DisplayName, Email, ExternalIdentityID, RoleCode, IsActive, CreatedDate, ModifiedDate)
    VALUES (
        'system',
        'System',
        'system@internal',
        'system',
        (SELECT Code FROM tblRole WHERE Name = 'Admin'),
        1,
        GETUTCDATE(),
        GETUTCDATE()
    )
END
